import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { configError } from "../errors.js";

export interface PackageFile {
  /** Null denotes a directory, including an empty asset directory. */
  readonly data: Buffer | null;
  readonly mode: number;
  readonly source?: string;
}
export type PackageFiles = Map<string, PackageFile>;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Adds one package file, refusing collisions instead of overwriting another component. */
export function addFile(
  files: PackageFiles,
  target: string,
  data: Buffer | string,
  mode = 0o644,
): void {
  if (files.has(target) || [...files.keys()].some((file) => file.startsWith(`${target}/`))) {
    throw configError(`export path collision at ${target}`, [
      "rename the conflicting skill or hook asset",
    ]);
  }

  files.set(target, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode });
}

/** Dereferences assets inside the catalog, rejecting cycles and external symlink targets. */
export async function collectFiles(
  files: PackageFiles,
  source: string,
  destination: string,
  catalogRoot: string,
  exclude: readonly string[] = [],
): Promise<void> {
  const root = await realpath(catalogRoot);

  if (!(await stat(source)).isDirectory()) {
    throw configError(`${source}: expected an asset directory`, [
      "point this component at a directory inside the catalog",
    ]);
  }

  const walk = async (
    file: string,
    target: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    const actual = await realpath(file);

    if (!isWithin(root, actual)) {
      throw configError(`${file}: asset escapes its catalog`, [
        "move the asset into the catalog before exporting",
      ]);
    }

    if (ancestors.has(actual)) {
      throw configError(`${file}: cyclic asset symlink`, ["remove the cycle before exporting"]);
    }

    const info = await stat(actual);

    if (info.isDirectory()) {
      const existing = files.get(target);

      if (existing?.data) {
        throw configError(`export path collision at ${target}`, ["rename the conflicting asset"]);
      }

      files.set(target, { data: null, mode: info.mode & 0o777, source: actual });
      const next = new Set([...ancestors, actual]);

      for (const name of (await readdir(actual)).sort()) {
        if (file === source && exclude.includes(name)) {
          continue;
        }

        await walk(path.join(actual, name), `${target}/${name}`, next);
      }
    } else if (info.isFile()) {
      addFile(files, target, await readFile(actual), info.mode & 0o777);
      files.set(target, { ...files.get(target)!, source: actual });
    } else {
      throw configError(`${file}: unsupported asset type`, [
        "package only regular files and directories",
      ]);
    }
  };

  await walk(source, destination, new Set());
}
