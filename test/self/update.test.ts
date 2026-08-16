/**
 * Replacing the binary: what stops the update before it starts, and what the swap leaves behind.
 *
 * Two properties are asserted in every failure case, because they are the ones that decide whether
 * a failed update is survivable: the old binary still has its old bytes, and no `.incoming` file is
 * left beside it. A self-update that half-works turns a working install into no install at all.
 *
 * The Windows swap is exercised on whatever the suite runs on, by passing the flag rather than
 * reading `process.platform`. That branch cannot be reached on a POSIX machine otherwise, and it is
 * the more delicate of the two: it moves the running binary aside before anything takes its place.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AmbitError, ExitCode } from "../../src/errors.js";
import type { Fetch } from "../../src/self/release.js";
import type { SelfContext } from "../../src/self/update.js";
import { applySelfUpdate, planSelfUpdate, swapInPlace } from "../../src/self/update.js";
import { VERSION } from "../../src/version.js";

/** The suite cannot make a directory unwritable for root, which ignores the permission bits. */
const IS_ROOT = process.getuid?.() === 0;

const LATEST = "v9.9.9";
const OLD_BYTES = "the ambit that is installed\n";
const NEW_BYTES = "the ambit that was released\n";

/** A compiled binary's own module URL, which is what {@link planSelfUpdate} looks for. */
const BINARY_URL = "file:///$bunfs/root/cli.js";

let workspace: string;
let binary: string;

beforeEach(async () => {
  // Resolved, because the plan reports the binary with its symlinks resolved and macOS makes
  // `/var` one. Comparing against an unresolved path would fail there and pass on Linux.
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), "ambit-self-update-")));
  binary = path.join(workspace, "ambit");
  await writeFile(binary, OLD_BYTES, { mode: 0o755 });
});

afterEach(async () => {
  await chmod(workspace, 0o700).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A GitHub that serves one release: the redirect naming {@link LATEST}, a `checksums.txt` for the
 * bytes given, and the asset itself.
 */
function releaseServer(bytes: string, checksum = sha256(bytes)): Fetch {
  return (url) => {
    if (url.endsWith("/releases/latest")) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://github.com/nebulab/ambit/releases/tag/${LATEST}` },
        }),
      );
    }
    if (url.endsWith("/checksums.txt")) {
      return Promise.resolve(new Response(`${checksum}  ambit-linux-x64\n`));
    }
    return Promise.resolve(new Response(bytes));
  };
}

function contextOf(overrides: Partial<SelfContext> = {}): SelfContext {
  return {
    platform: "linux",
    arch: "x64",
    execPath: binary,
    moduleUrl: BINARY_URL,
    mainPath: "/$bunfs/root/cli.js",
    fetch: releaseServer(NEW_BYTES),
    ...overrides,
  };
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

describe("planSelfUpdate", () => {
  it("plans a move to the latest release", async () => {
    const plan = await planSelfUpdate(contextOf());

    expect(plan).toEqual({
      kind: "binary",
      current: VERSION,
      target: LATEST,
      asset: "ambit-linux-x64",
      binary,
      changed: true,
    });
  });

  it("plans a named release without asking which one is latest", async () => {
    const fetchImpl: Fetch = () => Promise.reject(new Error("should not be called"));
    const plan = await planSelfUpdate(contextOf({ fetch: fetchImpl }), "0.0.1");

    expect(plan.target).toBe("v0.0.1");
    expect(plan.changed).toBe(true);
  });

  it("reports no change when the named release is the one running", async () => {
    const fetchImpl: Fetch = () => Promise.reject(new Error("should not be called"));
    const plan = await planSelfUpdate(contextOf({ fetch: fetchImpl }), VERSION);

    expect(plan.changed).toBe(false);
  });

  it("refuses under npx, which has nothing on disk to replace", async () => {
    const main = "/Users/x/.npm/_npx/8fa1b2/node_modules/@nebulab/ambit/dist/cli.js";
    const error = await refusalOf(() =>
      planSelfUpdate(contextOf({ moduleUrl: `file://${main}`, mainPath: main })),
    );

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toContain("nothing to update");
  });

  it("refuses under a global npm install, and names the command that does work", async () => {
    const main = "/usr/local/lib/node_modules/@nebulab/ambit/dist/cli.js";
    const error = await refusalOf(() =>
      planSelfUpdate(contextOf({ moduleUrl: `file://${main}`, mainPath: main })),
    );

    expect(error.code).toBe(ExitCode.Config);
    expect(error.detail.join(" ")).toContain("npm i -g @nebulab/ambit@latest");
  });

  it("refuses a platform no release ships a binary for", async () => {
    const error = await refusalOf(() => planSelfUpdate(contextOf({ platform: "freebsd" })));

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toContain("freebsd-x64");
  });

  it.skipIf(IS_ROOT)("refuses before downloading when the directory is read-only", async () => {
    const locked = path.join(workspace, "locked");
    await mkdir(locked);
    const installed = path.join(locked, "ambit");
    await writeFile(installed, OLD_BYTES);
    await chmod(locked, 0o500);

    const fetchImpl: Fetch = () => Promise.reject(new Error("should not be called"));
    const error = await refusalOf(() =>
      planSelfUpdate(contextOf({ execPath: installed, fetch: fetchImpl })),
    );

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toContain("cannot write to the directory");

    await chmod(locked, 0o700);
  });
});

describe("applySelfUpdate", () => {
  it("installs the verified bytes over the running binary", async () => {
    const context = contextOf();
    const plan = await planSelfUpdate(context);
    await applySelfUpdate(plan, context);

    expect(await readFile(binary, "utf8")).toBe(NEW_BYTES);
    expect((await stat(binary)).mode & 0o111).toBeGreaterThan(0);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });

  it("discards a download whose hash does not match, and keeps the old binary", async () => {
    const context = contextOf({ fetch: releaseServer(NEW_BYTES, sha256("something else")) });
    const plan = await planSelfUpdate(context);

    const error = await refusalOf(() => applySelfUpdate(plan, context));

    expect(error.code).toBe(ExitCode.Network);
    expect(error.message).toContain("checksum mismatch");
    expect(await readFile(binary, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });

  it("keeps the old binary when the download itself fails", async () => {
    const fetchImpl: Fetch = (url) =>
      url.endsWith("/checksums.txt")
        ? Promise.resolve(new Response(`${sha256(NEW_BYTES)}  ambit-linux-x64\n`))
        : Promise.resolve(new Response("Not Found", { status: 404 }));
    const context = contextOf({ fetch: fetchImpl });
    const plan = await planSelfUpdate(contextOf());

    const error = await refusalOf(() => applySelfUpdate(plan, context));

    expect(error.code).toBe(ExitCode.Network);
    expect(await readFile(binary, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });
});

describe("swapInPlace", () => {
  it("renames straight over the binary on POSIX", async () => {
    const incoming = `${binary}.incoming`;
    await writeFile(incoming, NEW_BYTES);

    await swapInPlace(binary, incoming, false);

    expect(await readFile(binary, "utf8")).toBe(NEW_BYTES);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });

  it("moves the running binary aside first on Windows, then clears it away", async () => {
    const incoming = `${binary}.incoming`;
    await writeFile(incoming, NEW_BYTES);

    await swapInPlace(binary, incoming, true);

    expect(await readFile(binary, "utf8")).toBe(NEW_BYTES);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });

  it("puts the displaced binary back when the new one cannot take its place", async () => {
    const missing = `${binary}.incoming`;

    await expect(swapInPlace(binary, missing, true)).rejects.toThrow();

    expect(await readFile(binary, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(workspace)).toEqual(["ambit"]);
  });
});
