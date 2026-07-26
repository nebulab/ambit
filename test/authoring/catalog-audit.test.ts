/**
 * `ambit catalog audit` — dead scopes and unreachable items.
 *
 * The subject of most of this suite is a catalog built **by the authoring commands themselves**:
 * `catalog init`, then `scope add`, `skill new`, `mcp new` and `annotate`. That is deliberate on two
 * counts. It makes the suite a round trip over B03–B07 — every command has to produce something the
 * parser reads back and the audit can reason about — and it means the fixture holding one of each
 * finding class is a catalog somebody could actually have authored, rather than one hand-written to
 * fail.
 *
 * Three claims carry it. The first is the split from `validate`: the authored catalog passes
 * `ambit catalog validate` with zero problems while the audit reports three findings, which is the whole
 * reason this command exists as a separate report — dead weight is a smell, not a broken catalog.
 *
 * The second is that reachability is transitive and follows `requires` in both namespaces: a server
 * nothing declares but a reachable skill requires is *not* reported, and a skill required only by an
 * unreachable skill *is*.
 *
 * The third is the scope rule, asserted against the shared fixture: a registered scope is dead only
 * when its whole subtree selects nothing, so registering a parent of a declared scope adds no finding
 * while registering an unrelated one does (matching `catalog tree`'s own claim).
 */
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { CATALOG_INIT_SCOPE } from "../../src/authoring/init.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

/** The scope `catalog init` registers, and the one the reachable skill declares. */
const CORE = CATALOG_INIT_SCOPE;

/** Registered, declared by nothing, with nothing registered beneath it. */
const DEAD_SCOPE = "project.dead";

/** Declares `core`, and requires the one server that is therefore reachable. */
const BRIEF = "brief";
const NEEDED = "needed";

/** Declares no scope, and nothing requires either of them. */
const ORPHAN_SKILL = "orphan";
const ORPHAN_MCP = "orphan";

let root: string;
let authored: string;

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as given. An authoring command takes `--catalog`, never `--project`. */
async function invoke(...argv: readonly string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Runs one authoring command against `dir`, asserting it succeeded. */
async function author(dir: string, ...argv: readonly string[]): Promise<CliResult> {
  const result = await invoke("catalog", ...argv, "--catalog", dir);
  expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(ExitCode.Success);
  return result;
}

/** Audits `dir`, asserting the command itself succeeded — findings are exit 0 without `--check`. */
async function audit(dir: string, ...flags: readonly string[]): Promise<CliResult> {
  const result = await invoke("catalog", "audit", "--catalog", dir, ...flags);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** One finding as `--json` carries it. */
interface JsonFinding {
  detail: readonly string[];
  kind: string;
  message: string;
}

interface JsonReport {
  audited: { mcps: number; scopes: number; skills: number };
  findings: readonly JsonFinding[];
  tidy: boolean;
}

async function auditJson(dir: string): Promise<JsonReport> {
  return JSON.parse((await audit(dir, "--json")).stdout) as JsonReport;
}

/**
 * Builds the audit fixture with the authoring commands, holding exactly one of each finding class
 * alongside one reachable item of each kind.
 *
 * Nothing here is hand-written, so a command that stopped producing something the parser reads back
 * fails this suite rather than only its own.
 */
async function buildAuthoredCatalog(dir: string): Promise<string> {
  await author(dir, "init");
  await author(
    dir,
    "skill",
    "new",
    BRIEF,
    "--description",
    "The engagement brief.",
    "--scope",
    CORE,
  );
  await author(dir, "scope", "add", DEAD_SCOPE, "--description", "An engagement that ended");
  await author(dir, "skill", "new", ORPHAN_SKILL, "--description", "Nothing points at this.");
  await author(
    dir,
    "mcp",
    "new",
    NEEDED,
    "--stdio",
    "npx",
    "--arg",
    "-y",
    "--arg",
    "@acme/needed-mcp",
  );
  await author(dir, "annotate", BRIEF, "--add-requires", `mcp.${NEEDED}`);
  await author(
    dir,
    "mcp",
    "new",
    ORPHAN_MCP,
    "--stdio",
    "npx",
    "--arg",
    "-y",
    "--arg",
    "@acme/orphan-mcp",
  );
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-audit-"));
  authored = await buildAuthoredCatalog(path.join(root, "authored"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog audit", () => {
  it("reports the dead scope, the unreachable skill, and the unreachable server", async () => {
    const result = await audit(authored);

    expect(result.stdout).toBe(
      [
        "audited 2 scopes, 2 skills, 2 mcps",
        "",
        "findings (3)",
        `  unused scope "${DEAD_SCOPE}" (scopes.yml)`,
        "      no skill and no MCP server declares it, and nothing registered beneath it does either",
        "      holding it selects nothing, so every picker rendering this registry offers a choice with no effect",
        `      declare it with \`ambit catalog annotate <name> --add-scope ${DEAD_SCOPE}\`, or unregister it with \`ambit catalog scope rm ${DEAD_SCOPE}\``,
        `  unreachable skill "${ORPHAN_SKILL}" (skills/orphan/SKILL.md)`,
        "      it declares no registered scope, and nothing reachable requires it",
        "      no profile can select it, so nothing it says ever reaches an agent",
        `      give it a scope with \`ambit catalog annotate ${ORPHAN_SKILL} --add-scope <scope>\`, or remove it with \`ambit catalog skill rm ${ORPHAN_SKILL}\``,
        `  unreachable MCP server "${ORPHAN_MCP}" (mcps/${ORPHAN_MCP}.yml)`,
        `      no registered scope selects it, and nothing reachable requires \`mcp.${ORPHAN_MCP}\``,
        "      no profile can select it, so nothing ever starts the server",
        `      give it a scope with \`ambit catalog annotate mcp.${ORPHAN_MCP} --add-scope <scope>\`, or remove it with \`ambit catalog mcp rm ${ORPHAN_MCP}\``,
      ].join("\n"),
    );
  });

  it("finds every one of them in a catalog `ambit catalog validate` calls clean", async () => {
    // The whole reason this is a second report: nothing here is a validation problem. A skill with no
    // scopes and a registered scope nobody declares are both perfectly legal.
    const validated = await invoke("catalog", "validate", "--catalog", authored);

    expect(validated.code, validated.stderr).toBe(ExitCode.Success);
    expect(validated.stdout).toContain("problems (0)");
    expect((await auditJson(authored)).findings).toHaveLength(3);
  });

  it("treats a server nothing declares but a reachable skill requires as reachable", async () => {
    const report = await auditJson(authored);

    expect(report.findings.map((found) => found.kind)).toEqual([
      "dead-scope",
      "unreachable-skill",
      "unreachable-mcp",
    ]);
    // The `requires` closure is the other way in, so neither the requirer nor the
    // required server is dead weight.
    expect(JSON.stringify(report)).not.toContain(NEEDED);
    expect(JSON.stringify(report)).not.toContain(BRIEF);
  });

  it("reports a skill only an unreachable skill requires", async () => {
    // Reachability is transitive: a one-step rule would call this pair reachable, and no profile can
    // select either of them.
    const deep = "deep";
    await author(authored, "skill", "new", deep, "--description", "Reached only from the orphan.");
    await author(authored, "annotate", ORPHAN_SKILL, "--add-requires", deep);

    const messages = (await auditJson(authored)).findings.map((found) => found.message);
    expect(messages.filter((message) => message.startsWith("unreachable skill"))).toEqual([
      `unreachable skill "${deep}" (skills/deep/SKILL.md)`,
      `unreachable skill "${ORPHAN_SKILL}" (skills/orphan/SKILL.md)`,
    ]);
  });

  it("stops reporting an item once something reachable selects it", async () => {
    await author(authored, "annotate", ORPHAN_SKILL, "--add-scope", CORE);
    await author(authored, "annotate", `mcp.${ORPHAN_MCP}`, "--add-scope", CORE);
    await author(authored, "scope", "rm", DEAD_SCOPE);

    const report = await auditJson(authored);
    expect(report.findings).toEqual([]);
    expect(report.tidy).toBe(true);
  });

  it("reads the catalog `--catalog` names, defaulting to the cwd", async () => {
    const given = await audit(authored);

    const out: string[] = [];
    const code = await run(["catalog", "audit"], {
      cwd: authored,
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(ExitCode.Success);
    expect(out.join("\n")).toBe(given.stdout);
  });

  it("exits 2 when the directory is not a catalog", async () => {
    const result = await invoke("catalog", "audit", "--catalog", root);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("scopes.yml is missing");
  });
});

describe("ambit catalog audit --check", () => {
  it("exits 6 when anything was found, printing the same report", async () => {
    const plain = await audit(authored);
    const checked = await invoke("catalog", "audit", "--catalog", authored, "--check");

    expect(checked.code).toBe(ExitCode.Doctor);
    expect(checked.stdout).toBe(plain.stdout);
    expect(checked.stderr).toBe("");
  });

  it("exits 0 when the catalog carries no dead weight", async () => {
    // The shared fixture: every skill declares a registered scope, and its second server is reached
    // through `requires` alone — which is exactly the shape a naive audit would report.
    const fixture = await buildFixtureCatalog(path.join(root, "fixture"));
    const result = await invoke("catalog", "audit", "--catalog", fixture, "--check");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      ["audited 4 scopes, 4 skills, 2 mcps", "", "findings (0)", "  (none)"].join("\n"),
    );
  });
});

describe("ambit catalog audit --json", () => {
  it("carries what was audited, every finding, and the verdict", async () => {
    const report = await auditJson(authored);

    expect(report.audited).toEqual({ mcps: 2, scopes: 2, skills: 2 });
    expect(report.tidy).toBe(false);
    expect(report.findings.map((found) => ({ kind: found.kind, message: found.message }))).toEqual([
      { kind: "dead-scope", message: `unused scope "${DEAD_SCOPE}" (scopes.yml)` },
      {
        kind: "unreachable-skill",
        message: `unreachable skill "${ORPHAN_SKILL}" (skills/orphan/SKILL.md)`,
      },
      {
        kind: "unreachable-mcp",
        message: `unreachable MCP server "${ORPHAN_MCP}" (mcps/${ORPHAN_MCP}.yml)`,
      },
    ]);
    for (const found of report.findings) expect(found.detail.length).toBeGreaterThan(0);
  });

  it("emits byte-identical JSON on a second run, carrying no machine-specific paths", async () => {
    const first = await audit(authored, "--json");
    const second = await audit(authored, "--json");

    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).not.toContain(root);
    expect((await audit(authored)).stdout).not.toContain(root);
  });
});

/**
 * The scope half of the report, against the shared fixture rather than the authored one: a scope is
 * dead only when its whole registered subtree selects nothing, which is the same rule `catalog tree`
 * draws and `expandHeldScopes` walks.
 */
describe("what makes a registered scope dead", () => {
  let fixture: string;

  beforeEach(async () => {
    fixture = await buildFixtureCatalog(path.join(root, "fixture"));
  });

  it("reports a scope nothing beneath it declares either", async () => {
    await author(fixture, "scope", "add", "person.jane", "--description", "Jane's own things");

    expect((await auditJson(fixture)).findings.map((found) => found.message)).toEqual([
      'unused scope "person.jane" (scopes.yml)',
    ]);
  });

  it("reports no finding for a parent whose descendants are declared", async () => {
    // Nothing declares `function`, and holding it reaches the whole engineering subtree — so it is
    // not dead weight, and reporting it would tell someone to delete a scope that works.
    await author(fixture, "scope", "add", "function", "--description", "Every function");

    const report = await auditJson(fixture);
    expect(report.audited.scopes).toBe(5);
    expect(report.findings).toEqual([]);
  });

  it("names the file an MCP entity is actually written as", async () => {
    // `.yaml` is as legal as `.yml`, and an error — or a finding, which
    // is the same thing listed rather than raised — has to name a file that is there.
    await author(fixture, "annotate", "mcp.scoped", "--remove-scope", "function.engineering");
    await rename(
      path.join(fixture, "mcps", "scoped.yml"),
      path.join(fixture, "mcps", "scoped.yaml"),
    );

    expect((await auditJson(fixture)).findings.map((found) => found.message)).toEqual([
      'unreachable MCP server "scoped" (mcps/scoped.yaml)',
    ]);
  });
});
