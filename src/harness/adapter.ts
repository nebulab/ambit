/**
 * The harness adapter boundary (spec §5).
 *
 * One adapter ships in v1, but the seam is explicit anyway: `plan` is pure and therefore
 * testable without a filesystem, and `apply` is the only thing in ambit that writes into a
 * project. Keeping that split is what makes `--dry-run` a print of the plan rather than a second
 * implementation of installation.
 *
 * A planned artifact carries both its project-relative `path` — the identity state records, and
 * the only form that survives the project being moved — and its absolute `target`, so `apply`
 * writes exactly what `plan` decided and never re-derives a location.
 */
import type { ConfigEntry } from "./config.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode, OwnedArtifact, State } from "../model/state.js";

/** Where — and how — a bundle is being materialized. */
export interface ProjectPaths {
  /** The project root, absolute. Every artifact path is relative to it. */
  readonly root: string;
  /**
   * The environment `${VAR}` placeholders interpolate from (spec §5). Passed in rather than read
   * from `process.env` inside an adapter, so `plan` stays a function of its arguments alone and a
   * test can pin what lands in a config file without touching the real environment.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * `--copy` / `--link`: force every skill's materialization mode for this run (spec §5).
   *
   * Absent — the normal case — means each skill follows its own source: a pinned remote one is
   * copied, a local one is symlinked. Carried here rather than read from a flag inside the adapter
   * for the same reason `env` is: `plan` decides the mode, and it must decide it from its arguments.
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
   * local directory someone edits (spec §5). `--copy`/`--link` force one for the whole run.
   */
  readonly mode: ArtifactMode;
  /** The skill's name, so a failure names the skill and not only a path. */
  readonly name: string;
}

/**
 * A section of a harness's own config file to write, `.mcp.json` being the only one in v1.
 *
 * Unlike a skill directory the target is not ambit's to replace: the file may hold entries a
 * person added by hand, so `apply` merges into it and ownership is recorded per key (spec §5).
 */
export interface PlannedHarnessConfig {
  readonly kind: "harness-config";
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** Absolute target. */
  readonly target: string;
  /** The top-level object within the file ambit writes into. */
  readonly section: string;
  /** What ambit puts there, sorted by key. */
  readonly entries: readonly ConfigEntry[];
  /** `<section>.<key>` for each entry — what state records as owned (spec §3.6). */
  readonly managedKeys: readonly string[];
}

/** Everything an adapter can be asked to write. */
export type PlannedArtifact = PlannedSkillDir | PlannedHarnessConfig;

/** What `apply` reports back, and what goes into state verbatim. */
export type AppliedArtifact = OwnedArtifact;

/** Code that writes a bundle into one agent tool's layout. */
export interface HarnessAdapter {
  readonly name: string;
  /** Pure: decides every path without touching disk. */
  plan(bundle: Bundle, project: ProjectPaths): readonly PlannedArtifact[];
  /**
   * Writes the plan.
   *
   * @param prior the state from the last install, which says what ambit may overwrite.
   */
  apply(plan: readonly PlannedArtifact[], prior: State): Promise<readonly AppliedArtifact[]>;
}
