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
import type { Bundle } from "./resolve.js";
import type { ArtifactMode, OwnedArtifact, State } from "./state.js";

/** Where a bundle is being materialized. */
export interface ProjectPaths {
  /** The project root, absolute. Every artifact path is relative to it. */
  readonly root: string;
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
  /** How the source reaches the target. This build always copies; A20 adds symlinks. */
  readonly mode: ArtifactMode;
  /** The skill's name, so a failure names the skill and not only a path. */
  readonly name: string;
}

/** Everything an adapter can be asked to write. MCP config joins this later. */
export type PlannedArtifact = PlannedSkillDir;

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
