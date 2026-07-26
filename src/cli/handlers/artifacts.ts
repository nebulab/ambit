/**
 * How the mutating commands render an artifact (spec §6).
 *
 * `install`, `prune` and `clean` all report the same two things — artifacts written and artifacts
 * removed — and a reader moving between them should not have to work out whether two tools are
 * describing one project. So the projections live here once: the same columns in the same order, the
 * same JSON keys, and a path that is always project-relative so nothing machine-specific reaches
 * either output.
 */
import type { OwnedArtifact } from "../../model/state.js";

/** Stands in for a cell an artifact kind has nothing to put in: a config file's mode, a directory's keys. */
export const NO_DETAIL = "-";

/**
 * One artifact as a JSON record, with the keys in a fixed order.
 *
 * Takes the owned shape rather than the planned or pruned one, because all three carry it and it is
 * the only part of them a report should show: a `target` is absolute and an `entries` list is the
 * harness's business.
 */
export function artifactJson(artifact: OwnedArtifact): Readonly<Record<string, unknown>> {
  return {
    kind: artifact.kind,
    ...(artifact.managedKeys !== undefined && { managedKeys: artifact.managedKeys }),
    ...(artifact.mode !== undefined && { mode: artifact.mode }),
    path: artifact.path,
  };
}

/** One row per artifact written: path, kind, and the mode a skill directory was materialized in. */
export function artifactRows(artifacts: readonly OwnedArtifact[]): readonly (readonly string[])[] {
  return artifacts.map((artifact) => [artifact.path, artifact.kind, artifact.mode ?? NO_DETAIL]);
}

/**
 * One row per artifact removed: path, kind, and the keys taken out of a co-owned config file.
 *
 * The third column carries keys rather than a mode, which is the difference between the two
 * directions: what a removal has to say is *how much* of a co-owned file went, since a config file
 * loses keys and stays where it is (spec §3.6), whereas a skill directory goes whole.
 */
export function removalRows(artifacts: readonly OwnedArtifact[]): readonly (readonly string[])[] {
  return artifacts.map((artifact) => [
    artifact.path,
    artifact.kind,
    artifact.managedKeys?.join(", ") ?? NO_DETAIL,
  ]);
}
