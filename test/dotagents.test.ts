/**
 * The dotagents compatibility promise, made executable (spec §1 "Relationship to dotagents",
 * spec §7 "Compatibility").
 *
 * ambit replaces dotagents, but a catalog must stay a plain skills repo so that dotagents — or
 * skills.sh, or anything else that reads `skills/<namespace>/<name>/SKILL.md` — can install from the
 * same directory. ambit's additions (`scopes.yml`, `mcps/`, the extra frontmatter keys) are supposed
 * to be additive and ignored. Spec §7 calls that "the guarantee most likely to rot", which is why it
 * is checked by running the real tool instead of by reasoning about it.
 *
 * The claim is asserted against ambit's own answer rather than a hand-written list: for each catalog,
 * `parseCatalogDirectory` says which skills are there, and dotagents must install exactly that set,
 * under exactly the names ambit derives from the paths, with each `SKILL.md` byte-identical to the
 * source. So a frontmatter key that made another parser choke, an `mcps/` entity mistaken for a
 * skill, or a nested skill directory another tool cannot see all fail here.
 *
 * Two catalogs, because the promise covers what ambit *writes* as well as what it reads: the
 * hand-written fixture, and one authored by `ambit catalog init` plus `ambit catalog skill new`.
 *
 * **This is the one test allowed to reach the network** (spec §7 exempts it; nothing else in the
 * suite may follow it). Two consequences are deliberate. `@sentry/dotagents` is left unpinned, since
 * the guarantee is about the release people actually have rather than one frozen when this was
 * written. And an unreachable registry is a *skip*, with a printed reason, for a developer working
 * offline — but a failure when `CI` is set, because a compatibility test that quietly passed by never
 * running is worse than no test at all. `AMBIT_SKIP_NETWORK_TESTS=1` skips without even probing.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { SKILL_FILENAME, parseCatalogDirectory } from "../src/catalog.js";
import { CATALOG_INIT_SCOPE } from "../src/catalog-init.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";

/** Unpinned on purpose: the promise is about whatever dotagents currently ships. */
const DOTAGENTS_PACKAGE = "@sentry/dotagents";

/** Set to skip the probe and both cases outright — the offline developer's escape hatch. */
const SKIP_VAR = "AMBIT_SKIP_NETWORK_TESTS";

/**
 * dotagents refuses a `path:` source resolving outside the project root, so the catalog under test
 * lives inside the project it is installed into.
 */
const CATALOG_DIRNAME = "catalog";

/** Where dotagents materializes skills, and the symlink it points each harness at. */
const AGENTS_DIRNAME = ".agents";
const INSTALLED_DIR = `${AGENTS_DIRNAME}/skills`;
const CLAUDE_LINK = ".claude/skills";

/** Whether an unreachable registry is a failure rather than a skip. */
const REQUIRE_NETWORK = (process.env.CI ?? "") !== "";

/**
 * npm's retry-with-backoff is what turns "no network" into a minute of silence, so the child is told
 * to give up after one attempt — but only outside CI, where a transient registry blip deserves a
 * retry rather than a report that the promise is broken.
 */
const IMPATIENT_NPM: Readonly<Record<string, string>> = {
  npm_config_fetch_retries: "0",
  npm_config_fetch_timeout: "20000",
};

/** A hard ceiling on every child, so an offline run ends in a message rather than a hang. */
const CHILD_TIMEOUT_MS = 120_000;

/** How much of npm's own complaint to quote: enough to name the cause, not its stack trace. */
const QUOTED_STDERR_LINES = 3;

/** Room for that ceiling plus the fixture work around it. */
const CASE_TIMEOUT_MS = 180_000;

const execFileAsync = promisify(execFile);

let root: string;
let project: string;
let dotagentsHome: string | undefined;

/** Why the suite cannot run, or `undefined` when it can. */
let unavailable: string | undefined;

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `npx @sentry/dotagents <args>`, reporting how it went instead of throwing so a failure is an
 * assertion naming the command's own output rather than a stack trace.
 *
 * The cache and user-scope directories are redirected into a temporary tree, because dotagents
 * defaults them under `$HOME` and a test that writes there is a test that changed the machine.
 */
async function dotagents(args: readonly string[], cwd: string): Promise<ChildResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(dotagentsHome !== undefined && {
      DOTAGENTS_HOME: dotagentsHome,
      DOTAGENTS_STATE_DIR: path.join(dotagentsHome, "state"),
    }),
    ...(REQUIRE_NETWORK ? {} : IMPATIENT_NPM),
  };
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["--yes", DOTAGENTS_PACKAGE, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

/**
 * Writes the project dotagents installs into: a wildcard entry over the catalog inside it, plus the
 * two `.gitignore` lines whose absence dotagents warns about — that warning is noise here, not the
 * subject.
 */
async function writeDotagentsProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "agents.toml"),
    `version = 1
agents = ["claude"]

[[skills]]
name = "*"
source = "path:./${CATALOG_DIRNAME}"
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, ".gitignore"),
    `agents.lock\n${AGENTS_DIRNAME}/.gitignore\n`,
    "utf8",
  );
}

/** The head of a failed child's complaint, since npm follows its reason with a stack trace. */
function firstLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, QUOTED_STDERR_LINES)
    .join("\n");
}

/** Runs one authoring command against the catalog under test, asserting it succeeded. */
async function author(...argv: readonly string[]): Promise<void> {
  const err: string[] = [];
  const code = await run([...argv, "--catalog", CATALOG_DIRNAME], {
    cwd: project,
    stdout: () => {},
    stderr: (line) => err.push(line),
  });
  expect(code, `${argv.join(" ")}: ${err.join("\n")}`).toBe(ExitCode.Success);
}

/**
 * Installs the catalog inside the project with dotagents and asserts the whole outcome: it
 * succeeded, it found exactly the skills ambit finds under exactly the names ambit derives, and it
 * copied every `SKILL.md` unchanged.
 */
async function expectInstallable(): Promise<void> {
  const catalogDir = path.join(project, CATALOG_DIRNAME);
  const catalog = await parseCatalogDirectory("subject", `path:${catalogDir}`, catalogDir);
  expect(catalog.skills.length).toBeGreaterThan(0);

  const result = await dotagents(["install"], project);
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);

  const installed = (await readdir(path.join(project, INSTALLED_DIR))).sort();
  expect(installed).toEqual([...catalog.skills.map((skill) => skill.name)].sort());

  for (const skill of catalog.skills) {
    const source = await readFile(path.join(catalogDir, skill.path, SKILL_FILENAME), "utf8");
    const target = await readFile(
      path.join(project, INSTALLED_DIR, skill.name, SKILL_FILENAME),
      "utf8",
    );
    expect(target, skill.name).toBe(source);
  }

  // Every harness reads skills through this link, so an install that skipped it installed nothing.
  await expect(stat(path.join(project, CLAUDE_LINK))).resolves.toBeDefined();
}

describe("dotagents compatibility", () => {
  beforeAll(async () => {
    if ((process.env[SKIP_VAR] ?? "") !== "") {
      unavailable = `${SKIP_VAR} is set`;
      return;
    }

    dotagentsHome = await mkdtemp(path.join(tmpdir(), "ambit-dotagents-home-"));

    // Doubles as the warm-up: every later invocation resolves from the npx cache this one fills.
    const probe = await dotagents(["--version"], tmpdir());
    if (probe.code === 0) return;

    unavailable =
      `cannot run \`npx ${DOTAGENTS_PACKAGE}\` (exit ${String(probe.code)}), so the ` +
      `compatibility promise in spec §1 is unverified. This is the one test that needs network ` +
      `access; set ${SKIP_VAR}=1 to skip it deliberately.\n${firstLines(probe.stderr)}`;
    if (REQUIRE_NETWORK) throw new Error(unavailable);
    console.warn(`skipping the dotagents compatibility test: ${unavailable}`);
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    if (dotagentsHome !== undefined) await rm(dotagentsHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ambit-dotagents-"));
    project = path.join(root, "project");
    await writeDotagentsProject(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "installs every skill in the hand-written fixture catalog, ignoring ambit's additions",
    async (ctx) => {
      if (unavailable !== undefined) return ctx.skip();

      await buildFixtureCatalog(path.join(project, CATALOG_DIRNAME));
      await expectInstallable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "installs every skill in a catalog authored by `catalog init` and `catalog skill new`",
    async (ctx) => {
      if (unavailable !== undefined) return ctx.skip();

      await author("catalog", "init");
      await author(
        "catalog",
        "skill",
        "new",
        "acme.commons.use-company-context",
        "--description",
        "Canonical context about Acme",
        "--scope",
        CATALOG_INIT_SCOPE,
      );
      // The second skill carries every extra frontmatter key ambit writes, since those keys are
      // exactly what another tool's parser could choke on.
      await author(
        "catalog",
        "skill",
        "new",
        "acme.projects.use-acme-brief",
        "--description",
        "The Acme engagement brief",
        "--scope",
        CATALOG_INIT_SCOPE,
        "--requires",
        "acme.commons.use-company-context",
        "--env",
        "ACME_FIGMA_TOKEN",
      );

      await expectInstallable();
    },
    CASE_TIMEOUT_MS,
  );
});
