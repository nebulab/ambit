import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PackageFiles } from "./files.js";

export interface ExportEntry {
  readonly data: Buffer | null;
  readonly mode: number;
  readonly link?: string;
  readonly linkType?: "dir" | "file";
}
export type ExportTree = Map<string, ExportEntry>;

/** Resolves existing ancestors without creating a missing output directory. */
export async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonicalPath(path.dirname(target)), path.basename(target));
  }
}

/** Builds the exported layout, including relative links calculated for its final location. */
export function packageTree(
  packages: readonly { directory: string; files: PackageFiles }[],
  output: string,
  link: boolean,
): ExportTree {
  const tree: ExportTree = new Map();
  const add = (name: string, entry: ExportEntry): void => {
    const parent = path.posix.dirname(name);
    if (parent !== "." && !tree.has(parent)) add(parent, { data: null, mode: 0o755 });
    tree.set(name, entry);
  };
  for (const item of packages) {
    const linkedDirectories: string[] = [];
    for (const [relative, file] of item.files) {
      if (linkedDirectories.some((directory) => relative.startsWith(`${directory}/`))) continue;
      const name = `${item.directory}/${relative}`;
      if (
        link &&
        file.source &&
        ((file.data === null && /^skills\/[^/]+$/.test(relative)) ||
          (file.data !== null && relative.startsWith("hooks/")))
      ) {
        add(name, {
          data: null,
          mode: 0o777,
          link: path.relative(path.dirname(path.join(output, name)), file.source),
          linkType: file.data === null ? "dir" : "file",
        });
        if (file.data === null) linkedDirectories.push(relative);
      } else {
        add(name, file);
      }
    }
  }
  return tree;
}

/** Reads file contents and link targets without following symlinks in an existing export. */
export async function readTree(root: string): Promise<ExportTree> {
  const tree: ExportTree = new Map();
  const visit = async (relative: string): Promise<void> => {
    const target = path.join(root, relative);
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      tree.set(relative, { data: null, mode: 0o777, link: await readlink(target) });
    } else if (info.isDirectory()) {
      if (relative) tree.set(relative, { data: null, mode: info.mode & 0o777 });
      for (const name of (await readdir(target)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      tree.set(relative, { data: await readFile(target), mode: info.mode & 0o777 });
    } else {
      tree.set(relative, { data: null, mode: -1 });
    }
  };
  await visit("");
  return tree;
}

/** Compares JSON values, other file bytes, executable bits, and exact link targets. */
export function sameEntry(name: string, expected: ExportEntry, actual: ExportEntry): boolean {
  if (expected.link !== actual.link) return false;
  if (expected.link !== undefined) return true;
  if (expected.data === null || actual.data === null)
    return expected.data === actual.data && actual.mode !== -1;
  if ((expected.mode & 0o111) !== (actual.mode & 0o111)) return false;
  if (name.endsWith(".json")) {
    try {
      return isDeepStrictEqual(
        JSON.parse(expected.data.toString()),
        JSON.parse(actual.data.toString()),
      );
    } catch {
      return false;
    }
  }
  return expected.data.equals(actual.data);
}
