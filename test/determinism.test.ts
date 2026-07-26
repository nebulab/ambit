/**
 * Determinism, as a suite.
 *
 * Spec §4 makes determinism a requirement rather than a preference — sort every collection before
 * iterating, never depend on object key order, never emit a timestamp, never let filesystem read
 * order reach output — and each earlier task asserted its own corner of it: `ambit.lock`'s bytes,
 * `resolve --explain --json`, the two catalog reports, both scaffolds. This file is the systematic
 * version. One table lists every surface ambit prints; every surface is run twice, then run again
 * with every directory listing permuted, and the bytes must not move. **Adding a command means
 * adding a row to `SURFACES`** — that is the whole of extending this file.
 *
 * Read order is permuted by wrapping `readdir`, not by rebuilding the fixture in a different order.
 * The order a filesystem hands entries back in is not something a test can arrange — APFS answers
 * in one stable hash order, ext4 in another, and neither is the creation order a test could
 * shuffle — so a wrapper is the only way to make the second determinism claim testable at all. That makes
 * the wrapper load-bearing: a suite whose shuffle quietly stopped applying would pass forever, so
 * the first describe below proves the permutation reaches the listings *ambit* reads and not merely
 * the ones this file reads.
 *
 * Nothing in the surface table writes, so the whole table shares one installed project; the
 * "wrote nothing" case is what pins that, and it is the reason the three `--dry-run` previews are
 * safe to list beside the read-only commands.
 *
 * One thing the table cannot do on its own: every surface in it is sorted twice over — a catalog's
 * directory entries as they are read, its items again before they are emitted — so a single missing
 * sort moves none of those bytes. The "report of problems" describe near the end is where the
 * shuffle bites, because a problem list and a duplicate-stem refusal are in *found* order and have
 * nothing but the entry sort protecting them. Read the two together: the table says the surfaces are
 * stable, and that describe says the mechanism keeping them stable is still there.
 */
import type * as FsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/cli/program.js";

/** Which permutation directory listings come back in. */
type ReadOrder = "natural" | "reversed" | "rotated";

/**
 * The wrapper's state, shared with the module mock below — which is hoisted above every import, so
 * it cannot close over anything declared normally.
 *
 * `seen` records the directories the wrapper was asked for, which is how the guard case proves the
 * mock is in force inside `src/` rather than only inside this file.
 */
const readOrder = vi.hoisted(() => ({
  current: "natural" as ReadOrder,
  seen: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  // `readdir` is overloaded across its options and its element type; the wrapper cares about none of
  // that, so it forwards its arguments untouched and permutes whatever array comes back.
  const forward = actual.readdir as unknown as (...args: readonly unknown[]) => Promise<unknown[]>;
  const wrapped = async (...args: readonly unknown[]): Promise<unknown[]> => {
    readOrder.seen.push(String(args[0]));
    return permute(await forward(...args), readOrder.current);
  };
  const readdir = wrapped as unknown as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

/**
 * `entries` in an order no filesystem necessarily chose.
 *
 * Two permutations, both fixed rather than random: reversal disturbs a two-entry directory (the
 * fixture's `mcps/`), rotation disturbs a longer one differently, and a seeded shuffle would make a
 * failure depend on which run produced it. Declared as a function so the hoisted mock factory above
 * can call it.
 */
function permute<T>(entries: readonly T[], order: ReadOrder): T[] {
  switch (order) {
    case "natural":
      return [...entries];
    case "reversed":
      return [...entries].reverse();
    case "rotated": {
      const [first, ...rest] = entries;
      return first === undefined ? [] : [...rest, first];
    }
  }
}

/** The orders every claim here is repeated under, beyond the filesystem's own. */
const SHUFFLED: readonly ReadOrder[] = ["reversed", "rotated"];

/** Runs `body` with directory listings permuted, restoring the filesystem's own order after. */
async function withReadOrder<T>(order: ReadOrder, body: () => Promise<T>): Promise<T> {
  readOrder.current = order;
  try {
    return await body();
  } finally {
    readOrder.current = "natural";
  }
}

const CATALOG_NAME = "company";

const CORE_SKILL = "acme.commons.use-company-context";

/**
 * Enough held scopes to select every skill and server the fixture holds, so each surface has as much
 * to sort as it can. The fourth registered scope is a descendant of `function.engineering` and is
 * reached by the subtree rule rather than held.
 */
const HELD_SCOPES = ["core", "function.engineering", "project.acme"];

/** The fixture's two credentials, stubbed so no surface depends on the developer's environment. */
const ENV_STUBS: Readonly<Record<string, string>> = {
  SCOPED_API_KEY: "determinism-scoped-key",
  FIXTURE_API_KEY: "determinism-fixture-key",
};

/** One thing ambit prints, and which directory it is pointed at. */
interface Surface {
  /** The words a user types, without the directory flag. */
  readonly argv: readonly string[];
  /** `project` takes `--project <dir>`; `catalog` takes `--catalog <dir>`. */
  readonly dir: "project" | "catalog";
}

/**
 * Every surface whose bytes this file pins, consumer and authoring alike.
 *
 * Text and `--json` are separate rows on purpose: they are two renderings, and only one of them is
 * covered by the goldens. The three `--dry-run` rows are here because a preview is a report — the
 * one surface of a mutating command that prints without writing, and the one nothing else asserts
 * twice.
 */
const SURFACES: readonly Surface[] = [
  { argv: ["scopes"], dir: "project" },
  { argv: ["scopes", "--json"], dir: "project" },
  { argv: ["catalog"], dir: "project" },
  { argv: ["catalog", "--json"], dir: "project" },
  { argv: ["resolve"], dir: "project" },
  { argv: ["resolve", "--json"], dir: "project" },
  { argv: ["resolve", "--explain"], dir: "project" },
  { argv: ["resolve", "--explain", "--json"], dir: "project" },
  { argv: ["why", CORE_SKILL], dir: "project" },
  { argv: ["why", CORE_SKILL, "--json"], dir: "project" },
  { argv: ["why", "mcp.fixture"], dir: "project" },
  { argv: ["status"], dir: "project" },
  { argv: ["status", "--json"], dir: "project" },
  { argv: ["validate"], dir: "project" },
  { argv: ["validate", "--json"], dir: "project" },
  { argv: ["doctor"], dir: "project" },
  { argv: ["doctor", "--json"], dir: "project" },
  { argv: ["install", "--dry-run"], dir: "project" },
  { argv: ["install", "--dry-run", "--json"], dir: "project" },
  { argv: ["prune", "--dry-run"], dir: "project" },
  { argv: ["prune", "--dry-run", "--json"], dir: "project" },
  { argv: ["clean", "--dry-run"], dir: "project" },
  { argv: ["clean", "--dry-run", "--json"], dir: "project" },
  { argv: ["catalog", "tree"], dir: "catalog" },
  { argv: ["catalog", "tree", "--json"], dir: "catalog" },
  { argv: ["catalog", "audit"], dir: "catalog" },
  { argv: ["catalog", "audit", "--json"], dir: "catalog" },
  { argv: ["validate"], dir: "catalog" },
];

/** What a surface printed, whole: two streams and the code, since all three have to be stable. */
interface Output {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** A date or a clock time in any shape ambit could plausibly print (no timestamps). */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/;

let root: string;
let catalogDir: string;
let projectDir: string;
let installed: Record<string, string>;

/** Points a project at a sibling `catalog/` directory and holds every scope the fixture registers. */
async function writeProfile(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
scopes:
${HELD_SCOPES.map((scope) => `  - ${scope}`).join("\n")}
`,
    "utf8",
  );
}

/** Runs the CLI, collecting both streams. */
async function cli(argv: readonly string[], cwd: string): Promise<Output> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv], {
    cwd,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** How a surface is typed against the shared fixture. */
function argvOf(surface: Surface): readonly string[] {
  const dir = surface.dir === "project" ? projectDir : catalogDir;
  return [...surface.argv, `--${surface.dir}`, dir];
}

/** How a surface's case is titled: what a reader would have to type to reproduce it. */
function titleOf(surface: Surface): string {
  return `ambit ${surface.argv.join(" ")} --${surface.dir}`;
}

async function runSurface(surface: Surface, order: ReadOrder = "natural"): Promise<Output> {
  return withReadOrder(order, () => cli(argvOf(surface), root));
}

/**
 * Every path under `dir`, relative and `/`-separated, mapped to what is there: a file's bytes, or
 * `-> target` for a symlink.
 *
 * Deliberately does not follow a link. Which of the two shapes install chose is part of what has to
 * stay stable, and descending into a linked skill would compare the catalog's own bytes instead.
 */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const within = relative === "" ? entry : `${relative}/${entry}`;
      const absolute = path.join(current, entry);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) found[within] = `-> ${await readlink(absolute)}`;
      else if (stats.isDirectory()) await walk(absolute, within);
      else found[within] = await readFile(absolute, "utf8");
    }
  };

  await walk(dir, "");
  return found;
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV_STUBS)) vi.stubEnv(name, value);

  root = await mkdtemp(path.join(tmpdir(), "ambit-determinism-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile(projectDir);

  const install = await cli(["install", "--project", projectDir], root);
  expect(install.code, install.stderr).toBe(ExitCode.Success);
  installed = await snapshot(projectDir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/**
 * The wrapper this file's whole claim rests on. Both cases fail loudly rather than vacuously: the
 * first if the permutation stops permuting, the second if it stops reaching `src/`.
 */
describe("the shuffled read order this suite relies on", () => {
  it("hands a directory's entries back in a different order under each shuffle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ambit-read-order-"));
    for (const name of ["a", "b", "c"]) await writeFile(path.join(dir, name), "", "utf8");

    const natural = await withReadOrder("natural", () => readdir(dir));
    const reversed = await withReadOrder("reversed", () => readdir(dir));
    const rotated = await withReadOrder("rotated", () => readdir(dir));

    expect(reversed).toEqual([...natural].reverse());
    expect(reversed).not.toEqual(natural);
    expect(rotated).not.toEqual(natural);
    expect(rotated).not.toEqual(reversed);
    expect([...rotated].sort()).toEqual([...natural].sort());

    await rm(dir, { recursive: true, force: true });
  });

  it("permutes the listings ambit reads, not only the ones this file reads", async () => {
    readOrder.seen.length = 0;

    const result = await runSurface({ argv: ["resolve", "--json"], dir: "project" }, "reversed");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    // Both halves of a catalog are walked through the wrapper, so a sort removed from either one
    // would show up in the cases below rather than passing unobserved.
    expect(readOrder.seen).toContain(path.join(catalogDir, "skills"));
    expect(readOrder.seen).toContain(path.join(catalogDir, "mcps"));
  });
});

describe("every surface prints the same bytes twice", () => {
  for (const surface of SURFACES) {
    it(`${titleOf(surface)} is byte-identical on a second run`, async () => {
      const first = await runSurface(surface);
      const second = await runSurface(surface);

      expect(second).toEqual(first);
    });
  }
});

describe("every surface ignores the order the filesystem lists directories in", () => {
  for (const surface of SURFACES) {
    it(`${titleOf(surface)} is byte-identical under a shuffled read order`, async () => {
      const baseline = await runSurface(surface);

      for (const order of SHUFFLED) {
        expect(await runSurface(surface, order), `read order: ${order}`).toEqual(baseline);
      }
    });
  }
});

/**
 * The other two halves of the determinism rule, checked over the whole table rather than command by
 * command: output that named a machine path or the wall clock would differ between two machines
 * even though it is stable on one, which is the failure a golden file cannot catch.
 */
describe("no surface carries anything machine-specific", () => {
  it("names no absolute path from this machine", async () => {
    for (const surface of SURFACES) {
      const result = await runSurface(surface);
      const printed = `${result.stdout}\n${result.stderr}`;

      expect(printed, titleOf(surface)).not.toContain(root);
      expect(printed, titleOf(surface)).not.toContain(tmpdir());
    }
  });

  it("prints no date and no clock time", async () => {
    for (const surface of SURFACES) {
      const result = await runSurface(surface);

      expect(`${result.stdout}\n${result.stderr}`, titleOf(surface)).not.toMatch(TIMESTAMP);
    }
  });
});

/**
 * The guard on sharing one project across the table above: every surface listed there is either
 * read-only or a `--dry-run`, and a row that turned out to write would have corrupted the fixture
 * for whatever ran after it.
 */
describe("nothing in the surface table touches disk", () => {
  it("leaves the installed project byte-identical to what install wrote", async () => {
    expect(await snapshot(projectDir)).toEqual(installed);
  });
});

/**
 * The two surfaces that make the shuffle above more than a formality.
 *
 * Everything the table asserts is protected twice over — a catalog's directory entries are sorted as
 * they are read, and its skills, servers and scopes are sorted again before they are emitted — so a
 * single missing sort would not move any of those bytes. These two do move: a report of *problems*
 * is in the order they were found, and the two documents in a duplicate-stem refusal are named in
 * the order the directory listed them, so nothing but the entry sort stands between read order and
 * output. Delete `sortedEntries`' sort and this describe is where it shows up.
 *
 * Both are `validate --catalog`, which is the surface that reports rather than throws on the first
 * offender, and both catalogs are per-test copies: the shared fixture has to stay valid.
 */
describe("a report of problems is in the same order whatever order directories are read in", () => {
  let brokenRoot: string;
  let brokenCatalog: string;

  /** Adds a skill whose frontmatter `name` disagrees with its path — the one problem parsing collects. */
  async function writeMismatchedSkill(relative: string, declared: string): Promise<void> {
    const target = path.join(brokenCatalog, "skills", relative, "SKILL.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      ["---", `name: ${declared}`, "ambit:", "  scopes: [core]", "---", "", "# fixture", ""].join(
        "\n",
      ),
      "utf8",
    );
  }

  async function validateBroken(order: ReadOrder): Promise<Output> {
    return withReadOrder(order, () => cli(["validate", "--catalog", brokenCatalog], brokenRoot));
  }

  /** Asserts the two shuffles print exactly what the filesystem's own order printed. */
  async function expectStable(expected: Output): Promise<void> {
    for (const order of SHUFFLED) {
      expect(await validateBroken(order), `read order: ${order}`).toEqual(expected);
    }
  }

  beforeEach(async () => {
    brokenRoot = await mkdtemp(path.join(tmpdir(), "ambit-determinism-report-"));
    brokenCatalog = path.join(brokenRoot, "catalog");
    await buildFixtureCatalog(brokenCatalog);
  });

  afterEach(async () => {
    await rm(brokenRoot, { recursive: true, force: true });
  });

  it("lists two skills whose names disagree with their paths in one order", async () => {
    await writeMismatchedSkill("acme/broken/use-alpha", "acme.broken.wrong-alpha");
    await writeMismatchedSkill("acme/broken/use-omega", "acme.broken.wrong-omega");

    const baseline = await validateBroken("natural");

    expect(baseline.code).toBe(ExitCode.Resolution);
    expect(baseline.stdout).toContain("problems (2)");
    // The report is in the order the walk found them, so the sort has to be in the walk.
    expect(baseline.stdout.indexOf("use-alpha")).toBeLessThan(baseline.stdout.indexOf("use-omega"));
    await expectStable(baseline);
  });

  it("names the two documents defining one MCP entity in one order", async () => {
    for (const extension of [".yml", ".yaml"]) {
      await writeFile(
        path.join(brokenCatalog, "mcps", `dup${extension}`),
        ["name: dup", "transport:", "  stdio:", "    command: fixture-mcp", ""].join("\n"),
        "utf8",
      );
    }

    const baseline = await validateBroken("natural");

    expect(baseline.code).toBe(ExitCode.Config);
    expect(baseline.stderr).toContain('mcps/dup.yaml and mcps/dup.yml both define "dup"');
    await expectStable(baseline);
  });
});

/**
 * The write path's own determinism. `ambit.lock` is already pinned byte-for-byte across two runs
 * (A14); what is new here is that the whole installed tree — lock, state, `.mcp.json`, the
 * gitignore block, and every symlink target — comes out the same when the catalog's directories are
 * read in a different order.
 *
 * Each order installs into its own project directory, all of them siblings of one catalog, so the
 * relative symlinks a linked skill carries are comparable between them.
 */
describe("ambit install writes the same tree whatever order directories are read in", () => {
  let writeRoot: string;

  /** Installs a fresh project under one read order and returns everything that landed in it. */
  async function installUnder(order: ReadOrder): Promise<Record<string, string>> {
    const dir = path.join(writeRoot, `project-${order}`);
    await mkdir(dir, { recursive: true });
    await writeProfile(dir);

    const result = await withReadOrder(order, () => cli(["install", "--project", dir], writeRoot));
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    return snapshot(dir);
  }

  beforeEach(async () => {
    writeRoot = await mkdtemp(path.join(tmpdir(), "ambit-determinism-install-"));
    await buildFixtureCatalog(path.join(writeRoot, "catalog"));
  });

  afterEach(async () => {
    await rm(writeRoot, { recursive: true, force: true });
  });

  it("puts identical bytes and identical links in every project", async () => {
    const baseline = await installUnder("natural");

    for (const order of SHUFFLED) {
      expect(await installUnder(order), `read order: ${order}`).toEqual(baseline);
    }
  });
});
