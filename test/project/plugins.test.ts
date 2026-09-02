/**
 * Installing a Claude Code plugin: the one item ambit resolves that only one harness can load.
 *
 * Three claims are load-bearing here, and none of them is checked anywhere else.
 *
 * A plugin lands **in the shared skills directory**, because that is where Claude Code looks for a
 * skills-directory plugin. Nothing is written into `.claude/settings.json` for it, which is the whole
 * argument for this route over a generated marketplace.
 *
 * A copy is **dereferenced**. The fixture's plugin lists a skill the catalog already ships, by
 * relative symlink, which is how a real catalog keeps one copy of a shared skill. Node's `cp` would
 * otherwise copy the link and rewrite its target to an absolute path inside the machine's catalog
 * cache — a path that means nothing on anyone else's machine and dangles the moment the cache is
 * cleared. The install has to arrive as bytes, and `status` has to read those bytes as clean.
 *
 * A harness that does not load plugins **installs nothing and is told so**. That is a `doctor`
 * warning rather than a refusal: one `ambit.yml` is installed by people on different tools, and
 * refusing would make a shared config unusable for whoever is on Codex.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { ExitCode } from "../../src/errors.js";
import { SHARED_SKILLS_DIR } from "../../src/harness/profile.js";
import { diagnoseProject } from "../../src/project/doctor.js";
import { SHARED_GITIGNORE_FILE } from "../../src/project/gitignore.js";
import { projectStatus } from "../../src/project/status.js";
import { readState } from "../../src/model/state.js";
import { run } from "../../src/cli/program.js";

const CATALOG_NAME = "company";

/** The fixture's plugin: its name under `plugins/`, and the pack that names it. */
const PLUGIN = "acme-tools";
const PLUGIN_PACK = "workflow.tooling";

/** Where the plugin is installed, and the skill it composes in by symlink. */
const PLUGIN_DIR = `${SHARED_SKILLS_DIR}/${PLUGIN}`;
const COMPOSED_SKILL = "company-context";

const CLAUDE_LINK = ".claude/skills";
const CLAUDE_SETTINGS = ".claude/settings.json";

let root: string;
let catalogDir: string;
let projectDir: string;

/** Points the project at the fixture catalog with one `requires` list and one harness list. */
async function writeProfile(
  entries: readonly string[],
  harnesses: readonly string[] = ["claude"],
): Promise<void> {
  const list = entries.length === 0 ? "[]" : `\n${entries.join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
harnesses: [${harnesses.join(", ")}]
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
requires: ${list}
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

async function pathExists(relative: string): Promise<boolean> {
  try {
    await stat(path.join(projectDir, relative));
    return true;
  } catch {
    return false;
  }
}

/** Every file under a project-relative directory, `/`-separated and sorted. Follows symlinks. */
async function tree(relative: string): Promise<readonly string[]> {
  const found: string[] = [];

  const walk = async (current: string, within: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const child = path.join(current, entry);
      const at = within === "" ? entry : `${within}/${entry}`;
      if ((await stat(child)).isDirectory()) await walk(child, at);
      else found.push(at);
    }
  };

  await walk(path.join(projectDir, relative), "");
  return found.sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-plugins-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile([`  - { pack: "${CATALOG_NAME}/${PLUGIN_PACK}" }`]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installing a plugin", () => {
  it("materializes it in the shared skills directory, beside where skills go", async () => {
    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)).toBe(true);
  });

  it("records it as a plugin directory, not as a skill", async () => {
    await cli("install");

    const owned = (await readState(projectDir)).artifacts.find(
      (artifact) => artifact.path === PLUGIN_DIR,
    );

    expect(owned?.kind).toBe("plugin-dir");
  });

  it("writes nothing into the harness's own settings for it", async () => {
    // The argument for the skills-directory route over a generated marketplace: Claude finds the
    // plugin because of where it sits, so ambit takes no new ownership in a file the user also writes.
    await cli("install");

    expect(await pathExists(CLAUDE_SETTINGS)).toBe(false);
  });

  it("points the harness's skills directory at it, even with no skill selected", async () => {
    // The link is planned off the whole bundle, not off `skills` alone: a project whose only
    // selection is a plugin still needs Claude looking at the shared directory.
    await cli("install");

    expect((await readState(projectDir)).artifacts.map((artifact) => artifact.path)).toContain(
      CLAUDE_LINK,
    );
    expect(await pathExists(CLAUDE_LINK)).toBe(true);
  });

  it("lists it in the shared .gitignore, so its bytes are not untracked", async () => {
    await cli("install");

    const ignored = await readFile(path.join(projectDir, SHARED_GITIGNORE_FILE), "utf8");

    expect(ignored).toContain(`/${PLUGIN}`);
  });

  it("selects it by name as readily as through the pack that groups it", async () => {
    await writeProfile([`  - { plugin: "${CATALOG_NAME}/${PLUGIN}" }`]);

    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)).toBe(true);
  });

  it("explains it like any other item, through the pack that named it", async () => {
    const result = await cli("why", `plugin:${PLUGIN}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`required-by:pack:${PLUGIN_PACK}`);
  });
});

describe("a copied plugin composed out of the catalog's own skills", () => {
  it("arrives as bytes rather than as a link into the catalog", async () => {
    // `--copy`, because a `path:` catalog would otherwise symlink the whole plugin and never exercise
    // the copy. Without `dereference`, `company-context` would arrive as a link naming an absolute
    // path inside the catalog — machine-specific, and dangling once the catalog moves.
    await cli("install", "--copy");

    const composed = path.join(projectDir, PLUGIN_DIR, "skills", COMPOSED_SKILL);

    expect((await lstat(composed)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(composed, "SKILL.md"), "utf8")).toContain(
      "name: company-context",
    );
  });

  it("carries the whole plugin, manifest and hooks included", async () => {
    await cli("install", "--copy");

    expect(await tree(PLUGIN_DIR)).toEqual([
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      `skills/${COMPOSED_SKILL}/SKILL.md`,
    ]);
  });

  it("reads as clean afterwards, since the copy and its source list the same files", async () => {
    // The regression this guards: comparing a dereferenced copy against a source full of symlinks
    // reported `skills/company-context differs from its source` on every run.
    await cli("install", "--copy");

    const status = await projectStatus(projectDir);
    const row = status.artifacts.find((artifact) => artifact.path === PLUGIN_DIR);

    expect(row?.state, row?.detail).toBe("ok");
  });
});

describe("a plugin whose links are not one-to-one", () => {
  it("keeps both of two links naming one directory, so the copy matches its source", async () => {
    // The walk guards against a link back to an *ancestor*, not against seeing a directory twice.
    // Two links to one skill are two real subtrees of the copy, and a global visited set would list
    // the second in the copy and not in the source, so `status` would report drift forever.
    await symlink(
      `../../../skills/${COMPOSED_SKILL}`,
      path.join(catalogDir, `plugins/${PLUGIN}/skills/also-${COMPOSED_SKILL}`),
      "dir",
    );

    await cli("install", "--copy");

    expect(await tree(PLUGIN_DIR)).toContain(`skills/also-${COMPOSED_SKILL}/SKILL.md`);
    const status = await projectStatus(projectDir);

    expect(status.artifacts.find((artifact) => artifact.path === PLUGIN_DIR)?.state).toBe("ok");
  });

  it("terminates on a link back to its own directory rather than walking forever", async () => {
    // The walk follows symlinks, so a link to an ancestor is a loop. `cp` refuses it first, which is
    // the assertion here — the point is that the run ends and says something, in bounded time.
    await symlink("..", path.join(catalogDir, `plugins/${PLUGIN}/skills/loop`), "dir");

    const result = await cli("install", "--copy");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`cannot copy ${PLUGIN_DIR}`);
  });

  it("refuses a link that points at nothing, naming the catalog rather than crashing", async () => {
    // Dereferencing is what makes this reachable: `cp` reads through the link and finds nothing.
    // Unguarded it surfaces as `unexpected internal error`, which sends the reader to ambit's issue
    // tracker for a broken file in their own catalog.
    await symlink(
      "../../../skills/not-here",
      path.join(catalogDir, `plugins/${PLUGIN}/skills/dangling`),
      "dir",
    );

    const result = await cli("install", "--copy");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`cannot copy ${PLUGIN_DIR}`);
    expect(result.stderr).toContain("correct the link in the catalog, or remove it");
  });
});

describe("a project no harness of which loads plugins", () => {
  beforeEach(async () => {
    await writeProfile([`  - { pack: "${CATALOG_NAME}/${PLUGIN_PACK}" }`], ["codex"]);
  });

  it("installs nothing for it, rather than leaving a directory nothing reads", async () => {
    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(PLUGIN_DIR)).toBe(false);
  });

  it("still resolves and records it, since the same config is installed on other tools", async () => {
    await cli("install");

    expect(await readFile(path.join(projectDir, "ambit.lock"), "utf8")).toContain(
      `  ${PLUGIN}:\n    catalog: ${CATALOG_NAME}`,
    );
  });

  it("says so in doctor, which is the only place that would", async () => {
    await cli("install");

    const report = await diagnoseProject(projectDir);
    const finding = report.findings.find(
      (found) => found.message === "no configured harness reads plugins",
    );

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail.join("\n")).toContain(PLUGIN);
    expect(finding?.detail.join("\n")).toContain("add claude to `harnesses`");
  });
});

describe("a plugin and a skill that share a name", () => {
  it("is refused, because both want one path in the shared directory", async () => {
    await mkdir(path.join(catalogDir, `skills/${PLUGIN}`), { recursive: true });
    await writeFile(
      path.join(catalogDir, `skills/${PLUGIN}/SKILL.md`),
      `---\nname: ${PLUGIN}\n---\n\n# collides with the plugin\n`,
      "utf8",
    );
    await writeProfile([
      `  - { pack: "${CATALOG_NAME}/${PLUGIN_PACK}" }`,
      `  - { skill: "${CATALOG_NAME}/${PLUGIN}" }`,
    ]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`"${PLUGIN}" is selected as both a skill and a plugin`);
    expect(result.stderr).toContain("shared skills directory");
  });
});

describe("a catalog whose plugin manifest is broken", () => {
  it("refuses a manifest that is not valid JSON", async () => {
    await writeFile(
      path.join(catalogDir, `plugins/${PLUGIN}/.claude-plugin/plugin.json`),
      "{ not json\n",
      "utf8",
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("refuses a manifest with no `name`, which Claude requires", async () => {
    await writeFile(
      path.join(catalogDir, `plugins/${PLUGIN}/.claude-plugin/plugin.json`),
      '{ "description": "no name" }\n',
      "utf8",
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("plugin manifest declares no `name`");
  });
});
