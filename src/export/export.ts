import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AmbitError, configError } from "../errors.js";
import { loadCatalogs, mergeCatalogs } from "../model/catalog.js";
import { loadProjectConfig } from "../model/config.js";
import type { SourceContext } from "../model/sources.js";
import { renderClaudePlugin, validateSkillReferences } from "./claude.js";
import type { PackageFiles } from "./files.js";
import { resolvePlugins } from "./resolve.js";

export interface ExportOptions {
  readonly output: string;
  readonly dryRun?: boolean;
  readonly link?: boolean;
}

export interface ExportResult {
  readonly output: string;
  readonly plugins: readonly {
    readonly name: string;
    readonly directory: string;
    readonly files: number;
  }[];
}

/**
 * Exports selected packs into a new directory, honoring existing catalog lock pins.
 * @throws {AmbitError} Exit 2 for invalid packages or an existing output; exit 3 for resolution errors.
 */
export async function exportPlugins(
  context: SourceContext,
  options: ExportOptions,
): Promise<ExportResult> {
  let staging: string | undefined;
  try {
    const output = path.resolve(context.projectDir, options.output);
    if (
      await lstat(output).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw configError(`export output already exists: ${output}`, [
        "choose a new output directory",
      ]);
    const config = await loadProjectConfig(context.projectDir);
    if (options.link && config.catalogs.some((catalog) => !catalog.source.startsWith("path:")))
      throw configError("linked exports require local path catalogs", [
        "use local catalogs or omit --link for a standalone export",
      ]);
    const catalogs = await loadCatalogs(config, context);
    const plugins = resolvePlugins(config, mergeCatalogs(catalogs));
    const rendered: PackageFiles[] = [];
    for (const plugin of plugins)
      rendered.push(
        await renderClaudePlugin(
          plugin,
          catalogs.find((catalog) => catalog.name === plugin.pack.catalog)!.root,
        ),
      );
    validateSkillReferences(plugins, rendered);
    const result = {
      output,
      plugins: plugins.map((plugin, index) => ({
        name: plugin.metadata.name,
        directory: plugin.directory,
        files: [...rendered[index]!.values()].filter((file) => file.data !== null).length,
      })),
    };
    if (options.dryRun) return result;
    await mkdir(path.dirname(output), { recursive: true });
    const outputParent = await realpath(path.dirname(output));
    staging = await mkdtemp(path.join(path.dirname(output), ".ambit-export-"));
    for (const [index, files] of rendered.entries()) {
      const linkedDirectories: string[] = [];
      for (const [relative, file] of files) {
        if (linkedDirectories.some((directory) => relative.startsWith(`${directory}/`))) continue;
        const target = path.join(staging, plugins[index]!.directory, relative);
        if (
          options.link &&
          file.source &&
          ((file.data === null && /^skills\/[^/]+$/.test(relative)) ||
            (file.data !== null && relative.startsWith("hooks/")))
        ) {
          await mkdir(path.dirname(target), { recursive: true });
          const finalTarget = path.join(
            outputParent,
            path.basename(output),
            plugins[index]!.directory,
            relative,
          );
          await symlink(
            path.relative(path.dirname(finalTarget), file.source),
            target,
            file.data === null ? "dir" : "file",
          );
          if (file.data === null) linkedDirectories.push(relative);
          continue;
        }
        if (file.data === null) {
          await mkdir(target, { recursive: true });
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.data);
        await chmod(target, file.mode);
      }
    }
    // Reserve the destination exclusively after rendering, so concurrent exports cannot replace it.
    await mkdir(output);
    try {
      await rename(staging, output);
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
    staging = undefined;
    return result;
  } catch (error) {
    if (error instanceof AmbitError) throw error;
    throw configError("cannot export Claude plugins", [
      error instanceof Error ? error.message : String(error),
      "check the source files and output directory permissions",
    ]);
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}
