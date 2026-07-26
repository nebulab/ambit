/**
 * `ambit catalog mcp new|rm` (spec §6, "Catalog authoring") — maintaining an MCP entity.
 *
 * Three claims carry this suite. The first is the round trip: what `new` writes is exactly `emitYaml` of
 * the values it was given, and the §3.3 parser reads that file back as the entity — for *both* transport
 * kinds, since `transport` is the discriminator and a command that could write an ambiguous one would
 * break every consumer. The second is the discriminator itself: neither flag and both flags are refused
 * with exit 2 naming the supported kinds, and so is a flag belonging to the kind that was not named,
 * because a `--header` that is typed, accepted, and silently dropped is worse than an error. The third is
 * the one every authoring suite makes: a refusal costs nothing, so every rejection asserts the tree is
 * untouched.
 *
 * Everything runs against a per-test copy of the fixture catalog. The shared fixture must stay clean: it
 * is what the golden profiles resolve against.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { Catalog } from "../../src/model/catalog.js";
import { parseCatalogDirectory } from "../../src/model/catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { emitYaml } from "../../src/model/yaml.js";

/** The fixture's own two servers: one nothing may remove, one nothing requires. */
const REQUIRED = "fixture";
const REQUIRED_FILE = "mcps/fixture.yml";
const REQUIRER = "acme.projects.use-acme-brief";
const REQUIRER_FILE = "skills/acme/projects/use-acme-brief/SKILL.md";

const FREE = "scoped";
const FREE_FILE = "mcps/scoped.yml";

/** The stdio server the cases create, and the argv it is spawned with. */
const NOTES = "notes";
const NOTES_FILE = "mcps/notes.yml";
const NOTES_COMMAND = "npx";
const NOTES_ARGS = ["-y", "@acme/notes-mcp"] as const;
const NOTES_ENV = "NOTES_TOKEN";

/** The http server the cases create. */
const CLOSE = "close";
const CLOSE_FILE = "mcps/close.yml";
const CLOSE_URL = "https://api.close.com/mcp";
const CLOSE_HEADER = "Authorization";
const CLOSE_HEADER_VALUE = "Bearer ${CLOSE_API_KEY}";

let root: string;
let catalogDir: string;
let projectDir: string;

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

/** Runs an mcp command against the catalog under test. */
async function mcp(...argv: readonly string[]): Promise<CliResult> {
  return invoke("catalog", "mcp", ...argv, "--catalog", catalogDir);
}

/** Runs one, asserting it succeeded. */
async function succeeds(...argv: readonly string[]): Promise<CliResult> {
  const result = await mcp(...argv);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Runs one, asserting it was refused with `code` and that nothing on disk moved. */
async function refused(code: ExitCode, ...argv: readonly string[]): Promise<CliResult> {
  const before = await snapshot();
  const result = await mcp(...argv);

  expect(result.code, result.stdout).toBe(code);
  expect(result.stdout).toBe("");
  expect(await snapshot()).toEqual(before);
  return result;
}

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

/** Every file in the catalog with its bytes, so "nothing was written" can be asserted as a whole. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const inner = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), inner);
      else files[inner] = await readFile(path.join(dir, entry.name), "utf8");
    }
  };
  await walk(catalogDir, "");
  return files;
}

/** The catalog as the parser reads it back. */
async function parsed(): Promise<Catalog> {
  return parseCatalogDirectory("subject", `path:${catalogDir}`, catalogDir);
}

/** One server as the §3.3 parser reads it, or `undefined` when the catalog provides none by that name. */
async function server(name: string) {
  return (await parsed()).mcps.find((candidate) => candidate.name === name);
}

/** `ambit validate` against the catalog: what every mutation has to leave passing. */
async function validates(): Promise<CliResult> {
  const result = await invoke("validate", "--catalog", catalogDir);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Creates the stdio server the round-trip cases share. */
async function newNotes(...extra: readonly string[]): Promise<CliResult> {
  return succeeds(
    "new",
    NOTES,
    "--stdio",
    NOTES_COMMAND,
    "--arg",
    NOTES_ARGS[0],
    "--arg",
    NOTES_ARGS[1],
    "--env",
    NOTES_ENV,
    ...extra,
  );
}

/** Creates the http server the round-trip cases share. */
async function newClose(...extra: readonly string[]): Promise<CliResult> {
  return succeeds(
    "new",
    CLOSE,
    "--http",
    CLOSE_URL,
    "--header",
    `${CLOSE_HEADER}=${CLOSE_HEADER_VALUE}`,
    ...extra,
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-mcp-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    "version: 1\ncatalogs:\n  - name: company\n    source: path:../catalog\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog mcp new", () => {
  it("writes one entity file, named for the server, and nothing else", async () => {
    const before = await snapshot();

    await newNotes();

    const after = await snapshot();
    expect(Object.keys(after)).toEqual([...Object.keys(before), NOTES_FILE].sort());
    for (const file of Object.keys(before)) expect(after[file], file).toBe(before[file]);
    await validates();
  });

  it("emits a stdio entity as exactly `emitYaml` of its values, and parses it back", async () => {
    await newNotes();

    // The bytes are `emitYaml`'s, so keys are sorted at every depth and a value that would otherwise
    // coerce is quoted (spec §3.0). The values are restated here rather than imported, so the claim is
    // independent of what the command computed.
    expect(await read(NOTES_FILE)).toBe(
      emitYaml({
        env: [NOTES_ENV],
        name: NOTES,
        transport: { stdio: { args: [...NOTES_ARGS], command: NOTES_COMMAND } },
      }),
    );
    // `file` is the document parsing read the entity out of, carried so anything reporting about it
    // can name the file that is actually there rather than the extension ambit happens to write.
    expect(await server(NOTES)).toEqual({
      name: NOTES,
      scopes: [],
      env: [NOTES_ENV],
      file: NOTES_FILE,
      transport: { kind: "stdio", command: NOTES_COMMAND, args: [...NOTES_ARGS] },
    });
    await validates();
  });

  it("emits an http entity as exactly `emitYaml` of its values, and parses it back", async () => {
    await newClose("--env", "CLOSE_API_KEY");

    expect(await read(CLOSE_FILE)).toBe(
      emitYaml({
        env: ["CLOSE_API_KEY"],
        name: CLOSE,
        transport: { http: { headers: { [CLOSE_HEADER]: CLOSE_HEADER_VALUE }, url: CLOSE_URL } },
      }),
    );
    expect(await server(CLOSE)).toEqual({
      name: CLOSE,
      scopes: [],
      env: ["CLOSE_API_KEY"],
      file: CLOSE_FILE,
      transport: {
        kind: "http",
        url: CLOSE_URL,
        headers: { [CLOSE_HEADER]: CLOSE_HEADER_VALUE },
      },
    });
    await validates();
  });

  it("agrees with its filename, which is the only thing that names a server", async () => {
    await newNotes();

    expect(Object.keys(await snapshot())).toContain(NOTES_FILE);
    // Parsing refuses a `name` that disagrees with the stem, so reading it back at all is the claim.
    expect((await server(NOTES))?.name).toBe(NOTES);
  });

  it("appears in `catalog dump`, which is the view resolution works from", async () => {
    await newClose();

    const dump = await invoke("catalog", "dump", "--json", "--project", projectDir);
    const report = JSON.parse(dump.stdout) as {
      mcps: Record<string, { transport: { kind: string; url?: string } }>;
    };

    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(report.mcps[CLOSE]?.transport).toMatchObject({ kind: "http", url: CLOSE_URL });
  });

  it("leaves out every key it was given nothing for, since absent and empty mean the same", async () => {
    await succeeds("new", NOTES, "--stdio", NOTES_COMMAND);

    expect(await read(NOTES_FILE)).toBe(
      emitYaml({ name: NOTES, transport: { stdio: { command: NOTES_COMMAND } } }),
    );
    expect(await server(NOTES)).toMatchObject({ scopes: [], env: [] });
    await validates();
  });

  it("sorts and deduplicates `--env`, and leaves `--arg` in the order it was given", async () => {
    await succeeds(
      "new",
      NOTES,
      "--stdio",
      NOTES_COMMAND,
      "--arg",
      "second",
      "--arg",
      "first",
      "--env",
      "SECOND",
      "--env",
      "FIRST",
      "--env",
      "SECOND",
    );

    // Argv order is not information for a set of env vars, and is the whole of what a program's
    // positional arguments mean.
    expect(await server(NOTES)).toMatchObject({
      env: ["FIRST", "SECOND"],
      transport: { args: ["second", "first"] },
    });
  });

  it("splits a header at its first `=`, so a value may hold one", async () => {
    await succeeds("new", CLOSE, "--http", CLOSE_URL, "--header", "X-Token=a=b");

    expect(await server(CLOSE)).toMatchObject({ transport: { headers: { "X-Token": "a=b" } } });
  });

  it("refuses an invocation that names no transport, naming the supported kinds", async () => {
    const result = await refused(ExitCode.Config, "new", NOTES);

    expect(result.stderr).toContain(`MCP server "${NOTES}" names no transport (${NOTES_FILE})`);
    expect(result.stderr).toContain("supported kinds: http, stdio");
    expect(result.stderr).toContain("give exactly one of `--stdio <command>` or `--http <url>`");
  });

  it("refuses an invocation that names two transports, naming the supported kinds", async () => {
    const result = await refused(
      ExitCode.Config,
      "new",
      NOTES,
      "--stdio",
      NOTES_COMMAND,
      "--http",
      CLOSE_URL,
    );

    expect(result.stderr).toContain(`MCP server "${NOTES}" names two transports (${NOTES_FILE})`);
    expect(result.stderr).toContain("supported kinds: http, stdio");
  });

  it("refuses a flag belonging to the kind it was not given, rather than dropping it", async () => {
    const header = await refused(
      ExitCode.Config,
      "new",
      NOTES,
      "--stdio",
      NOTES_COMMAND,
      "--header",
      "X-Token=a",
    );
    expect(header.stderr).toContain("`--header` belongs to the http transport (mcps)");

    const arg = await refused(ExitCode.Config, "new", CLOSE, "--http", CLOSE_URL, "--arg", "-y");
    expect(arg.stderr).toContain("`--arg` belongs to the stdio transport (mcps)");
  });

  it("refuses a header that is not a `key=value` pair", async () => {
    const missing = await refused(
      ExitCode.Config,
      "new",
      CLOSE,
      "--http",
      CLOSE_URL,
      "--header",
      CLOSE_HEADER,
    );
    expect(missing.stderr).toContain(`cannot read \`--header ${CLOSE_HEADER}\` (mcps)`);
    expect(missing.stderr).toContain("write it as `--header <key>=<value>`, once per header");

    const repeated = await refused(
      ExitCode.Config,
      "new",
      CLOSE,
      "--http",
      CLOSE_URL,
      "--header",
      "X-Token=a",
      "--header",
      "X-Token=b",
    );
    expect(repeated.stderr).toContain("`X-Token` was already given a value");
  });

  it("refuses a transport flag given an empty value", async () => {
    const result = await refused(ExitCode.Config, "new", NOTES, "--stdio", "  ");

    expect(result.stderr).toContain("`--stdio` names no command (mcps)");
  });

  it("refuses a name the catalog already provides", async () => {
    const result = await refused(ExitCode.Resolution, "new", FREE, "--stdio", NOTES_COMMAND);

    expect(result.stderr).toContain(`MCP server "${FREE}" already exists (${FREE_FILE})`);
    expect(result.stderr).toContain("pick another name, or edit the entity that is there");
  });

  it("names the file the author wrote when it refuses a name the catalog already provides", async () => {
    // The refusal's whole job is to send the reader to the entity that is already there, and §3.3
    // accepts `.yaml` — citing the `.yml` ambit would have written names a file that is not on disk.
    await rename(path.join(catalogDir, FREE_FILE), path.join(catalogDir, "mcps/scoped.yaml"));

    const result = await refused(ExitCode.Resolution, "new", FREE, "--stdio", NOTES_COMMAND);

    expect(result.stderr).toContain(`MCP server "${FREE}" already exists (mcps/scoped.yaml)`);
  });

  it("refuses a name that could not be a filename under mcps/", async () => {
    const separator = await refused(ExitCode.Config, "new", "a/b", "--stdio", NOTES_COMMAND);
    expect(separator.stderr).toContain('invalid MCP name "a/b" (mcps)');

    const hidden = await refused(ExitCode.Config, "new", ".notes", "--stdio", NOTES_COMMAND);
    expect(hidden.stderr).toContain('invalid MCP name ".notes" (mcps)');
  });

  it("prints what it created, which file that took, and what is left to do", async () => {
    const result = await newNotes();

    expect(result.stdout).toBe(
      [
        "created (1)",
        `  ${NOTES}  stdio  ${[NOTES_COMMAND, ...NOTES_ARGS].join(" ")}`,
        "",
        "files (1)",
        `  ${NOTES_FILE}  created`,
        "",
        `next: nothing selects it yet — run \`ambit catalog annotate mcp.${NOTES} --add-scope <scope>\`, or \`ambit catalog annotate <skill> --add-requires mcp.${NOTES}\``,
      ].join("\n"),
    );
  });

  it("carries the new file's bytes in --json", async () => {
    const result = await newClose("--json");
    const report = JSON.parse(result.stdout) as {
      created: { name: string; target: string; transport: string };
      files: readonly { file: string; text: string }[];
      written: boolean;
    };

    expect(report.created).toEqual({ name: CLOSE, target: CLOSE_URL, transport: "http" });
    expect(report.files).toEqual([{ file: CLOSE_FILE, text: await read(CLOSE_FILE) }]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, prints the diff and writes nothing", async () => {
    const before = await snapshot();

    const result = await newNotes("--dry-run");

    expect(result.stdout).toContain("would create (1)");
    expect(result.stdout).toContain(`  ${NOTES_FILE} (created)`);
    expect(result.stdout).toContain(`+ name: ${NOTES}`);
    expect(result.stdout).not.toContain("next:");
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog mcp rm", () => {
  it("deletes the entity file and leaves the rest of the catalog alone", async () => {
    const before = await snapshot();

    await succeeds("rm", FREE);

    const after = await snapshot();
    expect(Object.keys(after)).toEqual(Object.keys(before).filter((file) => file !== FREE_FILE));
    for (const file of Object.keys(after)) expect(after[file], file).toBe(before[file]);
    expect(await server(FREE)).toBeUndefined();
    await validates();
  });

  it("deletes the file the author wrote, not the extension ambit would have chosen", async () => {
    // `mcps/<name>.yml` is what `new` writes, but §3.3 accepts `.yaml` too — and removing a path that
    // is not there would have been a silent no-op reporting success.
    await rename(path.join(catalogDir, FREE_FILE), path.join(catalogDir, "mcps/scoped.yaml"));

    const result = await succeeds("rm", FREE);

    expect(result.stdout).toContain("  mcps/scoped.yaml  removed");
    expect(await readdir(path.join(catalogDir, "mcps"))).toEqual(["fixture.yml"]);
  });

  it("refuses while a skill requires it, naming the requirer", async () => {
    const result = await refused(ExitCode.Resolution, "rm", REQUIRED);

    expect(result.stderr).toContain(`MCP server "${REQUIRED}" is still required (${REQUIRED_FILE})`);
    expect(result.stderr).toContain(`skill "${REQUIRER}" requires it (${REQUIRER_FILE})`);
    // The next step names the command that clears a `requires` entry, not the hand-edit that
    // predated it (spec §6) — and the requirement keeps its `mcp.` prefix while the requirer, always
    // a skill, does not.
    expect(result.stderr).toContain(
      `clear it from each with \`ambit catalog annotate <skill> --remove-requires mcp.${REQUIRED}\``,
    );
  });

  it("refuses a server the catalog does not provide, without guessing at a near miss", async () => {
    const result = await refused(ExitCode.Resolution, "rm", "scopd");

    expect(result.stderr).toContain('unknown MCP server "scopd" (mcps/scopd.yml)');
    expect(result.stderr).not.toContain("did you mean");
  });

  it("prints what it removed and which file that took", async () => {
    const result = await succeeds("rm", FREE);

    expect(result.stdout).toBe(
      ["removed (1)", `  ${FREE}`, "", "files (1)", `  ${FREE_FILE}  removed`].join("\n"),
    );
  });

  it("reports the removal in --json as a file whose text is null", async () => {
    const result = await succeeds("rm", FREE, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly { file: string; text: string | null }[];
      removed: string;
      written: boolean;
    };

    expect(report.removed).toBe(FREE);
    expect(report.files).toEqual([{ file: FREE_FILE, text: null }]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, previews the removal and writes nothing", async () => {
    const before = await snapshot();

    const result = await succeeds("rm", FREE, "--dry-run");

    expect(result.stdout).toContain("would remove (1)");
    expect(result.stdout).toContain(`  ${FREE_FILE} (removed)`);
    expect(await snapshot()).toEqual(before);
  });
});
