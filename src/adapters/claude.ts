/**
 * The Claude Code adapter (spec §5).
 *
 * Skills land at `.claude/skills/<name>/`, one directory per bundle skill, named by the resolved
 * name rather than the catalog's nesting — that flat name is what the harness shows a user and
 * what `ambit why` talks about, so the two must agree.
 *
 * Remote-source skills are copied because they are immutable, pinned to a commit. This build
 * copies everything; symlinking `path:` sources so editing the installed skill edits the tracked
 * source arrives with A20, as does `.mcp.json` (A10).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  AppliedArtifact,
  HarnessAdapter,
  PlannedArtifact,
  PlannedSkillDir,
  ProjectPaths,
} from "../adapter.js";
import type { MergedSkill } from "../catalog.js";
import type { Bundle } from "../resolve.js";
import type { State } from "../state.js";
import { ownedPaths } from "../state.js";

/** The harness name this adapter answers to in `ambit.yml`'s `harnesses`. */
export const CLAUDE_HARNESS = "claude";

/** Where the harness reads skills from, project-relative. */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

function planSkill(skill: MergedSkill, project: ProjectPaths): PlannedSkillDir {
  const relative = `${CLAUDE_SKILLS_DIR}/${skill.name}`;
  return {
    kind: "skill-dir",
    path: relative,
    target: path.join(project.root, relative),
    source: path.join(skill.catalogRoot, skill.path),
    mode: "copy",
    name: skill.name,
  };
}

/**
 * Writes the planned skill directories.
 *
 * An owned target is removed before being rewritten, so a skill that lost a file upstream does
 * not keep a stale copy of it. An *unowned* target is not yet refused — that check, and
 * `--adopt`, arrive with A17.
 */
async function applyPlan(
  plan: readonly PlannedArtifact[],
  prior: State,
): Promise<readonly AppliedArtifact[]> {
  const owned = ownedPaths(prior);
  const applied: AppliedArtifact[] = [];

  for (const artifact of plan) {
    if (owned.has(artifact.path)) {
      await rm(artifact.target, { recursive: true, force: true });
    }
    await mkdir(path.dirname(artifact.target), { recursive: true });
    await cp(artifact.source, artifact.target, { recursive: true });
    applied.push({ path: artifact.path, kind: artifact.kind, mode: artifact.mode });
  }

  return applied;
}

export const claudeAdapter: HarnessAdapter = {
  name: CLAUDE_HARNESS,
  /** `bundle.skills` is already sorted by name, so the plan is too. */
  plan: (bundle: Bundle, project: ProjectPaths): readonly PlannedArtifact[] =>
    bundle.skills.map((skill) => planSkill(skill, project)),
  apply: applyPlan,
};
