/**
 * Comparing two bundles — what `ambit outdated` and `ambit update` report instead of two commit SHAs.
 *
 * `resolveBundle` is pure over `(config, mergedCatalog)`, so a project's catalogs can be resolved at
 * two different commits in one process and the two bundles compared directly. That is what makes the
 * report about *capabilities*: the useful question on an update is never "which commit" but "what new
 * thing will run in my session", and a SHA cannot answer it while a list of gained skills, changed
 * servers and added hooks can.
 *
 * Three things follow from that framing.
 *
 * **A moved commit is not a change.** A catalog whose branch advanced past a hundred commits that
 * touched nothing this project selects produces an empty diff, and that is the correct report. So
 * nothing here reads a commit: an item is compared against its counterpart by what it declares and by
 * the bytes it ships, and a catalog's SHA belongs to the row above.
 *
 * **A declared difference outranks a byte difference.** `description changed` and `requires changed`
 * both also change a `SKILL.md`'s bytes, and naming the field is strictly more useful than naming the
 * file — so fields are compared first and content is what is left when none of them moved.
 *
 * **The comparison is of the *merged* item, not of the catalog's copy.** Two bundles can differ
 * because a name moved between catalogs, or because a skill is now reached through a pack rather
 * than through an entry of the project's own; both are real changes to what the project got, so
 * `catalog` and the selection reason are compared alongside everything an entity declares.
 *
 * This is deliberately not what {@link assertLockCurrent} does. `--frozen` compares the lock as bytes
 * and must keep doing so — `src/project/lock.ts` argues that case, and a human-facing diff learning to
 * read structure changes nothing about it.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { MergedHook, MergedMcp, MergedPack, MergedSkill } from "../model/catalog.js";
import { hookCommand } from "../model/catalog.js";
import { SHARED_HOOKS_DIR } from "../harness/profile.js";
import type { McpTransport } from "../model/mcp-entity.js";
import type { Bundle, BundleItem, ItemKind } from "../resolution/resolve.js";
import { formatReason, reasonOf } from "../resolution/resolve.js";

/**
 * What happened to one name between two bundles.
 *
 * Three states rather than the five `status` reports, because this compares two resolutions of the
 * same project rather than a resolution against a disk: there is no ownership to have an opinion
 * about and nothing to be missing.
 */
export const BUNDLE_CHANGE_KINDS = ["added", "changed", "removed"] as const;

export type BundleChangeKind = (typeof BUNDLE_CHANGE_KINDS)[number];

/** One item that entered, left, or changed. */
export interface BundleChange {
  readonly kind: ItemKind;
  readonly name: string;
  readonly change: BundleChangeKind;
  /**
   * One line a reader can act on: why it is here now, why it was here, or what about it moved.
   *
   * Never empty. A row saying only that something changed sends the reader to `git log`, which is the
   * thing this report exists to replace.
   */
  readonly detail: string;
}

/** Two bundles compared, one list per namespace, each sorted by name. */
export interface BundleDiff {
  readonly packs: readonly BundleChange[];
  readonly skills: readonly BundleChange[];
  readonly mcps: readonly BundleChange[];
  readonly hooks: readonly BundleChange[];
}

/** How many of each kind one list holds — the `+2 ~1 -0` a report puts beside a namespace. */
export interface BundleChangeCounts {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
}

/** Every change across the four namespaces, in the order a report prints them. */
export function allChanges(diff: BundleDiff): readonly BundleChange[] {
  return [...diff.packs, ...diff.skills, ...diff.mcps, ...diff.hooks];
}

/** Whether the two bundles are the same bundle — the answer a report leads with. */
export function isUnchanged(diff: BundleDiff): boolean {
  return allChanges(diff).length === 0;
}

export function countChanges(changes: readonly BundleChange[]): BundleChangeCounts {
  return {
    added: changes.filter((change) => change.change === "added").length,
    changed: changes.filter((change) => change.change === "changed").length,
    removed: changes.filter((change) => change.change === "removed").length,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A JSON-shaped projection of an item: what {@link firstFieldDifference} walks. */
type Comparable = Readonly<Record<string, unknown>>;

/**
 * The transport as the entity's own document writes it, so a difference reads `transport.http.url`
 * rather than `transport.url`.
 *
 * A reader who is told a field moved goes and looks at the file, and the path they are given should be
 * the path that file has. The kind key is what carries that, and it is also the discriminator — so a
 * server that changed from stdio to http differs at `transport` itself, which is the right altitude
 * for that answer.
 */
function transportShape(transport: McpTransport): Comparable {
  return transport.kind === "stdio"
    ? { stdio: { args: transport.args, command: transport.command } }
    : { http: { headers: transport.headers, url: transport.url } };
}

/**
 * Whether two values a projection can hold are the same value.
 *
 * Arrays compare whole. An index is not a field name, and `env[1] changed` tells a reader less than
 * `env changed` does while sounding more precise than it is.
 */
function sameValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

/**
 * Whether a value is one the walk descends into: a plain object, whose keys are field names.
 *
 * An array is not, per {@link sameValue}, and neither is a `Requirement` inside one — a `requires`
 * list differs as a list.
 */
function isRecord(value: unknown): value is Comparable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The dotted path of the first field two projections disagree about, or undefined when they agree.
 *
 * First in sorted key order rather than first in declaration order, so the same pair of items always
 * reports the same field — the determinism rule the whole output surface is held to.
 */
function firstFieldDifference(
  before: Comparable,
  after: Comparable,
  prefix = "",
): string | undefined {
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compare)) {
    const left = before[key];
    const right = after[key];
    if (sameValue(left, right)) continue;

    const at = prefix === "" ? key : `${prefix}.${key}`;
    // Both sides present and both records: the disagreement is somewhere inside, and naming the
    // innermost field is the whole point. One side absent is a difference at this level.
    if (isRecord(left) && isRecord(right)) return firstFieldDifference(left, right, at);
    return at;
  }
  return undefined;
}

/**
 * What a pack declares, as one comparable record.
 *
 * `requires` is the whole of what a pack does, so a pack whose membership moved reports
 * `requires changed` — which is the one thing a reader wants to know about an update to a group they
 * take wholesale. What it grew or lost shows up as its own rows in the other three sections.
 */
function packShape(pack: MergedPack, reason: string): Comparable {
  return {
    catalog: pack.catalog,
    description: pack.description ?? null,
    reason,
    requires: pack.requires,
  };
}

/** What a skill declares, as one comparable record. */
function skillShape(skill: MergedSkill, reason: string): Comparable {
  return {
    catalog: skill.catalog,
    description: skill.description ?? null,
    expects: skill.expects,
    reason,
    requires: skill.requires,
  };
}

/** What a server declares, as one comparable record. */
function mcpShape(mcp: MergedMcp, reason: string): Comparable {
  return {
    catalog: mcp.catalog,
    expects: mcp.expects,
    reason,
    transport: transportShape(mcp.transport),
  };
}

/** What a hook declares, as one comparable record. */
function hookShape(hook: MergedHook, reason: string): Comparable {
  return {
    catalog: hook.catalog,
    command: hook.command,
    description: hook.description ?? null,
    event: hook.event,
    expects: hook.expects,
    matcher: hook.matcher ?? null,
    reason,
    timeout: hook.timeout ?? null,
    type: hook.type,
  };
}

/**
 * What the three namespaces have in common: a name, and — for the two kinds that can ship bytes —
 * where those bytes are.
 *
 * The two locating fields are optional here and required on {@link MergedSkill} and {@link MergedHook},
 * which is what lets one comparison serve a skill and a hook — each a directory — and a server, which
 * is a document and nothing else.
 */
interface BundleEntity {
  readonly name: string;
  readonly catalogRoot?: string;
  readonly path?: string;
}

/**
 * The directory an item's bytes live in, or undefined when it has none.
 *
 * A server is the one kind that has none: it is a handful of config values in a document, and every
 * one of them is already compared as a field.
 */
function bytesDirectory(item: BundleEntity): string | undefined {
  if (item.catalogRoot === undefined || item.path === undefined) return undefined;
  return path.join(item.catalogRoot, item.path);
}

/** Every file under `dir`, relative, `/`-separated and sorted, or undefined when it cannot be read. */
async function fileList(dir: string): Promise<readonly string[] | undefined> {
  const found: string[] = [];

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), within);
      else found.push(within);
    }
  };

  try {
    await walk(dir, "");
  } catch {
    return undefined;
  }
  return found.sort(compare);
}

/**
 * Whether two directories hold the same files with the same bytes.
 *
 * A tree that cannot be read counts as differing rather than as an error, exactly as `status` treats
 * an unreadable file: "this is no longer what the catalog shipped" is true either way, and a report of
 * what an update would bring is not the place to fail over a permission problem.
 */
async function sameTree(before: string, after: string): Promise<boolean> {
  if (before === after) return true;

  const [left, right] = await Promise.all([fileList(before), fileList(after)]);
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length || left.some((file, index) => file !== right[index])) {
    return false;
  }

  for (const relative of left) {
    try {
      const [a, b] = await Promise.all([
        readFile(path.join(before, relative)),
        readFile(path.join(after, relative)),
      ]);
      if (!a.equals(b)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * How a hook reads in a report: the event it fires on, what filters it, and what it will run.
 *
 * The command as a *harness* will receive it, so a hook shipping a script names the installed path
 * rather than the catalog-relative filename the author wrote — the whole question a reader has about a
 * hook arriving in their project is what is about to execute in their session, and the answer is the
 * string that lands in the harness's config file.
 */
export function hookSummary(hook: MergedHook): string {
  const matched = hook.matcher === undefined ? "" : ` ${hook.matcher}`;
  return `${hook.event}${matched} — runs ${hookCommand(hook, SHARED_HOOKS_DIR)}`;
}

/** What one namespace's comparison needs to know about the kind it is comparing. */
interface Namespace<T extends BundleEntity> {
  readonly kind: ItemKind;
  readonly before: readonly T[];
  readonly after: readonly T[];
  /** The comparable projection of one item, given the reason its own bundle gives for it. */
  readonly shape: (item: T, reason: string) => Comparable;
  /** How an arriving item introduces itself. Defaults to the reason it was selected for. */
  readonly arrival?: (item: T) => string;
}

/**
 * One namespace compared.
 *
 * The three lists are built from the union of both sides' names, sorted, so the report is a function
 * of the two bundles rather than of the order either was assembled in.
 */
async function diffNamespace<T extends BundleEntity>(
  namespace: Namespace<T>,
  before: Bundle,
  after: Bundle,
): Promise<readonly BundleChange[]> {
  const was = new Map(namespace.before.map((item) => [item.name, item]));
  const is = new Map(namespace.after.map((item) => [item.name, item]));
  const changes: BundleChange[] = [];

  for (const name of [...new Set([...was.keys(), ...is.keys()])].sort(compare)) {
    const item: BundleItem = { kind: namespace.kind, name };
    const left = was.get(name);
    const right = is.get(name);

    if (left === undefined && right !== undefined) {
      changes.push({
        kind: namespace.kind,
        name,
        change: "added",
        detail: namespace.arrival?.(right) ?? formatReason(reasonOf(after, item)),
      });
      continue;
    }
    if (right === undefined && left !== undefined) {
      changes.push({
        kind: namespace.kind,
        name,
        change: "removed",
        // Why it *was* there. The row's own marker carries the tense, and the reason is the thing a
        // reader has to check against their config to decide whether losing it was intended.
        detail: `was ${formatReason(reasonOf(before, item))}`,
      });
      continue;
    }
    if (left === undefined || right === undefined) continue;

    const field = firstFieldDifference(
      namespace.shape(left, formatReason(reasonOf(before, item))),
      namespace.shape(right, formatReason(reasonOf(after, item))),
    );
    if (field !== undefined) {
      changes.push({ kind: namespace.kind, name, change: "changed", detail: `${field} changed` });
      continue;
    }

    const from = bytesDirectory(left);
    const to = bytesDirectory(right);
    if (from !== undefined && to !== undefined && !(await sameTree(from, to))) {
      changes.push({
        kind: namespace.kind,
        name,
        change: "changed",
        // Named for what the item *is*: a skill is a directory of instructions, a hook that ships
        // bytes is a script, and a reader going to look at one is going somewhere different.
        detail: namespace.kind === "hook" ? "script changed" : "content changed",
      });
    }
  }

  return changes;
}

/**
 * Compares two resolutions of one project.
 *
 * Asynchronous only because of the byte comparison: everything a report needs beyond "did the files
 * change" is already in the two bundles, and would be pure.
 *
 * @param before the bundle the project resolves to now.
 * @param after the bundle it would resolve to with the pins moved.
 */
export async function diffBundles(before: Bundle, after: Bundle): Promise<BundleDiff> {
  return {
    packs: await diffNamespace<MergedPack>(
      { kind: "pack", before: before.packs, after: after.packs, shape: packShape },
      before,
      after,
    ),
    skills: await diffNamespace<MergedSkill>(
      { kind: "skill", before: before.skills, after: after.skills, shape: skillShape },
      before,
      after,
    ),
    mcps: await diffNamespace<MergedMcp>(
      { kind: "mcp", before: before.mcps, after: after.mcps, shape: mcpShape },
      before,
      after,
    ),
    hooks: await diffNamespace<MergedHook>(
      {
        kind: "hook",
        before: before.hooks,
        after: after.hooks,
        shape: hookShape,
        // The exception to "an arriving item names its reason": a hook is the one kind whose arrival
        // means something starts executing, so it says what.
        arrival: hookSummary,
      },
      before,
      after,
    ),
  };
}
