/**
 * Replacing the running ambit binary with a released one.
 *
 * Split into a plan and an apply, because everything that can refuse the update is knowable before
 * a byte is downloaded: how ambit was installed, whether a release ships an asset for this machine,
 * whether the file can be written at all. `--dry-run` is the plan on its own.
 *
 * Two invariants the apply holds:
 *
 * - **The bytes are verified before they are installed.** The download is hashed as it streams and
 *   checked against the release's `checksums.txt`, the same file `install.sh` checks against. A
 *   mismatch deletes the download and leaves the old binary in place. There is no flag to skip it.
 * - **The swap is a rename.** A rename within one directory is atomic, so an interrupted update
 *   leaves either the old binary or the new one and never a half-written file where ambit used to
 *   be. Windows cannot rename over a running executable, so there the old one is moved aside
 *   first; see {@link swapInPlace}.
 */
import { rename, rm } from "node:fs/promises";

import { configError, networkError } from "../errors.js";
import type { InstallKind } from "./platform.js";
import { assetName, canReplace, installKind, runningBinary } from "./platform.js";
import type { Fetch } from "./release.js";
import {
  CHECKSUMS_ASSET,
  asTag,
  checksumFor,
  downloadAsset,
  fetchAssetText,
  isNewer,
  latestTag,
} from "./release.js";
import { VERSION } from "../version.js";

/**
 * Everything self-update reads about the machine it runs on, gathered at the CLI boundary.
 *
 * Passed in rather than read from `process` down here, so one command run sees one machine and a
 * test can describe a different one without touching the real environment. Same reason
 * `sourceContextOf` exists for the commands that resolve catalogs.
 */
export interface SelfContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The executable this process is running, before symlinks are resolved. */
  readonly execPath: string;
  /** The URL of a bundled module, which is what tells a compiled binary apart from the npm build. */
  readonly moduleUrl: string;
  /** `process.argv[1]`, which is what tells npx apart from a global npm install. */
  readonly mainPath: string;
  readonly fetch: Fetch;
}

/** What an update would do, decided without downloading anything. */
export interface SelfUpdatePlan {
  readonly kind: InstallKind;
  /** The version running now, as `package.json` spells it: no leading `v`. */
  readonly current: string;
  /** The release that would be installed, as a tag: with a leading `v`. */
  readonly target: string;
  readonly asset: string;
  /** The file that would be replaced, with symlinks resolved. */
  readonly binary: string;
  /** Whether {@link target} is a different release from {@link current}. */
  readonly changed: boolean;
}

/** Suffix of the download while it is still unverified, beside the binary it may replace. */
const INCOMING_SUFFIX = ".incoming";

/** Suffix of the displaced binary on Windows, which cannot rename over a running executable. */
const DISPLACED_SUFFIX = ".old";

/**
 * Why this ambit cannot replace itself, for the two installs that are not a binary.
 *
 * npx and a global npm install need opposite advice, so they are separate messages rather than one
 * that names both and leaves the reader to pick.
 */
function refuseKind(kind: "npx" | "node"): never {
  if (kind === "npx") {
    throw configError("`npx @teamnebulab/ambit` has nothing to update", [
      "npx downloads the latest published version every time it runs",
      "to keep a copy on disk instead, install the binary: see https://github.com/nebulab/ambit#install",
    ]);
  }

  throw configError("this ambit was installed from npm, so npm is what updates it", [
    "`ambit self-update` replaces a standalone binary, and there is none here",
    "run `npm i -g @teamnebulab/ambit@latest`",
  ]);
}

/**
 * What `ambit self-update` would do, or the reason it cannot.
 *
 * The local refusals are made in order of cost: how ambit was installed, then whether this machine
 * has an asset, then whether the file can be written. Only after all three does anything reach the
 * network, so a user on a read-only install is told so immediately rather than after a 100 MB
 * download.
 *
 * @throws {AmbitError} exit 2 when ambit did not come from a binary, when no release ships an asset
 *   for this platform, or when the binary's directory is not writable; exit 4 when the latest
 *   release cannot be looked up.
 */
export async function planSelfUpdate(
  context: SelfContext,
  requested?: string,
): Promise<SelfUpdatePlan> {
  const kind = installKind(context.moduleUrl, context.mainPath);
  if (kind !== "binary") refuseKind(kind);

  const asset = assetName(context.platform, context.arch);
  if (asset === undefined) {
    throw configError(`no ambit binary is published for ${context.platform}-${context.arch}`, [
      "this build cannot replace itself with one that does not exist",
      "run ambit from npm instead: `npx @teamnebulab/ambit`",
    ]);
  }

  const binary = await runningBinary(context.execPath);
  if (!(await canReplace(binary))) {
    throw configError(`cannot write to the directory holding ${binary}`, [
      "self-update replaces the binary in place, and that needs write access to its directory",
      "reinstall it somewhere writable, or run the install script with the permissions it needs:",
      "curl -fsSL https://raw.githubusercontent.com/nebulab/ambit/main/install.sh | sh",
    ]);
  }

  const target = requested === undefined ? await latestTag(context.fetch) : asTag(requested);

  return {
    kind,
    current: VERSION,
    target,
    asset,
    binary,
    changed: asTag(VERSION) !== target,
  };
}

/**
 * Puts `incoming` where `binary` is.
 *
 * POSIX renames straight over the running executable: the running process keeps the old inode, and
 * the next run gets the new one. Windows refuses to replace a file that is open for execution, but
 * allows *renaming* it, so the old binary is moved aside first and the new one takes its name. The
 * displaced file cannot be deleted while it is still running, so a failure to remove it is
 * ignored; {@link applySelfUpdate} sweeps it up on the next run.
 */
export async function swapInPlace(
  binary: string,
  incoming: string,
  windows: boolean,
): Promise<void> {
  if (!windows) {
    await rename(incoming, binary);
    return;
  }

  const displaced = `${binary}${DISPLACED_SUFFIX}`;
  await rename(binary, displaced);
  try {
    await rename(incoming, binary);
  } catch (error) {
    await rename(displaced, binary);
    throw error;
  }

  try {
    await rm(displaced, { force: true });
  } catch {
    // Still running. The next self-update removes it.
  }
}

/**
 * Downloads the planned release, verifies it, and swaps it in.
 *
 * @throws {AmbitError} exit 4 when the download fails or its hash does not match the release's
 *   `checksums.txt`. Either way the old binary is untouched and the download is deleted.
 */
export async function applySelfUpdate(plan: SelfUpdatePlan, context: SelfContext): Promise<void> {
  const windows = context.platform === "win32";
  const incoming = `${plan.binary}${INCOMING_SUFFIX}`;

  // A leftover from a Windows update that could not delete its own displaced binary while it was
  // still running. Harmless, but it is this command's mess to clear.
  if (windows) await rm(`${plan.binary}${DISPLACED_SUFFIX}`, { force: true });

  const checksums = await fetchAssetText(context.fetch, plan.target, CHECKSUMS_ASSET);
  const expected = checksumFor(checksums, plan.asset);

  try {
    const actual = await downloadAsset(context.fetch, plan.target, plan.asset, incoming);
    if (actual !== expected) {
      throw networkError(`checksum mismatch for ${plan.asset}`, [
        `expected ${expected}, got ${actual}`,
        "the download was discarded and the installed ambit was left alone",
        "try again; if it keeps happening, report it at https://github.com/nebulab/ambit/issues",
      ]);
    }
    await swapInPlace(plan.binary, incoming, windows);
  } finally {
    await rm(incoming, { force: true });
  }
}

/** Whether the plan describes a move to a strictly newer release, as opposed to a downgrade. */
export function isUpgrade(plan: SelfUpdatePlan): boolean {
  return isNewer(plan.current, plan.target);
}
