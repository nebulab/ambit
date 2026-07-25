/**
 * Source resolution (spec §3.1, §5): a `source` string, plus an optional `ref`, to a directory a
 * parser can read.
 *
 * Catalogs and `skills` entries carrying their own source share one grammar, so they share this
 * module: the formats are the ones people already type into other tools — `acme/skills`, a GitHub
 * URL, an ssh remote — plus two explicit prefixes for what shorthand cannot express. `path:` names a
 * directory; `git:` says "hand the rest to git verbatim", which is the escape hatch for any URL shape
 * ambit would otherwise have to guess about.
 *
 * A shorthand with no host means GitHub, because that is where catalogs live and `owner/repo` reads
 * as nothing else. Everything else is taken literally — ambit rewrites no URLs, so what a project
 * writes is what git is asked for.
 *
 * Fetching goes through the shared cache (spec §5) rather than into the project, so two projects on
 * one catalog fetch it once and neither owns it.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { configError } from "./errors.js";
import { fetchGitSource } from "./git.js";

/** The prefix marking a source as a local directory (spec §3.1). */
const PATH_PREFIX = "path:";

/** The prefix marking the remainder as a git URL, whatever its shape. */
const GIT_PREFIX = "git:";

/** Where a bare `owner/repo` shorthand resolves to. */
const GITHUB_HOST = "github.com";

/** `owner/repo`, optionally `@ref`. Neither part may hold an `@`, so the split is unambiguous. */
const SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:@(.+))?$/;

/** A scp-like git URL: `[user@]host:path`, the shape ssh remotes are written in. */
const SCP_LIKE = /^(?:[^@/]+@)?[^@/:]+:(?!\/)/;

/** A local directory, read in place. */
export interface PathSource {
  readonly kind: "path";
  /** As written after the prefix; relative paths are resolved against the project. */
  readonly directory: string;
}

/** A git repository, fetched into the cache. */
export interface GitSource {
  readonly kind: "git";
  /** The URL as git will receive it. */
  readonly url: string;
  /** Tag, branch, or commit. Absent means the repository's default branch. */
  readonly ref?: string;
}

export type Source = PathSource | GitSource;

/** One `source`/`ref` pair, and how to name it when something is wrong with it. */
export interface SourceRequest {
  readonly source: string;
  readonly ref?: string;
  /** How the thing being resolved is named in errors: `catalog "company"`. */
  readonly subject: string;
  /** The `(file line N)` suffix its config entry sits at. */
  readonly where: string;
}

/**
 * What resolving a source reads from outside its arguments.
 *
 * Passed rather than reached for, so the cache location is a function of the call and a test can
 * point it somewhere disposable (spec §7).
 */
export interface SourceContext {
  /** What a relative `path:` source, and a relative git URL, are resolved against. */
  readonly projectDir: string;
  /** Environment the cache location and git itself are read from. */
  readonly env: NodeJS.ProcessEnv;
}

/** A source resolved to a directory on disk. */
export interface ResolvedSource {
  /** Absolute path to the root of what was resolved. */
  readonly root: string;
  /** The commit a git source was pinned to. Absent for `path:`, which has no revision. */
  readonly commit?: string;
}

/** The error for two disagreeing refs, which ambit will not pick between (spec §6). */
function conflictingRefs(request: SourceRequest, inSource: string, declared: string): never {
  throw configError(`${request.subject} names two refs ${request.where}`, [
    `\`source\` ends with "@${inSource}" and \`ref\` says "${declared}"`,
    "drop one of the two, or make them agree",
  ]);
}

/** The ref a shorthand carried and the one the entry declared, once they are known to agree. */
function refOf(request: SourceRequest, inSource: string | undefined): string | undefined {
  if (inSource === undefined) return request.ref;
  if (request.ref !== undefined && request.ref !== inSource) {
    conflictingRefs(request, inSource, request.ref);
  }
  return inSource;
}

/** A git source with the ref attached only when there is one, per `exactOptionalPropertyTypes`. */
function gitSource(url: string, ref: string | undefined): GitSource {
  return { kind: "git", url, ...(ref !== undefined && { ref }) };
}

/**
 * Reads a `source` string as one of the formats spec §3.1 lists.
 *
 * Pure, and the only place the grammar lives: `ambit catalog`, `resolve`, and `install` all reach a
 * source through here, so a format works everywhere or nowhere.
 *
 * @throws {AmbitError} exit 2 for a source matching no format, an empty `path:`, an empty `git:`, or
 *   a `@ref` shorthand contradicting the entry's own `ref`.
 */
export function parseSource(request: SourceRequest): Source {
  const source = request.source;

  if (source.startsWith(PATH_PREFIX)) {
    const directory = source.slice(PATH_PREFIX.length);
    if (directory.trim() === "") {
      throw configError(`${request.subject} has an empty path source ${request.where}`, [
        `\`${source}\` names no directory`,
        "write the directory after the prefix, as `path:./dir`",
      ]);
    }
    return { kind: "path", directory };
  }

  if (source.startsWith(GIT_PREFIX)) {
    const url = source.slice(GIT_PREFIX.length);
    if (url.trim() === "") {
      throw configError(`${request.subject} has an empty git source ${request.where}`, [
        `\`${source}\` names no repository`,
        "write the URL after the prefix, as `git:ssh://host/owner/repo.git`",
      ]);
    }
    return gitSource(url, request.ref);
  }

  // Taken literally: a URL or an ssh remote is already exactly what git wants.
  if (source.includes("://") || SCP_LIKE.test(source)) return gitSource(source, request.ref);

  const shorthand = SHORTHAND.exec(source);
  if (shorthand !== null) {
    const [, owner, repo, inSource] = shorthand;
    if (owner !== undefined && repo !== undefined) {
      return gitSource(`https://${GITHUB_HOST}/${owner}/${repo}.git`, refOf(request, inSource));
    }
  }

  throw configError(`${request.subject} has an unrecognized source ${request.where}`, [
    `\`${source}\` matches none of the source formats ambit accepts`,
    "use owner/repo, a git URL, `git:<url>`, or `path:./dir`",
  ]);
}

/**
 * Resolves a `path:` source to the directory it names.
 *
 * @throws {AmbitError} exit 2 if the directory is not there.
 */
async function resolvePathRoot(
  source: PathSource,
  request: SourceRequest,
  context: SourceContext,
): Promise<string> {
  const root = path.resolve(context.projectDir, source.directory);

  try {
    if ((await stat(root)).isDirectory()) return root;
  } catch {
    // Reported below, together with the not-a-directory case: from the config's point of view they
    // are one mistake, and the fix is the same.
  }

  throw configError(`${request.subject} is not a directory ${request.where}`, [
    `${root} does not exist, or is not a directory`,
    "correct `source`, or create the directory",
  ]);
}

/**
 * Resolves a source to a directory on disk, fetching it if it is a git source.
 *
 * @throws {AmbitError} exit 2 for a source ambit cannot read, a missing directory, or an unknown
 *   ref; exit 4 if git is missing or a fetch fails.
 */
export async function resolveSource(
  request: SourceRequest,
  context: SourceContext,
): Promise<ResolvedSource> {
  const source = parseSource(request);

  if (source.kind === "path") {
    return { root: await resolvePathRoot(source, request, context) };
  }

  const fetched = await fetchGitSource({
    url: source.url,
    ...(source.ref !== undefined && { ref: source.ref }),
    subject: request.subject,
    where: request.where,
    env: context.env,
    cwd: context.projectDir,
  });
  return { root: fetched.root, commit: fetched.commit };
}
