/**
 * Git source cache: bare clones under `$XDG_CACHE_HOME/ambit`, fetched on demand, plus one
 * checkout per commit.
 *
 * - A pin (`ambit.lock`'s recorded commit) is checked out directly, without resolving the ref.
 *   This is what lets a committed lock reproduce an install on a different machine's cache.
 * - The clone is refetched only when it cannot resolve the requested ref. Fetching on every
 *   resolve would let a moving ref like `ref: main` mean different commits between runs.
 *   `ambit update` is what advances the cache. A source with no pin has no earlier resolution to
 *   agree with, so `install` always asks the remote for it rather than reusing whatever another
 *   project last left in the shared cache (see `catalogPlan` in `src/project/install.ts`).
 * - A checkout is keyed by commit, not by ref, so projects pinned to different refs of one
 *   repository share the clone and reuse an existing checkout.
 * - Checkouts use `git worktree` rather than `git archive | tar`, so git is the only required
 *   PATH tool.
 * - `--offline` blocks only the clone and the fetch. A checkout ambit can produce from a clone it
 *   already has is still allowed; both places that would otherwise reach the remote fail with
 *   exit 4 instead.
 * - Two commands reach the remote anyway. `ambit update` fetches into the clone's own refs
 *   (`refresh: "advance"`), so later resolves see the new commit. `ambit outdated` reports and
 *   must change nothing, so it fetches into {@link PROBE_NAMESPACE} instead (`refresh: "probe"`),
 *   which ref resolution never reads.
 */
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { configError, networkError } from "../errors.js";

/** The directory ambit owns inside the XDG cache root. */
export const CACHE_DIRNAME = "ambit";

/** Bare clones within the cache, keyed by host/owner/repo. */
export const REPOS_DIRNAME = "repos";

/** Checkouts within the cache, keyed by host/owner/repo and then commit. */
export const SOURCES_DIRNAME = "sources";

/** Suffix of the file written beside a checkout once it is complete. */
const READY_SUFFIX = ".ready";

/** Suffix of a bare clone's directory, and the one stripped off a URL's last path segment. */
const GIT_SUFFIX = ".git";

/** Where a clone lands while it is still incomplete, so a failed one is never mistaken for a hit. */
const INCOMING_SUFFIX = ".incoming";

/** Stands in for the host of a git URL naming a local path — `file://…`, `/srv/skills.git`. */
const LOCAL_HOST = "local";

/**
 * Where a probe writes what the remote says, inside the cached clone.
 *
 * Outside `refs/heads/` and `refs/tags/`, which {@link resolveCommit} resolves a project's `ref`
 * against — so a probe cannot change what a later command installs. The refs are kept rather than
 * deleted afterward so git does not garbage-collect the objects a probed checkout needs.
 */
export const PROBE_NAMESPACE = "refs/ambit/latest";

/**
 * What a probe fetches, and where it lands. All three run every time.
 *
 * An absent `ref` means the remote's `HEAD`. Which of the three resolves also decides
 * {@link GitRefResolution.moving}.
 */
const PROBE_REFSPECS: readonly string[] = [
  `+refs/heads/*:${PROBE_NAMESPACE}/heads/*`,
  `+refs/tags/*:${PROBE_NAMESPACE}/tags/*`,
  `+HEAD:${PROBE_NAMESPACE}/HEAD`,
];

/**
 * How much of the remote one resolve may consult.
 *
 * - `none` — the cache alone, refetching only when it cannot answer the ref. Every command but the
 *   two below.
 * - `probe` — ask the remote where the ref points now, without letting the answer become what the
 *   clone's own refs say. `ambit outdated`, which reports and must change nothing.
 * - `advance` — fetch normally, so the clone's refs move and every later resolve follows.
 *   `ambit update`, which exists to do exactly that.
 */
export const REFRESH_MODES = ["none", "probe", "advance"] as const;

export type RefreshMode = (typeof REFRESH_MODES)[number];

/**
 * Env vars that would point git at the caller's repository instead of the cache. Set when ambit
 * runs from inside a git hook or alias.
 */
const REDIRECTING_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/** A scp-like git URL — `git@github.com:acme/skills.git` — which is not a parseable URL. */
const SCP_LIKE = /^(?:[^@/]+@)?([^@/:]+):(?!\/)(.*)$/;

/**
 * A full commit SHA: sha1 today, sha256 in a repository built for it.
 *
 * Full rather than abbreviated, and hex only, because that is what a pin must be. A pin that
 * could name a branch would be a moving pin, and one that could start with `-` would be a git
 * option.
 */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Whether a string is a full commit SHA, which is what a pin must be.
 *
 * Exported so the lock reader can validate a hand-edited pin against the same rule and report it
 * against `ambit.lock` rather than as a git failure.
 */
export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

const execFileAsync = promisify(execFile);

/** One repository to fetch, and everything the errors and the cache need to know about it. */
export interface GitFetchRequest {
  /** The URL as git will receive it. */
  readonly url: string;
  /** Tag, branch, or commit. Absent means the repository's default branch. */
  readonly ref?: string;
  /**
   * The commit an earlier resolution of this source recorded, from `ambit.lock`.
   *
   * When present, this commit is checked out directly and {@link GitFetchRequest.ref} is not
   * consulted. Only used under `refresh: "none"`; the refreshing modes exist to ask where a ref
   * points now, which a recorded commit cannot answer.
   *
   * Must be a full commit SHA ({@link isCommitSha}).
   */
  readonly pin?: string;
  /** How the thing being fetched is named in errors: `catalog "company"`. */
  readonly subject: string;
  /** The `(file line N)` suffix its config entry sits at. */
  readonly where: string;
  /** Environment the cache location and git itself are read from. */
  readonly env: NodeJS.ProcessEnv;
  /** Directory git runs in, so a URL naming a relative path means something definite. */
  readonly cwd: string;
  /** `--offline`: answer from the cache, and fail rather than reach the remote. */
  readonly offline?: boolean;
  /** How much of the remote this fetch may consult. Absent means {@link REFRESH_MODES}' `"none"`. */
  readonly refresh?: RefreshMode;
}

/** A fetched source: a directory to read, and the commit its contents are. */
export interface FetchedGitSource {
  /** Absolute path to the checkout. */
  readonly root: string;
  /** The full commit SHA the ref resolved to. */
  readonly commit: string;
  /**
   * Whether the `ref` this resolved through can move: a branch, a tag, or the repository's
   * default branch. False for a `ref` naming a commit, which is already a pin.
   *
   * Absent under `refresh: "none"`, which does not need it: deciding it costs an extra
   * `rev-parse`, and answering it from a clone that may be stale would be answering it wrong.
   */
  readonly moving?: boolean;
}

/**
 * Where the cache lives.
 *
 * Read from the environment it is given rather than `process.env`, so the location is a function of
 * the caller's arguments and a test can point it somewhere disposable.
 */
export function cacheRoot(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg !== undefined && xdg.trim() !== "") return path.join(xdg, CACHE_DIRNAME);
  return path.join(env.HOME ?? homedir(), ".cache", CACHE_DIRNAME);
}

/** Keeps a key segment inside the cache directory, whatever a URL put in it. */
function sanitize(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "-" : cleaned;
}

/** The host a git URL names, and the path within it, for whichever of the shapes git accepts. */
function splitUrl(url: string): { readonly host: string; readonly target: string } {
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname === "" ? LOCAL_HOST : parsed.hostname.toLowerCase();
      return { host, target: parsed.pathname };
    } catch {
      // Not a URL the platform parses. git may still understand it, and the cache key is ambit's
      // to choose, so fall through to the shapes below rather than refusing the source.
    }
  }

  const scp = SCP_LIKE.exec(url);
  const host = scp?.[1];
  const target = scp?.[2];
  if (host !== undefined && target !== undefined) return { host: host.toLowerCase(), target };

  return { host: LOCAL_HOST, target: url };
}

/**
 * Where a repository is cached, relative to the cache root: `<host>/<path…>` — host, then owner, then repo.
 *
 * A trailing `.git` is stripped so `https://github.com/acme/skills` and
 * `https://github.com/acme/skills.git` share one clone, since they are the same repository.
 */
export function gitCacheKey(url: string): string {
  const { host, target } = splitUrl(url);

  const segments = target.split("/").filter((segment) => segment !== "");
  const last = segments.pop();
  if (last !== undefined) {
    segments.push(last.endsWith(GIT_SUFFIX) ? last.slice(0, -GIT_SUFFIX.length) : last);
  }

  return [host, ...segments].map(sanitize).join("/");
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** What git said last, which is where its `fatal:` line lands. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

/** The environment git is run in: the caller's, minus anything that would redirect it. */
function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Fails instead of prompting for credentials: a prompt on a non-interactive run is
  // indistinguishable from a hang.
  const copy: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REDIRECTING_GIT_VARS) delete copy[name];
  return copy;
}

/** What one git invocation produced, with a non-zero exit reported rather than thrown. */
interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git, treating a non-zero exit as data rather than an error: `rev-parse` failing is how
 * ambit asks whether the cache already knows a ref. Only a git that cannot start at all throws.
 *
 * @throws {AmbitError} exit 4 if git is not on PATH.
 */
async function runGit(
  args: readonly string[],
  request: Pick<GitFetchRequest, "cwd" | "env">,
): Promise<GitOutcome> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: request.cwd,
      env: gitEnvironment(request.env),
      encoding: "utf8",
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw networkError("git is not on PATH", [
        "ambit fetches catalogs by running git, and could not start it",
        "install git, or add it to PATH",
      ]);
    }
    if (!isRecord(error)) throw error;
    return { ok: false, stdout: asString(error.stdout), stderr: asString(error.stderr) };
  }
}

/** The error for a git command that failed, carrying git's own last word. */
function gitFailed(summary: string, outcome: GitOutcome, advice: string): never {
  const said =
    lastLine(outcome.stderr) === "" ? lastLine(outcome.stdout) : lastLine(outcome.stderr);
  throw networkError(summary, [
    said === "" ? "git reported no reason" : `git said: ${said}`,
    advice,
  ]);
}

/**
 * Clones a repository into the cache.
 *
 * `--mirror` rather than plain `--bare`, so the clone gets `remote.origin.fetch` and can be
 * updated later, with every tag and branch resolvable without a second network round trip.
 *
 * The clone lands beside its final location and is renamed on success, so an interrupted clone
 * never leaves a directory a later run would treat as a cache hit.
 *
 * @throws {AmbitError} exit 4 if the clone fails.
 */
async function clone(repo: string, request: GitFetchRequest): Promise<void> {
  const incoming = `${repo}${INCOMING_SUFFIX}`;
  await rm(incoming, { recursive: true, force: true });
  await mkdir(path.dirname(repo), { recursive: true });

  const outcome = await runGit(
    ["clone", "--mirror", "--quiet", "--", request.url, incoming],
    request,
  );
  if (!outcome.ok) {
    await rm(incoming, { recursive: true, force: true });
    gitFailed(
      `cannot clone ${request.subject} ${request.where}`,
      outcome,
      "check `source`, and that you can reach the repository",
    );
  }

  await rename(incoming, repo);
}

/**
 * Updates a cached clone.
 *
 * @throws {AmbitError} exit 4 if the fetch fails.
 */
async function fetchInto(repo: string, request: GitFetchRequest): Promise<void> {
  const outcome = await runGit(["-C", repo, "fetch", "--quiet", "--prune", "origin"], request);
  if (!outcome.ok) {
    gitFailed(
      `cannot fetch ${request.subject} ${request.where}`,
      outcome,
      "check `source`, and that you can reach the repository",
    );
  }
}

/**
 * Fetches the remote's refs into {@link PROBE_NAMESPACE}, leaving the clone's own refs alone.
 *
 * Fetched by URL rather than by `origin`. A mirror clone has `remote.origin.mirror = true`, so
 * `git fetch origin <probe refspec>` would apply the mirror's `+refs/*:refs/*` alongside the probe
 * refspecs and update `refs/heads/*` too. An anonymous remote has no configured refspec and no
 * mirror flag, so it fetches only what it is told.
 *
 * @throws {AmbitError} exit 4 if the fetch fails.
 */
async function probeInto(repo: string, request: GitFetchRequest): Promise<void> {
  const outcome = await runGit(
    [
      "-C",
      repo,
      "fetch",
      "--quiet",
      "--prune",
      // Without this, git also follows tags reachable from what it just fetched into
      // `refs/tags/*`, the clone's own namespace, which a probe must not touch.
      "--no-tags",
      "--",
      request.url,
      ...PROBE_REFSPECS,
    ],
    request,
  );
  if (!outcome.ok) {
    gitFailed(
      `cannot check ${request.subject} for updates ${request.where}`,
      outcome,
      "check `source`, and that you can reach the repository",
    );
  }
}

/** The commit a revision names in the cached clone, or `undefined` if the clone cannot name it. */
async function revParse(
  repo: string,
  revision: string,
  request: GitFetchRequest,
): Promise<string | undefined> {
  const outcome = await runGit(
    ["-C", repo, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    request,
  );
  if (!outcome.ok) return undefined;

  const commit = outcome.stdout.trim();
  return commit === "" ? undefined : commit;
}

/** The commit a ref names in the cached clone, or `undefined` if the clone does not have it. */
async function resolveCommit(
  repo: string,
  ref: string | undefined,
  request: GitFetchRequest,
): Promise<string | undefined> {
  // `HEAD` in a mirror is the remote's default branch, which is what an absent `ref` asks for.
  return revParse(repo, ref ?? "HEAD", request);
}

/** A ref resolved to a commit, and whether the ref it went through is one that can move. */
interface GitRefResolution {
  readonly commit: string;
  readonly moving: boolean;
}

/**
 * Resolves the request's ref against what a probe just fetched.
 *
 * Tries a branch, then a tag, then the ref taken literally as a commit, in the order that decides
 * {@link GitRefResolution.moving}. Only the literal candidate cannot move; a tag counts as moving
 * because a force-pushed tag can point elsewhere.
 *
 * The literal candidate is tried last because it also resolves against the clone's own refs, and
 * a stale `refs/heads/main` there would otherwise answer ahead of the current value the probe just
 * fetched.
 */
async function resolveProbed(
  repo: string,
  request: GitFetchRequest,
): Promise<GitRefResolution | undefined> {
  const ref = request.ref;
  const candidates: readonly (readonly [revision: string, moving: boolean])[] =
    ref === undefined
      ? [[`${PROBE_NAMESPACE}/HEAD`, true]]
      : [
          [`${PROBE_NAMESPACE}/heads/${ref}`, true],
          [`${PROBE_NAMESPACE}/tags/${ref}`, true],
          [ref, false],
        ];

  for (const [revision, moving] of candidates) {
    const commit = await revParse(repo, revision, request);
    if (commit !== undefined) return { commit, moving };
  }
  return undefined;
}

/**
 * Whether the request's ref can move, judged against the clone's own refs.
 *
 * The `advance` counterpart of {@link resolveProbed}'s ordering. Called only after a fetch, so the
 * branches and tags checked are the remote's current ones.
 */
async function isMovingRef(repo: string, request: GitFetchRequest): Promise<boolean> {
  const ref = request.ref;
  // An absent ref is the default branch, which is a branch.
  if (ref === undefined) return true;

  for (const namespace of ["refs/heads", "refs/tags"]) {
    if ((await revParse(repo, `${namespace}/${ref}`, request)) !== undefined) return true;
  }
  return false;
}

/**
 * Rejects a ref that git would read as something other than a revision.
 *
 * @throws {AmbitError} exit 2 for a ref that cannot name one.
 */
function assertUsableRef(request: GitFetchRequest): void {
  const ref = request.ref;
  if (ref === undefined) return;

  if (ref.trim() === "" || ref.startsWith("-") || /\s/.test(ref)) {
    throw configError(`${request.subject} has an unusable ref ${request.where}`, [
      `"${ref}" is not a tag, a branch, or a commit`,
      "quote the ref and write it exactly as the repository has it",
    ]);
  }
}

/**
 * Rejects a pin that is not a full commit SHA.
 *
 * The lock reader checks this first, with a message pointing at the file the pin was written in.
 * This is the backstop for every other caller. A string passing {@link isCommitSha} cannot be a
 * git option and cannot name a branch, so it can be handed to git without a `--` separator.
 *
 * @throws {AmbitError} exit 2 for a pin that is not one.
 */
function assertUsablePin(request: GitFetchRequest): void {
  const pin = request.pin;
  if (pin === undefined || isCommitSha(pin)) return;

  throw configError(`${request.subject} has an unusable pin ${request.where}`, [
    `"${pin}" is not a full commit SHA`,
    "delete `ambit.lock` and run `ambit install` again to write a correct one",
  ]);
}

/** The error for a ref the repository does not have, after a fetch has already been tried. */
function unknownRef(request: GitFetchRequest): never {
  const ref = request.ref;
  if (ref === undefined) {
    throw configError(`${request.subject} has no default branch ${request.where}`, [
      `${request.url} is empty, or its HEAD points at nothing`,
      "push a commit, or point `source` elsewhere",
    ]);
  }

  throw configError(`cannot resolve ref "${ref}" for ${request.subject} ${request.where}`, [
    `${request.url} has no branch, tag, or commit "${ref}"`,
    "correct `ref`, or omit it to take the default branch",
  ]);
}

/**
 * The error for a repository `--offline` would have had to clone.
 *
 * Exit 4, not 2: nothing here says the config is wrong. The source may be correct and reachable;
 * it is simply not in the cache yet.
 */
function notCached(request: GitFetchRequest, repo: string): never {
  throw networkError(`${request.subject} is not in the cache ${request.where}`, [
    `\`--offline\` was given, and ${request.url} has never been fetched into ${repo}`,
    "run the command again without `--offline` to fetch it",
  ]);
}

/**
 * The error for a refresh `--offline` forbids.
 *
 * Refuses rather than falling back to the cache: only the remote knows where a ref points now, so
 * a cached answer under `--offline` would be a stale commit reported as the current one.
 */
function cannotRefreshOffline(request: GitFetchRequest): never {
  throw networkError(`cannot check ${request.subject} for updates offline ${request.where}`, [
    "`--offline` forbids reaching the remote, and only the remote knows where a ref points now",
    "run the command again without `--offline`",
  ]);
}

/**
 * The error for a recorded commit the repository does not have.
 *
 * Exit 2, not a fallback to the ref: falling back would silently install a different commit than
 * the lock names, which is what a lock exists to prevent. Happens from a force-push that dropped
 * the commit, or a lock naming a commit that was never pushed; both are fixed by `ambit update`.
 */
function unknownPin(request: GitFetchRequest, pin: string): never {
  throw configError(`cannot find the locked commit for ${request.subject} ${request.where}`, [
    `\`ambit.lock\` pins ${pin}, and ${request.url} does not have it`,
    "run `ambit update` to pin the commit its `ref` names now, and commit the new lock",
  ]);
}

/** The error for a recorded commit that is not in the cache, which `--offline` may not fetch for. */
function pinNotCached(request: GitFetchRequest, pin: string): never {
  throw networkError(
    `cannot resolve the locked commit from the cache for ${request.subject} ${request.where}`,
    [
      `\`--offline\` was given, and the cached clone of ${request.url} does not have ${pin}`,
      "run the command again without `--offline` to fetch it",
    ],
  );
}

/** The error for a ref the cached clone cannot answer, which `--offline` may not fetch for. */
function refNotCached(request: GitFetchRequest): never {
  const ref = request.ref;
  const named = ref === undefined ? "the default branch" : `ref "${ref}"`;

  throw networkError(
    `cannot resolve ${named} from the cache for ${request.subject} ${request.where}`,
    [
      `\`--offline\` was given, and the cached clone of ${request.url} does not have it`,
      "run the command again without `--offline` to fetch it",
    ],
  );
}

/**
 * Resolves a recorded commit against the clone, fetching once if the clone does not have it.
 *
 * Ordinarily just a `rev-parse` with no network: ambit wrote this commit into the lock from a
 * clone it had. The fetch covers a warm clone missing it anyway: the project's first run on this
 * machine, or a teammate's push landing after this clone's last fetch.
 *
 * @param cloned whether the clone was made by this call, in which case it already reflects the
 *   remote's current state and a fetch would find nothing.
 * @throws {AmbitError} exit 4 if the fetch fails or `--offline` forbids it; exit 2 if the repository
 *   does not have the commit.
 */
async function pinnedCommit(
  repo: string,
  pin: string,
  cloned: boolean,
  request: GitFetchRequest,
): Promise<string> {
  let commit = await revParse(repo, pin, request);
  if (commit === undefined && !cloned) {
    if (request.offline === true) pinNotCached(request, pin);
    await fetchInto(repo, request);
    commit = await revParse(repo, pin, request);
  }
  if (commit === undefined) unknownPin(request, pin);
  return commit;
}

/**
 * Materializes one commit as a directory, reusing the checkout if a previous run made it.
 *
 * @throws {AmbitError} exit 4 if the checkout fails.
 */
async function ensureCheckout(
  cache: string,
  key: string,
  repo: string,
  commit: string,
  request: GitFetchRequest,
): Promise<string> {
  const target = path.join(cache, SOURCES_DIRNAME, key, commit);
  const ready = `${target}${READY_SUFFIX}`;

  if ((await isFile(ready)) && (await isDirectory(target))) return target;

  await rm(ready, { force: true });
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  // Clears the registration a half-finished or hand-deleted checkout left behind, which `add` would
  // otherwise refuse to write over.
  await runGit(["-C", repo, "worktree", "prune"], request);

  const outcome = await runGit(
    [
      "-C",
      repo,
      // A catalog installs the bytes that were committed, whatever line-ending conversion the
      // machine's git config would otherwise apply.
      "-c",
      "core.autocrlf=false",
      "worktree",
      "add",
      "--detach",
      "--quiet",
      "--force",
      target,
      commit,
    ],
    request,
  );
  if (!outcome.ok) {
    await rm(target, { recursive: true, force: true });
    gitFailed(
      `cannot check out ${commit} of ${request.subject} ${request.where}`,
      outcome,
      `delete ${cache} and run the command again`,
    );
  }

  // Written last: the marker is what a later run trusts, so it must mean the checkout is complete.
  await writeFile(ready, `${commit}\n`, "utf8");
  return target;
}

/**
 * Fetches a git source into the cache and returns the commit's checkout.
 *
 * A {@link GitFetchRequest.pin} short-circuits everything else: the recorded commit is checked out
 * and the ref is never resolved.
 *
 * Otherwise, under the default `refresh: "none"`, the clone is fetched only when it cannot resolve
 * the ref, so a second run over an unchanged config need not touch the network. `refresh: "advance"`
 * fetches into the clone's own refs, so later resolves see the result. `refresh: "probe"` fetches
 * into {@link PROBE_NAMESPACE}, which nothing else reads. Both ignore a pin, since both ask a
 * question a pin cannot answer.
 *
 * A probe still writes a checkout: checkouts are keyed by commit, so this adds a directory rather
 * than changing what any existing path means.
 *
 * @throws {AmbitError} exit 4 if git is missing, a clone/fetch/probe/checkout fails, or
 *   `--offline` was given and the cache cannot answer; exit 2 for a ref or a pinned commit the
 *   repository does not have.
 */
export async function fetchGitSource(request: GitFetchRequest): Promise<FetchedGitSource> {
  assertUsableRef(request);
  assertUsablePin(request);

  const refresh = request.refresh ?? "none";
  const offline = request.offline === true;
  if (offline && refresh !== "none") cannotRefreshOffline(request);

  const cache = cacheRoot(request.env);
  const key = gitCacheKey(request.url);
  const repo = path.join(cache, REPOS_DIRNAME, `${key}${GIT_SUFFIX}`);

  let cloned = false;
  if (!(await isDirectory(repo))) {
    if (offline) notCached(request, repo);
    await clone(repo, request);
    cloned = true;
  }

  // Only consulted when nothing is refreshing: a refreshing run was asked for a newer answer than
  // the recorded commit.
  const pin = refresh === "none" ? request.pin : undefined;
  if (pin !== undefined) {
    const commit = await pinnedCommit(repo, pin, cloned, request);
    return { root: await ensureCheckout(cache, key, repo, commit, request), commit };
  }

  if (refresh === "probe") {
    // Needed even right after a clone: the probe namespace is empty until fetched into.
    await probeInto(repo, request);
    const probed = await resolveProbed(repo, request);
    if (probed === undefined) unknownRef(request);
    return {
      root: await ensureCheckout(cache, key, repo, probed.commit, request),
      commit: probed.commit,
      moving: probed.moving,
    };
  }

  // A fresh clone is already the remote's current answer, so advancing it would fetch nothing.
  if (refresh === "advance" && !cloned) await fetchInto(repo, request);

  let commit = await resolveCommit(repo, request.ref, request);
  if (commit === undefined && !cloned && refresh !== "advance") {
    // Reported as a cache miss, not a config error: only a fetch can tell whether the ref is
    // simply unfetched or genuinely does not exist.
    if (offline) refNotCached(request);
    await fetchInto(repo, request);
    commit = await resolveCommit(repo, request.ref, request);
  }
  if (commit === undefined) unknownRef(request);

  const root = await ensureCheckout(cache, key, repo, commit, request);
  if (refresh === "none") return { root, commit };
  return { root, commit, moving: await isMovingRef(repo, request) };
}
