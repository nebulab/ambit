/**
 * Which ambit is running, and which released asset would replace it.
 *
 * Both answers are decided from the current process alone, with no network call, so every refusal
 * self-update can make — npx has nothing to replace, this machine has no binary, the directory is
 * read-only — happens before anything is downloaded.
 *
 * The asset names here are the third copy of one list: `scripts/build.ts` produces them,
 * `install.sh` spells them from `uname`, and {@link assetName} maps `process.platform` and
 * `process.arch` onto them. All three have to agree, and a platform added to one is a 404 until it
 * is added to the other two.
 */
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** How this process was started, which is what decides whether it can replace itself. */
export type InstallKind = "binary" | "npx" | "node";

/**
 * Where a Bun standalone executable's own modules live: a virtual filesystem inside the executable
 * rather than a directory on disk. Windows spells the same thing with a drive letter. Finding one
 * of these in a module's URL is what tells ambit it is the compiled binary and not the npm bundle.
 */
const EMBEDDED_ROOTS: readonly string[] = ["/$bunfs/", "/~BUN/"];

/** The directory segment npx runs a package out of. */
const NPX_SEGMENT = "_npx";

/**
 * This module's own URL, captured where it is a literal.
 *
 * `import.meta.url` rather than `import.meta.dirname`, because the check below is a string match
 * and a URL is the one form every runtime ambit ships on spells the same way. Every `src/` module
 * ends up in one bundle, so which module reads it does not matter.
 */
export const MODULE_URL: string = import.meta.url;

/** The five assets a release publishes, keyed by `<process.platform>-<process.arch>`. */
const ASSETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "ambit-darwin-arm64",
  "darwin-x64": "ambit-darwin-x64",
  "linux-x64": "ambit-linux-x64",
  "linux-arm64": "ambit-linux-arm64",
  "win32-x64": "ambit-windows-x64.exe",
};

/**
 * Which of the three ways of running ambit this is.
 *
 * npx is told apart from a global npm install because the two need opposite advice: a global
 * install is upgraded with `npm i -g`, while npx already fetches the latest version on every run
 * and has nothing to upgrade.
 */
export function installKind(moduleUrl: string, mainPath: string): InstallKind {
  if (EMBEDDED_ROOTS.some((root) => moduleUrl.includes(root))) return "binary";
  if (mainPath.split(/[\\/]/).includes(NPX_SEGMENT)) return "npx";
  return "node";
}

/** The asset for this machine, or `undefined` where no release ships one. */
export function assetName(platform: string, arch: string): string | undefined {
  return ASSETS[`${platform}-${arch}`];
}

/**
 * The file a self-update replaces: the executable this process is running, with every symlink
 * resolved.
 *
 * Resolved because `ambit` on the `PATH` is often a link into wherever it was really installed.
 * Writing over the link would leave the real binary at the old version and break any other link
 * pointing at it.
 *
 * Falls back to the unresolved path when the link cannot be read, so the caller reports a
 * permission problem about a path the user recognizes rather than failing here.
 */
export async function runningBinary(execPath: string): Promise<string> {
  try {
    return await realpath(execPath);
  } catch {
    return execPath;
  }
}

/**
 * Whether the binary can be replaced in place.
 *
 * The directory is what is tested, not the file: the swap is a rename into the directory, so a
 * writable file in a read-only directory still cannot be updated.
 */
export async function canReplace(binary: string): Promise<boolean> {
  try {
    await access(path.dirname(binary), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
