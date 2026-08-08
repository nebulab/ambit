/**
 * How `outdated` and `update` render where a pin stands and what moving it changes.
 *
 * `outdated` and `update` print the same report (`update` adds what the install then did), so the
 * projections live here once rather than in each command.
 *
 * The commit column is abbreviated: a full pair of forty-hex strings pushes everything worth reading
 * off the line, and `ambit.lock` already holds the exact commits for anyone who needs them.
 */
import type { BundleChange, BundleDiff } from "../../project/bundle-diff.js";
import { countChanges } from "../../project/bundle-diff.js";
import type { CatalogPin } from "../../project/update.js";
import { keyed, section } from "../output.js";

/** Stands in for a column a `path:` catalog has nothing to put in: it has no revision. */
const NO_COMMIT = "-";

/** How many hex characters of a commit a report shows — git's own conventional abbreviation. */
const ABBREVIATED = 7;

/** The marker column, so a reader scans one character rather than reading a word three times. */
const MARKER: Readonly<Record<BundleChange["change"], string>> = {
  added: "+",
  changed: "~",
  removed: "-",
};

function abbreviate(commit: string): string {
  return commit.slice(0, ABBREVIATED);
}

/**
 * Where a pin stands, in one cell: the commit, or the move it would make.
 *
 * A catalog that has not moved shows one commit rather than the same one twice: the arrow means
 * change, so printing it where nothing changed would make every row look like one.
 */
function transitionOf(pin: CatalogPin): string {
  if (pin.commit === undefined) return NO_COMMIT;
  if (pin.latest === undefined || pin.latest === pin.commit) return abbreviate(pin.commit);
  return `${abbreviate(pin.commit)} → ${abbreviate(pin.latest)}`;
}

/** One row per configured catalog: its name, where it stands, and the commit or the move. */
export function pinRows(pins: readonly CatalogPin[]): readonly (readonly string[])[] {
  return pins.map((pin) => [pin.name, pin.freshness, transitionOf(pin)]);
}

/**
 * Every pin as a name-keyed JSON record.
 *
 * Full commits here, unlike the text form: a consumer comparing this against `ambit.lock` needs the
 * exact value the lock holds.
 */
export function pinJson(pins: readonly CatalogPin[]): Readonly<Record<string, unknown>> {
  return keyed(
    pins,
    (pin) => pin.name,
    (pin) => ({
      ...(pin.commit !== undefined && { commit: pin.commit }),
      freshness: pin.freshness,
      ...(pin.latest !== undefined && { latest: pin.latest }),
      ...(pin.ref !== undefined && { ref: pin.ref }),
      source: pin.source,
    }),
  );
}

/** One row per change: what happened, to what, and the one line a reader can act on. */
function changeRows(changes: readonly BundleChange[]): readonly (readonly string[])[] {
  return changes.map((change) => [MARKER[change.change], change.name, change.detail]);
}

/**
 * One namespace's changes as JSON records, in the order the text form lists them.
 *
 * A list rather than a name-keyed map, unlike everything else ambit emits: the counts are what a
 * consumer reads first, and a map would make them count keys by hand.
 */
function changeJson(changes: readonly BundleChange[]): Readonly<Record<string, unknown>> {
  return {
    changes: changes.map((change) => ({
      change: change.change,
      detail: change.detail,
      name: change.name,
    })),
    ...countChanges(changes),
  };
}

/**
 * The whole bundle diff as one section per namespace, in the order every other report lists them.
 *
 * Packs lead even though a pack materializes nothing: a pack whose membership moved is the cause of
 * most of the rows below it.
 */
export function diffSections(diff: BundleDiff): readonly string[] {
  return [
    ...section("packs", changeRows(diff.packs)),
    ...section("skills", changeRows(diff.skills)),
    ...section("mcps", changeRows(diff.mcps)),
    ...section("hooks", changeRows(diff.hooks)),
  ];
}

/** The whole bundle diff as one keyed record per namespace, each carrying its `+`/`~`/`-` counts. */
export function diffJson(diff: BundleDiff): Readonly<Record<string, unknown>> {
  return {
    hooks: changeJson(diff.hooks),
    mcps: changeJson(diff.mcps),
    packs: changeJson(diff.packs),
    skills: changeJson(diff.skills),
  };
}
