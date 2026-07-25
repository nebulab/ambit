/**
 * `ambit.lock` — the resolution result, written so an install can be reproduced (spec §3.5).
 *
 * The lock is a *record*, not an input: nothing here feeds back into resolution, which is why it
 * needs no parser. Its two jobs are both comparisons — a human diffing what changed between two
 * commits, and `--frozen` asking whether a committed lock is still current — and both are served by
 * bytes. So the lock is compared as text rather than as a parsed document: a file that would be
 * rewritten *is* out of date, whatever the two documents mean.
 *
 * That makes byte-stability the whole contract (spec §3.0), and it is bought by emitting through
 * {@link emitYaml} and by holding nothing a second run could disagree about: no timestamps, no
 * absolute paths, no cache locations, and a commit only where a source actually has one.
 *
 * Every value in it is machine-independent on purpose. A lock is committed by teams who want
 * reproducible installs (spec §3.5), so a path into someone's cache would turn a shared file into a
 * per-machine one and produce a diff on every developer's first install.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Catalog } from "./catalog.js";
import { configError, driftError } from "./errors.js";
import type { Bundle } from "./resolve.js";
import { formatReason, reasonOf } from "./resolve.js";
import { emitYaml } from "./yaml.js";

/** The lockfile's name, at the project root beside `ambit.yml`. */
export const LOCK_FILENAME = "ambit.lock";

/** The only lock version this build writes. */
export const LOCK_VERSION = 1;

/** One configured catalog, pinned. */
export interface LockCatalog {
  /** The `source` as config wrote it. */
  readonly source: string;
  /** The `ref` as config wrote it, absent when the entry named none. */
  readonly ref?: string;
  /** The commit the ref resolved to. Absent for a `path:` source, which has no revision. */
  readonly commit?: string;
}

/** One selected skill, pinned and explained. */
export interface LockSkill {
  /** Where it came from: a catalog name, or the `source` a config-declared skill named. */
  readonly catalog: string;
  /** Its directory within that source, `/`-separated. */
  readonly path: string;
  /** The commit those bytes came from, when the source has one. */
  readonly commit?: string;
  /** Why it is in the bundle, in `--explain`'s short form (spec §6). */
  readonly reason: string;
}

/**
 * One selected MCP server, explained.
 *
 * No `commit`, deliberately: a server is a handful of config values rather than a tree of files, so
 * the catalog entry's commit already says everything a reader could act on — and an inline `mcps`
 * entry (spec §3.1) comes from `ambit.yml` itself, which has no revision to record.
 */
export interface LockMcp {
  /** Where it came from: a catalog name, or the config file that declared it inline. */
  readonly catalog: string;
  /** Why it is in the bundle, in `--explain`'s short form (spec §6). */
  readonly reason: string;
}

/**
 * A lock document.
 *
 * The three sections are keyed maps rather than lists, matching spec §3.5, because a name is the
 * identity of everything in them — and because a map is what makes a diff show one changed entry
 * instead of a reordered list.
 */
export interface Lock {
  readonly version: number;
  /** Every configured catalog, not only those that contributed to the bundle. */
  readonly catalogs: Readonly<Record<string, LockCatalog>>;
  readonly skills: Readonly<Record<string, LockSkill>>;
  readonly mcps: Readonly<Record<string, LockMcp>>;
}

/**
 * A name-keyed record. Insertion order is irrelevant — emission sorts keys (spec §3.0) — so this
 * exists only to keep the entries typed rather than to fix an order.
 */
function byName<T, V>(
  items: readonly T[],
  name: (item: T) => string,
  value: (item: T) => V,
): Readonly<Record<string, V>> {
  const record: Record<string, V> = {};
  for (const item of items) record[name(item)] = value(item);
  return record;
}

/**
 * Builds the lock for a resolved project.
 *
 * Pure, so what the lock says is a function of what resolution decided and nothing else — and so a
 * test can compare two locks without touching disk.
 *
 * Every configured catalog is listed, including one that contributed nothing to this bundle: the
 * lock pins the *inputs*, and a catalog whose commit moves changes what a later resolve selects even
 * though today's bundle never named it.
 *
 * @param catalogs the loaded catalogs, in config order.
 * @param bundle the resolved bundle, whose reasons the lock records.
 * @throws {AmbitError} exit 1 if the bundle cannot account for one of its own items, which is a bug
 *   rather than anything a catalog can cause.
 */
export function buildLock(catalogs: readonly Catalog[], bundle: Bundle): Lock {
  return {
    version: LOCK_VERSION,
    catalogs: byName(
      catalogs,
      (catalog) => catalog.name,
      (catalog) => ({
        source: catalog.source,
        ...(catalog.ref !== undefined && { ref: catalog.ref }),
        ...(catalog.commit !== undefined && { commit: catalog.commit }),
      }),
    ),
    skills: byName(
      bundle.skills,
      (skill) => skill.name,
      (skill) => ({
        catalog: skill.catalog,
        path: skill.path,
        ...(skill.commit !== undefined && { commit: skill.commit }),
        reason: formatReason(reasonOf(bundle, { kind: "skill", name: skill.name })),
      }),
    ),
    mcps: byName(
      bundle.mcps,
      (mcp) => mcp.name,
      (mcp) => ({
        catalog: mcp.catalog,
        reason: formatReason(reasonOf(bundle, { kind: "mcp", name: mcp.name })),
      }),
    ),
  };
}

/**
 * Renders a lock as the bytes written to disk.
 *
 * Empty sections are emitted as empty maps rather than omitted, so the document's shape is the same
 * whatever a project resolves to: a project that loses its last MCP server should show `mcps: {}`
 * in the diff, not a vanished key a reader has to notice the absence of.
 */
export function serializeLock(lock: Lock): string {
  return emitYaml(lock);
}

/** Where the lock lives for a project. */
export function lockFilePath(projectDir: string): string {
  return path.join(projectDir, LOCK_FILENAME);
}

/** Whether a filesystem error means the path simply is not there. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Reads a project's lock as text, returning undefined when there is none.
 *
 * Text rather than a parsed document because that is all any caller needs: the lock is compared,
 * never consumed.
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

/** Writes a project's lock. */
export async function writeLockText(projectDir: string, text: string): Promise<void> {
  await writeFile(lockFilePath(projectDir), text, "utf8");
}

/**
 * Asserts that the lock on disk is exactly what resolution would write — the check `--frozen` is
 * (spec §6).
 *
 * Called before anything is materialized, so a CI run that fails this leaves the project untouched.
 *
 * @param expected the serialized lock resolution produced.
 * @throws {AmbitError} exit 5 when the project has no lock, or has one that differs.
 */
export async function assertLockCurrent(projectDir: string, expected: string): Promise<void> {
  const actual = await readLockText(projectDir);
  if (actual === expected) return;

  throw driftError(`${LOCK_FILENAME} is out of date`, [
    actual === undefined
      ? `\`--frozen\` compares against a committed lock, and ${projectDir} has no ${LOCK_FILENAME}`
      : `resolving this project produces a different ${LOCK_FILENAME} than the one on disk`,
    "run `ambit install` without `--frozen`, then commit the result",
  ]);
}
