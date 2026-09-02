/**
 * Listing the files of a materialized directory, the way both commands that compare one do.
 *
 * `status` compares an installed directory against its source, and `outdated` compares two revisions
 * of a source. They ask the same question of a tree and differ only in what they do when it cannot be
 * read, so the walk lives here and each keeps its own three-line wrapper.
 *
 * Symlinks are followed rather than listed as leaves. That is not a preference: `applyCatalogDir`
 * (`harness/profile.ts`) copies a catalog directory with its links resolved, so a copy holds the bytes
 * its source points at. A walk that listed the link itself would report every directory composed that
 * way — a plugin whose `skills/` are links into its catalog's own `skills/`, which is how a catalog
 * keeps one copy of a shared skill — as differing from its own copy, permanently.
 */
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a directory entry is a directory, following a symlink to answer for what it points at. */
async function isDirectory(entry: Dirent, target: string): Promise<boolean> {
  if (!entry.isSymbolicLink()) return entry.isDirectory();
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file under `dir`, relative to it, `/`-separated and sorted.
 *
 * Directories are not listed on their own: an empty directory is not a difference worth reporting,
 * and every difference that matters involves a file.
 *
 * The cycle guard tracks the chain currently being walked, not everything seen. Two links naming one
 * directory are two real subtrees of a resolved copy, so skipping the second would report the copy as
 * holding files its source does not. Only a link back to an *ancestor* can recur forever.
 *
 * It also costs nothing until a link is actually followed. A tree of real directories cannot repeat a
 * path, so `realpath` is asked only once the walk has crossed a symlink — which is every skill and
 * every hook script, and almost every plugin's top two levels.
 *
 * @throws whatever `readdir` or `realpath` threw. Callers decide whether an unreadable tree is an
 *   error or an answer, which is the only thing the two of them disagree about.
 */
export async function fileList(dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  const ancestors = new Set<string>();

  const walk = async (current: string, relative: string, followed: boolean): Promise<void> => {
    const resolved = followed ? await realpath(current) : undefined;
    if (resolved !== undefined) {
      if (ancestors.has(resolved)) return;
      ancestors.add(resolved);
    }

    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const child = path.join(current, entry.name);
      if (await isDirectory(entry, child)) {
        await walk(child, within, followed || entry.isSymbolicLink());
      } else {
        found.push(within);
      }
    }

    if (resolved !== undefined) ancestors.delete(resolved);
  };

  await walk(dir, "", false);
  return found.sort(compare);
}
