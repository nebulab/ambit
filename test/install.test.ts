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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { loadCatalogs, mergeCatalogs } from "../src/catalog.js";
import { loadProjectConfig } from "../src/config.js";
import { ExitCode } from "../src/errors.js";
import { installProject } from "../src/install.js";
import { run } from "../src/program.js";
import { resolveBundle } from "../src/resolve.js";
import { EMPTY_STATE, STATE_DIRNAME, STATE_FILENAME, parseState, readState } from "../src/state.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".claude/skills";

const CORE_SKILL = "acme.commons.use-company-context";
const ENGINEERING_SKILL = "acme.engineering.use-code-review";
const FRONTEND_SKILL = "acme.engineering.frontend.use-design-tokens";

let root: string;
let catalogDir: string;
let projectDir: string;

/** Points the project at the fixture catalog and gives it `scopes`. */
async function writeProfile(
  scopes: readonly string[],
  harnesses?: readonly string[],
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
`,
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
  await writeProfile(["core", "function.engineering"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the Claude adapter's plan", () => {
  it("targets one directory per bundle skill, and touches nothing", async () => {
    const config = await loadProjectConfig(projectDir);
    const bundle = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, projectDir)));

    const plan = claudeAdapter.plan(bundle, { root: projectDir });

    expect(plan.map((artifact) => artifact.path)).toEqual([
      `${SKILLS_DIR}/${CORE_SKILL}`,
      `${SKILLS_DIR}/${ENGINEERING_SKILL}`,
    ]);
    expect(plan.map((artifact) => artifact.mode)).toEqual(["copy", "copy"]);
    expect(plan[0]?.source).toBe(
      path.join(catalogDir, "skills/acme/commons/use-company-context"),
    );
    expect(await pathExists(SKILLS_DIR)).toBe(false);
  });

  it("is pure: planning twice yields the same paths", async () => {
    const config = await loadProjectConfig(projectDir);
    const bundle = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, projectDir)));
    const project = { root: projectDir };

    expect(claudeAdapter.plan(bundle, project)).toEqual(claudeAdapter.plan(bundle, project));
  });
});

describe("ambit install", () => {
  it("writes exactly the resolved skill directories", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL, ENGINEERING_SKILL]);
    expect(await tree(SKILLS_DIR)).toEqual([
      `${CORE_SKILL}/SKILL.md`,
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

  it("records every skill directory as an owned artifact", async () => {
    await cli("install");

    const state = parseState(await readStateFile(), STATE_FILENAME);
    expect(state).toEqual({
      version: 1,
      harnesses: ["claude"],
      artifacts: [
        { path: `${SKILLS_DIR}/${CORE_SKILL}`, kind: "skill-dir", mode: "copy" },
        { path: `${SKILLS_DIR}/${ENGINEERING_SKILL}`, kind: "skill-dir", mode: "copy" },
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
      `${ENGINEERING_SKILL}/SKILL.md`,
    ]);
  });

  it("lists what it wrote", async () => {
    const result = await cli("install");

    expect(result.stdout).toBe(
      [
        "harnesses (1)",
        "  claude",
        "",
        "artifacts (2)",
        `  ${SKILLS_DIR}/${CORE_SKILL}  skill-dir  copy`,
        `  ${SKILLS_DIR}/${ENGINEERING_SKILL}  skill-dir  copy`,
      ].join("\n"),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("install", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      artifacts: [
        { kind: "skill-dir", mode: "copy", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", mode: "copy", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
      ],
      harnesses: ["claude"],
      skills: [CORE_SKILL, ENGINEERING_SKILL],
    });
    expect(result.stdout).not.toContain(root);
  });

  it("returns the bundle it installed", async () => {
    const result = await installProject(projectDir);

    expect(result.bundle.skills.map((skill) => skill.name)).toEqual([
      CORE_SKILL,
      ENGINEERING_SKILL,
    ]);
    expect(result.harnesses).toEqual(["claude"]);
  });
});

describe("ambit install failures", () => {
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
