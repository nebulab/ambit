/**
 * The Claude Code adapter (spec §5).
 *
 * Skills land at `.claude/skills/<name>/`, one directory per bundle skill, named by the resolved
 * name rather than the catalog's nesting — that flat name is what the harness shows a user and
 * what `ambit why` talks about, so the two must agree.
 *
 * MCP servers land in `.mcp.json`, whose shape is the harness's and not ambit's: each entity's
 * `transport` is mapped onto it here, because knowing that `http` means `type`/`url`/`headers` is
 * exactly the harness-specific knowledge this seam exists to contain. That file is co-owned —
 * ambit merges its own servers in and leaves anything else alone (see `harness-config.ts`).
 *
 * How a skill's source reaches its target follows the source (spec §5). A remote source is copied:
 * it is pinned to a commit, so a copy cannot go stale, and nothing in the project should be editable
 * bytes that no revision accounts for. A `path:` source is symlinked, because the directory it names
 * is a working tree someone edits — copying it is how dotagents leaves an agent reading a stale
 * duplicate of the file its author is changing (spec §1). `--copy`/`--link` force one mode for the
 * whole run, including onto sources that would have chosen the other: `--link` against a cached
 * remote checkout is a link into the shared cache, which is what asking for it means.
 */
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppliedArtifact,
  HarnessAdapter,
  PlannedArtifact,
  PlannedHarnessConfig,
  PlannedSkillDir,
  ProjectPaths,
} from "../adapter.js";
import type { MergedMcp, MergedSkill } from "../catalog.js";
import type { ConfigEntry, JsonObject } from "../harness-config.js";
import {
  managedKey,
  mergeConfigSection,
  readJsonDocument,
  serializeJsonDocument,
} from "../harness-config.js";
import { configError } from "../errors.js";
import type { McpTransport } from "../mcp.js";
import type { Bundle } from "../resolve.js";
import type { ArtifactMode, State } from "../state.js";
import { ownedPaths } from "../state.js";

/** The harness name this adapter answers to in `ambit.yml`'s `harnesses`. */
export const CLAUDE_HARNESS = "claude";

/** Where the harness reads skills from, project-relative. */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/** Where the harness reads MCP servers from, project-relative. */
export const CLAUDE_MCP_FILE = ".mcp.json";

/** The object within that file holding one entry per server. */
export const CLAUDE_MCP_SECTION = "mcpServers";

/**
 * An `${VAR}` reference in a header value (spec §5). Anchored to the shell-variable character set,
 * so a `${...}` the harness itself expands in some other syntax is left for it to deal with.
 */
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Substitutes `${VAR}` from the environment.
 *
 * A variable that is not set leaves its placeholder in place rather than collapsing to an empty
 * string: an empty `Authorization` header reads as a server that is configured and broken, whereas
 * the placeholder still says what is missing, and `doctor` (A24) is what reports it. Spec §5 is
 * explicit that a missing var is a warning and not a failed install.
 */
function interpolate(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replaceAll(ENV_PLACEHOLDER, (placeholder, name: string) => env[name] ?? placeholder);
}

/**
 * Maps one entity's transport onto the harness's server shape (spec §5).
 *
 * `type` is emitted for `http` because the harness treats a server without one as stdio, and
 * omitted for stdio itself, where `command` already says so. Empty `args` and `headers` are left
 * out entirely — a key carrying nothing is noise in a file people read.
 */
function serverConfig(
  transport: McpTransport,
  env: Readonly<Record<string, string | undefined>>,
): JsonObject {
  if (transport.kind === "stdio") {
    return {
      command: transport.command,
      ...(transport.args.length > 0 && { args: [...transport.args] }),
    };
  }

  const declared = Object.entries(transport.headers).sort(([a], [b]) => compare(a, b));
  const headers: Record<string, string> = {};
  for (const [name, value] of declared) headers[name] = interpolate(value, env);

  return {
    type: "http",
    url: transport.url,
    ...(declared.length > 0 && { headers }),
  };
}

/**
 * Which mode one skill is materialized in (spec §5).
 *
 * A commit is the signal, because it is exactly the question the mode turns on: a source pinned to
 * one is immutable and gets copied, and a source without one is a working directory whose current
 * contents are the answer, so it gets linked. `MergedSkill.commit` is absent precisely for a `path:`
 * source — a catalog skill inherits its catalog's commit and a `source` skill carries its own — so
 * this needs no second notion of "is this local".
 */
function modeOf(skill: MergedSkill, project: ProjectPaths): ArtifactMode {
  if (project.mode !== undefined) return project.mode;
  return skill.commit === undefined ? "link" : "copy";
}

function planSkill(skill: MergedSkill, project: ProjectPaths): PlannedSkillDir {
  const relative = `${CLAUDE_SKILLS_DIR}/${skill.name}`;
  return {
    kind: "skill-dir",
    path: relative,
    target: path.join(project.root, relative),
    source: path.join(skill.catalogRoot, skill.path),
    mode: modeOf(skill, project),
    name: skill.name,
  };
}

/**
 * The `.mcp.json` artifact, or nothing when the bundle selected no servers.
 *
 * A bundle with no MCPs plans no artifact at all rather than an empty section, so a project that
 * never uses servers does not acquire a `.mcp.json` it did not ask for. Servers a previous install
 * wrote are `prune.ts`'s to remove, which is why it works from state rather than from this plan:
 * there is no artifact here to carry the news that a file's last managed key is gone.
 */
function planMcpConfig(
  mcps: readonly MergedMcp[],
  project: ProjectPaths,
): PlannedHarnessConfig | undefined {
  if (mcps.length === 0) return undefined;

  // `mcps` arrives sorted by name, so the entries — and the managed keys state records — are too.
  const entries: readonly ConfigEntry[] = mcps.map((mcp) => ({
    key: mcp.name,
    value: serverConfig(mcp.transport, project.env),
  }));

  return {
    kind: "harness-config",
    path: CLAUDE_MCP_FILE,
    target: path.join(project.root, CLAUDE_MCP_FILE),
    section: CLAUDE_MCP_SECTION,
    entries,
    managedKeys: entries.map((entry) => managedKey(CLAUDE_MCP_SECTION, entry.key)),
  };
}

/**
 * Symlinks a skill directory at its source.
 *
 * The link is written **relative** to its own directory: a project and the catalog it points at are
 * often one checkout, so a relative link survives that tree being moved, and it keeps a
 * machine-specific absolute path out of the working copy. `readlink` then shows a reader the same
 * thing `ambit status` compares.
 *
 * @throws {AmbitError} exit 2 when the link cannot be created — something already at the target,
 *   which every install path has already refused or removed, or a filesystem that will not make
 *   symlinks at all. `--copy` is the way past the second one, so the message says so.
 */
async function linkSkillDir(artifact: PlannedSkillDir): Promise<void> {
  const from = path.relative(path.dirname(artifact.target), artifact.source);
  try {
    // The `dir` type is what Windows needs to make a directory link; POSIX ignores it.
    await symlink(from, artifact.target, "dir");
  } catch (error) {
    throw configError(`cannot symlink ${artifact.path}`, [
      error instanceof Error ? error.message : String(error),
      `move ${artifact.path} aside, or run \`ambit install --copy\` to copy "${artifact.name}" instead`,
    ]);
  }
}

/**
 * Writes one skill directory, in the mode the plan chose.
 *
 * An owned target is removed before being rewritten, so a skill that lost a file upstream does not
 * keep a stale copy of it — and so a skill whose mode changed between runs becomes the other thing
 * rather than a copy sitting on top of a link. An unowned one is copied *over* rather than replaced —
 * a case an install never reaches, since ownership enforcement has already refused it or adopted it
 * into `prior` (`ownership.ts`). Keeping it a merge is deliberate anyway: `apply` called directly,
 * with a state that claims nothing, must not be able to delete a stranger's directory. Link mode has
 * no merge to fall back on, so there the same case is an error rather than a silent overwrite.
 *
 * @throws {AmbitError} exit 2 when a link cannot be created.
 */
async function applySkillDir(
  artifact: PlannedSkillDir,
  owned: ReadonlySet<string>,
): Promise<AppliedArtifact> {
  if (owned.has(artifact.path)) {
    // `recursive` removes a directory; a symlink is unlinked without following it, so the source a
    // previous link pointed at is never what gets deleted.
    await rm(artifact.target, { recursive: true, force: true });
  }
  await mkdir(path.dirname(artifact.target), { recursive: true });

  if (artifact.mode === "link") await linkSkillDir(artifact);
  else await cp(artifact.source, artifact.target, { recursive: true });

  return { path: artifact.path, kind: artifact.kind, mode: artifact.mode };
}

/**
 * Merges the planned entries into the harness's config file.
 *
 * Read-modify-write rather than a plain write, and it happens whether or not the file is owned:
 * ambit owns keys here, not the document, so a hand-maintained `.mcp.json` is a normal input
 * rather than a conflict.
 *
 * @throws {AmbitError} exit 2 if the existing file cannot be merged into (spec §5).
 */
async function applyHarnessConfig(artifact: PlannedHarnessConfig): Promise<AppliedArtifact> {
  const document = await readJsonDocument(artifact.target, artifact.path);
  const merged = mergeConfigSection(document, artifact.section, artifact.entries, artifact.path);

  await mkdir(path.dirname(artifact.target), { recursive: true });
  await writeFile(artifact.target, serializeJsonDocument(merged), "utf8");

  return { path: artifact.path, kind: artifact.kind, managedKeys: artifact.managedKeys };
}

async function applyPlan(
  plan: readonly PlannedArtifact[],
  prior: State,
): Promise<readonly AppliedArtifact[]> {
  const owned = ownedPaths(prior);
  const applied: AppliedArtifact[] = [];

  for (const artifact of plan) {
    applied.push(
      artifact.kind === "skill-dir"
        ? await applySkillDir(artifact, owned)
        : await applyHarnessConfig(artifact),
    );
  }

  return applied;
}

export const claudeAdapter: HarnessAdapter = {
  name: CLAUDE_HARNESS,
  /** `bundle.skills` and `bundle.mcps` are already sorted by name, so the plan is too. */
  plan: (bundle: Bundle, project: ProjectPaths): readonly PlannedArtifact[] => {
    const mcpConfig = planMcpConfig(bundle.mcps, project);
    return [
      ...bundle.skills.map((skill) => planSkill(skill, project)),
      ...(mcpConfig === undefined ? [] : [mcpConfig]),
    ];
  },
  apply: applyPlan,
};
