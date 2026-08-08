/**
 * More than one harness in one project.
 *
 * The single-harness path is covered exhaustively in `install.test.ts`; what only a multi-harness
 * install can show is what the shared skills directory implies. Two harnesses of the same family name
 * the same skills link, and *every* harness names the same skill directories — so the interesting
 * claims are about a target two adapters both want, and about each harness's own config file being
 * written in its own format at the same time.
 *
 * The migration cases belong here for the same reason: the layout they migrate from is the one that
 * existed before the skills directory was shared.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { ExitCode } from "../../src/errors.js";
import { SHARED_HOOKS_DIR, SHARED_SKILLS_DIR } from "../../src/harness/profile.js";
import { arrayEntryKey, managedKey } from "../../src/model/documents/index.js";
import { installProject } from "../../src/project/install.js";
import { run } from "../../src/cli/program.js";
import { parseState, STATE_DIRNAME, STATE_FILENAME } from "../../src/model/state.js";

const SKILLS_DIR = SHARED_SKILLS_DIR;
const CLAUDE_LINK = ".claude/skills";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";
const ALL_SKILLS = [ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL];

/** The fixture's tag-matched http server, and the variable its `Authorization` header names. */
const PACKED_MCP = "linter";
const PACKED_KEY_VAR = "LINTER_API_KEY";

/**
 * The fixture's two tag-matched hooks: one inline command on `core`, one shipping a script on
 * `function.engineering`. Both harness families here read a Claude-shaped entry and differ in one
 * string — how each spells the way to a materialized script — which is why the keys are built from the
 * entry per root rather than written out.
 */
const HOOK_DIR = `${SHARED_HOOKS_DIR}/guard-secrets`;
const CLAUDE_HOOK_ROOT = `\${CLAUDE_PROJECT_DIR}/${SHARED_HOOKS_DIR}`;

/** The two managed keys a Claude-shaped hooks section holds, in state's own key order. */
function hookKeys(hooksRoot: string): readonly string[] {
  return [
    managedKey(
      "hooks",
      arrayEntryKey("PreToolUse", {
        matcher: "Bash",
        hooks: [{ type: "command", command: `${hooksRoot}/guard-secrets/guard.sh`, timeout: 10 }],
      }),
    ),
    managedKey(
      "hooks",
      arrayEntryKey("SessionStart", {
        hooks: [{ type: "command", command: 'echo "acme conventions apply"' }],
      }),
    ),
  ];
}

let root: string;
let catalogDir: string;
let projectDir: string;

/** One `requires` entry, taking a whole pack from `catalog`. */
function requiresEntry(pack: string, catalog = "company"): string {
  return `  - { pack: "${catalog}/${pack}" }`;
}

async function writeProfile(harnesses: readonly string[]): Promise<void> {
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
harnesses: [${harnesses.join(", ")}]
catalogs:
  - name: company
    source: path:../catalog
requires:
${requiresEntry("core")}
${requiresEntry("function.engineering")}
${requiresEntry("function.engineering.*")}
`,
    "utf8",
  );
}

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

async function read(relative: string): Promise<string> {
  return readFile(path.join(projectDir, relative), "utf8");
}

async function stateArtifacts(): Promise<readonly { path: string; kind: string }[]> {
  return parseState(await read(`${STATE_DIRNAME}/${STATE_FILENAME}`), STATE_FILENAME).artifacts;
}

async function pathExists(relative: string): Promise<boolean> {
  try {
    await lstat(path.join(projectDir, relative));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-harnesses-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Two harnesses that need the same link.
 *
 * Claude Code and Cursor both read `.claude/skills`, so exactly one link is planned, applied, owned
 * and ignored — not two, and not one applied twice, which would mean the second adapter unlinking
 * what the first had just created.
 */
describe("two harnesses of the same family", () => {
  beforeEach(async () => {
    await writeProfile(["claude", "cursor"]);
  });

  it("plans the shared link and the shared skill directories once each", async () => {
    const result = await installProject(projectDir);

    expect(result.harnesses).toEqual(["claude", "cursor"]);
    // One hook directory, shared like the skills — and a config file per harness, because the two
    // read their hooks from files of their own even where they share a skills link.
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
      `${SKILLS_DIR}/${ENGINEERING_SKILL}`,
      `${SKILLS_DIR}/${CORE_SKILL}`,
      `${SKILLS_DIR}/${FRONTEND_SKILL}`,
      HOOK_DIR,
      CLAUDE_LINK,
      ".mcp.json",
      ".claude/settings.json",
      ".cursor/mcp.json",
      ".cursor/hooks.json",
    ]);
  });

  it("writes both config files and one skills tree", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(Object.keys(JSON.parse(await read(".mcp.json")).mcpServers as object)).toEqual([
      PACKED_MCP,
    ]);
    expect(Object.keys(JSON.parse(await read(".cursor/mcp.json")).mcpServers as object)).toEqual([
      PACKED_MCP,
    ]);
    expect((await readdir(path.join(projectDir, SKILLS_DIR))).sort()).toEqual(
      [...ALL_SKILLS].sort(),
    );
    // One link, and it points at the shared directory rather than at a copy of it.
    expect(await readlink(path.join(projectDir, CLAUDE_LINK))).toBe(`../${SKILLS_DIR}`);
  });

  it("records each shared artifact once", async () => {
    await cli("install");

    const paths = (await stateArtifacts()).map((artifact) => artifact.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists the link once in the managed .gitignore block", async () => {
    await cli("install");

    const contents = await read(".gitignore");
    expect(contents.split(CLAUDE_LINK)).toHaveLength(2);
  });

  it("changes no bytes on a second install", async () => {
    await cli("install");
    const before = [
      await read(".mcp.json"),
      await read(".cursor/mcp.json"),
      await read(".gitignore"),
    ];

    const second = await cli("install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);

    expect([
      await read(".mcp.json"),
      await read(".cursor/mcp.json"),
      await read(".gitignore"),
    ]).toEqual(before);
    expect(await readlink(path.join(projectDir, CLAUDE_LINK))).toBe(`../${SKILLS_DIR}`);
  });
});

/**
 * Two harnesses from different families, which is the case that exercises two document formats in one
 * run: `.mcp.json` through the JSON driver and `.codex/config.toml` through the TOML one.
 */
describe("two harnesses from different families", () => {
  beforeEach(async () => {
    await writeProfile(["claude", "codex"]);
  });

  it("writes each harness's config in that harness's own file and format", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(JSON.parse(await read(".mcp.json"))).toEqual({
      mcpServers: {
        [PACKED_MCP]: {
          type: "http",
          url: "https://mcp.invalid/fixture",
          headers: { Authorization: `Bearer \${${PACKED_KEY_VAR}}` },
        },
      },
    });
    expect(await read(".codex/config.toml")).toBe(`[mcp_servers.linter]
url = "https://mcp.invalid/fixture"

[mcp_servers.linter.http_headers]
Authorization = "Bearer \${${PACKED_KEY_VAR}}"
`);
  });

  it("materializes the skills once, and links only for the harness that needs it", async () => {
    await cli("install");

    expect((await readdir(path.join(projectDir, SKILLS_DIR))).sort()).toEqual(
      [...ALL_SKILLS].sort(),
    );
    // Codex reads `.agents/skills` natively, so it gets no directory of its own.
    expect(await pathExists(CLAUDE_LINK)).toBe(true);
    expect(await pathExists(".codex/skills")).toBe(false);
  });

  it("records the format of each config file, so pruning knows how to edit it", async () => {
    await cli("install");

    expect(
      (await stateArtifacts()).filter((artifact) => artifact.kind === "harness-config"),
    ).toEqual(
      // In state's own order, which is by path — so a diff of two installs reads as a diff.
      [
        {
          path: ".claude/settings.json",
          kind: "harness-config",
          format: "json",
          shape: "array",
          managedKeys: hookKeys(CLAUDE_HOOK_ROOT),
        },
        {
          path: ".codex/config.toml",
          kind: "harness-config",
          format: "toml",
          managedKeys: [`mcp_servers.${PACKED_MCP}`],
        },
        {
          path: ".codex/hooks.json",
          kind: "harness-config",
          format: "json",
          shape: "array",
          // The same entry shape, and one string apart: Codex interpolates nothing, so its copy of
          // the script-shipping hook carries the project-relative path.
          managedKeys: hookKeys(SHARED_HOOKS_DIR),
        },
        {
          path: ".mcp.json",
          kind: "harness-config",
          format: "json",
          managedKeys: [`mcpServers.${PACKED_MCP}`],
        },
      ],
    );
  });

  it("prunes the stale server from both files, in both formats", async () => {
    await cli("install");
    // A profile with no servers, so the one both files hold is stale.
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      `version: 1
harnesses: [claude, codex]
catalogs:
  - name: company
    source: path:../catalog
requires:
${requiresEntry("core")}
`,
      "utf8",
    );

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(JSON.parse(await read(".mcp.json"))).toEqual({ mcpServers: {} });
    // The TOML file is co-owned like the JSON one, so it stays — holding nothing of ambit's.
    expect(await read(".codex/config.toml")).toBe("");
  });

  it("leaves a Codex config's own settings and comments exactly as they were", async () => {
    const handwritten = `# Mine, not ambit's.
model = "gpt-5-codex"

[sandbox]
mode = "read-only"
`;
    await mkdir(path.join(projectDir, ".codex"), { recursive: true });
    await writeFile(path.join(projectDir, ".codex/config.toml"), handwritten, "utf8");

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect((await read(".codex/config.toml")).startsWith(handwritten)).toBe(true);
  });
});

describe("all five harnesses at once", () => {
  it("writes one skills tree, one link, and five config files", async () => {
    await writeProfile(["claude", "codex", "cursor", "opencode", "vscode"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect((await readdir(path.join(projectDir, SKILLS_DIR))).sort()).toEqual(
      [...ALL_SKILLS].sort(),
    );
    for (const file of [
      ".mcp.json",
      ".codex/config.toml",
      ".cursor/mcp.json",
      ".opencode/opencode.jsonc",
      ".vscode/mcp.json",
    ]) {
      expect(await pathExists(file), file).toBe(true);
    }
    // Each skill is materialized once however many harnesses read it: three directories, not fifteen.
    expect(
      (await stateArtifacts()).filter((artifact) => artifact.kind === "skill-dir"),
    ).toHaveLength(ALL_SKILLS.length);
  });

  it("reports no drift afterwards, in all three document formats at once", async () => {
    await writeProfile(["claude", "codex", "cursor", "opencode", "vscode"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    const result = await cli("status", "--check");

    // The one case that compares a JSON, a JSONC and a TOML file in a single run — each through its
    // own driver's notion of "already what install would write".
    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });

  it("passes doctor with every referenced variable set", async () => {
    await writeProfile(["claude", "codex", "cursor", "opencode", "vscode"]);
    await cli("install");
    // Every variable the bundle references, whichever entity declared it: `doctor` reads the
    // environment rather than the files, so a reference in five formats is still one question.
    process.env[PACKED_KEY_VAR] = "s3cret";
    process.env.ACME_FIGMA_TOKEN = "figma-token";

    try {
      const result = await cli("doctor");
      expect(result.code, result.stderr).toBe(ExitCode.Success);
    } finally {
      delete process.env[PACKED_KEY_VAR];
      delete process.env.ACME_FIGMA_TOKEN;
    }
  });
});

/**
 * `doctor`'s environment check across harnesses.
 *
 * The check is about the environment, so its answer must not depend on which harness's file the
 * reference landed in — and every harness spells a reference differently, including one (Codex) that
 * writes the bare variable name. A check that read the installed bytes would work for Claude Code and
 * quietly stop working for the rest.
 */
describe("a variable referenced by a header and not declared in `env`", () => {
  beforeEach(async () => {
    await writeFile(
      path.join(catalogDir, "mcps/undeclared.yml"),
      `name: undeclared

transport:
  http:
    url: https://mcp.invalid/undeclared
    headers:
      Authorization: "Bearer \${UNDECLARED_TOKEN}"
`,
      "utf8",
    );
    // Beside the fixture's own `core` pack, rewritten so the profile's entry reaches this server too.
    await writeFile(
      path.join(catalogDir, "packs/core.yml"),
      [
        "name: core",
        "description: What every Acme session needs, whoever is in it.",
        "requires:",
        "  - skill: company-context",
        "  - hook: session-notes",
        "  - mcp: undeclared",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  for (const harness of ["claude", "codex", "cursor", "opencode", "vscode"]) {
    it(`is reported for ${harness}`, async () => {
      await writeProfile([harness]);
      expect((await cli("install")).code).toBe(ExitCode.Success);

      const result = await cli("doctor");

      expect(result.code).toBe(ExitCode.Doctor);
      expect(result.stdout).toContain('unset environment variable "UNDECLARED_TOKEN"');
      expect(result.stdout).toContain("references it, for the harness to expand at spawn");
    });
  }
});

/**
 * Migration from the layout that predates the shared skills directory.
 *
 * The old layout put every skill in `.claude/skills/<name>/`, which is now the path of the link
 * itself. ambit adopts that directory implicitly — but only when it installed everything in it, which
 * is exactly when replacing it with a link loses nothing.
 */
describe("migrating an old-layout .claude/skills", () => {
  beforeEach(async () => {
    await writeProfile(["claude"]);
  });

  /** A `.claude/skills` holding skill directories a prior install recorded as ambit's. */
  async function writeOldLayout(extra?: string): Promise<void> {
    const state = {
      version: 1,
      harnesses: ["claude"],
      artifacts: ALL_SKILLS.map((name) => ({
        path: `${CLAUDE_LINK}/${name}`,
        kind: "skill-dir",
        mode: "link",
      })),
    };
    for (const name of ALL_SKILLS) {
      const target = path.join(projectDir, CLAUDE_LINK, name);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
    if (extra !== undefined) {
      const target = path.join(projectDir, CLAUDE_LINK, extra);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), `---\nname: ${extra}\n---\n`, "utf8");
    }
    await mkdir(path.join(projectDir, STATE_DIRNAME), { recursive: true });
    await writeFile(
      path.join(projectDir, STATE_DIRNAME, STATE_FILENAME),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  it("replaces a directory of ambit's own skills with the link, without `--adopt`", async () => {
    await writeOldLayout();

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // ambit wrote everything that was in there, so turning the container into a link loses nothing —
    // which is why this one adoption is implicit rather than something to ask a person about.
    expect(await readlink(path.join(projectDir, CLAUDE_LINK))).toBe(`../${SKILLS_DIR}`);
    // And the skills survive the same run's pruning. Prior state owns `.claude/skills/<name>`, which
    // the new link now resolves through, so a prune that followed it would delete the install it had
    // just made.
    expect((await readdir(path.join(projectDir, SKILLS_DIR))).sort()).toEqual(
      [...ALL_SKILLS].sort(),
    );
    expect((await stateArtifacts()).map((artifact) => artifact.path)).toContain(CLAUDE_LINK);
  });

  it("refuses when one hand-written skill sits in there, and names `--adopt`", async () => {
    await writeOldLayout("hand-written");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned path");
    expect(result.stderr).toContain(
      `${CLAUDE_LINK} exists but ambit did not create it, so it cannot be pointed at ${SKILLS_DIR}`,
    );
    expect(result.stderr).toContain("run `ambit install --adopt` to take ownership");
    // And the person's skill is still there, which is the whole point of refusing.
    expect(await read(`${CLAUDE_LINK}/hand-written/SKILL.md`)).toContain("name: hand-written");
  });

  it("takes it over under `--adopt`, which is what the refusal offered", async () => {
    await writeOldLayout("hand-written");

    const result = await cli("install", "--adopt");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await readlink(path.join(projectDir, CLAUDE_LINK))).toBe(`../${SKILLS_DIR}`);
  });

  it("reports a dangling symlink as unowned rather than crashing", async () => {
    // What dotagents leaves behind, and the shape that used to surface as "this is a bug in ambit":
    // `mkdir` on a path whose ancestor is a dangling link fails with ENOENT.
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await symlink("../.agents/skills", path.join(projectDir, CLAUDE_LINK), "dir");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite unowned path");
    expect(result.stderr).not.toContain("this is a bug in ambit");
  });

  /**
   * The same shape one level up, which `--adopt` cannot help with.
   *
   * A dangling link *at* a planned path is something ambit refuses and can be told to take over. A
   * dangling link an artifact has to be created *under* is different: `mkdir -p` cannot descend
   * through it, so adopting the artifact would still fail — and it used to fail as "unexpected
   * internal error … this is a bug in ambit", from deep inside apply.
   */
  it("refuses a dangling symlink standing where a parent directory belongs, and says what to move", async () => {
    await symlink("nowhere", path.join(projectDir, ".agents"), "dir");

    for (const argv of [["install"], ["install", "--adopt"]]) {
      const result = await cli(...argv);

      expect(result.code).toBe(ExitCode.Config);
      expect(result.stderr).toContain("refusing to write under an unowned path");
      expect(result.stderr).toContain(
        `.agents is not a directory ambit can write into, so ${SKILLS_DIR}/${ENGINEERING_SKILL} cannot be created`,
      );
      expect(result.stderr).toContain("move .agents aside, or point it at a directory that exists");
      // Never the internal-error wording, and `--adopt` is not offered, because it would not help.
      expect(result.stderr).not.toContain("this is a bug in ambit");
      expect(result.stderr).not.toContain("--adopt` to take ownership");
    }
  });

  it("refuses a plain file standing where a parent directory belongs", async () => {
    await writeFile(path.join(projectDir, ".agents"), "not a directory\n", "utf8");

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to write under an unowned path");
    expect(await read(".agents")).toBe("not a directory\n");
  });

  it("writes through a parent directory that is a link to a real directory", async () => {
    // A symlinked ancestor is only a problem when it dangles: one pointing at a directory is a
    // directory as far as writing into it goes, and refusing it would break anyone who keeps
    // `.agents` on another volume.
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(path.relative(projectDir, elsewhere), path.join(projectDir, ".agents"), "dir");

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect((await readdir(path.join(elsewhere, "skills"))).sort()).toEqual([...ALL_SKILLS].sort());
  });

  it("adopts a dangling symlink and points it at the shared directory", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await symlink("../.agents/skills", path.join(projectDir, CLAUDE_LINK), "dir");

    const result = await cli("install", "--adopt");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await readlink(path.join(projectDir, CLAUDE_LINK))).toBe(`../${SKILLS_DIR}`);
    expect((await readdir(path.join(projectDir, SKILLS_DIR))).sort()).toEqual(
      [...ALL_SKILLS].sort(),
    );
  });
});
