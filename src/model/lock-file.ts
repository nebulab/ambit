/**
 * `ambit.lock` as a file ambit *reads*: where it lives, and the pins inside it.
 *
 * The writing half is `src/project/lock.ts`, which builds the document and renders its bytes. The split
 * is the layer each half belongs to. Rendering a lock needs a resolved bundle and its reasons, which is
 * project-level knowledge; reading a pin back out is something catalog loading has to do, so it lives
 * beside the loader that needs it and the lock's name and version live with it.
 *
 * **Why a lock is read at all.** A moving `ref:` used to be answered from the machine-wide git cache,
 * which refetches only when it cannot resolve a ref — so the commit a project got was whatever the
 * shared clone happened to hold: months old on a warm machine, current on a cold one, and moved under it
 * by any other project on the machine that ran `ambit update`. The lock recorded that faithfully and
 * could not prevent it, which made `--frozen` unsatisfiable for a project using `ref: main` at all: a
 * cold CI clone resolves `main` to today's commit and fails against a lock written last week.
 *
 * So the `catalogs` section is an input. Every other section stays a record, compared as bytes rather
 * than consumed — see `src/project/lock.ts`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectConfig } from "./config.js";
import { configError } from "../errors.js";
import { isCommitSha } from "./git.js";
import { parseSource } from "./sources.js";
import { parseYamlMapping } from "./yaml.js";

/** The lockfile's name, at the project root beside `ambit.yml`. */
export const LOCK_FILENAME = "ambit.lock";

/** The only lock version this build reads or writes. */
export const LOCK_VERSION = 1;

/** Where the lock lives for a project. */
export function lockFilePath(projectDir: string): string {
  return path.join(projectDir, LOCK_FILENAME);
}

/** Whether a filesystem error means the path simply is not there. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Reads a project's lock as text, returning undefined when there is none.
 *
 * Text, because that is what `--frozen` compares: a lock that would be rewritten *is* out of date,
 * whatever the two documents mean.
 *
 * @throws {AmbitError} exit 2 for a lock that exists but cannot be read — reported rather than
 *   treated as absent, since "there is no lock" and "your lock is unreadable" call for different
 *   fixes.
 */
export async function readLockText(projectDir: string): Promise<string | undefined> {
  const file = lockFilePath(projectDir);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw configError(`cannot read ${LOCK_FILENAME}`, [
      error instanceof Error ? error.message : String(error),
      `make ${file} readable, or delete it and run \`ambit install\` again`,
    ]);
  }
}

/** One `catalogs` entry as the lock recorded it: what it was resolved from, and what it resolved to. */
interface RecordedCatalog {
  /** The `source` as config wrote it when the commit was recorded. */
  readonly source: string;
  /** The `ref` as config wrote it, absent when the entry named none. */
  readonly ref?: string;
  /** The commit the ref resolved to. Absent for a `path:` source, which has no revision. */
  readonly commit?: string;
}

/** The error for a lock this build cannot read a pin out of. */
function unsupportedVersion(found: number): never {
  throw configError(`${LOCK_FILENAME} is version ${found}, which this build cannot read`, [
    `ambit resolves against the commits a lock records, and only version ${LOCK_VERSION} is a shape it knows`,
    `upgrade ambit, or delete ${LOCK_FILENAME} and run \`ambit install\` again`,
  ]);
}

/**
 * Reads the `catalogs` section back.
 *
 * Failures are fatal. A lock is an input now, so a version this build does not know and a document that
 * does not parse both mean "ambit cannot tell what this project is pinned to" — and answering that by
 * resolving as though there were no lock would reintroduce the silent drift the pins exist to remove.
 *
 * Unknown keys are deliberately *not* rejected, unlike everywhere else ambit parses YAML: only these
 * three are read, and a lock written by a later ambit that records a fourth should still pin correctly
 * rather than refuse to be read at all.
 *
 * @throws {AmbitError} exit 2 for an unreadable lock, a version this build cannot read, a malformed
 *   document, or a `commit` that is not a full SHA.
 */
async function readRecordedCatalogs(
  projectDir: string,
): Promise<ReadonlyMap<string, RecordedCatalog> | undefined> {
  const text = await readLockText(projectDir);
  if (text === undefined) return undefined;

  const root = parseYamlMapping(text, LOCK_FILENAME);
  const version = root.requireInteger("version");
  if (version !== LOCK_VERSION) unsupportedVersion(version);

  const catalogs = root.optionalMapping("catalogs");
  if (catalogs === undefined) return new Map();

  const recorded = new Map<string, RecordedCatalog>();
  for (const name of catalogs.keys()) {
    const entry = catalogs.requireMapping(name);
    const commit = entry.optionalString("commit");
    const ref = entry.optionalString("ref");
    // Refused here rather than left to git, so the message names the file the pin was hand-edited in.
    if (commit !== undefined && !isCommitSha(commit)) {
      throw entry.keyError(
        "commit",
        `catalog "${name}" is pinned to something that is not a commit`,
        [
          `"${commit}" is not a full commit SHA`,
          `delete ${LOCK_FILENAME} and run \`ambit install\` again to write a correct one`,
        ],
      );
    }
    recorded.set(name, {
      source: entry.requireString("source"),
      ...(ref !== undefined && { ref }),
      ...(commit !== undefined && { commit }),
    });
  }
  return recorded;
}

/**
 * What a `source`/`ref` pair *means*, as one comparable string — or nothing, if it means nothing here.
 *
 * Parsed rather than compared as written, because the question a pin's validity turns on is "is this
 * still the same repository at the same revision", and one repository has several spellings:
 * `acme/skills` and `https://github.com/acme/skills.git` are one source, as are a URL and its `git:`
 * form, and `acme/skills@v1` says what a separate `ref: v1` says. Comparing the strings would void a
 * good pin over a rewrite that changed nothing, sending the run to the network to rediscover the commit
 * it already had.
 *
 * A source that does not parse is not comparable, so its pin is void rather than honoured — as is a
 * `path:` source, which has no revision to pin in the first place. Nothing is thrown: the config's own
 * source is about to be parsed properly by the load that follows, which is where a bad one should be
 * reported, and a bad one in the *lock* is a pin to ignore rather than a project to stop.
 */
function gitIdentity(source: string, ref: string | undefined): string | undefined {
  try {
    const parsed = parseSource({
      source,
      ...(ref !== undefined && { ref }),
      subject: "",
      where: "",
    });
    return parsed.kind === "git" ? `${parsed.url} ${parsed.ref ?? ""}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit each configured catalog is pinned to, keyed by catalog name.
 *
 * Empty for a project with no lock, which is the case that has nothing to reproduce: every catalog then
 * resolves against its remote, since inheriting a shared clone's idea of `main` is not an answer this
 * project ever asked for.
 *
 * An entry survives only when the lock's `source` and `ref` still name the same repository and revision
 * `ambit.yml` does ({@link gitIdentity}), and only when it has a commit at all. The three ways it does
 * not:
 *
 * - **the config moved** — `ref:` was edited, or `source:` repointed. The recorded commit answers a
 *   question the project has stopped asking, so it is dropped and the new `ref` is resolved.
 * - **the catalog is new** — added since the lock was written, so there is nothing to reproduce and it
 *   resolves against its remote exactly as a first install's catalogs do.
 * - **`path:`** — no revision, so nothing to pin.
 *
 * @throws {AmbitError} exit 2 for a lock that exists and cannot be read — see
 *   {@link readRecordedCatalogs}.
 */
export async function readCatalogPins(
  projectDir: string,
  config: ProjectConfig,
): Promise<ReadonlyMap<string, string>> {
  const recorded = await readRecordedCatalogs(projectDir);
  if (recorded === undefined) return new Map();

  const pins = new Map<string, string>();
  for (const entry of config.catalogs) {
    const locked = recorded.get(entry.name);
    if (locked?.commit === undefined) continue;

    const configured = gitIdentity(entry.source, entry.ref);
    if (configured === undefined) continue;
    if (gitIdentity(locked.source, locked.ref) !== configured) continue;

    pins.set(entry.name, locked.commit);
  }
  return pins;
}
