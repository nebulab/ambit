/**
 * The harness adapter boundary.
 *
 * `plan` is pure and testable without a filesystem; `apply` is the only thing in ambit that writes
 * into a project. This split makes `--dry-run` a print of the plan rather than a second
 * implementation of installation.
 *
 * A planned artifact carries both its project-relative `path` (the identity state records, and the
 * only form that survives the project being moved) and its absolute `target`, so `apply` writes
 * exactly what `plan` decided and never re-derives a location.
 */
import type {
  ConfigEntry,
  DocumentFormat,
  DocumentShape,
  JsonObject,
} from "../model/documents/index.js";
import type { HookEvent } from "../model/hook-entity.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode, OwnedArtifact, State } from "../model/state.js";

/**
 * Which config a harness reads the installed files as.
 *
 * - `project` — one project's own config, read only while that project is open.
 * - `user` — the machine-wide config every project sees, which is what a harness reads its own
 *   files under the home directory as.
 *
 * The distinction reaches the plan because a user-level file cannot name a path relative to a
 * project: there is no one project for it to be relative to (`harness/definitions.ts`).
 */
export type InstallScope = "project" | "user";

/**
 * Where, and how, a bundle is being materialized.
 *
 * Nothing about the environment appears here beyond {@link ProjectPaths.scope}: ambit writes a
 * harness-native reference for every `${VAR}` rather than a value, so a plan is a function of the
 * bundle and the project alone. Two people installing the same bundle at a project get
 * byte-identical files whatever their shells hold.
 */
export interface ProjectPaths {
  /** The project root, absolute. Every artifact path is relative to it. */
  readonly root: string;
  /**
   * Which config the harnesses will read this install as. Absent reads as `project`.
   *
   * Decided from `root` alone, by `installScope` (`project/install.ts`), so it is a property of
   * where the install is happening rather than a flag anyone types.
   */
  readonly scope?: InstallScope;
  /**
   * `--copy` / `--link`: force every skill's materialization mode for this run.
   *
   * Absent (the normal case) means each skill follows its own source: a pinned remote one is
   * copied, a local one is symlinked. Carried here, rather than read from a flag inside the
   * adapter, because `plan` must decide the mode from its arguments alone.
   */
  readonly mode?: ArtifactMode;
}

/** A skill directory to materialize. */
export interface PlannedSkillDir {
  readonly kind: "skill-dir";
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** Absolute source directory within the catalog. */
  readonly source: string;
  /**
   * How the source reaches the target: copied for a source pinned to a commit, symlinked for a
   * local directory someone edits. `--copy`/`--link` force one for the whole run.
   */
  readonly mode: ArtifactMode;
  /** The skill's name, so a failure names the skill and not only a path. */
  readonly name: string;
}

/**
 * A hook's own directory to materialize — the bytes a hook that ships a script is made of.
 *
 * Field for field a {@link PlannedSkillDir}, because it is the same kind of artifact: a directory
 * inside a catalog, put under `.agents/` in one of two modes, owned as a whole path. Only `kind`
 * differs, so state, pruning, `status`, and the gitignore blocks can tell a hook directory from a
 * skill.
 *
 * Planned only for a hook whose `command` names a file its directory holds. Any other hook is a
 * command line and some config values, so it plans a config entry and nothing else.
 */
export interface PlannedHookDir {
  readonly kind: "hook-dir";
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** Absolute source directory within the catalog. */
  readonly source: string;
  /**
   * How the source reaches the target — the same rule a skill follows: copied for a source pinned
   * to a commit, symlinked for a local directory someone edits, forced for the whole run by
   * `--copy`/`--link`. `cp` preserves mode, so a script's executable bit survives either way.
   */
  readonly mode: ArtifactMode;
  /** The hook's name, so a failure names the hook and not only a path. */
  readonly name: string;
}

/**
 * A Claude Code plugin's directory to materialize.
 *
 * Field for field a {@link PlannedSkillDir}, because it lands the same way: a directory inside a
 * catalog, put under the shared skills directory in one of two modes, owned as a whole path. Only
 * `kind` differs, so state, pruning, `status`, and the gitignore blocks can tell one from a skill.
 *
 * Planned only by a harness whose profile says it loads one. A project whose harnesses all read
 * plain skills plans none, and `doctor` says so.
 */
export interface PlannedPluginDir {
  readonly kind: "plugin-dir";
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** Absolute source directory within the catalog. */
  readonly source: string;
  /**
   * How the source reaches the target — the same rule a skill follows: copied for a source pinned to
   * a commit, symlinked for a local directory someone edits, forced for the whole run by
   * `--copy`/`--link`.
   */
  readonly mode: ArtifactMode;
  /** The plugin's name, so a failure names the plugin and not only a path. */
  readonly name: string;
}

/**
 * A directory symlink pointing a harness at the shared skills directory.
 *
 * Separate from a skill directory because it is one artifact regardless of what the bundle holds,
 * and it is the one thing ambit installs that a harness reads through rather than reads directly.
 */
export interface PlannedSkillsLink {
  readonly kind: "skills-link";
  /** Project-relative, `/`-separated — e.g. `.claude/skills`. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** Absolute path the link points at: the shared skills directory. */
  readonly source: string;
  /**
   * Always `link`, carried anyway so that what `plan` describes and what `apply` records are the
   * same shape. `--dry-run` prints the plan and `install` prints what it applied, and the two must
   * render identically.
   */
  readonly mode: "link";
}

/**
 * A section of a harness's own config file to write.
 *
 * Unlike a skill directory, the target is not ambit's to replace: the file may hold entries a
 * person added by hand, so `apply` merges into it and ownership is recorded per key.
 */
export interface PlannedHarnessConfig {
  readonly kind: "harness-config";
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** The top-level object within the file ambit writes into. */
  readonly section: string;
  /** How the file is parsed and written — which driver reads and edits it. */
  readonly format: DocumentFormat;
  /**
   * How the managed section is laid out: a table keyed by name, or one array per event.
   *
   * Carried beside `format` because the format alone cannot pick a driver — `.mcp.json` and
   * `.claude/settings.json` are both JSON. Absent reads as `"map"`, which is what every MCP config
   * uses.
   */
  readonly shape?: DocumentShape;
  /**
   * Root keys the file should carry beside the managed section — Cursor's `version: 1`.
   *
   * Seeded only where the document lacks the key, so ambit adds one when creating the file and
   * never overwrites a value someone else wrote. Not recorded in state, unlike `shape`: removal
   * applies no defaults, so prune and clean need only the shape to edit this file.
   */
  readonly rootDefaults?: JsonObject;
  /** What ambit puts there, sorted by key. */
  readonly entries: readonly ConfigEntry[];
  /** `<section>.<key>` for each entry — what state records as owned. */
  readonly managedKeys: readonly string[];
}

/** Everything an adapter can be asked to write. */
export type PlannedArtifact =
  PlannedSkillDir | PlannedHookDir | PlannedPluginDir | PlannedSkillsLink | PlannedHarnessConfig;

/** The kinds owned as a whole path, rather than co-owned per key. */
export type PlannedPathArtifact =
  PlannedSkillDir | PlannedHookDir | PlannedPluginDir | PlannedSkillsLink;

/**
 * The artifact kinds that are a directory copied out of a catalog.
 *
 * Named once, because three places have to recognize one: writing it, comparing it against its
 * source, and reporting the mode it landed in. Spelling the disjunction out at each of them made a
 * fourth such kind a four-line change rather than a one-line one.
 */
export const CATALOG_DIR_KINDS = ["skill-dir", "hook-dir", "plugin-dir"] as const;

/**
 * The artifacts that are a directory copied out of a catalog.
 *
 * One type because they are handled identically: writing, comparing against source, and reporting
 * the landed mode are the same operation whether the directory holds a skill, a hook's script, or a
 * plugin. See `applyCatalogDir` (`profile.ts`) and `catalogDirVerdict` (`project/status.ts`).
 */
export type PlannedCatalogDir = PlannedSkillDir | PlannedHookDir | PlannedPluginDir;

/** Whether a planned artifact is one of those directories — see {@link CATALOG_DIR_KINDS}. */
export function isCatalogDir(artifact: PlannedArtifact): artifact is PlannedCatalogDir {
  return (CATALOG_DIR_KINDS as readonly string[]).includes(artifact.kind);
}

/** What `apply` reports back, and what goes into state verbatim. */
export type AppliedArtifact = OwnedArtifact;

/**
 * Why one harness cannot install one hook.
 *
 * - `no-mechanism` — the harness expresses hooks nowhere, which is opencode.
 * - `no-event` — the harness expresses hooks, but has no spelling for this one's event.
 *
 * Neither is an error: the hook installs everywhere else. Failing the run would let one harness in
 * `harnesses` veto every other harness's hooks.
 */
export type HookSkipReason = "no-mechanism" | "no-event";

/** One hook a harness was given and cannot write, for the run to report. */
export interface SkippedHook {
  /** The harness that cannot express it. */
  readonly harness: string;
  /** The hook's name, as declared. */
  readonly hook: string;
  /** Its event, in ambit's own spelling. */
  readonly event: HookEvent;
  readonly reason: HookSkipReason;
}

/** Code that writes a bundle into one agent tool's layout. */
export interface HarnessAdapter {
  readonly name: string;
  /** Pure: decides every path without touching disk. */
  plan(bundle: Bundle, project: ProjectPaths): readonly PlannedArtifact[];
  /**
   * The hooks in the bundle this harness cannot express, which `plan` leaves out.
   *
   * Separate from `plan` because a skipped hook is not an artifact: nothing writes it, nothing owns
   * it, nothing prunes it. Both answers come from one predicate (`profile.ts`), so they cannot
   * disagree about which hooks were installed.
   */
  skips(bundle: Bundle): readonly SkippedHook[];
  /**
   * Writes the plan.
   *
   * @param prior the state from the last install, which says what ambit may overwrite.
   */
  apply(plan: readonly PlannedArtifact[], prior: State): Promise<readonly AppliedArtifact[]>;
}
