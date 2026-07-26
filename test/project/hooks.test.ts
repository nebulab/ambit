/**
 * Hooks end to end: an inline `hooks:` declaration through `install`, `status`, `prune` and `clean`.
 *
 * `.claude/settings.json` is what this whole capability turns on. It is not ambit's document — a
 * person's `model`, their `permissions` and hooks they wrote themselves live in it — and the tool
 * ambit replaces rewrites its entire `hooks` root on every install, destroying whatever was there.
 * So the claims below are measured in bytes rather than in behaviour, and the coexistence case is
 * asserted as whole-file text at every step of a full install → install → prune → clean cycle.
 *
 * `.cursor/hooks.json` then says the same claims hold for a harness shaped differently in every respect
 * one can be — a file of its own, its own event names, and a root key ambit seeds but does not own. And
 * `.codex/hooks.json` says they hold for the harness that differs in one respect only: Claude's entries,
 * somewhere else.
 *
 * opencode closes the set from the other end. It expresses no hooks at all, so a project that configures
 * it and declares one is warned and left installed — the case that must not be an error, since one
 * harness's limitation cannot be allowed to cost every other harness its hooks.
 *
 * No catalog anywhere in here: an inline hook is selected because it was declared, so a project needs
 * nothing else to walk the entire path — and a test that resolves nothing cannot be reading some
 * fixture's hooks by accident.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/errors.js";
import { arrayEntryKey, managedKey } from "../../src/model/documents/index.js";
import { run } from "../../src/cli/program.js";
import type { OwnedArtifact } from "../../src/model/state.js";
import { parseState, STATE_DIRNAME, STATE_FILENAME } from "../../src/model/state.js";

/** The file Claude Code reads, and VS Code with it. */
const SETTINGS = ".claude/settings.json";

/** The hook whose event array a person has already written into. */
const FORMAT_HOOK = [
  "- name: format",
  "  event: PostToolUse",
  "  matcher: Write",
  "  command: npx prettier --write",
  "  timeout: 30",
];

/** The hook whose event array is ambit's alone, so removing it empties one. */
const NOTIFY_HOOK = ["- name: notify", "  event: Stop", "  command: ./bin/notify"];

/** What each of them is written as — the renderer's output, which the digest is taken over. */
const FORMAT_ENTRY = {
  matcher: "Write",
  hooks: [{ type: "command", command: "npx prettier --write", timeout: 30 }],
};
const NOTIFY_ENTRY = { hooks: [{ type: "command", command: "./bin/notify" }] };

/** And the keys state records them under: `hooks.<Event>@<digest>`. */
const FORMAT_KEY = managedKey("hooks", arrayEntryKey("PostToolUse", FORMAT_ENTRY));
const NOTIFY_KEY = managedKey("hooks", arrayEntryKey("Stop", NOTIFY_ENTRY));

let root: string;
let projectDir: string;

/**
 * Points a project at nothing at all, and gives it `hooks`.
 *
 * @param hooks the `hooks` list's lines, unindented; empty declares no hooks.
 * @param harnesses the `harnesses` list; the default is what `ambit.yml` defaults to.
 */
async function writeProfile(
  hooks: readonly string[],
  harnesses: readonly string[] = ["claude"],
): Promise<void> {
  const block =
    hooks.length === 0 ? "" : `hooks:\n${hooks.map((line) => `  ${line}`).join("\n")}\n`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
harnesses: [${harnesses.join(", ")}]
scopes: []
${block}`,
    "utf8",
  );
}

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

/** One of the project's files as bytes. */
async function fileText(relative: string): Promise<string> {
  return readFile(path.join(projectDir, relative), "utf8");
}

/** The settings file as bytes. */
async function settingsText(): Promise<string> {
  return fileText(SETTINGS);
}

/** The settings file parsed, for the claims that are about content rather than bytes. */
async function settings(): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await settingsText()) as Readonly<Record<string, unknown>>;
}

async function stateArtifacts(): Promise<readonly OwnedArtifact[]> {
  const text = await readFile(path.join(projectDir, STATE_DIRNAME, STATE_FILENAME), "utf8");
  return parseState(text, STATE_FILENAME).artifacts;
}

async function pathExists(relative: string): Promise<boolean> {
  try {
    await lstat(path.join(projectDir, relative));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-hooks-"));
  projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("an inline hook installed into .claude/settings.json", () => {
  beforeEach(async () => {
    await writeProfile([...FORMAT_HOOK, ...NOTIFY_HOOK]);
  });

  it("writes one entry per hook, and records each entry's digest as owned", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await settings()).toEqual({
      hooks: { PostToolUse: [FORMAT_ENTRY], Stop: [NOTIFY_ENTRY] },
    });
    // `shape` beside `format`, because prune and clean edit this file from state alone and the two
    // JSON shapes are not the same edit.
    expect(await stateArtifacts()).toEqual([
      {
        path: SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [FORMAT_KEY, NOTIFY_KEY],
      },
    ]);
  });

  it("changes no bytes on a second install, and reports no drift", async () => {
    await cli("install");
    const written = await settingsText();

    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await settingsText()).toBe(written);
    // Exit 0 rather than 5: the digest in the file is the digest state claims, so nothing drifted.
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("prunes the entry a narrowed config no longer declares, leaving the array behind", async () => {
    await cli("install");
    await writeProfile(FORMAT_HOOK);

    expect((await cli("prune")).code).toBe(ExitCode.Success);

    // `Stop: []` survives for the reason the map driver leaves `{}`: ambit owns entries in this file
    // and not its containers, and a person may be about to add a hook of their own to that array.
    expect(await settings()).toEqual({ hooks: { PostToolUse: [FORMAT_ENTRY], Stop: [] } });
    expect(await stateArtifacts()).toEqual([
      {
        path: SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [FORMAT_KEY],
      },
    ]);
  });

  it("writes no settings file at all for a project that declares no hooks", async () => {
    await writeProfile([]);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    // A project that never asked for hooks should not acquire a settings file, the same way one that
    // selects no servers acquires no `.mcp.json`.
    expect(await pathExists(SETTINGS)).toBe(false);
  });
});

/**
 * VS Code reads Claude's settings file natively, so the two share it.
 *
 * The same relationship as Claude and Cursor sharing one skills link: two harnesses naming one target
 * is one artifact, not two that collide.
 */
describe("claude and vscode together", () => {
  beforeEach(async () => {
    await writeProfile(FORMAT_HOOK, ["claude", "vscode"]);
  });

  it("writes the shared file once, and records it once", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // One entry, not one per harness reading it.
    expect(await settings()).toEqual({ hooks: { PostToolUse: [FORMAT_ENTRY] } });
    expect(await stateArtifacts()).toEqual([
      {
        path: SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [FORMAT_KEY],
      },
    ]);
    // And one row, so `install` does not report the same write twice.
    expect(result.stdout.split(SETTINGS)).toHaveLength(2);
  });

  it("leaves VS Code's own config alone, having nothing to put in it", async () => {
    await cli("install");

    expect(await pathExists(".vscode/mcp.json")).toBe(false);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});

/**
 * The issue's headline promise, as a byte claim.
 *
 * A person's `.claude/settings.json`, holding two hooks ambit knows nothing about and two sibling keys
 * that are none of its business, through the full cycle. This is the case dotagents fails — one
 * `[[hooks]]` entry there and the whole `hooks` root is replaced — so it is asserted as whole-file
 * text at every step rather than as a property of one of them.
 */
describe("a settings file a person wrote", () => {
  /**
   * What the user wrote, in the form the JSON driver emits.
   *
   * Deliberately already canonical, so that "byte-identical" below is a claim about content rather
   * than about whether ambit reformatted the file — a claim {@link expected} re-states in its first
   * assertion.
   */
  const HANDWRITTEN = `{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(git status:*)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./bin/hello"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "./bin/audit"
          }
        ]
      }
    ]
  }
}
`;

  /** That document with `mutate` applied to its `hooks`, and nothing else touched. */
  function expected(mutate: (hooks: Record<string, unknown>) => void): string {
    const document = JSON.parse(HANDWRITTEN) as { hooks: Record<string, unknown> };
    mutate(document.hooks);
    return `${JSON.stringify(document, null, 2)}\n`;
  }

  beforeEach(async () => {
    await writeProfile([...FORMAT_HOOK, ...NOTIFY_HOOK]);
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(path.join(projectDir, SETTINGS), HANDWRITTEN, "utf8");
  });

  it("survives install, a second install, prune and clean byte-identically", async () => {
    // The precondition the rest of this test rests on: the user's own bytes are what the driver emits,
    // so any difference below is ambit changing content and not ambit reindenting.
    expect(expected(() => {})).toBe(HANDWRITTEN);

    // ambit's own PostToolUse hook joins the array the user already had one in; its Stop hook creates
    // one. Both appear after what was there, and the sibling keys keep their positions.
    const installed = expected((hooks) => {
      (hooks.PostToolUse as unknown[]).push(FORMAT_ENTRY);
      hooks.Stop = [NOTIFY_ENTRY];
    });

    expect((await cli("install")).code).toBe(ExitCode.Success);
    expect(await settingsText()).toBe(installed);

    // A second install appends nothing: the digests are already there.
    expect((await cli("install")).code).toBe(ExitCode.Success);
    expect(await settingsText()).toBe(installed);

    // A prune with nothing stale writes nothing at all.
    expect((await cli("prune")).code).toBe(ExitCode.Success);
    expect(await settingsText()).toBe(installed);

    // And `clean` takes back exactly ambit's two entries. The emptied `Stop` array stays, for the
    // reason the map driver leaves `{}` behind; the user's own array keeps its foreign entry.
    expect((await cli("clean")).code).toBe(ExitCode.Success);
    expect(await settingsText()).toBe(expected((hooks) => (hooks.Stop = [])));

    // Which is to say: the file still holds exactly what the user wrote.
    const remaining = JSON.parse(await settingsText()) as { hooks: Record<string, unknown> };
    delete remaining.hooks.Stop;
    expect(`${JSON.stringify(remaining, null, 2)}\n`).toBe(HANDWRITTEN);
  });

  it("never claims a foreign entry, whatever event it sits on", async () => {
    await cli("install");

    // The two hand-written entries have digests ambit never plans, so they are not in state, so
    // nothing can ever prune them. The promise falls out of the identity scheme rather than a rule.
    const [artifact] = await stateArtifacts();
    expect(artifact?.managedKeys).toEqual([FORMAT_KEY, NOTIFY_KEY]);
  });
});

/**
 * The one pre-existing entry that *is* a conflict: a person who hand-wrote the very hook ambit is
 * about to install. Refusing it and offering `--adopt` is what `.mcp.json` does for a colliding server
 * name, and the digest is what makes the same question askable of an array.
 */
describe("a hand-written entry identical to one ambit would install", () => {
  const ADOPTED = `${JSON.stringify({ hooks: { PostToolUse: [FORMAT_ENTRY] } }, null, 2)}\n`;

  beforeEach(async () => {
    await writeProfile(FORMAT_HOOK);
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(path.join(projectDir, SETTINGS), ADOPTED, "utf8");
  });

  it("refuses it by name, leaving the project untouched", async () => {
    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(
      `"${FORMAT_KEY}" in ${SETTINGS} exists but ambit did not create`,
    );
    expect(result.stderr).toContain("ambit install --adopt");
    expect(await settingsText()).toBe(ADOPTED);
    // Nothing at all was written: the check runs over the whole plan before any adapter applies.
    expect(await pathExists(STATE_DIRNAME)).toBe(false);
  });

  it("takes it over under `--adopt`, without writing a second copy of it", async () => {
    const result = await cli("install", "--adopt");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The digest is already present, so the merge appends nothing — the array holds one entry.
    expect(await settingsText()).toBe(ADOPTED);
    expect((await stateArtifacts())[0]?.managedKeys).toEqual([FORMAT_KEY]);
  });

  it("prunes what it adopted once the declaration is gone", async () => {
    await cli("install", "--adopt");
    await writeProfile([]);

    expect((await cli("prune")).code).toBe(ExitCode.Success);

    expect(await settings()).toEqual({ hooks: { PostToolUse: [] } });
    expect(await stateArtifacts()).toEqual([]);
  });
});

/**
 * Cursor, which is where the neutral vocabulary earns itself.
 *
 * A second harness that differs in every respect one can: its own file, its own spelling of every
 * event, an entry that nests nothing and has nowhere to put a `matcher`, and a `version` beside the
 * hooks that ambit seeds and a person owns. None of which the install path knows — it is the same code
 * that wrote Claude's file above, reading a different profile.
 */
describe("an inline hook installed into .cursor/hooks.json", () => {
  const HOOKS_JSON = ".cursor/hooks.json";

  /** A hook with nothing optional on it, so an event is the only thing varying below. */
  const WATCH_ENTRY = { command: "./bin/watch" };

  function watchHook(event: string): readonly string[] {
    return ["- name: watch", `  event: ${event}`, `  command: ${WATCH_ENTRY.command}`];
  }

  /**
   * Every event ambit knows, and what Cursor calls it.
   *
   * Written out rather than read off the profile: the map is the claim, so a test that imported it
   * would agree with any spelling the profile happened to hold.
   */
  const EVENTS: readonly (readonly [string, string])[] = [
    ["SessionStart", "sessionStart"],
    ["UserPromptSubmit", "userPromptSubmit"],
    ["PreToolUse", "preToolUse"],
    ["PostToolUse", "postToolUse"],
    ["Stop", "stop"],
    ["SubagentStop", "subagentStop"],
    ["PreCompact", "preCompact"],
    ["SessionEnd", "sessionEnd"],
  ];

  it.each(EVENTS)("puts a %s hook in Cursor's `%s` array", async (event, spelling) => {
    await writeProfile(watchHook(event), ["cursor"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // `version` first, because ambit created the file and Cursor's own documentation writes it there.
    expect(await fileText(HOOKS_JSON)).toBe(
      `${JSON.stringify({ version: 1, hooks: { [spelling]: [WATCH_ENTRY] } }, null, 2)}\n`,
    );
    // And the managed key names the array the entry actually sits in. If it named the PascalCase event
    // instead, `sectionKeys` would not recognize what ambit just wrote and the next install would
    // append the hook a second time.
    expect(await stateArtifacts()).toEqual([
      {
        path: HOOKS_JSON,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [managedKey("hooks", arrayEntryKey(spelling, WATCH_ENTRY))],
      },
    ]);
  });

  it("changes no bytes on a second install, and reports no drift", async () => {
    await writeProfile(watchHook("PreCompact"), ["cursor"]);
    await cli("install");
    const written = await fileText(HOOKS_JSON);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await fileText(HOOKS_JSON)).toBe(written);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("drops a `matcher`, which Cursor has no field for", async () => {
    await writeProfile(
      ["- name: guard", "  event: PreToolUse", "  matcher: Bash", "  command: ./bin/guard"],
      ["cursor"],
    );

    expect((await cli("install")).code).toBe(ExitCode.Success);

    // Written through, `matcher` would be a key Cursor ignores — so the hook would silently run on
    // every tool while the file claimed otherwise. Dropped, it runs unfiltered and says so.
    const written = await fileText(HOOKS_JSON);
    expect(JSON.parse(written)).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: "./bin/guard" }] },
    });
    expect(written).not.toContain("Bash");
    expect(written).not.toContain("matcher");
  });

  it("leaves the whole document alone but for the array it appends to", async () => {
    // A `version` a person raised themselves, and a hook of their own on the event ambit writes to.
    // dotagents replaces this file's `hooks` root and forces `version` back to 1; ambit owns one entry.
    const HANDWRITTEN = `${JSON.stringify(
      { version: 2, hooks: { stop: [{ command: "./bin/mine" }] } },
      null,
      2,
    )}\n`;
    await writeProfile(watchHook("Stop"), ["cursor"]);
    await mkdir(path.join(projectDir, ".cursor"), { recursive: true });
    await writeFile(path.join(projectDir, HOOKS_JSON), HANDWRITTEN, "utf8");

    expect((await cli("install")).code).toBe(ExitCode.Success);

    const installed = `${JSON.stringify(
      { version: 2, hooks: { stop: [{ command: "./bin/mine" }, WATCH_ENTRY] } },
      null,
      2,
    )}\n`;
    expect(await fileText(HOOKS_JSON)).toBe(installed);

    // And `clean` gives back exactly what they wrote, `version: 2` included.
    expect((await cli("clean")).code).toBe(ExitCode.Success);
    expect(await fileText(HOOKS_JSON)).toBe(HANDWRITTEN);
  });
});

/**
 * Codex: Claude's entries, in a file of its own.
 *
 * The pairing that proves the layout and the renderer are separable — Codex shares `claudeHook` outright
 * and shares nothing else, so a hook has the same digest here as in `.claude/settings.json` and lands
 * somewhere else entirely.
 *
 * `.codex/hooks.json` and not `[hooks]` in `.codex/config.toml`, which Codex also reads: a TOML `hooks`
 * table is an array-of-tables, which the TOML driver refuses. So the test also pins that ambit leaves
 * `config.toml` alone — a project on Codex with hooks and no servers acquires no TOML at all.
 */
describe("an inline hook installed into .codex/hooks.json", () => {
  const CODEX_HOOKS = ".codex/hooks.json";

  beforeEach(async () => {
    await writeProfile([...FORMAT_HOOK, ...NOTIFY_HOOK], ["codex"]);
  });

  it("writes Claude's own entries, under Claude's own event names", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // No `version` and no other root key: unlike Cursor's file this one holds hooks and nothing else,
    // so ambit seeds nothing beside them.
    expect(await fileText(CODEX_HOOKS)).toBe(
      `${JSON.stringify({ hooks: { PostToolUse: [FORMAT_ENTRY], Stop: [NOTIFY_ENTRY] } }, null, 2)}\n`,
    );
    // The same digests Claude's file would carry, because the entries are byte-identical.
    expect(await stateArtifacts()).toEqual([
      {
        path: CODEX_HOOKS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: [FORMAT_KEY, NOTIFY_KEY],
      },
    ]);
  });

  it("touches no config.toml, which is the file this layout exists to avoid", async () => {
    await cli("install");

    expect(await pathExists(".codex/config.toml")).toBe(false);
  });

  it("changes no bytes on a second install, and reports no drift", async () => {
    await cli("install");
    const written = await fileText(CODEX_HOOKS);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await fileText(CODEX_HOOKS)).toBe(written);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("leaves a hook of someone else's where it is, and gives it back on clean", async () => {
    const HANDWRITTEN = `${JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "./bin/mine" }] }] } },
      null,
      2,
    )}\n`;
    await mkdir(path.join(projectDir, ".codex"), { recursive: true });
    await writeFile(path.join(projectDir, CODEX_HOOKS), HANDWRITTEN, "utf8");

    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(JSON.parse(await fileText(CODEX_HOOKS))).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "./bin/mine" }] }, NOTIFY_ENTRY],
        PostToolUse: [FORMAT_ENTRY],
      },
    });

    expect((await cli("clean")).code).toBe(ExitCode.Success);
    // The emptied array stays, for the reason the map driver leaves `{}`; the foreign entry never moved.
    expect(JSON.parse(await fileText(CODEX_HOOKS))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "./bin/mine" }] }], PostToolUse: [] },
    });
  });

  it("writes each of Claude and Codex its own file, from one rendering", async () => {
    await writeProfile(NOTIFY_HOOK, ["claude", "codex"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // Two artifacts rather than one: the entries are identical, so it is the *file* that makes them two
    // writes — `planFor` collapses two harnesses onto one target and never two targets onto one.
    expect(await settings()).toEqual({ hooks: { Stop: [NOTIFY_ENTRY] } });
    expect(JSON.parse(await fileText(CODEX_HOOKS))).toEqual({ hooks: { Stop: [NOTIFY_ENTRY] } });
    expect((await stateArtifacts()).map((artifact) => artifact.path)).toEqual([
      SETTINGS,
      CODEX_HOOKS,
    ]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});

/**
 * opencode, which expresses no hooks at all.
 *
 * The other half of task 6: a harness in `harnesses` that cannot take a hook is not an error. Failing
 * would let one harness veto every other harness's hooks, and dropping the hook in silence would leave a
 * project believing it installed something. So the run succeeds, writes what it can, and says what it
 * could not.
 */
describe("a hook selected while opencode is configured", () => {
  it("warns, exits 0, and writes opencode nothing", async () => {
    await writeProfile(NOTIFY_HOOK, ["opencode"]);

    const result = await cli("install");

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toBe(
      'warning: hook "notify" (Stop) not installed: opencode has no declarative hook mechanism',
    );
    // No file of opencode's, and no settings file either: the hook reached no harness, so nothing at all
    // was written for it.
    expect(await pathExists(".opencode/opencode.jsonc")).toBe(false);
    expect(await pathExists(SETTINGS)).toBe(false);
    expect(await stateArtifacts()).toEqual([]);
  });

  it("installs the hook everywhere else, and warns only for opencode", async () => {
    await writeProfile(NOTIFY_HOOK, ["claude", "opencode"]);

    const result = await cli("install");
    expect(result.code).toBe(ExitCode.Success);

    // Claude's file is written in full. The skip is opencode's alone — which is the reason it is a
    // warning: one harness's limitation must not cost the others their hooks.
    expect(await settings()).toEqual({ hooks: { Stop: [NOTIFY_ENTRY] } });
    expect(result.stderr).toContain("opencode has no declarative hook mechanism");
    expect(result.stderr.split("\n")).toHaveLength(1);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("says the same thing on a dry run, having written nothing", async () => {
    await writeProfile(NOTIFY_HOOK, ["opencode"]);

    const result = await cli("install", "--dry-run");

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toContain('hook "notify" (Stop) not installed');
    expect(await pathExists(STATE_DIRNAME)).toBe(false);
  });

  it("carries the skip in `--json`, as the reason rather than the sentence", async () => {
    await writeProfile(NOTIFY_HOOK, ["opencode"]);

    const result = await cli("install", "--json");
    expect(result.code).toBe(ExitCode.Success);

    expect((JSON.parse(result.stdout) as { skipped: unknown }).skipped).toEqual([
      { event: "Stop", harness: "opencode", hook: "notify", reason: "no-mechanism" },
    ]);
    // Still on stderr, so stdout stays a document a script can parse.
    expect(result.stderr).toContain("no declarative hook mechanism");
  });
});

/**
 * Claude and Cursor together: two harnesses, two files, two renderings.
 *
 * The counterpart of the Claude/VS Code case above. There the two shared a file because they render one
 * entry; here they render different entries into different files, so `planFor` collapses nothing.
 */
describe("claude and cursor together", () => {
  it("writes each harness its own file, in that harness's own shape", async () => {
    await writeProfile(NOTIFY_HOOK, ["claude", "cursor"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await settings()).toEqual({ hooks: { Stop: [NOTIFY_ENTRY] } });
    expect(JSON.parse(await fileText(".cursor/hooks.json"))).toEqual({
      version: 1,
      hooks: { stop: [{ command: "./bin/notify" }] },
    });
    expect((await stateArtifacts()).map((artifact) => artifact.path)).toEqual([
      SETTINGS,
      ".cursor/hooks.json",
    ]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});
