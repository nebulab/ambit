import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { run } from "../../src/cli/program.js";
import { exportPlugins } from "../../src/export/export.js";
import { loadCatalogs, mergeCatalogs } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { buildLock, serializeLock } from "../../src/project/lock.js";
import { resolveBundle } from "../../src/resolution/resolve.js";

let root: string;
let source: string;
const context = () => ({
  projectDir: source,
  env: { AMBIT_CACHE_DIR: path.join(root, "cache") },
  offline: true,
});

async function put(file: string, value: string): Promise<void> {
  const target = path.join(source, file);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

const read = (file: string) => readFile(path.join(root, "out", file), "utf8");
const json = async (file: string) => JSON.parse(await read(file));
const exportIt = () => exportPlugins(context(), { output: path.join(root, "out") });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-export-test-"));
  source = path.join(root, "source");
  await put(
    "ambit.yml",
    "version: 1\ncatalogs: [{name: local, source: 'path:.'}]\nrequires: [{pack: local/work}]\n",
  );
  await put(
    "packs/work.yml",
    "name: work\nplugin:\n  name: example-work\n  version: 1.2.3\n  description: Work tools\n  author: {name: Example}\n  directory: work\n  dependencies: [external-tools]\nrequires:\n  - skill: do-work\n  - pack: base\n  - hook: check\n  - mcp: api\n",
  );
  await put(
    "packs/base.yml",
    "name: base\nplugin: {name: example-base}\nrequires: [{skill: use-base}]\n",
  );
  await put(
    "skills/do-work/SKILL.md",
    "---\nname: do-work\ndescription: Do work\nambit:\n  requires: [{skill: helper}]\n---\nUse /example-base:use-base.\n",
  );
  await put("skills/helper/SKILL.md", "---\nname: helper\ndescription: Help\n---\nHelp.\n");
  await put("skills/use-base/SKILL.md", "---\nname: use-base\ndescription: Base\n---\nBase.\n");
  await put(
    "hooks/check/hook.yml",
    "name: check\nevent: PreToolUse\nmatcher: Bash\ntype: script\ncommand: check.sh --flag\ntimeout: 5\n",
  );
  await put("hooks/check/check.sh", '#!/bin/sh\ncat "$(dirname "$0")/message.txt"\n');
  await chmod(path.join(source, "hooks/check/check.sh"), 0o755);
  await put("hooks/check/message.txt", "relocated successfully\n");
  await put(
    "mcps/api.yml",
    "name: api\ntransport:\n  http:\n    url: https://example.test/mcp\n    bearer_token_env_var: EXPORT_TEST_TOKEN\n",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("preserves plugin boundaries, external dependencies, and transitive skill requirements", async () => {
  await exportIt();
  expect((await readdir(path.join(root, "out"))).sort()).toEqual(["example-base", "work"]);
  expect(await json("work/.claude-plugin/plugin.json")).toEqual({
    name: "example-work",
    version: "1.2.3",
    description: "Work tools",
    author: { name: "Example" },
    dependencies: ["external-tools", "example-base"],
  });
  expect((await readdir(path.join(root, "out/work/skills"))).sort()).toEqual(["do-work", "helper"]);
  expect(await read("work/skills/do-work/SKILL.md")).toBe(
    await readFile(path.join(source, "skills/do-work/SKILL.md"), "utf8"),
  );
  expect(await json("work/.mcp.json")).toEqual({
    mcpServers: {
      api: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${EXPORT_TEST_TOKEN}" },
      },
    },
  });
  expect(await json("work/hooks/hooks.json")).toEqual({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh --flag", timeout: 5 },
          ],
        },
      ],
    },
  });
  expect((await readdir(path.join(root, "out/work/hooks"))).sort()).toEqual([
    "check.sh",
    "hooks.json",
    "message.txt",
  ]);
  expect(await readdir(source)).not.toContain(".ambit");
  expect(await readdir(source)).not.toContain("ambit.lock");
});

it("copies symlinked assets, preserves executability, and runs after relocation and source removal", async () => {
  await symlink("../../hooks/check/message.txt", path.join(source, "skills/do-work/message.txt"));
  await exportIt();
  const exported = path.join(root, "out/work");

  expect((await lstat(path.join(exported, "skills/do-work/message.txt"))).isSymbolicLink()).toBe(
    false,
  );
  expect((await stat(path.join(exported, "hooks/check.sh"))).mode & 0o777).toBe(0o755);
  await rename(path.join(root, "out"), path.join(root, "moved"));
  await rm(source, { recursive: true });
  expect(
    execFileSync(path.join(root, "moved/work/hooks/check.sh"), { encoding: "utf8", cwd: tmpdir() }),
  ).toBe("relocated successfully\n");
});

it("exports dependency-only packs and expands helper packs without plugin metadata", async () => {
  await put(
    "packs/work.yml",
    "name: work\nplugin: {name: example-work}\nrequires: [{pack: helper}]\n",
  );
  await put("packs/helper.yml", "name: helper\nrequires: [{pack: base}]\n");
  await exportIt();
  expect(await json("example-work/.claude-plugin/plugin.json")).toEqual({
    name: "example-work",
    dependencies: ["example-base"],
  });
  expect(await readdir(path.join(root, "out/example-work"))).toEqual([".claude-plugin"]);
});

it("keeps dependency declaration order and removes duplicates", async () => {
  await put("packs/z.yml", "name: z\nplugin: {name: example-z}\n");
  await put(
    "packs/work.yml",
    "name: work\nplugin: {name: example-work}\nrequires: [{pack: z}, {pack: base}, {pack: z}]\n",
  );
  await exportIt();
  expect((await json("example-work/.claude-plugin/plugin.json")).dependencies).toEqual([
    "example-z",
    "example-base",
  ]);
});

it("copies Claude command files without leaking catalog paths into the manifest", async () => {
  await put(
    "packs/work.yml",
    "name: work\nplugin: {name: example-work, commands: commands/work}\n",
  );
  const command = "---\ndescription: A command\n---\nCommand body.\n";

  await put("commands/work/check.md", command);
  await exportIt();
  expect(await read("example-work/commands/check.md")).toBe(command);
  expect(await json("example-work/.claude-plugin/plugin.json")).toEqual({ name: "example-work" });
});

it("validates a dry run without writing output or its parent", async () => {
  const result = await exportPlugins(context(), { output: "missing/deep/output", dryRun: true });

  expect(result.plugins).toHaveLength(2);
  expect(await readdir(source)).not.toContain("missing");
});

it.each([
  ["missing plugin metadata", "packs/work.yml", "name: work\n", "no plugin metadata"],
  [
    "unsafe output directory",
    "packs/work.yml",
    "name: work\nplugin: {name: good, directory: ../escape}\n",
    "basename",
  ],
  [
    "unknown plugin field",
    "packs/work.yml",
    "name: work\nplugin: {name: good, typo: true}\n",
    "unknown key",
  ],
  [
    "invalid plugin name",
    "packs/work.yml",
    "name: work\nplugin: {name: Bad_Name}\n",
    "plugin names",
  ],
  [
    "unsafe commands path",
    "packs/work.yml",
    "name: work\nplugin: {name: good, commands: ../escape}\n",
    "inside the catalog",
  ],
  [
    "missing skill description",
    "skills/helper/SKILL.md",
    "---\nname: helper\n---\nHelp\n",
    "description",
  ],
  [
    "missing requirement",
    "packs/base.yml",
    "name: base\nplugin: {name: example-base}\nrequires: [{skill: missing}]\n",
    "matches nothing",
  ],
  [
    "dependency cycle",
    "packs/base.yml",
    "name: base\nplugin: {name: example-base}\nrequires: [{pack: work}]\n",
    "cycle",
  ],
  [
    "duplicate plugin names",
    "packs/base.yml",
    "name: base\nplugin: {name: example-work}\n",
    "duplicate plugin",
  ],
  [
    "local MCP executable",
    "mcps/api.yml",
    "name: api\ntransport: {stdio: {command: ./server.js}}\n",
    "local file",
  ],
  [
    "unbundled hook",
    "hooks/check/hook.yml",
    "name: check\nevent: Stop\ntype: command\ncommand: ./local.sh\n",
    "local file",
  ],
  [
    "missing namespace dependency",
    "skills/do-work/SKILL.md",
    "---\nname: do-work\ndescription: Do work\n---\nUse /unknown:missing.\n",
    "unavailable skill",
  ],
  [
    "missing namespaced skill",
    "skills/do-work/SKILL.md",
    "---\nname: do-work\ndescription: Do work\n---\nUse /example-base:missing.\n",
    "unavailable skill",
  ],
])("rejects %s before creating output", async (_label, file, content, diagnostic) => {
  await put(file, content);
  await expect(exportIt()).rejects.toThrow(diagnostic);
  expect(await readdir(root)).not.toContain("out");
});

it("rejects a nested skill layout", async () => {
  await put(
    "skills/do-work/nested/SKILL.md",
    "---\nname: do-work.nested\ndescription: Nested\n---\nNested.\n",
  );
  await expect(exportIt()).rejects.toThrow("nested skill");
});

it("rejects catalog-escaping and cyclic symlinks", async () => {
  await writeFile(path.join(root, "secret"), "not a plugin asset");
  const link = path.join(source, "skills/helper/link");

  await symlink(path.join(root, "secret"), link);
  await expect(exportIt()).rejects.toThrow("escapes its catalog");
  await rm(link);
  await symlink(".", link);
  await expect(exportIt()).rejects.toThrow("cyclic asset");
});

it("rejects a hook asset colliding with the generated config", async () => {
  await put("hooks/check/hooks.json", "{}");
  await expect(exportIt()).rejects.toThrow("path collision");
});

it("refuses an existing output without changing it", async () => {
  await mkdir(path.join(root, "out"));
  await writeFile(path.join(root, "out/keep"), "keep");
  await expect(exportIt()).rejects.toThrow("already exists");
  expect(await read("keep")).toBe("keep");
});

it("requires explicit CLI format and output and supports JSON dry runs", async () => {
  async function cli(args: string[]) {
    const stdout: string[] = [],
      stderr: string[] = [];
    const code = await run(args, {
      cwd: source,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  expect((await cli(["export"])).code).toBe(2);
  expect((await cli(["export", "--format", "agent-plugin", "--output", "out"])).code).toBe(2);
  const result = await cli([
    "export",
    "--format",
    "claude-plugin",
    "--output",
    "out",
    "--dry-run",
    "--json",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).plugins).toHaveLength(2);
  expect(await readdir(source)).not.toContain("out");
});

it("uses locked git revisions reproducibly, including metadata, when offline", async () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });

  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "Initial catalog",
  );
  const commit = git("rev-parse", "HEAD").trim();
  const project = path.join(root, "consumer");

  await mkdir(project);
  await writeFile(
    path.join(project, "ambit.yml"),
    `version: 1\ncatalogs: [{name: local, source: 'file://${source}'}]\nrequires: [{pack: local/work}]\n`,
  );
  const remoteContext = { ...context(), projectDir: project, offline: false };
  const config = await loadProjectConfig(project);
  const catalogs = await loadCatalogs(config, remoteContext);
  const lock = serializeLock(buildLock(catalogs, resolveBundle(config, mergeCatalogs(catalogs))));

  await writeFile(path.join(project, "ambit.lock"), lock);
  expect(catalogs[0]!.commit).toBe(commit);
  await exportPlugins(remoteContext, { output: path.join(root, "first") });
  await put("packs/work.yml", "name: work\nplugin: {name: changed-name}\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "Change metadata",
  );
  await rm(source, { recursive: true });
  await exportPlugins({ ...remoteContext, offline: true }, { output: path.join(root, "second") });
  const compare = (relative: string) => readFile(path.join(root, relative), "utf8");

  expect(await compare("second/work/.claude-plugin/plugin.json")).toBe(
    await compare("first/work/.claude-plugin/plugin.json"),
  );
  expect(await compare("second/work/skills/do-work/SKILL.md")).toBe(
    await compare("first/work/skills/do-work/SKILL.md"),
  );
  expect(await readFile(path.join(project, "ambit.lock"), "utf8")).toBe(lock);
});

it("preserves empty supporting directories", async () => {
  await mkdir(path.join(source, "skills/helper/assets/empty"), { recursive: true });
  await exportIt();
  expect((await stat(path.join(root, "out/work/skills/helper/assets/empty"))).isDirectory()).toBe(
    true,
  );
});

it("rejects malformed Claude frontmatter and links above the plugin root", async () => {
  await put(
    "skills/helper/SKILL.md",
    "---\nname: helper\ndescription: Help\nuser-invocable: 'no'\n---\nHelp.\n",
  );
  await expect(exportIt()).rejects.toThrow("boolean");
  await put(
    "skills/helper/SKILL.md",
    "---\nname: helper\ndescription: Help\n---\n[Outside](../../../outside.md)\n",
  );
  await expect(exportIt()).rejects.toThrow("escapes the plugin");
});

it("rejects missing assets referenced through CLAUDE_PLUGIN_ROOT", async () => {
  await put(
    "mcps/api.yml",
    "name: api\ntransport: {stdio: {command: node, args: ['${CLAUDE_PLUGIN_ROOT}/missing.js']}}\n",
  );
  await expect(exportIt()).rejects.toThrow("missing or escapes");
});

it("rejects an MCP script argument that would depend on the source checkout", async () => {
  await put(
    "mcps/api.yml",
    "name: api\ntransport: {stdio: {command: node, args: ['./server.js']}}\n",
  );
  await expect(exportIt()).rejects.toThrow("local path");
});

it("requires a directory for slash commands and a valid homepage URL", async () => {
  await put("packs/work.yml", "name: work\nplugin: {name: good, homepage: not-a-url}\n");
  await expect(exportIt()).rejects.toThrow("invalid URL");
  await put("packs/work.yml", "name: work\nplugin: {name: good, commands: command.md}\n");
  await put("command.md", "---\ndescription: Command\n---\nBody\n");
  await expect(exportIt()).rejects.toThrow("asset directory");
});

it("links skills and hook assets relative to the final output and survives moving the repository", async () => {
  await exportPlugins(context(), { output: "plugins", link: true });
  const plugin = path.join(source, "plugins/work");

  expect(await readlink(path.join(plugin, "skills/do-work"))).toBe("../../../skills/do-work");
  expect(await readlink(path.join(plugin, "hooks/check.sh"))).toBe("../../../hooks/check/check.sh");
  expect((await lstat(path.join(plugin, "hooks/hooks.json"))).isSymbolicLink()).toBe(false);
  const moved = path.join(root, "moved");

  await rename(source, moved);
  expect(
    await readFile(path.join(moved, "plugins/work/skills/do-work/SKILL.md"), "utf8"),
  ).toContain("Do work");
  expect(
    execFileSync("sh", [path.join(moved, "plugins/work/hooks/check.sh")], { encoding: "utf8" }),
  ).toBe("relocated successfully\n");
});

it("rejects remote catalogs for linked exports even during dry runs", async () => {
  await put(
    "ambit.yml",
    "version: 1\ncatalogs: [{name: remote, source: 'github:example/catalog'}]\nrequires: [{pack: remote/work}]\n",
  );
  await expect(
    exportPlugins(context(), { output: "plugins", link: true, dryRun: true }),
  ).rejects.toThrow("linked exports require local path catalogs");
});

it("checks linked exports without writing and replaces drift while retaining JSON formatting", async () => {
  const options = { output: "plugins", link: true };

  await exportPlugins(context(), options);
  const manifest = path.join(source, "plugins/work/.claude-plugin/plugin.json");
  const original = JSON.parse(await readFile(manifest, "utf8"));
  const formatted = JSON.stringify(original);

  await writeFile(manifest, formatted);
  const before = (await stat(manifest)).mtimeMs;

  await exportPlugins(context(), { ...options, check: true });
  expect((await stat(manifest)).mtimeMs).toBe(before);
  await put("plugins/stale/file", "stale");
  await expect(exportPlugins(context(), { ...options, check: true })).rejects.toMatchObject({
    code: 5,
  });
  expect(await readFile(path.join(source, "plugins/stale/file"), "utf8")).toBe("stale");
  await exportPlugins(context(), { ...options, force: true });
  expect(await readFile(manifest, "utf8")).toBe(formatted);
  expect(await readlink(path.join(source, "plugins/work/skills/do-work"))).toBe(
    "../../../skills/do-work",
  );
  await expect(lstat(path.join(source, "plugins/stale"))).rejects.toMatchObject({ code: "ENOENT" });
  await exportPlugins(context(), { ...options, check: true });
  await writeFile(manifest, JSON.stringify({ ...original, version: "2.0.0" }));
  await expect(exportPlugins(context(), { ...options, check: true })).rejects.toMatchObject({
    code: 5,
  });
});

it("detects changed link targets and copied directories in linked exports", async () => {
  const options = { output: "plugins", link: true };

  await exportPlugins(context(), options);
  const skill = path.join(source, "plugins/work/skills/do-work");

  await rm(skill);
  await symlink("../../../skills/./do-work", skill);
  await expect(exportPlugins(context(), { ...options, check: true })).rejects.toMatchObject({
    code: 5,
  });
  await rm(skill);
  await mkdir(skill);
  await writeFile(
    path.join(skill, "SKILL.md"),
    await readFile(path.join(source, "skills/do-work/SKILL.md")),
  );
  await expect(exportPlugins(context(), { ...options, check: true })).rejects.toMatchObject({
    code: 5,
  });
});

it("detects changed bytes and executable permissions in standalone exports", async () => {
  await exportIt();
  const options = { output: path.join(root, "out"), check: true };

  await exportPlugins(context(), options);
  const script = path.join(root, "out/work/hooks/check.sh");

  await chmod(script, 0o644);
  await expect(exportPlugins(context(), options)).rejects.toMatchObject({ code: 5 });
  await chmod(script, 0o755);
  await writeFile(script, "changed");
  await expect(exportPlugins(context(), options)).rejects.toMatchObject({ code: 5 });
});

it("refuses unsafe replacements and validates before touching an existing export", async () => {
  await expect(exportPlugins(context(), { output: ".", force: true })).rejects.toThrow(
    "contains source files",
  );
  await expect(exportPlugins(context(), { output: "skills", force: true })).rejects.toThrow(
    "contains source files",
  );
  await expect(
    exportPlugins(context(), { output: "skills/do-work/assets", force: true }),
  ).rejects.toThrow("overlaps source assets");
  await symlink(source, path.join(root, "alias"));
  await expect(
    exportPlugins(context(), { output: path.join(root, "alias"), force: true }),
  ).rejects.toThrow("regular directory");
  await exportIt();
  const manifest = await read("work/.claude-plugin/plugin.json");

  await put("skills/helper/SKILL.md", "missing frontmatter");
  await expect(
    exportPlugins(context(), { output: path.join(root, "out"), force: true }),
  ).rejects.toThrow();
  expect(await read("work/.claude-plugin/plugin.json")).toBe(manifest);
});

it("exposes check and force through the CLI and leaves missing output untouched", async () => {
  const args = ["export", "--format", "claude-plugin", "--output", "missing/plugins", "--link"];
  const cli = (flags: string[]) =>
    run([...args, ...flags], { cwd: source, stdout: () => {}, stderr: () => {} });

  expect(await cli(["--check"])).toBe(5);
  expect(await readdir(source)).not.toContain("missing");
  expect(await cli(["--force", "--dry-run"])).toBe(0);
  expect(await readdir(source)).not.toContain("missing");
  expect(await cli(["--force"])).toBe(0);
  expect(await cli(["--check"])).toBe(0);
  expect(await cli(["--check", "--force"])).toBe(2);
  expect(await cli(["--check", "--dry-run"])).toBe(2);
});
