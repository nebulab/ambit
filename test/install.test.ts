/**
 * `ambit install` against the fixture catalog (spec §5, §7): the walking skeleton's last step —
 * config in, skills on disk, ownership recorded.
 *
 * The tree assertions are exhaustive rather than spot checks. "Exactly the resolved skill
 * directories" is the claim A06 makes, and a test that only looks for what should be there would
 * pass while an extra skill sat next to it.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import type { PlannedSkillDir } from "../src/adapter.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../src/catalog.js";
import { loadProjectConfig } from "../src/config.js";
import { ExitCode } from "../src/errors.js";
import { installProject } from "../src/install.js";
import { run } from "../src/program.js";
import type { Bundle } from "../src/resolve.js";
import { resolveBundle } from "../src/resolve.js";
import type { SourceContext } from "../src/sources.js";
import { EMPTY_STATE, STATE_DIRNAME, STATE_FILENAME, parseState, readState } from "../src/state.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".claude/skills";
const MCP_FILE = ".mcp.json";

const CORE_SKILL = "acme.commons.use-company-context";
const ENGINEERING_SKILL = "acme.engineering.use-code-review";
const FRONTEND_SKILL = "acme.engineering.frontend.use-design-tokens";

/** The fixture's scope-matched http server, and the one only `requires` reaches. */
const SCOPED_MCP = "scoped";
const FIXTURE_MCP = "fixture";

/** The variable the scoped server interpolates into its `Authorization` header. */
const SCOPED_KEY_VAR = "SCOPED_API_KEY";

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
  const harnessLine =
    harnesses === undefined ? "" : `harnesses: [${harnesses.join(", ")}]\n`;
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

/** Every file under `dir`, project-relative, `/`-separated and sorted. */
async function tree(dir: string): Promise<readonly string[]> {
  const absolute = path.join(projectDir, dir);
  const found: string[] = [];

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), within);
      } else {
        found.push(within);
      }
    }
  };

  await walk(absolute, "");
  return found.sort();
}

/** The installed skill directory names, sorted. */
async function installedSkills(): Promise<readonly string[]> {
  const entries = await readdir(path.join(projectDir, SKILLS_DIR), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(path.join(projectDir, target));
    return true;
  } catch {
    return false;
  }
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
  // What lands in `.mcp.json` depends on the environment (spec §5), so every test pins it rather
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
    const plan = claudeAdapter.plan(await bundleFor(), { root: projectDir, env: {} });

    expect(plan.map((artifact) => artifact.path)).toEqual([
      `${SKILLS_DIR}/${CORE_SKILL}`,
      `${SKILLS_DIR}/${FRONTEND_SKILL}`,
      `${SKILLS_DIR}/${ENGINEERING_SKILL}`,
      MCP_FILE,
    ]);

    const skills = plan.filter((artifact): artifact is PlannedSkillDir => artifact.kind === "skill-dir");
    expect(skills.map((artifact) => artifact.mode)).toEqual(["copy", "copy", "copy"]);
    expect(skills[0]?.source).toBe(
      path.join(catalogDir, "skills/acme/commons/use-company-context"),
    );
    expect(await pathExists(SKILLS_DIR)).toBe(false);
    expect(await pathExists(MCP_FILE)).toBe(false);
  });

  it("is pure: planning twice yields the same paths", async () => {
    const bundle = await bundleFor();
    const project = { root: projectDir, env: {} };

    expect(claudeAdapter.plan(bundle, project)).toEqual(claudeAdapter.plan(bundle, project));
  });

  it("plans no config file for a bundle with no servers", async () => {
    await writeProfile(["core"]);

    const plan = claudeAdapter.plan(await bundleFor(), { root: projectDir, env: {} });

    expect(plan.map((artifact) => artifact.kind)).toEqual(["skill-dir"]);
  });
});

describe("ambit install", () => {
  it("writes exactly the resolved skill directories", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL, FRONTEND_SKILL, ENGINEERING_SKILL]);
    expect(await tree(SKILLS_DIR)).toEqual([
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
      `${ENGINEERING_SKILL}/SKILL.md`,
    ]);
  });

  it("copies the skill byte-for-byte from the catalog", async () => {
    await cli("install");

    const installed = await readFile(
      path.join(projectDir, SKILLS_DIR, CORE_SKILL, "SKILL.md"),
      "utf8",
    );
    const source = await readFile(
      path.join(catalogDir, "skills/acme/commons/use-company-context/SKILL.md"),
      "utf8",
    );
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
        { path: `${SKILLS_DIR}/${CORE_SKILL}`, kind: "skill-dir", mode: "copy" },
        { path: `${SKILLS_DIR}/${FRONTEND_SKILL}`, kind: "skill-dir", mode: "copy" },
        { path: `${SKILLS_DIR}/${ENGINEERING_SKILL}`, kind: "skill-dir", mode: "copy" },
        { path: MCP_FILE, kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`] },
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
    await cli("install");
    const stale = path.join(projectDir, SKILLS_DIR, CORE_SKILL, "stale.md");
    await writeFile(stale, "left over from an older catalog\n", "utf8");

    await cli("install");

    expect(await tree(SKILLS_DIR)).toEqual([
      `${CORE_SKILL}/SKILL.md`,
      `${FRONTEND_SKILL}/SKILL.md`,
      `${ENGINEERING_SKILL}/SKILL.md`,
    ]);
  });

  it("lists what it wrote", async () => {
    const result = await cli("install");

    // Both columns but the last are padded out to their longest cell, so the kinds line up down
    // the section and the config file's missing mode reads as a gap rather than a shifted row.
    const width = `${SKILLS_DIR}/${FRONTEND_SKILL}`.length;
    expect(result.stdout).toBe(
      [
        "harnesses (1)",
        "  claude",
        "",
        "artifacts (4)",
        `  ${`${SKILLS_DIR}/${CORE_SKILL}`.padEnd(width)}  skill-dir       copy`,
        `  ${SKILLS_DIR}/${FRONTEND_SKILL}  skill-dir       copy`,
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       copy`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  -`,
      ].join("\n"),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("install", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      artifacts: [
        { kind: "skill-dir", mode: "copy", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", mode: "copy", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "skill-dir", mode: "copy", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
      ],
      harnesses: ["claude"],
      skills: [CORE_SKILL, FRONTEND_SKILL, ENGINEERING_SKILL],
    });
    expect(result.stdout).not.toContain(root);
  });

  it("returns the bundle it installed", async () => {
    const result = await installProject(projectDir);

    expect(result.bundle.skills.map((skill) => skill.name)).toEqual([
      CORE_SKILL,
      FRONTEND_SKILL,
      ENGINEERING_SKILL,
    ]);
    expect(result.harnesses).toEqual(["claude"]);
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

  const FIXTURE_SERVER = { command: "npx", args: ["-y", "@acme/fixture-mcp"] };

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

  it("interpolates `${VAR}` in a header from the environment", async () => {
    vi.stubEnv(SCOPED_KEY_VAR, "s3cret");

    await cli("install");

    expect(await readMcpConfig()).toEqual({
      mcpServers: {
        [SCOPED_MCP]: { ...SCOPED_SERVER, headers: { Authorization: "Bearer s3cret" } },
      },
    });
  });

  it("leaves a placeholder in place when its variable is unset, rather than emptying it", async () => {
    await cli("install");

    expect(await readMcpFile()).toContain(`Bearer \${${SCOPED_KEY_VAR}}`);
  });

  it("omits `args` and `headers` a server does not declare", async () => {
    await writeCatalogFile(
      "mcps/plain.yml",
      "name: plain\nscopes: [core]\n\ntransport:\n  stdio:\n    command: plain-mcp\n",
    );
    await writeCatalogFile(
      "mcps/bare.yml",
      "name: bare\nscopes: [core]\n\ntransport:\n  http:\n    url: https://bare.invalid/mcp\n",
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
 * Spec §4.8 end to end: what a project names outright is materialized like anything else, and the
 * `source` form does not need a catalog behind it.
 */
describe("explicitly declared skills and servers", () => {
  const READWISE = "readwise-cli";

  it("installs a skill from its own source and an inline server, holding no scopes", async () => {
    const source = path.join(root, "extra", "skills", READWISE);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), `---\nname: ${READWISE}\n---\n\n# readwise\n`, "utf8");

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
      { path: `${SKILLS_DIR}/${READWISE}`, kind: "skill-dir", mode: "copy" },
      { path: MCP_FILE, kind: "harness-config", managedKeys: ["mcpServers.custom"] },
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
    await writeProfile(["core"], ["cursor"]);

    const result = await cli("install");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown harness "cursor"');
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

  for (const flag of ["--dry-run", "--frozen", "--adopt", "--copy", "--link"]) {
    it(`reports \`${flag}\` as unimplemented instead of ignoring it`, async () => {
      const result = await cli("install", flag);

      expect(result.code).toBe(ExitCode.Internal);
      expect(result.stderr).toContain(`\`${flag}\` is not implemented yet`);
      expect(await pathExists(SKILLS_DIR)).toBe(false);
    });
  }
});

describe("state", () => {
  it("treats an absent file as owning nothing", async () => {
    expect(await readState(projectDir)).toEqual(EMPTY_STATE);
  });

  it("rejects a state file from a future version", () => {
    expect(() => parseState('{"version": 2, "harnesses": [], "artifacts": []}', STATE_FILENAME))
      .toThrowError(/unsupported state version 2/);
  });
});
