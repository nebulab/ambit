/** Reconstructs the retired skills-internal catalog, then checks exports against its current plugins. */
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportPlugins } from "../src/export/export.js";
import { emitYaml } from "../src/model/yaml.js";
import { parseProjectConfig } from "../src/model/config.js";

const repository = path.resolve(process.argv[2] ?? "../skills-internal");
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
const baseline = git("rev-parse", "HEAD").trim();
const retiredConsumer = "dabc028^";
const retiredCatalog = "3e3adc8^";
const workspace = await mkdtemp(path.join(tmpdir(), "ambit-plugin-parity-"));
const source = path.join(workspace, "catalog");
const historical = parseProjectConfig(git("show", `${retiredConsumer}:ambit.yml`), "ambit.yml");

interface Manifest {
  name: string;
  dependencies?: string[];
  [key: string]: unknown;
}
interface NativeMcp {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

async function put(relative: string, content: string): Promise<void> {
  const target = path.join(source, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function inventory(root: string, relative = ""): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const entry of (await readdir(path.join(root, relative))).sort()) {
    const file = path.posix.join(relative, entry);
    const target = path.join(root, file);
    const info = await stat(target);
    if (info.isDirectory()) Object.assign(result, await inventory(root, file));
    else {
      const bytes = await readFile(target);
      result[file] = {
        executable: info.mode & 0o111,
        content: file.endsWith(".json") ? JSON.parse(bytes.toString()) : bytes.toString("base64"),
      };
    }
  }
  return result;
}

try {
  await mkdir(source);
  await cp(path.join(repository, "skills"), path.join(source, "skills"), {
    recursive: true,
    dereference: true,
  });
  await cp(path.join(repository, "hooks"), path.join(source, "hooks"), {
    recursive: true,
    dereference: true,
  });
  const retired = git("ls-tree", "-r", "--name-only", retiredCatalog, "packs", "mcps", "hooks")
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".yml"));
  for (const file of retired) await put(file, git("show", `${retiredCatalog}:${file}`));
  const directories = (await readdir(path.join(repository, "plugins"))).sort();
  const manifests = new Map<string, Manifest>();
  for (const directory of directories) {
    manifests.set(
      directory,
      JSON.parse(
        await readFile(
          path.join(repository, "plugins", directory, ".claude-plugin/plugin.json"),
          "utf8",
        ),
      ) as Manifest,
    );
  }
  // Retain the historical catalog addresses where a current plugin continues that pack.
  const packNames = new Map(
    directories.map((directory) => {
      let name = directory;
      if (directory.startsWith("function-")) name = directory.replace("function-", "function.");
      if (directory.startsWith("client-") && directory !== "client-delivery")
        name = directory.replace("client-", "project.");
      const workflows: Record<string, string> = {
        "content-production": "workflow.content",
        "engagement-surveys": "workflow.engagement-surveys",
        presentations: "workflow.presentations",
        "shopify-development": "workflow.shopify-development",
      };
      return [directory, workflows[directory] ?? name];
    }),
  );
  const local = new Map(
    [...manifests].map(([directory, manifest]) => [manifest.name, packNames.get(directory)!]),
  );
  const mcpDefinitions = new Map<string, string>();
  for (const [directory, manifest] of manifests) {
    const root = path.join(repository, "plugins", directory);
    const requires: Record<string, string>[] = [];
    const skills = await readdir(path.join(root, "skills")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    requires.push(...skills.sort().map((skill) => ({ skill })));
    const mcpText = await readFile(path.join(root, ".mcp.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (mcpText) {
      const mcps = (JSON.parse(mcpText) as { mcpServers: Record<string, NativeMcp> }).mcpServers;
      for (const [name, mcp] of Object.entries(mcps)) {
        const { type, command, args, env, url, headers, ...unsupported } = mcp;
        assert.deepEqual(unsupported, {}, `unhandled MCP fields: ${name}`);
        assert.ok(type === undefined || type === "http" || type === "stdio");
        const transport = command
          ? { stdio: { command, ...(args && { args }), ...(env && { env }) } }
          : { http: { url, ...(headers && { headers }) } };
        const definition = emitYaml({ name, transport });
        assert.ok(
          !mcpDefinitions.has(name) || mcpDefinitions.get(name) === definition,
          `different declarations of MCP ${name}`,
        );
        mcpDefinitions.set(name, definition);
        await put(`mcps/${name}.yml`, definition);
        requires.push({ mcp: name });
      }
    }
    if (directory === "git-workflow") requires.push({ hook: "git-conventions" });
    const external = (manifest.dependencies ?? []).filter((name) => !local.has(name));
    for (const name of manifest.dependencies ?? []) {
      const pack = local.get(name);
      if (pack) requires.push({ pack });
    }
    const { dependencies: _dependencies, ...metadata } = manifest;
    void _dependencies;
    const commands = await stat(path.join(root, "commands")).then(
      () => `commands/${directory}`,
      () => undefined,
    );
    if (commands)
      await cp(path.join(root, "commands"), path.join(source, commands), {
        recursive: true,
        dereference: true,
      });
    const name = packNames.get(directory)!;
    await put(
      `packs/${name.replaceAll(".", "/")}.yml`,
      emitYaml({
        name,
        plugin: {
          ...metadata,
          directory,
          ...(commands && { commands }),
          ...(external.length && { dependencies: external }),
        },
        requires,
      }),
    );
  }
  const catalog = historical.catalogs.find((entry) => entry.source === "path:.");
  assert.ok(catalog, "historical config must select its own catalog");
  await put(
    "ambit.yml",
    emitYaml({
      version: historical.version,
      harnesses: historical.harnesses,
      catalogs: [catalog],
      requires: [...packNames.values()].map((name) => ({ pack: `${catalog.name}/${name}` })),
    }),
  );
  const exported = await exportPlugins(
    { projectDir: source, env: {}, offline: true },
    { output: path.join(workspace, "export") },
  );
  const expected = await inventory(path.join(repository, "plugins"));
  const moved = path.join(workspace, "relocated");
  await rename(exported.output, moved);
  await rm(source, { recursive: true });
  const actual = await inventory(moved);
  const differences = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter(
    (file) => !isDeepStrictEqual(actual[file], expected[file]),
  );
  assert.deepEqual(differences, [], "export differs at these paths");
  // The validator is optional so this comparison can also run without a Claude installation.
  let validated = 0;
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    for (const directory of directories) {
      execFileSync("claude", ["plugin", "validate", path.join(moved, directory)], {
        stdio: "pipe",
      });
      validated++;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(
    JSON.stringify(
      {
        baseline,
        historicalConsumer: git("rev-parse", retiredConsumer).trim(),
        historicalCatalog: git("rev-parse", retiredCatalog).trim(),
        restoredDefinitions: retired.length,
        plugins: directories.length,
        files: Object.keys(expected).length,
        claudeValidated: validated,
        parity:
          "exact dereferenced files, executable permissions, and parsed JSON; source removed before comparison",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
