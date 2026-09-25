import path from "node:path";
import { configError } from "../errors.js";
import { claude } from "../harness/definitions.js";
import { commandProgram, scriptReference } from "../model/hook-entity.js";
import { parseFrontmatterMapping } from "../model/yaml.js";
import { addFile, collectFiles } from "./files.js";
import type { PackageFiles } from "./files.js";
import type { PluginBundle } from "./resolve.js";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Renders a complete Claude package without reading credential values or executing assets. */
export async function renderClaudePlugin(
  plugin: PluginBundle,
  catalogRoot: string,
): Promise<PackageFiles> {
  const files: PackageFiles = new Map();
  const {
    directory: _directory,
    dependencies: _dependencies,
    commands,
    ...metadata
  } = plugin.metadata;
  void _directory;
  void _dependencies;
  if (commands !== undefined) {
    await collectFiles(files, path.join(catalogRoot, commands), "commands", catalogRoot);
    for (const [file, { data }] of files) {
      if (data !== null && file.endsWith(".md")) parseFrontmatterMapping(data.toString(), file);
    }
  }
  addFile(
    files,
    ".claude-plugin/plugin.json",
    json({
      ...metadata,
      ...(plugin.dependencies.length > 0 && { dependencies: plugin.dependencies }),
    }),
  );
  for (const skill of plugin.bundle.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) {
      throw configError(`${skill.path}/SKILL.md: "${skill.name}" is not a Claude skill name`, [
        "use a flat skill directory with a lowercase hyphenated name of at most 64 characters",
      ]);
    }
    const destination = `skills/${skill.name}`;
    await collectFiles(
      files,
      path.join(skill.catalogRoot, skill.path),
      destination,
      skill.catalogRoot,
    );
    const filename = `${destination}/SKILL.md`;
    const frontmatter = parseFrontmatterMapping(files.get(filename)!.data!.toString(), filename);
    frontmatter.requireString("description");
    for (const key of ["argument-hint", "model", "context", "agent", "license", "compatibility"])
      frontmatter.optionalString(key);
    for (const key of ["disable-model-invocation", "user-invocable"])
      frontmatter.optionalBoolean(key);
    for (const target of files.keys()) {
      if (
        target.startsWith(`${destination}/`) &&
        target.endsWith("/SKILL.md") &&
        target !== filename
      ) {
        throw configError(`${target}: nested skill inside "${skill.name}"`, [
          "move each skill into its own catalog skill directory",
        ]);
      }
    }
  }
  if (plugin.bundle.mcps.length > 0) {
    const servers: Record<string, unknown> = Object.create(null);
    for (const mcp of plugin.bundle.mcps) {
      if (
        mcp.transport.kind === "stdio" &&
        !mcp.transport.command.startsWith("${CLAUDE_PLUGIN_ROOT}/") &&
        (/[\\/]/.test(mcp.transport.command) || mcp.transport.command.startsWith("~"))
      ) {
        throw configError(`${mcp.file}: MCP command references a local file`, [
          "use an executable on PATH; exporting local MCP executables is not supported",
        ]);
      }
      if (
        mcp.transport.kind === "stdio" &&
        mcp.transport.args.some((argument) => /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(argument))
      ) {
        throw configError(`${mcp.file}: MCP argument references a local path`, [
          "bundle the asset in a skill or hook and reference it through ${CLAUDE_PLUGIN_ROOT}, or use a package executable on PATH",
        ]);
      }
      servers[mcp.name] = claude.serverConfig(mcp);
    }
    addFile(files, ".mcp.json", json({ mcpServers: servers }));
  }
  const hooks: Record<string, unknown[]> = {};
  for (const hook of plugin.bundle.hooks) {
    let command = hook.command;
    if (hook.type === "script") {
      await collectFiles(files, path.join(hook.catalogRoot, hook.path), "hooks", hook.catalogRoot, [
        "hook.yml",
        "hook.yaml",
      ]);
      const program = commandProgram(command);
      const reference = scriptReference(program);
      command = `\${CLAUDE_PLUGIN_ROOT}/hooks/${reference}${command.trim().slice(program.length)}`;
    } else if (/^(?:[./~]|[A-Za-z]:[\\/])/.test(commandProgram(command))) {
      throw configError(`${hook.path}/hook.yml: command references a local file`, [
        "use `type: script` and place the script in the hook directory",
      ]);
    }
    (hooks[hook.event] ??= []).push({
      ...(hook.matcher !== undefined && { matcher: hook.matcher }),
      hooks: [
        { type: "command", command, ...(hook.timeout !== undefined && { timeout: hook.timeout }) },
      ],
    });
  }
  if (plugin.bundle.hooks.length > 0) addFile(files, "hooks/hooks.json", json({ hooks }));
  validatePackagePaths(files);
  validateMarkdownPaths(files);
  return files;
}

function validatePackagePaths(files: PackageFiles): void {
  for (const [file, { data }] of files) {
    if (data === null || ![".mcp.json", "hooks/hooks.json"].includes(file)) continue;
    // Component configuration may reference packaged assets, but never a path above the root.
    for (const match of data.toString().matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'`]+)/g)) {
      const target = path.posix.normalize(match[1]!);
      if (target.startsWith("../") || target === ".." || !files.has(target)) {
        throw configError(`${file}: plugin asset "${match[1]}" is missing or escapes the package`, [
          "reference a file included in this plugin's skills or hooks",
        ]);
      }
    }
  }
}

function validateMarkdownPaths(files: PackageFiles): void {
  for (const [file, { data }] of files) {
    if (data === null || !file.endsWith(".md")) continue;
    for (const match of data.toString().matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const link = match[1]!;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|\$)/i.test(link)) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), link.split("#")[0]!),
      );
      if (target === ".." || target.startsWith("../")) {
        throw configError(`${file}: relative link "${link}" escapes the plugin`, [
          "include the referenced asset inside the plugin or use a plugin skill invocation",
        ]);
      }
    }
  }
}

/** Checks explicit Claude skill invocations against the plugin dependency graph. */
export function validateSkillReferences(
  plugins: readonly PluginBundle[],
  rendered: readonly PackageFiles[],
): void {
  const byName = new Map(plugins.map((plugin) => [plugin.metadata.name, plugin]));
  plugins.forEach((plugin, index) => {
    const accessible = new Set<string>();
    const visit = (name: string): void => {
      if (accessible.has(name)) return;
      accessible.add(name);
      for (const dependency of byName.get(name)?.dependencies ?? []) visit(dependency);
    };
    visit(plugin.metadata.name);
    for (const [file, { data }] of rendered[index]!) {
      if (data === null || !file.endsWith(".md")) continue;
      for (const match of data.toString().matchAll(/(?:`|\s)\/([a-z0-9-]+):([a-z0-9-]+)\b/g)) {
        const [, namespace, skill] = match;
        const owner = byName.get(namespace!);
        if (
          !accessible.has(namespace!) ||
          (owner && !owner.bundle.skills.some((item) => item.name === skill))
        ) {
          throw configError(
            `${plugin.directory}/${file}: unavailable skill /${namespace}:${skill}`,
            ["declare the owning pack as a dependency and use its plugin namespace"],
          );
        }
      }
    }
  });
}
