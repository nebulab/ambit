/**
 * The GitHub release ambit updates from: which version is latest, and the bytes of one asset.
 *
 * Nothing here calls the GitHub API. The latest tag is read from the redirect
 * `/releases/latest` already answers with, and the assets are fetched from the same public
 * download URLs `install.sh` uses. The API would need no token either, but it is rate-limited to
 * 60 requests an hour per address, which a shared office address or a CI runner can exhaust; a
 * redirect and a download are not.
 *
 * The download is streamed and hashed as it passes, so a ~100 MB executable never has to be held
 * in memory to be checked.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { AmbitError, networkError } from "../errors.js";

/** The repository releases are published from. Matches `REPO` in `install.sh`. */
const REPO = "nebulab/ambit";

const RELEASES_URL = `https://github.com/${REPO}/releases`;

/** The file every release attaches, one `sha256sum` line per asset. */
export const CHECKSUMS_ASSET = "checksums.txt";

/** How long a metadata request may take. Short: it is one redirect or a few hundred bytes. */
export const METADATA_TIMEOUT_MS = 10_000;

/** How long an asset download may take. Long: it is an executable on an unknown connection. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;

/** The subset of `fetch` this module uses, so a test can supply its own. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A parsed release version. Build metadata is not kept: it does not order two versions. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated identifiers after `-`, empty for a normal release. */
  readonly prerelease: readonly string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/;

/** Where one file of one release is downloaded from. */
export function assetUrl(tag: string, asset: string): string {
  return `${RELEASES_URL}/download/${tag}/${asset}`;
}

/** The tag for a version a user typed, which may or may not carry the `v` a tag has. */
export function asTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/** A version, or `undefined` for anything that is not one. Callers never guess at an ordering. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return undefined;

  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/**
 * Orders two prerelease identifiers the way semver does: numeric ones compare as numbers and sort
 * below alphanumeric ones, which compare as text.
 */
function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Negative when `a` is older, positive when it is newer, zero when the two are the same release.
 *
 * A prerelease sorts below the release it leads to, so `1.0.0-rc.1` never counts as an update for
 * someone already on `1.0.0`.
 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    // A shorter set of identifiers sorts below an otherwise identical longer one.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }

  return 0;
}

/** Whether `candidate` is a release worth moving to from `current`. Unparseable means no. */
export function isNewer(current: string, candidate: string): boolean {
  const from = parseVersion(current);
  const to = parseVersion(candidate);
  if (from === undefined || to === undefined) return false;
  return compareVersions(to, from) > 0;
}

/**
 * The tag of the newest published release.
 *
 * `/releases/latest` answers with a redirect to `/releases/tag/<tag>`, which is where the tag is
 * read from. `redirect: "manual"` is what keeps this one request rather than one request and a
 * download of the release page's HTML.
 *
 * @throws {AmbitError} exit 4 when the request fails, or when the redirect names no tag, which is
 *   what a repository with no published release answers.
 */
export async function latestTag(
  fetchImpl: Fetch,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${RELEASES_URL}/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw networkError("could not reach GitHub to find the latest ambit release", [
      error instanceof Error ? error.message : String(error),
      "check the connection, or install a specific release with `ambit self-update <version>`",
    ]);
  }

  const location = response.headers.get("location") ?? "";
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
  if (tag === undefined) {
    throw networkError("GitHub did not name a latest ambit release", [
      `${RELEASES_URL}/latest answered ${String(response.status)} pointing at "${location}"`,
      "this is what a repository with no published release answers",
    ]);
  }

  return decodeURIComponent(tag);
}

/**
 * The body of one release asset as text, for `checksums.txt`.
 *
 * @throws {AmbitError} exit 4 when the request fails or the asset is not part of the release.
 */
export async function fetchAssetText(
  fetchImpl: Fetch,
  tag: string,
  asset: string,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<string> {
  const url = assetUrl(tag, asset);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw networkError(`could not download ${asset}`, [
      error instanceof Error ? error.message : String(error),
      `it was requested from ${url}`,
    ]);
  }

  if (!response.ok) {
    throw networkError(`could not download ${asset}`, [
      `${url} answered ${String(response.status)}`,
      `check that release ${tag} exists and attaches ${asset}`,
    ]);
  }

  return await response.text();
}

/**
 * The recorded hash for one asset, out of a `checksums.txt` body.
 *
 * @throws {AmbitError} exit 4 when the file lists no line for that asset, which would otherwise
 *   leave the download unverified.
 */
export function checksumFor(checksums: string, asset: string): string {
  for (const line of checksums.split("\n")) {
    const match = CHECKSUM_LINE.exec(line.trim());
    if (match?.[2] === asset && match[1] !== undefined) return match[1];
  }

  throw networkError(`${CHECKSUMS_ASSET} lists no entry for ${asset}`, [
    "the release is incomplete, so the download cannot be verified",
    "report it at https://github.com/nebulab/ambit/issues",
  ]);
}

/**
 * Streams one asset to `destination` and returns its sha256, lowercase hex.
 *
 * The hash is taken from the same bytes that reach the disk rather than from a re-read of the
 * file, so nothing that happens to the file afterwards can pass a check the download failed.
 *
 * @throws {AmbitError} exit 4 when the request fails or the response carries no body.
 */
export async function downloadAsset(
  fetchImpl: Fetch,
  tag: string,
  asset: string,
  destination: string,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<string> {
  const url = assetUrl(tag, asset);
  const hash = createHash("sha256");

  async function* hashing(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of body) {
      hash.update(chunk);
      yield chunk;
    }
  }

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw networkError(`could not download ${asset}`, [
        `${url} answered ${String(response.status)}`,
        `check that release ${tag} exists and attaches ${asset}`,
      ]);
    }
    if (response.body === null) {
      throw networkError(`could not download ${asset}`, [
        `${url} answered with no body`,
        "try again, or download the binary from the releases page",
      ]);
    }

    // The executable bit is set here rather than after the swap: the file has to be runnable
    // before it takes the place of one that is.
    await pipeline(
      hashing(response.body as unknown as AsyncIterable<Uint8Array>),
      createWriteStream(destination, { mode: 0o755 }),
    );
  } catch (error) {
    // The two refusals above are already in the standard shape; only a transport failure or a
    // write error reaches the wrapping below.
    if (error instanceof AmbitError) throw error;
    throw networkError(`could not download ${asset}`, [
      error instanceof Error ? error.message : String(error),
      `it was requested from ${url}`,
    ]);
  }

  return hash.digest("hex");
}
