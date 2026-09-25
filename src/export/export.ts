import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AmbitError, configError, driftError } from "../errors.js";
import { loadCatalogs, mergeCatalogs } from "../model/catalog.js";
import { loadProjectConfig } from "../model/config.js";
import type { SourceContext } from "../model/sources.js";
import { renderClaudePlugin, validateSkillReferences } from "./claude.js";
import type { PackageFiles } from "./files.js";
import { resolvePlugins } from "./resolve.js";
import { canonicalPath, packageTree, readTree, sameEntry } from "./tree.js";

export interface ExportOptions {
  readonly output: string;
  readonly dryRun?: boolean;
  readonly link?: boolean;
  readonly force?: boolean;
  readonly check?: boolean;
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
 * Exports or checks selected packs, honoring existing catalog lock pins.
 * @throws {AmbitError} Exit 2 for invalid packages or an existing output; exit 3 for resolution errors; exit 5 for drift.
 */
export async function exportPlugins(
  context: SourceContext,
  options: ExportOptions,
): Promise<ExportResult> {
  let staging: string | undefined;
  try {
    const output = path.resolve(context.projectDir, options.output);
    if (options.check && (options.force || options.dryRun))
      throw configError("--check cannot be combined with --force or --dry-run");
    const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && !options.force && !options.check)
      throw configError(`export output already exists: ${output}`, [
        "use --force to regenerate it or --check to check for drift",
      ]);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw configError(`export output must be a regular directory: ${output}`);
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
    const finalOutput = await canonicalPath(output);
    const contains = (root: string, target: string): boolean => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    if (options.force) {
      const roots = [context.projectDir, ...catalogs.map((catalog) => catalog.root)];
      const assets = plugins.flatMap((plugin) =>
        [...plugin.bundle.skills, ...plugin.bundle.hooks].map((asset) =>
          path.join(asset.catalogRoot, asset.path),
        ),
      );
      for (const source of [...roots, ...assets]) {
        const actual = await canonicalPath(source);
        if (
          contains(finalOutput, actual) ||
          (assets.includes(source) && contains(actual, finalOutput))
        )
          throw configError(
            `export output contains source files or overlaps source assets: ${output}`,
            ["choose a directory outside the catalog's skills and hooks"],
          );
      }
    }
    const tree = packageTree(
      plugins.map((plugin, index) => ({
        directory: plugin.directory,
        files: rendered[index]!,
      })),
      finalOutput,
      options.link === true,
    );
    const current = existing ? await readTree(output) : new Map();
    if (options.check) {
      const differences = [...new Set([...tree.keys(), ...current.keys()])]
        .sort()
        .filter(
          (name) =>
            !tree.has(name) ||
            !current.has(name) ||
            !sameEntry(name, tree.get(name)!, current.get(name)!),
        );
      if (!existing || differences.length)
        throw driftError(`export differs from ${output}`, [
          ...differences,
          "run export with --force to regenerate it",
        ]);
      return result;
    }
    if (options.dryRun) return result;
    await mkdir(path.dirname(output), { recursive: true });
    staging = await mkdtemp(path.join(path.dirname(output), ".ambit-export-"));
    for (const [relative, file] of tree) {
      const target = path.join(staging, relative);
      if (file.link !== undefined) {
        await symlink(file.link, target, file.linkType);
      } else if (file.data === null) {
        await mkdir(target, { recursive: true });
      } else {
        const previous = current.get(relative);
        // Retain JSON formatting for unchanged values to avoid unrelated marketplace diffs.
        const data =
          previous?.data && sameEntry(relative, file, previous) ? previous.data : file.data;
        await writeFile(target, data);
        await chmod(target, file.mode);
      }
    }
    if (existing) {
      const backup = await mkdtemp(path.join(path.dirname(output), ".ambit-export-"));
      try {
        await rename(output, path.join(backup, "previous"));
        try {
          await rename(staging, output);
        } catch (error) {
          await rename(path.join(backup, "previous"), output);
          throw error;
        }
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        // Keep the backup available if restoring the previous export also fails.
        throw configError(`cannot replace export at ${output}`, [
          String(error),
          `previous export backup: ${backup}`,
        ]);
      }
    } else {
      // Reserve exclusively so concurrent exports cannot replace another writer's output.
      await mkdir(output);
      try {
        await rename(staging, output);
      } catch (error) {
        await rm(output, { recursive: true, force: true });
        throw error;
      }
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
