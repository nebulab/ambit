/**
 * `ambit.lock` — the resolution result, written so an install can be reproduced.
 *
 * This is the half that builds and writes the document. The half that reads it — where the file
 * lives, and the pins catalog loading resolves against — is `src/model/lock-file.ts`; the shared
 * constants live there and are re-exported here so a caller finds all of "the lock" in one place.
 *
 * The `catalogs` section is an input; every other section is a record. `--frozen` compares the lock
 * as text, so a file that would be rewritten is out of date regardless of what the two documents
 * mean. The one exception is `commit` under `catalogs`: `readCatalogPins` reads it back and
 * resolution goes to that commit, so it must be true, not just byte-equal.
 *
 * A pin is void once the config it was resolved from changes. Each entry records the `source` and
 * `ref` its commit came from, so a reader can tell a pin worth honoring from a stale one. Editing
 * `ref:` invalidates the pin as it always did.
 *
 * Byte-stability is the contract for everything written here: emit through {@link emitYaml}, and
 * hold nothing a second run could disagree about (no timestamps, no absolute paths, no cache
 * locations, a commit only where a source actually has one). Every value is machine-independent so
 * a committed lock stays shared across a team; a path into someone's local cache would make it
 * per-machine and produce a diff on every developer's first install.
 */
import { writeFile } from "node:fs/promises";

import type { Catalog } from "../model/catalog.js";
import { driftError } from "../errors.js";
import { LOCK_FILENAME, LOCK_VERSION, lockFilePath, readLockText } from "../model/lock-file.js";
import type { Bundle } from "../resolution/resolve.js";
import { formatReason, reasonOf } from "../resolution/resolve.js";
import { emitYaml } from "../model/yaml.js";

export {
  LOCK_FILENAME,
  LOCK_VERSION,
  lockFilePath,
  readCatalogPins,
  readLockText,
} from "../model/lock-file.js";

/** One configured catalog, pinned. */
export interface LockCatalog {
  /** The `source` as config wrote it. */
  readonly source: string;
  /** The `ref` as config wrote it, absent when the entry named none. */
  readonly ref?: string;
  /** The commit the ref resolved to. Absent for a `path:` source, which has no revision. */
  readonly commit?: string;
}

/**
 * One selected pack, explained.
 *
 * No `path` and no `commit`: a pack materializes nothing and ships no bytes. It is recorded because
 * the reason line on every skill, server, and hook it pulled in names it, and those reasons need
 * something in the lock to resolve against.
 */
export interface LockPack {
  /** The catalog it came from. */
  readonly catalog: string;
  /** Why it is in the bundle, in `--explain`'s short form. */
  readonly reason: string;
}

/** One selected skill, pinned and explained. */
export interface LockSkill {
  /** The catalog it came from. */
  readonly catalog: string;
  /** Its directory within that source, `/`-separated. */
  readonly path: string;
  /** The commit those bytes came from, when the source has one. */
  readonly commit?: string;
  /** Why it is in the bundle, in `--explain`'s short form. */
  readonly reason: string;
}

/**
 * One selected MCP server, explained.
 *
 * No `commit`, deliberately: a server is a handful of config values rather than a tree of files, so
 * the catalog entry's commit already says everything a reader could act on.
 */
export interface LockMcp {
  /** The catalog it came from. */
  readonly catalog: string;
  /** Why it is in the bundle, in `--explain`'s short form. */
  readonly reason: string;
}

/**
 * One selected hook, explained — and pinned when it ships bytes.
 *
 * A hook is config values rendered into a harness file, or — when its `command` names a script the
 * hook's directory ships — also a tree of files to materialize. `path` and `commit` appear only in
 * the second case, the same reason {@link LockSkill} carries them and {@link LockMcp} does not. A
 * hook whose command is a command line takes {@link LockMcp}'s shape instead.
 *
 * `path` is the hook's directory within its source, like {@link LockSkill.path}. It is never the
 * command ambit writes into a harness file, since that command is rewritten per harness and is not
 * one value the lock could hold.
 */
export interface LockHook {
  /** The catalog it came from. */
  readonly catalog: string;
  /** Its directory within that source, `/`-separated. Present only when it ships a script. */
  readonly path?: string;
  /** The commit those bytes came from, when the source has one. */
  readonly commit?: string;
  /** Why it is in the bundle, in `--explain`'s short form. */
  readonly reason: string;
}

/**
 * A lock document.
 *
 * The five sections are keyed maps, not lists: a name is the identity of everything in them, and a
 * map makes a diff show one changed entry instead of a reordered list.
 */
export interface Lock {
  readonly version: number;
  /** Every configured catalog, not only those that contributed to the bundle. */
  readonly catalogs: Readonly<Record<string, LockCatalog>>;
  readonly packs: Readonly<Record<string, LockPack>>;
  readonly skills: Readonly<Record<string, LockSkill>>;
  readonly mcps: Readonly<Record<string, LockMcp>>;
  readonly hooks: Readonly<Record<string, LockHook>>;
}

/**
 * A name-keyed record. Insertion order is irrelevant — emission sorts keys — so this
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
 * Pure: what the lock says is a function of what resolution decided, so a test can compare two locks
 * without touching disk.
 *
 * Every configured catalog is listed, even one that contributed nothing to this bundle. The lock
 * pins the inputs, and a catalog whose commit moves changes what a later resolve selects even though
 * today's bundle never named it.
 *
 * @param catalogs the loaded catalogs, in config order.
 * @param bundle the resolved bundle, whose reasons the lock records.
 * @throws {AmbitError} exit 1 if the bundle cannot account for one of its own items — a bug, not
 *   anything a catalog can cause.
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
    packs: byName(
      bundle.packs,
      (pack) => pack.name,
      (pack) => ({
        catalog: pack.catalog,
        reason: formatReason(reasonOf(bundle, { kind: "pack", name: pack.name })),
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
    hooks: byName(
      bundle.hooks,
      (hook) => hook.name,
      (hook) => ({
        catalog: hook.catalog,
        // A hook with no script has no bytes to pin, so it records neither path nor commit — see
        // LockHook.
        ...(hook.type === "script" && { path: hook.path }),
        ...(hook.type === "script" && hook.commit !== undefined && { commit: hook.commit }),
        reason: formatReason(reasonOf(bundle, { kind: "hook", name: hook.name })),
      }),
    ),
  };
}

/**
 * Renders a lock as the bytes written to disk.
 *
 * Empty sections are emitted as empty maps, not omitted, so a project that loses its last MCP server
 * shows `mcps: {}` in the diff instead of a vanished key.
 */
export function serializeLock(lock: Lock): string {
  return emitYaml(lock);
}

/** Writes a project's lock. */
export async function writeLockText(projectDir: string, text: string): Promise<void> {
  await writeFile(lockFilePath(projectDir), text, "utf8");
}

/**
 * Asserts that the lock on disk is exactly what resolution would write — the check `--frozen` is.
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
