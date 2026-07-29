/**
 * `ambit install` against the fixture catalog: the walking skeleton's last step —
 * config in, skills on disk, ownership recorded.
 *
 * The tree assertions are exhaustive rather than spot checks. "Exactly the resolved skill
 * directories" is the claim A06 makes, and a test that only looks for what should be there would
 * pass while an extra skill sat next to it.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { PlannedSkillDir } from "../../src/harness/adapter.js";
import { claude } from "../../src/harness/definitions.js";
import { adapterFor, SHARED_HOOKS_DIR, SHARED_SKILLS_DIR } from "../../src/harness/profile.js";
import { arrayEntryKey, managedKey } from "../../src/model/documents/index.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  GITIGNORE_FILENAME,
  SHARED_GITIGNORE_FILE,
} from "../../src/project/gitignore.js";
import { installProject } from "../../src/project/install.js";
import { LOCK_FILENAME } from "../../src/project/lock.js";
import { run } from "../../src/cli/program.js";
import type { Bundle } from "../../src/resolution/resolve.js";
import { resolveBundle } from "../../src/resolution/resolve.js";
import type { SourceContext } from "../../src/model/sources.js";
import {
  EMPTY_STATE,
  STATE_DIRNAME,
  STATE_FILENAME,
  parseState,
  readState,
  serializeState,
} from "../../src/model/state.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = SHARED_SKILLS_DIR;
const CLAUDE_LINK = ".claude/skills";
const claudeAdapter = adapterFor(claude);
const MCP_FILE = ".mcp.json";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";

/** The fixture's scope-matched http server, and the one only `requires` reaches. */
const SCOPED_MCP = "scoped";
const FIXTURE_MCP = "fixture";

/** The variable the scoped server interpolates into its `Authorization` header. */
const SCOPED_KEY_VAR = "SCOPED_API_KEY";

/**
 * The fixture's two scope-matched hooks, the directory one of them ships and the file they share.
 *
 * `core` selects an inline-command hook and `function.engineering` one shipping a script, so the
 * default profile's bundle plans a config file and a materialized directory besides the skills. The
 * keys are built from the rendered entry rather than written out: a digest is not a literal anyone can
 * check by eye, and `test/project/hooks.test.ts` is where the rendering itself is pinned.
 */
const HOOK_DIR = `${SHARED_HOOKS_DIR}/guard-secrets`;
const CLAUDE_SETTINGS = ".claude/settings.json";

const CORE_HOOK_KEY = managedKey(
  "hooks",
  arrayEntryKey("SessionStart", {
    hooks: [{ type: "command", command: 'echo "acme conventions apply"' }],
  }),
);

const ENGINEERING_HOOK_KEY = managedKey(
  "hooks",
  arrayEntryKey("PreToolUse", {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: `\${CLAUDE_PROJECT_DIR}/${HOOK_DIR}/guard.sh`,
        timeout: 10,
      },
    ],
  }),
);

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it `scopes`.
 *
 * @param extra further top-level config lines, `skills` and `mcps` blocks among them.
 */
async function writeProfile(
  scopes: readonly string[],
  harnesses?: readonly string[],
  extra: readonly string[] = [],
): Promise<void> {
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  const harnessLine = harnesses === undefined ? "" : `harnesses: [${harnesses.join(", ")}]\n`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
${harnessLine}catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
scopes: ${list}
${extra.map((line) => `${line}\n`).join("")}`,
    "utf8",
  );
}

/** Runs the CLI against the project, collecting stdout and stderr. */
async function cli(
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", projectDir], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * Whether a path is a directory, *through* a symlink.
 *
 * The walkers below have to follow links, because a linked skill is a directory as far as
 * the harness reading it is concerned — the claims about what is installed are the same claims
 * whichever mode put it there. Which mode that was is asserted on its own, from state and `lstat`.
 */
async function isDirectoryAt(target: string): Promise<boolean> {
  return (await stat(target)).isDirectory();
}

/** Every file under `dir`, project-relative, `/`-separated and sorted. */
async function tree(dir: string): Promise<readonly string[]> {
  const absolute = path.join(projectDir, dir);
  const found: string[] = [];

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const within = relative === "" ? entry : `${relative}/${entry}`;
      if (await isDirectoryAt(path.join(current, entry))) {
        await walk(path.join(current, entry), within);
      } else {
        found.push(within);
      }
    }
  };

  await walk(absolute, "");
  return found.sort();
}

/** Every file in the project, keyed by relative path and carrying its contents. */
async function snapshot(): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(current, entry.name);

      // A link pointing back inside the project is a second view of files this walk already has —
      // `.claude/skills` is one, and following it would list every skill twice. Recorded as an entry,
      // not descended into. A link out to the catalog is followed, because the bytes it exposes are
      // only reachable through it.
      if (entry.isSymbolicLink()) {
        const points = path.resolve(current, await readlink(absolute));
        if (!path.relative(projectDir, points).startsWith("..")) {
          found[within] = `-> ${await readlink(absolute)}`;
          continue;
        }
      }

      if (await isDirectoryAt(absolute)) await walk(absolute, within);
      else found[within] = await readFile(absolute, "utf8");
    }
  };

  await walk(projectDir, "");
  return found;
}

/** The installed skill directory names, sorted. */
async function installedSkills(): Promise<readonly string[]> {
  const skills = path.join(projectDir, SKILLS_DIR);
  const names: string[] = [];
  for (const entry of await readdir(skills)) {
    if (await isDirectoryAt(path.join(skills, entry))) names.push(entry);
  }
  return names.sort();
}

/** Where an installed skill's symlink points, or undefined when it is not a symlink at all. */
async function linkAt(target: string): Promise<string | undefined> {
  const absolute = path.join(projectDir, target);
  if (!(await lstat(absolute)).isSymbolicLink()) return undefined;
  return readlink(absolute);
}

async function readStateFile(): Promise<string> {
  return readFile(path.join(projectDir, STATE_DIRNAME, STATE_FILENAME), "utf8");
}

async function readMcpFile(): Promise<string> {
  return readFile(path.join(projectDir, MCP_FILE), "utf8");
}

/** `.mcp.json` as a document, so a test can assert both its contents and its key order. */
async function readMcpConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readMcpFile()) as Record<string, unknown>;
}

/** Writes a file into the per-test copy of the catalog. */
async function writeCatalogFile(relative: string, contents: string): Promise<void> {
  await writeFile(path.join(catalogDir, relative), contents, "utf8");
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  return exists(path.join(projectDir, target));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-install-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  // `function.engineering` also selects its nested frontend child, so this profile is three
  // skills — and the `scoped` MCP server, which declares that same scope.
  await writeProfile(["core", "function.engineering"]);
  // What lands in `.mcp.json` depends on the environment, so every test pins it rather
  // than inheriting whatever the developer's shell exports.
  vi.stubEnv(SCOPED_KEY_VAR, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** The bundle the project's current profile resolves to. */
async function bundleFor(): Promise<Bundle> {
  const context: SourceContext = { projectDir, env: process.env };
  const config = await loadProjectConfig(projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, context));
  return resolveBundle(config, await mergeConfigEntities(catalogs, config, context));
}

describe("the Claude adapter's plan", () => {
  it("targets one directory per bundle skill and one config file, and touches nothing", async () => {
    const plan = claudeAdapter.plan(await bundleFor(), { root: projectDir });

    expect(plan.map((artifact) => artifact.path)).toEqual([
      `${SKILLS_DIR}/${ENGINEERING_SKILL}`,
      `${SKILLS_DIR}/${CORE_SKILL}`,
      `${SKILLS_DIR}/${FRONTEND_SKILL}`,
      HOOK_DIR,
      CLAUDE_LINK,
      MCP_FILE,
      CLAUDE_SETTINGS,
    ]);

    // The fixture is a `path:` catalog, so every skill is planned as a link.
    const skills = plan.filter(
      (artifact): artifact is PlannedSkillDir => artifact.kind === "skill-dir",
    );
    expect(skills.map((artifact) => artifact.mode)).toEqual(["link", "link", "link"]);
    expect(skills[0]?.source).toBe(path.join(catalogDir, "skills/code-review"));
    expect(await pathExists(SKILLS_DIR)).toBe(false);
    expect(await pathExists(MCP_FILE)).toBe(false);
  });

  it("plans the mode `--copy` and `--link` ask for, whatever the source would have chosen", async () => {
    const bundle = await bundleFor();
    const modes = (mode?: "copy" | "link"): readonly (string | undefined)[] =>
      claudeAdapter
        .plan(bundle, { root: projectDir, ...(mode !== undefined && { mode }) })
        .filter((artifact): artifact is PlannedSkillDir => artifact.kind === "skill-dir")
        .map((artifact) => artifact.mode);

    expect(modes("copy")).toEqual(["copy", "copy", "copy"]);
    expect(modes("link")).toEqual(["link", "link", "link"]);
  });

  it("is pure: planning twice yields the same paths", async () => {
    const bundle = await bundleFor();
    const project = { root: projectDir };

    expect(claudeAdapter.plan(bundle, project)).toEqual(claudeAdapter.plan(bundle, project));
  });

  it("plans no server config file for a bundle with no servers", async () => {
    await writeProfile(["core"]);

    const plan = claudeAdapter.plan(await bundleFor(), { root: projectDir });

    // The skills link is still planned: Claude Code reads through it whatever the bundle holds. The
    // one config file left is the settings file, which this profile's hook needs — `.mcp.json` is the
    // one a serverless bundle plans nothing for.
    expect(plan.map((artifact) => artifact.kind)).toEqual([
      "skill-dir",
      "skills-link",
      "harness-config",
    ]);
    expect(plan.map((artifact) => artifact.path)).not.toContain(MCP_FILE);
  });
});

describe("ambit install", () => {
  it("writes exactly the resolved skill directories", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL]);
    expect(await tree(SKILLS_DIR)).toEqual([
      `${ENGINEERING_SKILL}/SKILL.md`,
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
    ]);
  });

  it("serves the catalog's bytes, byte-for-byte, at the installed path", async () => {
    await cli("install");

    const installed = await readFile(
      path.join(projectDir, SKILLS_DIR, CORE_SKILL, "SKILL.md"),
      "utf8",
    );
    const source = await readFile(path.join(catalogDir, "skills/company-context/SKILL.md"), "utf8");
    expect(installed).toBe(source);
  });

  it("installs what a different profile resolves to, and nothing more", async () => {
    await writeProfile(["function.engineering.frontend"]);

    await cli("install");

    expect(await installedSkills()).toEqual([FRONTEND_SKILL]);
  });

  it("creates no skills directory for an empty bundle", async () => {
    await writeProfile([]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(SKILLS_DIR)).toBe(false);
    expect(parseState(await readStateFile(), STATE_FILENAME).artifacts).toEqual([]);
  });

  it("records every skill directory and every managed config key as owned", async () => {
    await cli("install");

    const state = parseState(await readStateFile(), STATE_FILENAME);
    expect(state).toEqual({
      version: 1,
      harnesses: ["claude"],
      artifacts: [
        { path: HOOK_DIR, kind: "hook-dir", mode: "link" },
        { path: `${SKILLS_DIR}/${ENGINEERING_SKILL}`, kind: "skill-dir", mode: "link" },
        { path: `${SKILLS_DIR}/${CORE_SKILL}`, kind: "skill-dir", mode: "link" },
        { path: `${SKILLS_DIR}/${FRONTEND_SKILL}`, kind: "skill-dir", mode: "link" },
        {
          path: CLAUDE_SETTINGS,
          kind: "harness-config",
          format: "json",
          // `shape` too, which prune and clean read to know the section is an array of entries.
          shape: "array",
          managedKeys: [ENGINEERING_HOOK_KEY, CORE_HOOK_KEY],
        },
        { path: CLAUDE_LINK, kind: "skills-link", mode: "link" },
        {
          path: MCP_FILE,
          kind: "harness-config",
          format: "json",
          managedKeys: [`mcpServers.${SCOPED_MCP}`],
        },
      ],
    });
  });

  it("writes a byte-stable state file", async () => {
    await cli("install");
    const first = await readStateFile();
    await cli("install");

    expect(await readStateFile()).toBe(first);
  });

  it("leaves the same tree behind on a second run", async () => {
    await cli("install");
    const first = await tree(SKILLS_DIR);

    const second = await cli("install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await tree(SKILLS_DIR)).toEqual(first);
  });

  it("replaces an owned skill directory rather than merging into it", async () => {
    // `--copy` because the claim is about a directory of ambit's own bytes: writing into a *linked*
    // skill writes into the catalog, where a stale file is the catalog's problem and not install's.
    await cli("install", "--copy");
    const stale = path.join(projectDir, SKILLS_DIR, CORE_SKILL, "stale.md");
    await writeFile(stale, "left over from an older catalog\n", "utf8");

    await cli("install", "--copy");

    expect(await tree(SKILLS_DIR)).toEqual([
      `${ENGINEERING_SKILL}/SKILL.md`,
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
    ]);
  });

  it("lists what it wrote", async () => {
    const result = await cli("install");

    // Both columns but the last are padded out to their longest cell, so the kinds line up down
    // the section and the config file's missing mode reads as a gap rather than a shifted row.
    const width = `${SKILLS_DIR}/${CORE_SKILL}`.length;
    expect(result.stdout).toBe(
      [
        "harnesses (1)",
        "  claude",
        "",
        "artifacts (7)",
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       link`,
        `  ${SKILLS_DIR}/${CORE_SKILL}  skill-dir       link`,
        `  ${`${SKILLS_DIR}/${FRONTEND_SKILL}`.padEnd(width)}  skill-dir       link`,
        `  ${HOOK_DIR.padEnd(width)}  hook-dir        link`,
        `  ${CLAUDE_LINK.padEnd(width)}  skills-link     link`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  -`,
        `  ${CLAUDE_SETTINGS.padEnd(width)}  harness-config  -`,
      ].join("\n"),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("install", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      artifacts: [
        { kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "hook-dir", mode: "link", path: HOOK_DIR },
        { kind: "skills-link", mode: "link", path: CLAUDE_LINK },
        // No `format`: a report shows what a reader needs, and the path already says which it is.
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
        {
          kind: "harness-config",
          managedKeys: [ENGINEERING_HOOK_KEY, CORE_HOOK_KEY],
          path: CLAUDE_SETTINGS,
        },
      ],
      harnesses: ["claude"],
      skills: [ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL],
      // Present and empty rather than absent, so a consumer reads one shape whether or not a harness
      // had to decline something.
      skipped: [],
    });
    expect(result.stdout).not.toContain(root);
  });

  it("returns the bundle it installed", async () => {
    const result = await installProject(projectDir);

    expect(result.bundle.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      CORE_SKILL,
      FRONTEND_SKILL,
    ]);
    expect(result.harnesses).toEqual(["claude"]);
  });
});

/**
 * The materialization modes, and the reason for them: a local catalog is a working tree
 * someone edits, so the file the agent reads must be that file and not a duplicate of it.
 */
describe("how a skill's source reaches its target", () => {
  const CORE_TARGET = `${SKILLS_DIR}/${CORE_SKILL}`;
  const CORE_SOURCE = "skills/company-context";
  const EDITED = "---\nname: company-context\ntags: [core]\n---\n\n# edited\n";

  /** The skill's file inside the catalog, which a linked install must be the very same file as. */
  async function readSource(): Promise<string> {
    return readFile(path.join(catalogDir, CORE_SOURCE, "SKILL.md"), "utf8");
  }

  async function readInstalled(): Promise<string> {
    return readFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), "utf8");
  }

  /** The mode state records for one skill directory. */
  async function recordedMode(target: string): Promise<string | undefined> {
    const state = parseState(await readStateFile(), STATE_FILENAME);
    return state.artifacts.find((artifact) => artifact.path === target)?.mode;
  }

  it("symlinks a `path:` catalog's skill, relatively, at the directory the catalog holds", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const written = await linkAt(CORE_TARGET);
    expect(written).toBe(
      path.relative(
        path.dirname(path.join(projectDir, CORE_TARGET)),
        path.join(catalogDir, CORE_SOURCE),
      ),
    );
    // Relative, so the project and its catalog can be moved together — and so no absolute path from
    // this machine lands in the working tree.
    expect(written?.startsWith("..")).toBe(true);
    expect(await recordedMode(CORE_TARGET)).toBe("link");
  });

  it("makes editing the installed skill edit the tracked source", async () => {
    await cli("install");

    await writeFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), EDITED, "utf8");

    // The whole point of linking: there is no second copy to go stale.
    expect(await readSource()).toBe(EDITED);
  });

  it("copies under `--copy`, so editing the installed skill leaves the source alone", async () => {
    const result = await cli("install", "--copy");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await linkAt(CORE_TARGET)).toBeUndefined();
    expect(await recordedMode(CORE_TARGET)).toBe("copy");
    const source = await readSource();

    await writeFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), EDITED, "utf8");

    expect(await readSource()).toBe(source);
  });

  it("replaces a copy with a link and a link with a copy when the mode changes", async () => {
    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);

    expect((await cli("install")).code).toBe(ExitCode.Success);
    expect(await linkAt(CORE_TARGET)).toBeDefined();
    expect(await recordedMode(CORE_TARGET)).toBe("link");
    // Replaced, not written through: the source still holds exactly what the catalog ships.
    expect(await readInstalled()).toBe(await readSource());

    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);
    expect(await linkAt(CORE_TARGET)).toBeUndefined();
    expect(await recordedMode(CORE_TARGET)).toBe("copy");
    expect(await tree(SKILLS_DIR)).toEqual([
      `${ENGINEERING_SKILL}/SKILL.md`,
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
    ]);
  });

  it("refuses `--copy` and `--link` together rather than picking one", async () => {
    // Declared as conflicting options (A30), so the refusal is Commander's and arrives before the
    // handler — which is why nothing is installed, either way round.
    for (const flags of [
      ["--copy", "--link"],
      ["--link", "--copy"],
    ]) {
      const result = await cli("install", ...flags);

      expect(result.code).toBe(ExitCode.Config);
      expect(result.stderr).toContain("option '--copy' cannot be used with option '--link'");
      expect(await pathExists(SKILLS_DIR)).toBe(false);
    }
  });

  it("unlinks a pruned skill without following the link into the catalog", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL]);
    // The skill ambit stopped selecting is gone from the project and untouched in the catalog.
    expect(await pathExists(`${SKILLS_DIR}/${ENGINEERING_SKILL}`)).toBe(false);
    expect(await exists(path.join(catalogDir, "skills/code-review/SKILL.md"))).toBe(true);
  });
});

describe(".mcp.json", () => {
  /** The scoped server matches this profile by scope; `fixture` only arrives via `requires`. */
  const BOTH_SERVERS = ["function.engineering", "project.acme"];

  const SCOPED_SERVER = {
    type: "http",
    url: "https://mcp.invalid/fixture",
    headers: { Authorization: `Bearer \${${SCOPED_KEY_VAR}}` },
  };

  /** stdio servers carry an `env` map so the harness passes each declared variable to the process. */
  const FIXTURE_SERVER = {
    command: "npx",
    args: ["-y", "@acme/fixture-mcp"],
    env: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}" },
  };

  it("holds exactly the scope-matched server and the requires-only one", async () => {
    await writeProfile(BOTH_SERVERS);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // Both transport kinds at once: `fixture` is stdio, `scoped` is http.
    expect(await readMcpConfig()).toEqual({
      mcpServers: { [FIXTURE_MCP]: FIXTURE_SERVER, [SCOPED_MCP]: SCOPED_SERVER },
    });
  });

  it("writes no file at all when the bundle selects no server", async () => {
    await writeProfile(["core"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(MCP_FILE)).toBe(false);
  });

  it("writes a `${VAR}` reference rather than the value, even with the variable set", async () => {
    vi.stubEnv(SCOPED_KEY_VAR, "s3cret");

    await cli("install");

    // The credential stays in the environment. Resolving it here would put a live token into a file
    // ambit deliberately does not gitignore, and make the output differ per machine.
    expect(await readMcpConfig()).toEqual({ mcpServers: { [SCOPED_MCP]: SCOPED_SERVER } });
    expect(await readMcpFile()).not.toContain("s3cret");
  });

  it("writes the same reference whether or not the variable is set", async () => {
    await cli("install");
    const unset = await readMcpFile();

    vi.stubEnv(SCOPED_KEY_VAR, "s3cret");
    await cli("install");

    expect(await readMcpFile()).toBe(unset);
    expect(unset).toContain(`Bearer \${${SCOPED_KEY_VAR}}`);
  });

  it("omits `args` and `headers` a server does not declare", async () => {
    await writeCatalogFile(
      "mcps/plain.yml",
      "name: plain\ntags: [core]\n\ntransport:\n  stdio:\n    command: plain-mcp\n",
    );
    await writeCatalogFile(
      "mcps/bare.yml",
      "name: bare\ntags: [core]\n\ntransport:\n  http:\n    url: https://bare.invalid/mcp\n",
    );
    await writeProfile(["core"]);

    await cli("install");

    expect(await readMcpConfig()).toEqual({
      mcpServers: {
        bare: { type: "http", url: "https://bare.invalid/mcp" },
        plain: { command: "plain-mcp" },
      },
    });
  });

  it("leaves a hand-added server and every foreign key untouched", async () => {
    const handmade = { command: "node", args: ["./scripts/local-mcp.js"] };
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade }, extra: { kept: true } }, null, 2)}\n`,
      "utf8",
    );
    await writeProfile(BOTH_SERVERS);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const document = await readMcpConfig();
    expect(document).toEqual({
      mcpServers: { handmade, [FIXTURE_MCP]: FIXTURE_SERVER, [SCOPED_MCP]: SCOPED_SERVER },
      extra: { kept: true },
    });
    // Keys already in the file keep their position; ambit's are appended.
    expect(Object.keys(document)).toEqual(["mcpServers", "extra"]);
    expect(Object.keys(document.mcpServers as object)).toEqual([
      "handmade",
      FIXTURE_MCP,
      SCOPED_MCP,
    ]);
  });

  it("records only the keys it wrote as owned", async () => {
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade: { command: "node" } } }, null, 2)}\n`,
      "utf8",
    );
    await writeProfile(BOTH_SERVERS);

    await cli("install");

    const state = parseState(await readStateFile(), STATE_FILENAME);
    expect(state.artifacts.find((artifact) => artifact.path === MCP_FILE)).toEqual({
      path: MCP_FILE,
      kind: "harness-config",
      format: "json",
      managedKeys: [`mcpServers.${FIXTURE_MCP}`, `mcpServers.${SCOPED_MCP}`],
    });
  });

  it("is byte-identical on a second install", async () => {
    await writeProfile(BOTH_SERVERS);
    await cli("install");
    const first = await readMcpFile();

    await cli("install");

    expect(await readMcpFile()).toBe(first);
  });

  it("exits 2 rather than overwriting a file it cannot parse", async () => {
    await writeFile(path.join(projectDir, MCP_FILE), "{ not json\n", "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`${MCP_FILE} is not valid JSON`);
    expect(await readMcpFile()).toBe("{ not json\n");
  });

  it("exits 2 when the servers section is not an object", async () => {
    await writeFile(path.join(projectDir, MCP_FILE), '{"mcpServers": []}\n', "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`"mcpServers" in ${MCP_FILE} is not a JSON object`);
    expect(await readMcpFile()).toBe('{"mcpServers": []}\n');
  });
});

/**
 * The managed `.gitignore` blocks, end to end.
 *
 * The text transformation is pinned in `test/gitignore.test.ts`; what these cases add is the part
 * only a real install can show — which paths land in which of the two files, that the nested block
 * tracks the bundle across runs, and that a `.gitignore` someone else wrote survives being written
 * into.
 */
describe(".gitignore", () => {
  const HANDWRITTEN = "node_modules/\n.env\n";

  /** The lines between the markers of one file, which is exactly what ambit claims to own. */
  async function managedBlock(file: string = GITIGNORE_FILENAME): Promise<readonly string[]> {
    const lines = (await readFile(path.join(projectDir, file), "utf8")).split("\n");
    const start = lines.findIndex((line) => line.startsWith(BLOCK_BEGIN));
    const end = lines.findIndex((line) => line.startsWith(BLOCK_END));
    expect(start, `no managed block in ${file}`).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start + 1, end);
  }

  it("lists every skill directory it installed in the shared directory's own file", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);

    // The hook's materialized directory among them, and sorted with the rest: everything ambit writes
    // under the shared directory is volatile, whichever namespace put it there.
    expect(await managedBlock(SHARED_GITIGNORE_FILE)).toEqual([
      "/hooks/guard-secrets",
      `/skills/${ENGINEERING_SKILL}`,
      `/skills/${CORE_SKILL}`,
      `/skills/${FRONTEND_SKILL}`,
    ]);
  });

  it("keeps at the root only what a nested file cannot reach", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);

    // Not `.mcp.json` and not `ambit.lock`: a team commits both. Not `.agents/.gitignore` either —
    // it is generated, but tracked. The link is a symlink git would otherwise track, and it lives
    // outside the shared directory, so it needs a root pattern of its own.
    expect(await managedBlock()).toEqual([`${STATE_DIRNAME}/`, CLAUDE_LINK]);
  });

  it("leaves the nested file itself tracked, so a clone inherits the ignore list", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);

    for (const file of [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE]) {
      expect(await managedBlock(file)).not.toContain(SHARED_GITIGNORE_FILE);
    }
  });

  it("ignores a linked skill too, which git would otherwise track as a symlink", async () => {
    await cli("install");

    // The fixture is a `path:` catalog, so these are links — and the pattern carries no
    // trailing slash precisely so that it still matches them.
    expect(await linkAt(`${SKILLS_DIR}/${CORE_SKILL}`)).toBeDefined();
    expect(await managedBlock(SHARED_GITIGNORE_FILE)).toContain(`/skills/${CORE_SKILL}`);
  });

  it("appends to a .gitignore the project already had, leaving its lines untouched", async () => {
    await writeFile(path.join(projectDir, GITIGNORE_FILENAME), HANDWRITTEN, "utf8");

    expect((await cli("install")).code).toBe(ExitCode.Success);

    const contents = await readFile(path.join(projectDir, GITIGNORE_FILENAME), "utf8");
    expect(contents.startsWith(HANDWRITTEN)).toBe(true);
    expect(await managedBlock()).toContain(`${STATE_DIRNAME}/`);
  });

  it("drops the skill a narrowed profile no longer installs", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await managedBlock(SHARED_GITIGNORE_FILE)).toEqual([`/skills/${CORE_SKILL}`]);
    // The root block is the stable one: narrowing the bundle does not touch it.
    expect(await managedBlock()).toEqual([`${STATE_DIRNAME}/`, CLAUDE_LINK]);
  });

  it("rewrites its own block in place rather than adding a second one", async () => {
    await writeFile(path.join(projectDir, GITIGNORE_FILENAME), HANDWRITTEN, "utf8");
    await cli("install");
    await writeProfile(["core"]);

    await cli("install");

    for (const file of [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE]) {
      const contents = await readFile(path.join(projectDir, file), "utf8");
      expect(contents.split(BLOCK_BEGIN), file).toHaveLength(2);
      expect(contents, file).not.toContain(ENGINEERING_SKILL);
    }
  });

  it("writes nothing when the blocks already say what this install would write", async () => {
    await cli("install");
    const before = await Promise.all(
      [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE].map((file) =>
        readFile(path.join(projectDir, file), "utf8"),
      ),
    );

    await cli("install");

    for (const [index, file] of [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE].entries()) {
      expect(await readFile(path.join(projectDir, file), "utf8"), file).toBe(before[index]);
    }
  });

  it("removes the nested file when a project ends up installing no skills at all", async () => {
    await cli("install");
    expect(await pathExists(SHARED_GITIGNORE_FILE)).toBe(true);

    await writeProfile([]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    // An empty bundle would leave a pair of markers with nothing between them, which says less than
    // no file at all.
    expect(await pathExists(SHARED_GITIGNORE_FILE)).toBe(false);
  });

  it("exits 2 rather than guessing at an unterminated block, leaving the file alone", async () => {
    const broken = `${HANDWRITTEN}${BLOCK_BEGIN}\n${STATE_DIRNAME}/\ncoverage/\n`;
    await writeFile(path.join(projectDir, GITIGNORE_FILENAME), broken, "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`${GITIGNORE_FILENAME} holds an unterminated ambit block`);
    expect(await readFile(path.join(projectDir, GITIGNORE_FILENAME), "utf8")).toBe(broken);
    // The block is written last, so the skills themselves are installed and the retry is free.
    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL].sort());
  });
});

/**
 * Spec §4.8 end to end: what a project names outright is materialized like anything else, and the
 * `source` form does not need a catalog behind it.
 */
describe("explicitly declared skills and servers", () => {
  const READWISE = "readwise-cli";

  it("installs a skill from its own source and an inline server, holding no scopes", async () => {
    const source = path.join(root, "extra", "skills", READWISE);
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      `---\nname: ${READWISE}\n---\n\n# readwise\n`,
      "utf8",
    );

    await writeProfile([], undefined, [
      "skills:",
      `  - name: ${READWISE}`,
      "    source: path:../extra",
      "mcps:",
      "  - name: custom",
      "    transport:",
      "      stdio:",
      "        command: custom-mcp",
    ]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([READWISE]);
    expect(await readMcpConfig()).toEqual({ mcpServers: { custom: { command: "custom-mcp" } } });
    expect(parseState(await readStateFile(), STATE_FILENAME).artifacts).toEqual([
      { path: `${SKILLS_DIR}/${READWISE}`, kind: "skill-dir", mode: "link" },
      { path: CLAUDE_LINK, kind: "skills-link", mode: "link" },
      {
        path: MCP_FILE,
        kind: "harness-config",
        format: "json",
        managedKeys: ["mcpServers.custom"],
      },
    ]);
  });
});

describe("ambit install failures", () => {
  for (const [label, transport] of [
    ["no kind", "transport: {}"],
    ["two kinds", "transport:\n  stdio:\n    command: npx\n  http:\n    url: https://x.invalid"],
  ] as const) {
    it(`exits 2 for an MCP entity whose transport names ${label}`, async () => {
      await writeCatalogFile("mcps/broken.yml", `name: broken\n${transport}\n`);

      const result = await cli("install");

      expect(result.code).toBe(ExitCode.Config);
      expect(result.stderr).toContain("supported kinds: http, stdio");
      expect(await pathExists(MCP_FILE)).toBe(false);
      expect(await pathExists(SKILLS_DIR)).toBe(false);
    });
  }

  it("exits 2 for a harness with no adapter", async () => {
    await writeProfile(["core"], ["zed"]);

    const result = await cli("install");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown harness "zed"');
    // The message lists what this build does ship, so a typo is one line from being fixed.
    expect(result.stderr).toContain("claude, codex, cursor, opencode, vscode");
    expect(await pathExists(SKILLS_DIR)).toBe(false);
  });

  it("exits 2 when the project has no config", async () => {
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cli("install");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("no ambit config");
  });

  it("exits 2 rather than trusting an unreadable state file", async () => {
    await cli("install");
    await writeFile(
      path.join(projectDir, STATE_DIRNAME, STATE_FILENAME),
      '{"version": 1, "harnesses": ["claude"], "artifacts": [{"kind": "nonsense"}]}\n',
      "utf8",
    );

    const result = await cli("install");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("not a valid ambit state file");
  });
});

/**
 * `install --dry-run`: the plan, printed.
 *
 * "Touches nothing" is asserted as the whole project rather than as the absence of the skills
 * directory, because a preview that wrote the lock, or state, or a `.gitignore` block would satisfy
 * the narrower claim. And the artifact rows are compared against the ones the real install goes on to
 * print: a dry run whose output is a different rendering of the same plan is a second implementation,
 * which is exactly what the `plan`/`apply` split exists to prevent.
 */
describe("ambit install --dry-run", () => {
  /** The `files` section, which says of each derived file whether install would rewrite it. */
  const FILES_SECTION = (lock: string, root: string, shared: string): string =>
    [
      "files (3)",
      `  ${LOCK_FILENAME}          ${lock}`,
      `  ${GITIGNORE_FILENAME}          ${root}`,
      `  ${SHARED_GITIGNORE_FILE}  ${shared}`,
    ].join("\n");

  /** The two sections a preview adds after the ones install itself prints. */
  const EXTRA_SECTIONS = (lock: string, root: string, shared: string): string =>
    ["pruned (0)", "  (none)", "", FILES_SECTION(lock, root, shared)].join("\n");

  it("writes nothing at all", async () => {
    const result = await cli("install", "--dry-run");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The config is the only file the project had, and the only one it still has.
    expect(Object.keys(await snapshot())).toEqual(["ambit.yml"]);
    expect(await pathExists(SKILLS_DIR)).toBe(false);
  });

  it("prints the rows the install goes on to print, plus what only a preview can say", async () => {
    const preview = await cli("install", "--dry-run");

    const installed = await cli("install");
    expect(installed.code, installed.stderr).toBe(ExitCode.Success);

    expect(preview.stdout).toBe(
      `${installed.stdout}\n\n${EXTRA_SECTIONS("changed", "changed", "changed")}`,
    );
  });

  it("reports every derived file as unchanged once the project is installed", async () => {
    await cli("install");

    const result = await cli("install", "--dry-run");

    expect(result.stdout).toContain(EXTRA_SECTIONS("unchanged", "unchanged", "unchanged"));
  });

  it("reports the root block unchanged and the nested one stale when only the bundle narrowed", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("install", "--dry-run");

    expect(result.stdout).toContain(FILES_SECTION("changed", "unchanged", "changed"));
  });

  it("reports what the install would remove, and removes none of it", async () => {
    await cli("install");
    await writeProfile(["core"]);
    const before = await snapshot();

    const result = await cli("install", "--dry-run", "--json");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(JSON.parse(result.stdout)).toEqual({
      artifacts: [
        { kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skills-link", mode: "link", path: CLAUDE_LINK },
        { kind: "harness-config", managedKeys: [CORE_HOOK_KEY], path: CLAUDE_SETTINGS },
      ],
      gitignore: [
        { changed: false, file: GITIGNORE_FILENAME },
        { changed: true, file: SHARED_GITIGNORE_FILE },
      ],
      harnesses: ["claude"],
      lockChanged: true,
      pruned: [
        { kind: "hook-dir", path: HOOK_DIR },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "harness-config", managedKeys: [ENGINEERING_HOOK_KEY], path: CLAUDE_SETTINGS },
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
      ],
      skills: [CORE_SKILL],
      skipped: [],
    });
    expect(await snapshot()).toEqual(before);
    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL]);
  });

  it("refuses an unowned target rather than previewing an install that would stop", async () => {
    const target = path.join(projectDir, SKILLS_DIR, CORE_SKILL);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: hand-written\n---\n", "utf8");

    const result = await cli("install", "--dry-run");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned path");
  });

  it("still refuses a stale lock under `--frozen`, since refusing writes nothing", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("install", "--dry-run", "--frozen");

    expect(result.code).toBe(ExitCode.Drift);
    expect(result.stderr).toContain(`${LOCK_FILENAME} is out of date`);
  });
});

/**
 * Spec §5's ownership rules — the safety core. Every refusal test asserts what is still on disk
 * afterwards, because "exits 2" is only half the claim: the other half is that nothing moved.
 */
describe("ownership", () => {
  const CORE_TARGET = `${SKILLS_DIR}/${CORE_SKILL}`;
  const HANDWRITTEN = "---\nname: hand-written\n---\n\n# not ambit's\n";
  const STRAY = "notes nobody told ambit about\n";
  const STATE_FILE = `${STATE_DIRNAME}/${STATE_FILENAME}`;

  /** A directory the plan targets, holding files no state claims. */
  async function writeUnownedSkillDir(): Promise<void> {
    const target = path.join(projectDir, CORE_TARGET);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), HANDWRITTEN, "utf8");
    await writeFile(path.join(target, "notes.md"), STRAY, "utf8");
  }

  /** A `.mcp.json` whose `scoped` key collides with the one the fixture's server would write. */
  async function writeUnownedServer(): Promise<string> {
    const contents = `${JSON.stringify(
      {
        mcpServers: {
          [SCOPED_MCP]: { command: "node", args: ["./scoped.js"] },
          kept: { command: "keep" },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(path.join(projectDir, MCP_FILE), contents, "utf8");
    return contents;
  }

  it("refuses to overwrite a skill directory it does not own", async () => {
    await writeUnownedSkillDir();

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned path");
    expect(result.stderr).toContain(`${CORE_TARGET} exists but ambit did not create it`);
    expect(result.stderr).toContain("run `ambit install --adopt` to take ownership");
  });

  it("leaves an unowned directory byte-identical, and installs nothing else either", async () => {
    await writeUnownedSkillDir();

    await cli("install");

    // The check sees the whole plan before the first write, so the other two skills, the server
    // file, the lock, and the state file are all still absent.
    expect(await tree(SKILLS_DIR)).toEqual([`${CORE_SKILL}/SKILL.md`, `${CORE_SKILL}/notes.md`]);
    expect(await readFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), "utf8")).toBe(
      HANDWRITTEN,
    );
    expect(await pathExists(MCP_FILE)).toBe(false);
    expect(await pathExists(LOCK_FILENAME)).toBe(false);
    expect(await pathExists(STATE_FILE)).toBe(false);
    expect(await pathExists(GITIGNORE_FILENAME)).toBe(false);
  });

  it("refuses a plain file sitting where a skill directory belongs", async () => {
    await mkdir(path.join(projectDir, SKILLS_DIR), { recursive: true });
    await writeFile(path.join(projectDir, CORE_TARGET), STRAY, "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned path");
    expect(await readFile(path.join(projectDir, CORE_TARGET), "utf8")).toBe(STRAY);
  });

  it("does not read owning one skill as permission to overwrite another", async () => {
    await writeProfile(["core"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core", "function.engineering"]);
    const target = path.join(projectDir, SKILLS_DIR, ENGINEERING_SKILL);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), HANDWRITTEN, "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`${SKILLS_DIR}/${ENGINEERING_SKILL} exists`);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(HANDWRITTEN);
  });

  it("refuses to overwrite a server key it does not own", async () => {
    const contents = await writeUnownedServer();

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned key");
    expect(result.stderr).toContain(`"mcpServers.${SCOPED_MCP}" in ${MCP_FILE}`);
    expect(result.stderr).toContain(`remove it from ${MCP_FILE}`);
    expect(await readMcpFile()).toBe(contents);
    expect(await pathExists(SKILLS_DIR)).toBe(false);
  });

  it("replaces an adopted skill directory rather than copying into it", async () => {
    await writeUnownedSkillDir();

    const result = await cli("install", "--adopt");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The stray file is gone and SKILL.md is the catalog's, which is what taking ownership means.
    expect(await tree(SKILLS_DIR)).toEqual([
      `${ENGINEERING_SKILL}/SKILL.md`,
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
    ]);
    expect(await readFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), "utf8")).toBe(
      await readFile(path.join(catalogDir, "skills/company-context/SKILL.md"), "utf8"),
    );
    expect(
      parseState(await readStateFile(), STATE_FILENAME).artifacts.map((artifact) => artifact.path),
    ).toContain(CORE_TARGET);
  });

  it("adopts a colliding server key while leaving foreign keys alone", async () => {
    await writeUnownedServer();

    const result = await cli("install", "--adopt");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const document = await readMcpConfig();
    expect(document).toEqual({
      mcpServers: {
        [SCOPED_MCP]: {
          type: "http",
          url: "https://mcp.invalid/fixture",
          headers: { Authorization: `Bearer \${${SCOPED_KEY_VAR}}` },
        },
        kept: { command: "keep" },
      },
    });
    expect(
      parseState(await readStateFile(), STATE_FILENAME).artifacts.find(
        (artifact) => artifact.path === MCP_FILE,
      )?.managedKeys,
    ).toEqual([`mcpServers.${SCOPED_MCP}`]);
  });

  it("needs `--adopt` only once: the second install owns what the first adopted", async () => {
    await writeUnownedSkillDir();
    await writeUnownedServer();
    expect((await cli("install", "--adopt")).code).toBe(ExitCode.Success);

    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });

  it("changes nothing when there is nothing to adopt", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    const state = await readStateFile();
    const servers = await readMcpFile();

    const result = await cli("install", "--adopt");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await readStateFile()).toBe(state);
    expect(await readMcpFile()).toBe(servers);
  });
});

/**
 * Spec §5 rule 3, and §7's pruning case: install bundle A, install bundle B, and what only A held
 * is gone from disk, from `.mcp.json`, and from state — while anything ambit does not own stays
 * exactly where it was.
 */
describe("pruning", () => {
  /** A profile holding both servers, so narrowing to `WIDE` leaves one of them stale. */
  const BOTH_SERVERS = ["function.engineering", "project.acme"];
  const PROJECT_SKILL = "acme-brief";
  const HANDMADE_SKILL = "hand-written";

  /** A skill directory beside ambit's that no state claims. */
  async function writeForeignSkillDir(): Promise<void> {
    const target = path.join(projectDir, SKILLS_DIR, HANDMADE_SKILL);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), `---\nname: ${HANDMADE_SKILL}\n---\n`, "utf8");
  }

  it("removes the skill directories the new bundle no longer selects", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL]);
    expect(await tree(SKILLS_DIR)).toEqual([`${CORE_SKILL}/SKILL.md`]);
  });

  it("stops claiming what it removed", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("install");

    expect(parseState(await readStateFile(), STATE_FILENAME).artifacts).toEqual([
      { path: `${SKILLS_DIR}/${CORE_SKILL}`, kind: "skill-dir", mode: "link" },
      // The settings file survives the narrowing, holding one entry rather than two: `core` still
      // selects the inline hook, so what was pruned is the other one's key.
      {
        path: CLAUDE_SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [CORE_HOOK_KEY],
      },
      { path: CLAUDE_LINK, kind: "skills-link", mode: "link" },
    ]);
  });

  it("reports what it removed, by path", async () => {
    await installProject(projectDir);
    await writeProfile(["core"]);

    const result = await installProject(projectDir);

    expect(result.pruned).toEqual([
      { path: HOOK_DIR, kind: "hook-dir" },
      { path: `${SKILLS_DIR}/${ENGINEERING_SKILL}`, kind: "skill-dir" },
      { path: `${SKILLS_DIR}/${FRONTEND_SKILL}`, kind: "skill-dir" },
      { path: CLAUDE_SETTINGS, kind: "harness-config", managedKeys: [ENGINEERING_HOOK_KEY] },
      { path: MCP_FILE, kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`] },
    ]);
  });

  it("removes only the server keys the new bundle dropped", async () => {
    await writeProfile(BOTH_SERVERS);
    await cli("install");
    await writeProfile(["function.engineering"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // `scoped` still matches by scope; `fixture` only ever arrived through the project skill's
    // `requires`, which this profile no longer selects.
    expect(Object.keys((await readMcpConfig()).mcpServers as object)).toEqual([SCOPED_MCP]);
    expect(parseState(await readStateFile(), STATE_FILENAME).artifacts).toEqual([
      { path: HOOK_DIR, kind: "hook-dir", mode: "link" },
      { path: `${SKILLS_DIR}/${ENGINEERING_SKILL}`, kind: "skill-dir", mode: "link" },
      { path: `${SKILLS_DIR}/${FRONTEND_SKILL}`, kind: "skill-dir", mode: "link" },
      {
        path: CLAUDE_SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [ENGINEERING_HOOK_KEY],
      },
      { path: CLAUDE_LINK, kind: "skills-link", mode: "link" },
      {
        path: MCP_FILE,
        kind: "harness-config",
        format: "json",
        managedKeys: [`mcpServers.${SCOPED_MCP}`],
      },
    ]);
  });

  it("empties the servers section rather than deleting a file it co-owns", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("install");

    // A bundle with no servers plans no `.mcp.json` artifact at all, so this can only come from
    // state — and the file stays, because ambit owns keys in it and not the document.
    expect(await readMcpConfig()).toEqual({ mcpServers: {} });
    expect(
      parseState(await readStateFile(), STATE_FILENAME).artifacts.map((artifact) => artifact.path),
    ).not.toContain(MCP_FILE);
  });

  it("leaves a hand-added server and every foreign key untouched", async () => {
    const handmade = { command: "node", args: ["./scripts/local-mcp.js"] };
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade }, extra: { kept: true } }, null, 2)}\n`,
      "utf8",
    );
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await readMcpConfig()).toEqual({ mcpServers: { handmade }, extra: { kept: true } });
  });

  it("leaves a skill directory no state claims alone", async () => {
    await cli("install");
    await writeForeignSkillDir();
    await writeProfile(["core"]);

    await cli("install");

    expect(await installedSkills()).toEqual([CORE_SKILL, HANDMADE_SKILL]);
    expect(await tree(SKILLS_DIR)).toContain(`${HANDMADE_SKILL}/SKILL.md`);
  });

  it("removes an explicitly declared skill once the declaration goes", async () => {
    await writeProfile([], undefined, ["skills:", `  - ${PROJECT_SKILL}`]);
    await cli("install");
    // The project skill requires the core skill and `mcp.fixture`, so dropping it drops all three.
    expect(await installedSkills()).toEqual([PROJECT_SKILL, CORE_SKILL]);
    await writeProfile([]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([]);
    expect(await readMcpConfig()).toEqual({ mcpServers: {} });
    expect(parseState(await readStateFile(), STATE_FILENAME).artifacts).toEqual([]);
  });

  it("changes nothing when the bundle is unchanged", async () => {
    await writeProfile(BOTH_SERVERS);
    await cli("install");
    const servers = await readMcpFile();
    const state = await readStateFile();

    const result = await installProject(projectDir);

    expect(result.pruned).toEqual([]);
    expect(await readMcpFile()).toBe(servers);
    expect(await readStateFile()).toBe(state);
  });

  it("succeeds when what it owned is already gone", async () => {
    await cli("install");
    await rm(path.join(projectDir, SKILLS_DIR, ENGINEERING_SKILL), { recursive: true });
    await rm(path.join(projectDir, MCP_FILE));
    await writeProfile(["core"]);

    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await installedSkills()).toEqual([CORE_SKILL]);
    // Pruning a key from a file someone deleted must not put the file back.
    expect(await pathExists(MCP_FILE)).toBe(false);
  });

  it("exits 2 rather than guessing at a managed key that names no section", async () => {
    await cli("install");
    // A key ambit still owns, so ownership enforcement passes and pruning is what has to deal with
    // the second one — which no build of ambit could have written.
    const state = parseState(await readStateFile(), STATE_FILENAME);
    await writeFile(
      path.join(projectDir, STATE_DIRNAME, STATE_FILENAME),
      serializeState({
        ...state,
        artifacts: state.artifacts.map((artifact) =>
          // `.mcp.json` alone: rewriting every config file's keys would put keys naming no section
          // into the settings file too, and ownership would refuse before pruning got a look.
          artifact.kind === "harness-config" && artifact.path === MCP_FILE
            ? { ...artifact, managedKeys: [`mcpServers.${SCOPED_MCP}`, SCOPED_MCP] }
            : artifact,
        ),
      }),
      "utf8",
    );

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`cannot prune "${SCOPED_MCP}" from ${MCP_FILE}`);
  });
});

/**
 * Spec §7's idempotence claim, whole: a second install of an unchanged project changes no bytes.
 *
 * The individual files are pinned above — state, `.mcp.json`, the tree — but the claim is about all
 * of them at once, and a per-file assertion cannot notice a fifth file appearing. So this compares
 * the entire project, and asserts what the comparison covered: a snapshot that quietly went empty
 * would pass every one of these.
 */
describe("idempotence", () => {
  const PROJECT_FILES = [
    `${STATE_DIRNAME}/${STATE_FILENAME}`,
    `${SKILLS_DIR}/${ENGINEERING_SKILL}/SKILL.md`,
    `${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`,
    `${SKILLS_DIR}/${FRONTEND_SKILL}/SKILL.md`,
    // The script-shipping hook's materialized directory, which is bytes rather than config values.
    `${HOOK_DIR}/HOOK.yml`,
    `${HOOK_DIR}/guard.sh`,
    // The link Claude Code reads through, which is one entry however many skills sit behind it.
    CLAUDE_LINK,
    MCP_FILE,
    CLAUDE_SETTINGS,
    LOCK_FILENAME,
    // Both managed blocks are files install writes, so they belong in the claim: this list is
    // meant to fail when a new one appears.
    GITIGNORE_FILENAME,
    SHARED_GITIGNORE_FILE,
    "ambit.yml",
  ];

  it("changes no bytes on a second identical install", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    const before = await snapshot();
    expect(Object.keys(before).sort()).toEqual([...PROJECT_FILES].sort());

    const second = await cli("install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
  });

  it("changes no bytes on a second install of a project holding content it does not own", async () => {
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade: { command: "node" } }, extra: { kept: true } }, null, 2)}\n`,
      "utf8",
    );
    const foreign = path.join(projectDir, SKILLS_DIR, "hand-written");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "SKILL.md"), "---\nname: hand-written\n---\n", "utf8");

    expect((await cli("install")).code).toBe(ExitCode.Success);
    const before = await snapshot();

    const second = await cli("install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
  });

  it("prints the same report twice", async () => {
    const first = await cli("install");

    expect((await cli("install")).stdout).toBe(first.stdout);
  });
});

describe("state", () => {
  it("treats an absent file as owning nothing", async () => {
    expect(await readState(projectDir)).toEqual(EMPTY_STATE);
  });

  it("rejects a state file from a future version", () => {
    expect(() =>
      parseState('{"version": 2, "harnesses": [], "artifacts": []}', STATE_FILENAME),
    ).toThrowError(/unsupported state version 2/);
  });
});
