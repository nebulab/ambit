/**
 * The update notice: when it stays quiet, and how rarely it asks.
 *
 * Most of these assert a negative, because a notice is only tolerable if it is nearly always
 * absent. Every guard is checked one at a time against an otherwise valid context, so a guard that
 * stopped working could not hide behind another one still holding.
 *
 * The cache cases assert on whether `fetch` was called at all, not on the returned line: the
 * promise of a daily check is a promise about requests, and a version comparison that happened to
 * be right would say nothing about how it was reached.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Fetch } from "../../src/self/release.js";
import type { NoticeContext } from "../../src/self/notice.js";
import { CHECK_INTERVAL_MS, NOTICE_CACHE_FILE, updateNotice } from "../../src/self/notice.js";
import { CACHE_DIRNAME } from "../../src/model/git.js";
import { VERSION } from "../../src/version.js";

const NEWER = "v99.0.0";
const NOW = 1_760_000_000_000;

/** A compiled binary's own module URL, and a global npm install's. */
const BINARY_URL = "file:///$bunfs/root/cli.js";
const NPM_MAIN = "/usr/local/lib/node_modules/@teamnebulab/ambit/dist/cli.js";

let cacheHome: string;
let calls: number;

beforeEach(async () => {
  cacheHome = await mkdtemp(path.join(tmpdir(), "ambit-notice-"));
  calls = 0;
});

afterEach(async () => {
  await rm(cacheHome, { recursive: true, force: true });
});

/** A GitHub that names {@link NEWER} as latest, counting how many times it is asked. */
const counting: Fetch = (url) => {
  calls += 1;
  if (!url.endsWith("/releases/latest")) return Promise.resolve(new Response("", { status: 404 }));
  return Promise.resolve(
    new Response(null, {
      status: 302,
      headers: { location: `https://github.com/nebulab/ambit/releases/tag/${NEWER}` },
    }),
  );
};

/** A GitHub that is unreachable, counting how many times it is asked. */
const failing: Fetch = () => {
  calls += 1;
  return Promise.reject(new Error("offline"));
};

function contextOf(overrides: Partial<NoticeContext> = {}): NoticeContext {
  return {
    env: { XDG_CACHE_HOME: cacheHome },
    argv: ["status"],
    isTty: true,
    now: NOW,
    moduleUrl: BINARY_URL,
    mainPath: "/$bunfs/root/cli.js",
    fetch: counting,
    ...overrides,
  };
}

function cacheFile(): string {
  return path.join(cacheHome, CACHE_DIRNAME, NOTICE_CACHE_FILE);
}

async function writeCache(record: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(path.join(cacheHome, CACHE_DIRNAME), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(record), "utf8");
}

async function readCache(): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await readFile(cacheFile(), "utf8")) as Readonly<Record<string, unknown>>;
}

describe("updateNotice", () => {
  it("reports a newer release, and names the command that installs it", async () => {
    expect(await updateNotice(contextOf())).toBe(
      `ambit ${NEWER} is available; you are on ${VERSION}. To upgrade, run \`ambit self-update\`.`,
    );
  });

  it("tells a global npm install to use npm", async () => {
    const notice = await updateNotice(
      contextOf({ moduleUrl: `file://${NPM_MAIN}`, mainPath: NPM_MAIN }),
    );

    expect(notice).toContain("npm i -g @teamnebulab/ambit@latest");
  });

  it("says nothing when the latest release is the one running", async () => {
    const current: Fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://github.com/nebulab/ambit/releases/tag/v${VERSION}` },
        }),
      );

    expect(await updateNotice(contextOf({ fetch: current }))).toBeUndefined();
  });
});

describe("updateNotice guards", () => {
  it("says nothing when AMBIT_NO_UPDATE_CHECK is set", async () => {
    const env = { XDG_CACHE_HOME: cacheHome, AMBIT_NO_UPDATE_CHECK: "1" };

    expect(await updateNotice(contextOf({ env }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing under CI", async () => {
    const env = { XDG_CACHE_HOME: cacheHome, CI: "true" };

    expect(await updateNotice(contextOf({ env }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing when stderr is not a terminal", async () => {
    expect(await updateNotice(contextOf({ isTty: false }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing to a machine reading the output", async () => {
    expect(await updateNotice(contextOf({ argv: ["status", "--json"] }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing when the run was told not to reach the network", async () => {
    expect(await updateNotice(contextOf({ argv: ["install", "--offline"] }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing during the update itself", async () => {
    expect(await updateNotice(contextOf({ argv: ["self-update"] }))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("says nothing under npx, which is already on the latest version", async () => {
    const main = "/Users/x/.npm/_npx/8fa1b2/node_modules/@teamnebulab/ambit/dist/cli.js";

    expect(
      await updateNotice(contextOf({ moduleUrl: `file://${main}`, mainPath: main })),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("updateNotice caching", () => {
  it("answers from a cache younger than the interval, without asking", async () => {
    await writeCache({ checkedAt: NOW - CHECK_INTERVAL_MS + 1000, latest: NEWER });

    expect(await updateNotice(contextOf())).toContain(NEWER);
    expect(calls).toBe(0);
  });

  it("asks again once the cache is older than the interval", async () => {
    await writeCache({ checkedAt: NOW - CHECK_INTERVAL_MS - 1, latest: "v0.0.1" });

    expect(await updateNotice(contextOf())).toContain(NEWER);
    expect(calls).toBe(1);
    expect(await readCache()).toEqual({ checkedAt: NOW, latest: NEWER });
  });

  it("records the attempt even when it fails, so an offline machine asks once a day", async () => {
    expect(await updateNotice(contextOf({ fetch: failing }))).toBeUndefined();
    expect(calls).toBe(1);
    expect(await readCache()).toEqual({ checkedAt: NOW });

    expect(await updateNotice(contextOf({ fetch: failing }))).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("ignores a cache file that is not the shape it wrote", async () => {
    await writeCache({ checkedAt: "yesterday" });

    expect(await updateNotice(contextOf())).toContain(NEWER);
    expect(calls).toBe(1);
  });
});
