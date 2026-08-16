/**
 * What ambit reads off a GitHub release: which tag is latest, what a checksum line says, and the
 * bytes of one asset.
 *
 * Every case here supplies its own `fetch`, so the suite stays offline and can describe answers
 * GitHub gives rarely — a repository with no release, a truncated download, a `checksums.txt`
 * missing a line. Those are the paths that matter, because they are the ones that decide whether
 * unverified bytes get installed.
 *
 * The download test hashes a real file written to a real directory rather than asserting against a
 * stub, since the whole point of that function is that the hash and the file come from the same
 * stream.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AmbitError, ExitCode } from "../../src/errors.js";
import type { Fetch } from "../../src/self/release.js";
import {
  asTag,
  checksumFor,
  compareVersions,
  downloadAsset,
  fetchAssetText,
  isNewer,
  latestTag,
  parseVersion,
} from "../../src/self/release.js";

const TAG = "v1.2.3";
const ASSET = "ambit-linux-x64";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ambit-release-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** A `fetch` that answers every URL with the same response. */
function answering(response: () => Response): Fetch {
  return () => Promise.resolve(response());
}

/** The version each string parses to, for a test that only cares about ordering. */
function order(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) throw new Error(`unparseable: ${a} or ${b}`);
  return compareVersions(left, right);
}

async function refusalOf(run: () => Promise<unknown>): Promise<AmbitError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AmbitError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The same, for the one function here that refuses synchronously. */
function refusalOfSync(run: () => unknown): AmbitError {
  try {
    run();
  } catch (error) {
    if (error instanceof AmbitError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("parseVersion", () => {
  it("reads a tag with or without its leading v", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it("splits a prerelease into its identifiers", () => {
    expect(parseVersion("v1.0.0-rc.2")?.prerelease).toEqual(["rc", "2"]);
  });

  it("ignores build metadata, which does not order two versions", () => {
    expect(parseVersion("1.2.3+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it("reads nothing out of a string that is not a version", () => {
    expect(parseVersion("latest")).toBeUndefined();
    expect(parseVersion("v1.2")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(order("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(order("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(order("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(order("1.2.3", "1.2.3")).toBe(0);
    expect(order("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("sorts a prerelease below the release it leads to", () => {
    expect(order("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(order("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders prerelease identifiers the way semver does", () => {
    expect(order("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(order("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(order("1.0.0-rc", "1.0.0-rc.1")).toBeLessThan(0);
  });
});

describe("isNewer", () => {
  it("is true only for a strictly newer release", () => {
    expect(isNewer("0.1.0", "v0.2.0")).toBe(true);
    expect(isNewer("0.2.0", "v0.2.0")).toBe(false);
    expect(isNewer("0.3.0", "v0.2.0")).toBe(false);
  });

  it("refuses to guess when either side is not a version", () => {
    expect(isNewer("0.1.0", "nightly")).toBe(false);
    expect(isNewer("dev", "v9.9.9")).toBe(false);
  });
});

describe("asTag", () => {
  it("adds the leading v a tag has and a package version does not", () => {
    expect(asTag("0.2.0")).toBe("v0.2.0");
    expect(asTag("v0.2.0")).toBe("v0.2.0");
  });
});

describe("latestTag", () => {
  it("reads the tag out of the redirect", async () => {
    const fetchImpl = answering(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://github.com/nebulab/ambit/releases/tag/v0.4.1" },
        }),
    );

    expect(await latestTag(fetchImpl)).toBe("v0.4.1");
  });

  it("refuses when the redirect names no tag, which is a repository with no release", async () => {
    const fetchImpl = answering(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://github.com/nebulab/ambit/releases" },
        }),
    );

    const error = await refusalOf(() => latestTag(fetchImpl));
    expect(error.code).toBe(ExitCode.Network);
    expect(error.message).toContain("did not name a latest ambit release");
  });

  it("refuses when the request itself fails", async () => {
    const fetchImpl: Fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com"));

    const error = await refusalOf(() => latestTag(fetchImpl));
    expect(error.code).toBe(ExitCode.Network);
    expect(error.detail.join(" ")).toContain("ENOTFOUND");
  });
});

describe("checksumFor", () => {
  const hash = "a".repeat(64);

  it("finds the line for one asset", () => {
    const file = [`${"b".repeat(64)}  ambit-darwin-arm64`, `${hash}  ${ASSET}`].join("\n");
    expect(checksumFor(file, ASSET)).toBe(hash);
  });

  it("reads the binary-mode star sha256sum writes", () => {
    expect(checksumFor(`${hash} *${ASSET}\n`, ASSET)).toBe(hash);
  });

  it("does not match an asset whose name merely ends with the one asked for", () => {
    const error = refusalOfSync(() => checksumFor(`${hash}  extra-${ASSET}\n`, ASSET));
    expect(error.code).toBe(ExitCode.Network);
  });

  it("refuses when the file lists no line for the asset", () => {
    const error = refusalOfSync(() => checksumFor(`${hash}  ambit-darwin-arm64\n`, ASSET));
    expect(error.code).toBe(ExitCode.Network);
    expect(error.message).toContain("lists no entry");
  });
});

describe("fetchAssetText", () => {
  it("returns the body", async () => {
    const fetchImpl = answering(() => new Response("hello\n"));
    expect(await fetchAssetText(fetchImpl, TAG, "checksums.txt")).toBe("hello\n");
  });

  it("refuses a release that does not attach the asset", async () => {
    const fetchImpl = answering(() => new Response("Not Found", { status: 404 }));

    const error = await refusalOf(() => fetchAssetText(fetchImpl, TAG, "checksums.txt"));
    expect(error.code).toBe(ExitCode.Network);
    expect(error.detail.join(" ")).toContain("404");
  });
});

describe("downloadAsset", () => {
  it("writes the bytes and returns the hash of the same stream", async () => {
    const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 256));
    const expected = createHash("sha256").update(bytes).digest("hex");
    const destination = path.join(workspace, ASSET);
    const fetchImpl = answering(() => new Response(bytes));

    expect(await downloadAsset(fetchImpl, TAG, ASSET, destination)).toBe(expected);
    expect(new Uint8Array(await readFile(destination))).toEqual(bytes);
  });

  it("writes it executable, since it replaces something that has to run", async () => {
    const destination = path.join(workspace, ASSET);
    await downloadAsset(
      answering(() => new Response("#!/bin/sh\n")),
      TAG,
      ASSET,
      destination,
    );

    expect((await stat(destination)).mode & 0o111).toBeGreaterThan(0);
  });

  it("refuses a response that is not a download", async () => {
    const destination = path.join(workspace, ASSET);
    const fetchImpl = answering(() => new Response("Not Found", { status: 404 }));

    const error = await refusalOf(() => downloadAsset(fetchImpl, TAG, ASSET, destination));
    expect(error.code).toBe(ExitCode.Network);
    expect(error.detail.join(" ")).toContain("404");
  });
});
