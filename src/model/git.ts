/**
 * The git cache: bare clones under `$XDG_CACHE_HOME/ambit`, fetched on demand, plus one
 * checkout per commit so the catalog parser reads a git source exactly as it reads a directory.
 *
 * Three decisions here are load-bearing.
 *
 * **A cached clone is refetched only when it cannot answer the ref.** Fetching on every resolve
 * would let `ref: main` mean two different commits in two runs a minute apart, which is precisely
 * what determinism promises it will not do; and the reproducibility mechanism for a moving ref is the
 * lock, not the network. So the cache grows when it is asked something it does not know, and the way
 * to move a project forward is to change what it asks for.
 *
 * That is a claim about a *second* run, and it is the caller's job to notice when there has not been
 * a first: a project with no `ambit.lock` has no earlier resolution to agree with, so `install` asks
 * the remote rather than inheriting whatever commit some unrelated project last left in the shared
 * cache. See `unlockedRefresh` in `src/project/install.ts`.
 *
 * **A checkout is keyed by commit, never by ref.** Two projects pinned to different refs of one
 * repository share the clone without racing over a working tree, and a checkout that is already
 * there is byte-for-byte the one an earlier run produced.
 *
 * **The checkout is a `git worktree`,** because the alternative — piping `git archive` into `tar` —
 * would put a second tool on the required-PATH list, and only git may be on that list.
 *
 * **`--offline` refuses the clone and the fetch, and nothing else.** It is a promise about the
 * network rather than about the cache as a whole: a checkout ambit can produce from a clone it
 * already has is still an answer that came out of the cache, so a first offline run against a
 * warm clone is allowed to write one. What it may not do is reach for the remote — so both places
 * this module would have done that fail with exit 4 naming what the cache is missing.
 *
 * **Two commands are allowed to ask the remote anyway, and they ask differently.** `ambit update`
 * exists to move a pin forward, so it fetches into the clone's own refs and every later resolve sees
 * the new commit — that is the whole point of it. `ambit outdated` reports and changes nothing, so it
 * may not do that: a read-only command that left `ref: main` meaning a different commit would make
 * the *next* `install` move a pin nobody asked to move. It therefore fetches the remote's refs into
 * {@link PROBE_NAMESPACE}, which ref resolution never reads, and answers out of there. The two are
 * {@link RefreshMode}'s `"advance"` and `"probe"`; everything else resolves as it always has.
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
 * Where a probe puts what the remote says, inside the cached clone.
 *
 * Deliberately outside `refs/heads/` and `refs/tags/`, which is what makes a probe read-only in the
 * only sense that matters: {@link resolveCommit} resolves a project's `ref` against the clone's own
 * refs, so a namespace it never names cannot change what any later command installs. The refs are
 * kept rather than deleted afterwards because they are what stops git garbage-collecting the objects
 * a probed checkout is made of.
 */
export const PROBE_NAMESPACE = "refs/ambit/latest";

/**
 * What a probe fetches, and where it puts it.
 *
 * All three, every time: a `ref` may name a branch or a tag, an absent one means the remote's `HEAD`,
 * and which of the three answered is also how {@link GitRefResolution.moving} is decided.
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
 * Variables that would point git at the caller's repository instead of the cache.
 *
 * ambit is a plausible thing to run from a git hook or an alias, and all three of these are set in
 * that environment.
 */
const REDIRECTING_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/** A scp-like git URL — `git@github.com:acme/skills.git` — which is not a parseable URL. */
const SCP_LIKE = /^(?:[^@/]+@)?([^@/:]+):(?!\/)(.*)$/;

const execFileAsync = promisify(execFile);

/** One repository to fetch, and everything the errors and the cache need to know about it. */
export interface GitFetchRequest {
  /** The URL as git will receive it. */
  readonly url: string;
  /** Tag, branch, or commit. Absent means the repository's default branch. */
  readonly ref?: string;
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
   * Whether the `ref` this resolved through is one that can move: a branch, a tag, or the
   * repository's default branch. False for a `ref` naming a commit, which is already a pin.
   *
   * Absent under `refresh: "none"`, which is not a question that path asks — deciding it costs a
   * `rev-parse` nothing else needs, and answering it from a clone that may be arbitrarily stale
   * would be answering it wrong.
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
 * `https://github.com/acme/skills.git` share one clone — they are the same repository, and fetching
 * it twice under two names would be the kind of waste a cache exists to avoid.
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
  // A prompt for credentials on a non-interactive run is indistinguishable from a hang, so a
  // missing credential has to fail instead of asking.
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
 * Runs git, treating a non-zero exit as data: `rev-parse` failing is how ambit asks whether the
 * cache already knows a ref, so only a git that will not start at all is an error here.
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
 * `--mirror` rather than plain `--bare`: a bare clone gets no `remote.origin.fetch`, so it can never
 * be updated afterwards, and every tag and branch is what makes a later `ref:` resolvable without a
 * second network round trip.
 *
 * The clone lands beside its final location and is renamed on success, so an interrupted one leaves
 * no directory a later run would treat as a cache hit.
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
 * Addressed by **URL rather than by `origin`**, and that is the whole trick. A mirror clone carries
 * `remote.origin.mirror = true`, and git applies a mirror's `+refs/*:refs/*` alongside whatever
 * refspecs a fetch names — so `git fetch origin <probe refspec>` updates `refs/heads/*` too, which is
 * precisely what a probe must not do. An anonymous remote has no configured refspec and no mirror
 * flag, so it fetches exactly what it is told to.
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
      // Without it, git follows tags reachable from what it just fetched into `refs/tags/*` — the
      // clone's own namespace, which a probe may not touch.
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
 * The candidates are tried in the order that decides {@link GitRefResolution.moving}: a branch, then a
 * tag, then the ref taken literally. Only the last is a commit, and it is the only one that cannot
 * move — a tag is in the moving set because a force-pushed tag is a thing that happens, and a project
 * that would silently pick up its new contents deserves the same row a branch gets.
 *
 * The literal candidate resolves against the clone's own refs as well as the objects the probe
 * brought, which is why it comes last: a stale `refs/heads/main` would otherwise answer for a branch
 * the probe has a current value for.
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
 * Whether the request's ref is one that can move, judged against the clone's own refs.
 *
 * The `advance` counterpart of {@link resolveProbed}'s ordering, and asked only after a fetch, so the
 * branches and tags it looks at are the ones the remote has.
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
 * Exit 4 rather than 2: nothing here says the config is wrong. The source may well be correct and
 * reachable — it simply is not in the cache, which is a cache error, and the fix is a run that is
 * allowed to fetch.
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
 * Refusing rather than quietly falling back to the cache, because the fallback would answer the
 * question wrongly rather than not at all: only the remote knows where a branch points now, so a
 * cached answer under `--offline` is a stale commit reported as the current one.
 */
function cannotRefreshOffline(request: GitFetchRequest): never {
  throw networkError(`cannot check ${request.subject} for updates offline ${request.where}`, [
    "`--offline` forbids reaching the remote, and only the remote knows where a ref points now",
    "run the command again without `--offline`",
  ]);
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
 * Under the default `refresh: "none"` the clone is fetched only when the cache cannot resolve the
 * ref, so a second run over an unchanged config touches the network not at all. The two refreshing
 * modes are the module header's subject: `"advance"` fetches into the clone's own refs and every
 * later resolve follows, `"probe"` fetches into {@link PROBE_NAMESPACE} and nothing later can see it.
 *
 * A probe writes a checkout like any other resolve. That is not a contradiction with being read-only:
 * a checkout is keyed by commit, so it adds a directory rather than changing what any existing path
 * means, and the whole reason to probe is to read the catalog at the commit the remote now names.
 *
 * @throws {AmbitError} exit 4 if git is missing, a clone, fetch, probe, or checkout fails, or
 *   `--offline` was given and the cache cannot answer — including any refresh at all, which the
 *   cache by definition cannot answer; exit 2 for a ref the repository does not have.
 */
export async function fetchGitSource(request: GitFetchRequest): Promise<FetchedGitSource> {
  assertUsableRef(request);

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

  if (refresh === "probe") {
    // Even straight after a clone: the probe namespace is empty until something fetches into it, and
    // one redundant fetch of a repository already on disk is cheaper than a second resolution path.
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
    // Offline, an unresolvable ref is reported as the cache miss it is rather than as the config
    // error the online path would go on to prove it was: the clone has simply never been told
    // about it, and only a fetch could tell the two apart.
    if (offline) refNotCached(request);
    await fetchInto(repo, request);
    commit = await resolveCommit(repo, request.ref, request);
  }
  if (commit === undefined) unknownRef(request);

  const root = await ensureCheckout(cache, key, repo, commit, request);
  if (refresh === "none") return { root, commit };
  return { root, commit, moving: await isMovingRef(repo, request) };
}
