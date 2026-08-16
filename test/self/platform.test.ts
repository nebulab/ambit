/**
 * How ambit recognizes itself: which of the three installs is running, and which asset would
 * replace it.
 *
 * The install kind is asserted against real strings rather than a stub, because the whole check is
 * a string match and a test that made up its own shapes would prove nothing. `/$bunfs/root` is what
 * a compiled binary really reports for `import.meta.url` (verified by compiling one), and
 * `B:/~BUN/root` is the Windows spelling of the same virtual filesystem.
 *
 * Every published asset is named here, so adding a platform to `scripts/build.ts` and forgetting
 * `src/self/platform.ts` fails the suite rather than 404ing on a user's machine.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { assetName, canReplace, installKind, runningBinary } from "../../src/self/platform.js";

/** The suite cannot make a directory unwritable for root, which ignores the permission bits. */
const IS_ROOT = process.getuid?.() === 0;

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ambit-platform-"));
});

afterEach(async () => {
  await chmod(workspace, 0o700).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("installKind", () => {
  it("recognizes a compiled binary by its embedded module root", () => {
    expect(installKind("file:///$bunfs/root/cli.js", "/$bunfs/root/cli.js")).toBe("binary");
  });

  it("recognizes a compiled binary on Windows", () => {
    expect(installKind("file:///B:/~BUN/root/cli.js", "B:\\~BUN\\root\\cli.js")).toBe("binary");
  });

  it("recognizes npx by the cache directory it runs out of", () => {
    const main = "/Users/x/.npm/_npx/8fa1b2/node_modules/@nebulab/ambit/dist/cli.js";
    expect(installKind(`file://${main}`, main)).toBe("npx");
  });

  it("recognizes npx on Windows, where the same path uses backslashes", () => {
    const main = "C:\\Users\\x\\AppData\\npm-cache\\_npx\\8fa1b2\\node_modules\\ambit\\cli.js";
    expect(installKind("file:///C:/Users/x/ambit/cli.js", main)).toBe("npx");
  });

  it("treats a global npm install as neither", () => {
    const main = "/usr/local/lib/node_modules/@nebulab/ambit/dist/cli.js";
    expect(installKind(`file://${main}`, main)).toBe("node");
  });

  it("does not mistake a directory merely containing the segment for the npx cache", () => {
    const main = "/Users/x/my_npx_notes/ambit/cli.js";
    expect(installKind(`file://${main}`, main)).toBe("node");
  });
});

describe("assetName", () => {
  it("names the asset for every platform a release publishes", () => {
    expect(assetName("darwin", "arm64")).toBe("ambit-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("ambit-darwin-x64");
    expect(assetName("linux", "x64")).toBe("ambit-linux-x64");
    expect(assetName("linux", "arm64")).toBe("ambit-linux-arm64");
    expect(assetName("win32", "x64")).toBe("ambit-windows-x64.exe");
  });

  it("names nothing for a platform no release ships", () => {
    expect(assetName("freebsd", "x64")).toBeUndefined();
    expect(assetName("win32", "arm64")).toBeUndefined();
  });
});

describe("runningBinary", () => {
  it("resolves the symlink a PATH entry usually is", async () => {
    const real = path.join(workspace, "ambit-real");
    const link = path.join(workspace, "ambit");
    await writeFile(real, "#!/bin/sh\n");
    await symlink(real, link);

    expect(await runningBinary(link)).toBe(await runningBinary(real));
    expect(path.basename(await runningBinary(link))).toBe("ambit-real");
  });

  it("falls back to the path it was given when nothing is there", async () => {
    const missing = path.join(workspace, "gone");
    expect(await runningBinary(missing)).toBe(missing);
  });
});

describe("canReplace", () => {
  it("accepts a binary in a writable directory", async () => {
    const binary = path.join(workspace, "ambit");
    await writeFile(binary, "");

    expect(await canReplace(binary)).toBe(true);
  });

  it.skipIf(IS_ROOT)("refuses a binary whose directory cannot be written", async () => {
    const locked = path.join(workspace, "locked");
    await mkdir(locked);
    const binary = path.join(locked, "ambit");
    await writeFile(binary, "");
    await chmod(locked, 0o500);

    expect(await canReplace(binary)).toBe(false);

    await chmod(locked, 0o700);
  });
});
