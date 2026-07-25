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
 * Remote-source skills are copied because they are immutable, pinned to a commit. This build
 * copies everything; symlinking `path:` sources so editing the installed skill edits the tracked
 * source arrives with A20.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
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
import type { McpTransport } from "../mcp.js";
import type { Bundle } from "../resolve.js";
import type { State } from "../state.js";
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
 * The `.mcp.json` artifact, or nothing when the bundle selected no servers.
 *
 * A bundle with no MCPs plans no artifact at all rather than an empty section, so a project that
 * never uses servers does not acquire a `.mcp.json` it did not ask for. Removing servers a
 * previous install wrote is pruning's job (A18), not this one's.
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
 * Writes one skill directory.
 *
 * An owned target is removed before being rewritten, so a skill that lost a file upstream does not
 * keep a stale copy of it. An unowned one is copied *over* rather than replaced — a case an install
 * never reaches, since ownership enforcement has already refused it or adopted it into `prior`
 * (`ownership.ts`). Keeping it a merge is deliberate anyway: `apply` called directly, with a state
 * that claims nothing, must not be able to delete a stranger's directory.
 */
async function applySkillDir(
  artifact: PlannedSkillDir,
  owned: ReadonlySet<string>,
): Promise<AppliedArtifact> {
  if (owned.has(artifact.path)) {
    await rm(artifact.target, { recursive: true, force: true });
  }
  await mkdir(path.dirname(artifact.target), { recursive: true });
  await cp(artifact.source, artifact.target, { recursive: true });

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
