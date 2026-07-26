/**
 * `ambit scopes`: the picker data a consuming tool renders.
 *
 * The registry is the subject, so every case asserts the *whole* table — a scope that quietly went
 * missing from a merged registry is exactly the failure a picker cannot recover from, since a person
 * cannot choose what they are never shown.
 *
 * The other half of each case is `held`, which is what makes this command more than a slice of
 * `ambit catalog`. It is literal membership in `ambit.yml`'s list, so the descendants-only rule (spec
 * §2) must not leak into it: a project holding a parent scope reaches the child, and still does not
 * hold it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

const CATALOG_NAME = "company";
const SECOND = "personal";

/** The fixture's four scopes and their descriptions, which are the payload of this command. */
const CORE = "core";
const ENGINEERING = "function.engineering";
const FRONTEND = "function.engineering.frontend";
const PROJECT = "project.acme";

const CORE_DESCRIPTION = "The universal floor — context everyone needs";
const ENGINEERING_DESCRIPTION = "Building and shipping software";
const FRONTEND_DESCRIPTION = "Browser-side work: components, styling, accessibility";
const PROJECT_DESCRIPTION = "The Acme engagement";

/** A scope only the second catalog registers, so the merge is visible in the output. */
const JANE = "person.jane";
const JANE_DESCRIPTION = "Jane's own things";

let root: string;
let catalogDir: string;
let secondDir: string;
let projectDir: string;

/** Points the project at the fixture catalog, and optionally at a second one, and gives it `scopes`. */
async function writeProfile(
  scopes: readonly string[],
  catalogs: readonly string[] = [CATALOG_NAME],
): Promise<void> {
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  const entries = catalogs
    .map((name) => `  - name: ${name}\n    source: path:../${name === CATALOG_NAME ? "catalog" : name}\n`)
    .join("");
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1\ncatalogs:\n${entries}scopes: ${list}\n`,
    "utf8",
  );
}

/** A second catalog: a registry and nothing else, since only its scopes matter here. */
async function writeSecondCatalog(): Promise<void> {
  await mkdir(secondDir, { recursive: true });
  await writeFile(
    path.join(secondDir, "scopes.yml"),
    [
      "scopes:",
      `  ${CORE}:`,
      `    description: ${JSON.stringify(CORE_DESCRIPTION)}`,
      `  ${JANE}:`,
      `    description: ${JSON.stringify(JANE_DESCRIPTION)}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Runs the CLI against the project, collecting stdout and stderr. */
async function cli(
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", projectDir], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** One scope as `--json` reports it. */
interface ScopeRecord {
  readonly description: string;
  readonly held: boolean;
}

async function report(): Promise<Readonly<Record<string, ScopeRecord>>> {
  const result = await cli("scopes", "--json");
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return (JSON.parse(result.stdout) as { scopes: Readonly<Record<string, ScopeRecord>> }).scopes;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-scopes-"));
  catalogDir = path.join(root, "catalog");
  secondDir = path.join(root, SECOND);
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile([CORE]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit scopes", () => {
  it("lists every registered scope with its description, marking the held ones", async () => {
    const result = await cli("scopes");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "scopes (4)",
        `  ${CORE}                           held  ${CORE_DESCRIPTION}`,
        `  ${ENGINEERING}           -     ${ENGINEERING_DESCRIPTION}`,
        `  ${FRONTEND}  -     ${FRONTEND_DESCRIPTION}`,
        `  ${PROJECT}                   -     ${PROJECT_DESCRIPTION}`,
      ].join("\n"),
    );
  });

  it("emits the registry as a name-keyed map in --json, sorted by name", async () => {
    const scopes = await report();

    expect(scopes).toEqual({
      [CORE]: { description: CORE_DESCRIPTION, held: true },
      [ENGINEERING]: { description: ENGINEERING_DESCRIPTION, held: false },
      [FRONTEND]: { description: FRONTEND_DESCRIPTION, held: false },
      [PROJECT]: { description: PROJECT_DESCRIPTION, held: false },
    });
    expect(Object.keys(scopes)).toEqual([CORE, ENGINEERING, FRONTEND, PROJECT]);
  });

  it("merges the registries of every configured catalog", async () => {
    await writeSecondCatalog();
    await writeProfile([CORE, JANE], [CATALOG_NAME, SECOND]);

    const scopes = await report();

    expect(Object.keys(scopes)).toEqual([CORE, ENGINEERING, FRONTEND, JANE, PROJECT]);
    expect(scopes[JANE]).toEqual({ description: JANE_DESCRIPTION, held: true });
  });

  it("marks a scope held only where the project lists it, not where it is merely reached", async () => {
    // Holding the parent selects the child but does not hold it, and a picker that
    // pre-checked the child would report a choice nobody made.
    await writeProfile([ENGINEERING]);

    const scopes = await report();

    expect(scopes[ENGINEERING]?.held).toBe(true);
    expect(scopes[FRONTEND]?.held).toBe(false);
  });

  it("marks nothing held for a project that holds nothing", async () => {
    await writeProfile([]);

    const scopes = await report();

    expect(Object.values(scopes).map((scope) => scope.held)).toEqual([false, false, false, false]);
  });

  it("still renders the registry when a held scope is registered nowhere", async () => {
    // This is the command someone reads to fix that typo, so it must not be the command the typo
    // breaks. `resolve` is where an unregistered scope is an error, and it still is.
    await writeProfile([CORE, "function.enginering"]);

    const scopes = await report();
    const resolved = await cli("resolve");

    expect(Object.keys(scopes)).toEqual([CORE, ENGINEERING, FRONTEND, PROJECT]);
    expect(scopes[CORE]?.held).toBe(true);
    expect(resolved.code).toBe(ExitCode.Resolution);
    expect(resolved.stderr).toContain('unknown scope "function.enginering"');
  });
});
