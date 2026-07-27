/**
 * `ambit catalog hook new|rm` — maintaining a hook directory.
 *
 * A hook is the one item that is a *directory* whose *document* is entirely ambit's, so this suite
 * takes one claim from each of the two suites beside it. From `catalog mcp`: the round trip, that what
 * `new` writes is exactly `emitYaml` of the values it was given and the parser reads that file back as
 * the hook — including the two derivations only the catalog can make, `shipsScript` and the name. From
 * `catalog skill`: that `rm` removes a *tree*, so a hook that shipped a script loses the script with
 * it, and that a directory holding another hook is refused rather than silently deleted.
 *
 * The third claim is the one every authoring suite makes: a refusal costs nothing, so every rejection
 * asserts the whole tree is untouched. That covers the two rules this command deliberately leaves to
 * the parser — a `matcher` on an event that carries no tool, and a `command` naming a script the
 * directory does not hold — both of which are raised while the editor validates the result, before
 * anything is written.
 *
 * The fixture catalog holds no hooks, so every case here authors its own. That is also why `rm`'s
 * refusal is set up through `catalog annotate`: nothing but a skill's `requires` can hold a hook down.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { Catalog, CatalogHook } from "../../src/model/catalog.js";
import { parseCatalogDirectory } from "../../src/model/catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { emitYaml } from "../../src/model/yaml.js";

/** The inline hook most cases create: a command line, so it ships nothing. */
const NOTIFY = "notify";
const NOTIFY_DIR = "hooks/notify";
const NOTIFY_FILE = "hooks/notify/HOOK.yml";
const NOTIFY_COMMAND = "npx --yes @acme/notify";
const NOTIFY_EVENT = "Stop";
const NOTIFY_ENV = "NOTIFY_TOKEN";

/** The matchable hook: the one event a `matcher` means anything for. */
const GUARD = "guard";
const GUARD_FILE = "hooks/guard/HOOK.yml";
const GUARD_EVENT = "PreToolUse";
const GUARD_MATCHER = "Bash";
const GUARD_COMMAND = "npx --yes @acme/guard";

/** A nested name, which is a path under `hooks/` exactly as a skill's is under `skills/`. */
const NESTED = "repo.block-rm";
const NESTED_DIR = "hooks/repo/block-rm";
const NESTED_FILE = "hooks/repo/block-rm/HOOK.yml";

/** The fixture skill the `rm` refusal hangs a `requires` off. */
const REQUIRER = "code-review";
const REQUIRER_FILE = "skills/code-review/SKILL.md";

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

/** Runs a hook command against the catalog under test. */
async function hookCli(...argv: readonly string[]): Promise<CliResult> {
  return invoke("catalog", "hook", ...argv, "--catalog", catalogDir);
}

/** Runs one, asserting it succeeded. */
async function succeeds(...argv: readonly string[]): Promise<CliResult> {
  const result = await hookCli(...argv);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Runs one, asserting it was refused with `code` and that nothing on disk moved. */
async function refused(code: ExitCode, ...argv: readonly string[]): Promise<CliResult> {
  const before = await snapshot();
  const result = await hookCli(...argv);

  expect(result.code, result.stdout).toBe(code);
  expect(result.stdout).toBe("");
  expect(await snapshot()).toEqual(before);
  return result;
}

/** Runs any other authoring command against the catalog, asserting it succeeded. */
async function author(...argv: readonly string[]): Promise<CliResult> {
  const result = await invoke("catalog", ...argv, "--catalog", catalogDir);
  expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(ExitCode.Success);
  return result;
}

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

async function write(file: string, text: string): Promise<void> {
  const target = path.join(catalogDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
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

/** One hook as the parser reads it, or `undefined` when the catalog provides none by that name. */
async function hook(name: string): Promise<CatalogHook | undefined> {
  return (await parsed()).hooks.find((candidate) => candidate.name === name);
}

/** `ambit catalog validate` against the catalog: what every mutation has to leave passing. */
async function validates(): Promise<CliResult> {
  const result = await invoke("catalog", "validate", "--catalog", catalogDir);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Creates the inline hook the round-trip cases share. */
async function newNotify(...extra: readonly string[]): Promise<CliResult> {
  return succeeds(
    "new",
    NOTIFY,
    "--event",
    NOTIFY_EVENT,
    "--command",
    NOTIFY_COMMAND,
    "--env",
    NOTIFY_ENV,
    ...extra,
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-hook-"));
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

describe("ambit catalog hook new", () => {
  it("writes one HOOK.yml inside a directory of its own, and nothing else", async () => {
    const before = await snapshot();

    await newNotify();

    const after = await snapshot();
    expect(Object.keys(after)).toEqual([...Object.keys(before), NOTIFY_FILE].sort());
    for (const file of Object.keys(before)) expect(after[file], file).toBe(before[file]);
    await validates();
  });

  it("emits the document as exactly `emitYaml` of its values, and parses it back", async () => {
    await newNotify("--description", "Says something happened.");

    // The bytes are `emitYaml`'s, so keys are sorted and a value that would otherwise coerce is
    // quoted. The values are restated here rather than imported, so the claim is independent of what
    // the command computed.
    expect(await read(NOTIFY_FILE)).toBe(
      emitYaml({
        command: NOTIFY_COMMAND,
        description: "Says something happened.",
        env: [NOTIFY_ENV],
        event: NOTIFY_EVENT,
        name: NOTIFY,
      }),
    );
    // `path` and `shipsScript` are the two things only the catalog can say: where the hook was found,
    // and whether its `command` names a file the directory holds.
    expect(await hook(NOTIFY)).toEqual({
      name: NOTIFY,
      description: "Says something happened.",
      scopes: [],
      event: NOTIFY_EVENT,
      command: NOTIFY_COMMAND,
      env: [NOTIFY_ENV],
      path: NOTIFY_DIR,
      shipsScript: false,
    });
    await validates();
  });

  it("writes a `matcher` and a `timeout` where the event allows one", async () => {
    await succeeds(
      "new",
      GUARD,
      "--event",
      GUARD_EVENT,
      "--matcher",
      GUARD_MATCHER,
      "--command",
      GUARD_COMMAND,
      "--timeout",
      "30",
    );

    expect(await read(GUARD_FILE)).toBe(
      emitYaml({
        command: GUARD_COMMAND,
        event: GUARD_EVENT,
        matcher: GUARD_MATCHER,
        name: GUARD,
        timeout: 30,
      }),
    );
    expect(await hook(GUARD)).toMatchObject({ matcher: GUARD_MATCHER, timeout: 30 });
    await validates();
  });

  it("declares a hook whose script the directory already holds", async () => {
    // The order is deliberate: `command` naming a file the directory does not hold is what parsing
    // refuses, so a hook that ships bytes is authored by putting the script there first.
    await write(`${NOTIFY_DIR}/hook.sh`, "#!/bin/sh\necho hi\n");

    await succeeds("new", NOTIFY, "--event", NOTIFY_EVENT, "--command", "hook.sh --strict");

    expect(await hook(NOTIFY)).toMatchObject({ shipsScript: true, command: "hook.sh --strict" });
    await validates();
  });

  it("derives a nested hook's name from its path, exactly as a skill's is derived", async () => {
    await succeeds("new", NESTED, "--event", NOTIFY_EVENT, "--command", NOTIFY_COMMAND);

    expect(Object.keys(await snapshot())).toContain(NESTED_FILE);
    // Parsing refuses a `name` that disagrees with the path, so reading it back at all is the claim.
    expect(await hook(NESTED)).toMatchObject({ name: NESTED, path: NESTED_DIR });
    await validates();
  });

  it("appears in `dump-catalog`, which is the view resolution works from", async () => {
    await newNotify();

    const dump = await invoke("dump-catalog", "--json", "--project", projectDir);
    const report = JSON.parse(dump.stdout) as {
      hooks: Record<string, { event: string; command: string }>;
    };

    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(report.hooks[NOTIFY]).toMatchObject({ event: NOTIFY_EVENT, command: NOTIFY_COMMAND });
  });

  it("leaves out every key it was given nothing for, since absent and empty mean the same", async () => {
    await succeeds("new", NOTIFY, "--event", NOTIFY_EVENT, "--command", NOTIFY_COMMAND);

    expect(await read(NOTIFY_FILE)).toBe(
      emitYaml({ command: NOTIFY_COMMAND, event: NOTIFY_EVENT, name: NOTIFY }),
    );
    // Including `scopes`, which this command is given no way to set: a new hook is reachable only
    // through a skill's `requires` until someone annotates it.
    expect(await hook(NOTIFY)).toMatchObject({ scopes: [], env: [] });
    await validates();
  });

  it("sorts and deduplicates `--env`, so argv order is not information", async () => {
    await succeeds(
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      NOTIFY_COMMAND,
      "--env",
      "SECOND",
      "--env",
      "FIRST",
      "--env",
      "SECOND",
    );

    expect((await hook(NOTIFY))?.env).toEqual(["FIRST", "SECOND"]);
  });

  it("refuses an invocation that names no event, listing the supported set", async () => {
    const result = await refused(ExitCode.Config, "new", NOTIFY, "--command", NOTIFY_COMMAND);

    expect(result.stderr).toContain(`hook "${NOTIFY}" names no event (${NOTIFY_FILE})`);
    expect(result.stderr).toContain(
      "supported events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, PreCompact, SessionEnd",
    );
    expect(result.stderr).toContain("give `--event <event>`, one of them");
  });

  it("refuses an event no harness maps, in the parser's own words", async () => {
    const result = await refused(
      ExitCode.Config,
      "new",
      NOTIFY,
      "--event",
      "OnTuesday",
      "--command",
      NOTIFY_COMMAND,
    );

    expect(result.stderr).toContain(`unknown hook event "OnTuesday" (${NOTIFY_FILE})`);
    expect(result.stderr).toContain("replace `OnTuesday` with one of them");
  });

  it("refuses an invocation that says nothing about what to run", async () => {
    const blank = await refused(
      ExitCode.Config,
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      "  ",
    );

    expect(blank.stderr).toContain(`hook "${NOTIFY}" names no command (${NOTIFY_FILE})`);
  });

  it("refuses a timeout that is not a whole number of seconds", async () => {
    const result = await refused(
      ExitCode.Config,
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      NOTIFY_COMMAND,
      "--timeout",
      "30s",
    );

    expect(result.stderr).toContain("cannot read `--timeout 30s` (hooks)");
    expect(result.stderr).toContain("write it as `--timeout <seconds>`");
  });

  it("leaves the `matcher` rule to the parser, which refuses it before anything is written", async () => {
    const result = await refused(
      ExitCode.Config,
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--matcher",
      GUARD_MATCHER,
      "--command",
      NOTIFY_COMMAND,
    );

    expect(result.stderr).toContain(`\`matcher\` is not meaningful for ${NOTIFY_EVENT}`);
  });

  it("leaves the shipped-script rule to the parser, naming the directory's contents", async () => {
    const result = await refused(
      ExitCode.Config,
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      "./hook.sh",
    );

    expect(result.stderr).toContain(`hook "${NOTIFY}" ships no hook.sh`);
    expect(result.stderr).toContain(`${NOTIFY_DIR} holds nothing but HOOK.yml`);
  });

  it("refuses a name the catalog already provides", async () => {
    await newNotify();

    const result = await refused(
      ExitCode.Resolution,
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      "npx other",
    );

    expect(result.stderr).toContain(`hook "${NOTIFY}" already exists (${NOTIFY_FILE})`);
    expect(result.stderr).toContain("pick another name, or edit the hook that is there");
  });

  it("refuses a name that could not be a path under hooks/", async () => {
    const separator = await refused(
      ExitCode.Config,
      "new",
      "a/b",
      "--event",
      NOTIFY_EVENT,
      "--command",
      NOTIFY_COMMAND,
    );
    expect(separator.stderr).toContain('invalid hook name "a/b" (hooks)');

    const empty = await refused(
      ExitCode.Config,
      "new",
      "a..b",
      "--event",
      NOTIFY_EVENT,
      "--command",
      NOTIFY_COMMAND,
    );
    expect(empty.stderr).toContain('invalid hook name "a..b" (hooks)');
  });

  it("prints what it created, which file that took, and what is left to do", async () => {
    const result = await succeeds(
      "new",
      NOTIFY,
      "--event",
      NOTIFY_EVENT,
      "--command",
      NOTIFY_COMMAND,
    );

    expect(result.stdout).toBe(
      [
        "created (1)",
        `  ${NOTIFY}  ${NOTIFY_EVENT}  ${NOTIFY_COMMAND}`,
        "",
        "files (1)",
        `  ${NOTIFY_FILE}  created`,
        "",
        `next: nothing selects it yet — run \`ambit catalog annotate hook.${NOTIFY} --add-scope <scope>\`, or \`ambit catalog annotate <skill> --add-requires hook.${NOTIFY}\``,
      ].join("\n"),
    );
  });

  it("carries the new file's bytes in --json", async () => {
    const result = await newNotify("--json");
    const report = JSON.parse(result.stdout) as {
      created: { command: string; event: string; name: string };
      files: readonly { file: string; text: string }[];
      trees: readonly unknown[];
      written: boolean;
    };

    expect(report.created).toEqual({
      command: NOTIFY_COMMAND,
      event: NOTIFY_EVENT,
      name: NOTIFY,
    });
    expect(report.files).toEqual([{ file: NOTIFY_FILE, text: await read(NOTIFY_FILE) }]);
    expect(report.trees).toEqual([]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, prints the diff and writes nothing", async () => {
    const before = await snapshot();

    const result = await newNotify("--dry-run");

    expect(result.stdout).toContain("would create (1)");
    expect(result.stdout).toContain(`  ${NOTIFY_FILE} (created)`);
    expect(result.stdout).toContain(`+ name: ${NOTIFY}`);
    expect(result.stdout).not.toContain("next:");
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog hook rm", () => {
  it("deletes the whole directory, script included, and leaves the catalog alone", async () => {
    const before = await snapshot();
    await write(`${NOTIFY_DIR}/hook.sh`, "#!/bin/sh\necho hi\n");
    await succeeds("new", NOTIFY, "--event", NOTIFY_EVENT, "--command", "hook.sh");

    await succeeds("rm", NOTIFY);

    // A command that removed only the `HOOK.yml` would leave the script behind, which is why `rm`
    // removes a tree rather than a file.
    expect(await snapshot()).toEqual(before);
    expect(await hook(NOTIFY)).toBeUndefined();
    await validates();
  });

  it("prunes the namespace directory a nested hook leaves empty", async () => {
    const before = await snapshot();
    await succeeds("new", NESTED, "--event", NOTIFY_EVENT, "--command", NOTIFY_COMMAND);

    await succeeds("rm", NESTED);

    // The snapshot equality says nothing extra is left; this says the empty namespace directory the
    // nested hook needed is gone, rather than sitting beside the fixture's own hooks.
    expect(await snapshot()).toEqual(before);
    expect(await readdir(path.join(catalogDir, "hooks"))).not.toContain("repo");
  });

  it("refuses while a skill requires it, naming the requirer", async () => {
    await newNotify();
    await author("annotate", REQUIRER, "--add-requires", `hook.${NOTIFY}`);

    const result = await refused(ExitCode.Resolution, "rm", NOTIFY);

    expect(result.stderr).toContain(`hook "${NOTIFY}" is still required (${NOTIFY_FILE})`);
    expect(result.stderr).toContain(`skill "${REQUIRER}" requires it (${REQUIRER_FILE})`);
    // The requirement keeps its `hook.` prefix, spelled the one way `requires` accepts, while the
    // requirer — always a skill — carries none.
    expect(result.stderr).toContain(
      `clear it from each with \`ambit catalog annotate <skill> --remove-requires hook.${NOTIFY}\``,
    );
  });

  it("refuses a directory that holds another hook, rather than deleting it too", async () => {
    await succeeds("new", "repo", "--event", NOTIFY_EVENT, "--command", NOTIFY_COMMAND);
    await succeeds("new", NESTED, "--event", NOTIFY_EVENT, "--command", NOTIFY_COMMAND);

    const result = await refused(ExitCode.Resolution, "rm", "repo");

    expect(result.stderr).toContain(
      'cannot remove hook "repo": it holds another hook (hooks/repo)',
    );
    expect(result.stderr).toContain(`hook "${NESTED}" is written inside it (${NESTED_FILE})`);
    expect(result.stderr).toContain(`ambit catalog hook rm ${NESTED}`);
  });

  it("refuses a hook the catalog does not provide, without guessing at a near miss", async () => {
    const result = await refused(ExitCode.Resolution, "rm", "notfy");

    expect(result.stderr).toContain('unknown hook "notfy" (hooks/notfy/HOOK.yml)');
    expect(result.stderr).not.toContain("did you mean");
  });

  it("prints what it removed and which path that took", async () => {
    await newNotify();

    const result = await succeeds("rm", NOTIFY);

    expect(result.stdout).toBe(
      ["removed (1)", `  ${NOTIFY}`, "", "files (1)", `  ${NOTIFY_DIR}/  removed`].join("\n"),
    );
  });

  it("reports the removal in --json as a tree, not as a file", async () => {
    await newNotify();

    const result = await succeeds("rm", NOTIFY, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly unknown[];
      removed: string;
      trees: readonly { directory: string; to: string | null }[];
      written: boolean;
    };

    expect(report.removed).toBe(NOTIFY);
    expect(report.files).toEqual([]);
    expect(report.trees).toEqual([{ directory: NOTIFY_DIR, to: null }]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, previews the removal and writes nothing", async () => {
    await newNotify();
    const before = await snapshot();

    const result = await succeeds("rm", NOTIFY, "--dry-run");

    expect(result.stdout).toContain("would remove (1)");
    expect(result.stdout).toContain(`  ${NOTIFY_DIR}/ (removed)`);
    expect(await snapshot()).toEqual(before);
  });
});
