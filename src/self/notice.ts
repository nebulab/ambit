/**
 * The one line that tells a user a newer ambit exists.
 *
 * A dependency manager is run in loops and in scripts, so this is built to be invisible until it
 * has something to say and to cost nothing when it does not:
 *
 * - **At most one request a day.** The answer is cached under the same root the git cache uses, and
 *   a fresh cache answers without touching the network at all.
 * - **Silent unless a person is watching.** No notice when stderr is not a terminal, under CI, with
 *   `--json` or `--offline`, when `AMBIT_NO_UPDATE_CHECK` is set, or when the command being run is
 *   the update itself.
 * - **Never a failure.** Every error is swallowed. Being unable to check for a new version is not a
 *   reason for a command that already succeeded to say anything at all.
 *
 * The timestamp is written whether or not the check succeeded, so a machine that is offline makes
 * one failed request a day rather than one per command.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cacheRoot } from "../model/git.js";
import { installKind } from "./platform.js";
import type { Fetch } from "./release.js";
import { isNewer, latestTag } from "./release.js";
import { VERSION } from "../version.js";

/** Where the last check is remembered, beside the git cache's `repos/` and `sources/`. */
export const NOTICE_CACHE_FILE = "self-update.json";

/** How long an answer is reused before asking again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long the check may take. Short: it runs after a command the user is waiting to end. */
export const CHECK_TIMEOUT_MS = 2_000;

/** Set to anything non-empty to never check. */
export const OPT_OUT_VAR = "AMBIT_NO_UPDATE_CHECK";

/** What one command run needs to know to decide whether, and what, to report. */
export interface NoticeContext {
  readonly env: NodeJS.ProcessEnv;
  /** The arguments the user typed, without the program name. */
  readonly argv: readonly string[];
  /** Whether stderr is a terminal. */
  readonly isTty: boolean;
  readonly now: number;
  readonly moduleUrl: string;
  readonly mainPath: string;
  readonly fetch: Fetch;
}

/** What the cache file holds. `latest` is absent when the last check could not reach GitHub. */
interface NoticeCache {
  readonly checkedAt: number;
  readonly latest?: string;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Whether this run may check at all, from the invocation alone.
 *
 * Separate from the check so the guards can be read as a list and tested as one. `--json` is here
 * because a machine reading ambit's output did not ask for advice, and `--offline` because the
 * flag is a statement that this run must not reach the network.
 */
export function shouldCheck(context: NoticeContext): boolean {
  if (isSet(context.env[OPT_OUT_VAR])) return false;
  if (isSet(context.env.CI)) return false;
  if (!context.isTty) return false;
  if (context.argv.includes("--json") || context.argv.includes("--offline")) return false;
  if (context.argv.includes("self-update")) return false;
  return installKind(context.moduleUrl, context.mainPath) !== "npx";
}

function cacheFile(env: NodeJS.ProcessEnv): string {
  return path.join(cacheRoot(env), NOTICE_CACHE_FILE);
}

async function readCache(env: NodeJS.ProcessEnv): Promise<NoticeCache | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cacheFile(env), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<NoticeCache>;
    if (typeof record.checkedAt !== "number") return undefined;
    return typeof record.latest === "string"
      ? { checkedAt: record.checkedAt, latest: record.latest }
      : { checkedAt: record.checkedAt };
  } catch {
    return undefined;
  }
}

async function writeCache(env: NodeJS.ProcessEnv, cache: NoticeCache): Promise<void> {
  try {
    const file = cacheFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // An unwritable cache costs one request per run, which is not worth failing a command over.
  }
}

/** The tag of the newest release, from the cache when it is fresh and from GitHub when it is not. */
async function newestRelease(context: NoticeContext): Promise<string | undefined> {
  const cached = await readCache(context.env);
  if (cached !== undefined && context.now - cached.checkedAt < CHECK_INTERVAL_MS) {
    return cached.latest;
  }

  try {
    const latest = await latestTag(context.fetch, CHECK_TIMEOUT_MS);
    await writeCache(context.env, { checkedAt: context.now, latest });
    return latest;
  } catch {
    await writeCache(context.env, { checkedAt: context.now });
    return undefined;
  }
}

/**
 * The line to print, or `undefined` when there is nothing to say.
 *
 * The advice differs by install: a binary can update itself, a global npm install is npm's to
 * update. npx never gets here, since {@link shouldCheck} rules it out.
 */
export async function updateNotice(context: NoticeContext): Promise<string | undefined> {
  if (!shouldCheck(context)) return undefined;

  const latest = await newestRelease(context);
  if (latest === undefined || !isNewer(VERSION, latest)) return undefined;

  const how =
    installKind(context.moduleUrl, context.mainPath) === "binary"
      ? "run `ambit self-update`"
      : "run `npm i -g @nebulab/ambit@latest`";

  return `ambit ${latest} is available; you are on ${VERSION}. To upgrade, ${how}.`;
}
