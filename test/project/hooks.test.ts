/**
 * Hooks end to end: a project's own `hooks/<name>/HOOK.yml` through `install`, `status`, `prune` and
 * `clean`.
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
 * No catalog but the project itself in any of that. Every definition lives in a file, so a project that
 * declares a hook of its own puts it in `hooks/` and lists itself with `source: path:.` — which is both
 * the shortest way to walk the entire path and the case worth walking, since it is what a project
 * shipping its own hook actually writes. The last block is the one exception, and it has to be: it needs
 * two catalogs' worth of nothing, only a hook whose script lives somewhere the project does not.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diagnoseProject } from "../../src/project/doctor.js";
import { ExitCode } from "../../src/errors.js";
import { BLOCK_BEGIN, BLOCK_END, SHARED_GITIGNORE_FILE } from "../../src/project/gitignore.js";
import { arrayEntryKey, managedKey } from "../../src/model/documents/index.js";
import { run } from "../../src/cli/program.js";
import type { OwnedArtifact } from "../../src/model/state.js";
import { parseState, STATE_DIRNAME, STATE_FILENAME } from "../../src/model/state.js";

/** The file Claude Code reads, and VS Code with it. */
const SETTINGS = ".claude/settings.json";

/** One hook as its own document: the directory it sits in, and the lines beyond `name` and `tags`. */
interface Hook {
  readonly name: string;
  readonly lines: readonly string[];
}

/** The hook whose event array a person has already written into. */
const FORMAT_HOOK: Hook = {
  name: "format",
  lines: [
    "event: PostToolUse",
    "matcher: Write",
    "type: command",
    "command: npx prettier --write",
    "timeout: 30",
  ],
};

/** The hook whose event array is ambit's alone, so removing it empties one. */
const NOTIFY_HOOK: Hook = {
  name: "notify",
  lines: ["event: Stop", "type: command", "command: ./bin/notify"],
};

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
 * Points a project at itself as its only catalog, and gives it `hooks` to ship.
 *
 * Each hook is tagged `core`, which the project then holds, so shipping it is what puts it in the
 * bundle — and a project declaring none holds nothing, since a held scope no item declares is exit 3.
 *
 * `hooks/` is rebuilt from scratch on every call, because the cases that narrow a declaration have to
 * *remove* a hook rather than leave its document beside a config that no longer selects it.
 *
 * @param hooks the hooks the project ships; empty declares none.
 * @param harnesses the `harnesses` list; the default is what `ambit.yml` defaults to.
 */
async function writeProfile(
  hooks: readonly Hook[],
  harnesses: readonly string[] = ["claude"],
): Promise<void> {
  await rm(path.join(projectDir, "hooks"), { recursive: true, force: true });
  for (const hook of hooks) {
    const dir = path.join(projectDir, "hooks", hook.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "HOOK.yml"),
      [`name: ${hook.name}`, "tags: [core]", ...hook.lines, ""].join("\n"),
      "utf8",
    );
  }
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
harnesses: [${harnesses.join(", ")}]
catalogs:
  - name: local
    source: path:.
scopes: ${hooks.length === 0 ? "[]" : "[core]"}
`,
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

/** Where a project path points, or `undefined` when it is not a symlink at all. */
async function linkTarget(relative: string): Promise<string | undefined> {
  try {
    return await readlink(path.join(projectDir, relative));
  } catch {
    return undefined;
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

describe("a project's own hook installed into .claude/settings.json", () => {
  beforeEach(async () => {
    await writeProfile([FORMAT_HOOK, NOTIFY_HOOK]);
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
    await writeProfile([FORMAT_HOOK]);

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
    await writeProfile([FORMAT_HOOK], ["claude", "vscode"]);
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
    await writeProfile([FORMAT_HOOK, NOTIFY_HOOK]);
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
    await writeProfile([FORMAT_HOOK]);
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
 * A digest that stops matching what state recorded — from each of the two sides it can stop from.
 *
 * The digest is the identity, so "this entry changed" is not a thing the driver can say: a changed
 * entry is a key that is absent and a different key that is present. That is what makes `status` the
 * load-bearing half of the story. Without a row saying so, an install would put ambit's entry back
 * beside the one that no longer matches and the file would quietly grow a second hook on the event.
 *
 * Both sides are here because the residue differs. Edit the *file* and ambit cannot tell its own
 * former entry from a hook the person wrote — so it restores its own and leaves theirs, which is the
 * ownership rule rather than an exception to it. Edit the *declaration* and the stale digest is one
 * state claims, so the next install takes it out and writes the current one: one entry, not two.
 */
describe("an entry whose digest no longer matches what state recorded", () => {
  /** The same hook with its timeout raised — what a person editing `HOOK.yml` would leave. */
  const RETIMED_HOOK: Hook = {
    name: "format",
    lines: [
      "event: PostToolUse",
      "matcher: Write",
      "type: command",
      "command: npx prettier --write",
      "timeout: 45",
    ],
  };
  const RETIMED_ENTRY = {
    matcher: "Write",
    hooks: [{ type: "command", command: "npx prettier --write", timeout: 45 }],
  };
  const RETIMED_KEY = managedKey("hooks", arrayEntryKey("PostToolUse", RETIMED_ENTRY));

  /** ambit's own entry, edited in place in the file rather than in the declaration. */
  const EDITED_ENTRY = {
    matcher: "Write",
    hooks: [{ type: "command", command: "npx prettier --write", timeout: 60 }],
  };

  /** Rewrites the installed entry's timeout, the way someone tweaking the file by hand would. */
  async function editInstalledEntry(): Promise<void> {
    const text = await settingsText();
    expect(text).toContain('"timeout": 30');
    await writeFile(
      path.join(projectDir, SETTINGS),
      text.replace('"timeout": 30', '"timeout": 60'),
      "utf8",
    );
  }

  /** Every artifact row `status --json` reported. */
  async function statusRows(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await cli("status", "--json");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    return (
      JSON.parse(result.stdout) as { artifacts: readonly Readonly<Record<string, unknown>>[] }
    ).artifacts;
  }

  beforeEach(async () => {
    await writeProfile([FORMAT_HOOK]);
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("reports the hand-edited entry as drift, naming the digest state claims", async () => {
    await editInstalledEntry();

    expect(await statusRows()).toEqual([
      {
        detail: `"${FORMAT_KEY}" is absent`,
        kind: "harness-config",
        path: SETTINGS,
        state: "missing",
      },
    ]);
    // Exit 5, so a CI job finds out before the install that heals it.
    expect((await cli("status", "--check")).code).toBe(ExitCode.Drift);
  });

  it("puts its own entry back on the next install, and leaves the edit as the person's", async () => {
    await editInstalledEntry();

    expect((await cli("install")).code).toBe(ExitCode.Success);

    // Two entries, and neither is a duplicate of the other: the edited one has a digest ambit never
    // plans, which is indistinguishable from a hook the person wrote themselves — so it stays, exactly
    // as the foreign entries above do. Ambit's own is written once, at the end of the array.
    expect(await settings()).toEqual({ hooks: { PostToolUse: [EDITED_ENTRY, FORMAT_ENTRY] } });
    expect((await stateArtifacts())[0]?.managedKeys).toEqual([FORMAT_KEY]);

    // And that is a settled state rather than a file that grows: the row is `ok` again, and a further
    // install appends nothing.
    const healed = await settingsText();
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
    expect((await cli("install")).code).toBe(ExitCode.Success);
    expect(await settingsText()).toBe(healed);
  });

  it("reports the digest a changed declaration now wants as missing", async () => {
    await writeProfile([RETIMED_HOOK]);

    // The new digest, not the old one: the row is a function of the bundle, so it names the entry
    // install would write rather than the one that happens to be in the file.
    expect(await statusRows()).toEqual([
      {
        detail: `"${RETIMED_KEY}" is absent`,
        kind: "harness-config",
        path: SETTINGS,
        state: "missing",
      },
    ]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Drift);
  });

  it("prunes the stale digest and writes the current one, leaving no duplicate", async () => {
    await writeProfile([RETIMED_HOOK]);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    // One entry. The old digest is one state claimed and the plan no longer writes, so pruning takes
    // it out of the array — the same rule that retires a withdrawn hook, applied to a redeclared one.
    expect(await settings()).toEqual({ hooks: { PostToolUse: [RETIMED_ENTRY] } });
    expect((await stateArtifacts())[0]?.managedKeys).toEqual([RETIMED_KEY]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
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
describe("a project's own hook installed into .cursor/hooks.json", () => {
  const HOOKS_JSON = ".cursor/hooks.json";

  /** A hook with nothing optional on it, so an event is the only thing varying below. */
  const WATCH_ENTRY = { command: "./bin/watch" };

  function watchHook(event: string): Hook {
    return {
      name: "watch",
      lines: [`event: ${event}`, "type: command", `command: ${WATCH_ENTRY.command}`],
    };
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
    await writeProfile([watchHook(event)], ["cursor"]);

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
    await writeProfile([watchHook("PreCompact")], ["cursor"]);
    await cli("install");
    const written = await fileText(HOOKS_JSON);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await fileText(HOOKS_JSON)).toBe(written);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("drops a `matcher`, which Cursor has no field for", async () => {
    await writeProfile(
      [
        {
          name: "guard",
          lines: ["event: PreToolUse", "matcher: Bash", "type: command", "command: ./bin/guard"],
        },
      ],
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
    await writeProfile([watchHook("Stop")], ["cursor"]);
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
describe("a project's own hook installed into .codex/hooks.json", () => {
  const CODEX_HOOKS = ".codex/hooks.json";

  beforeEach(async () => {
    await writeProfile([FORMAT_HOOK, NOTIFY_HOOK], ["codex"]);
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
    await writeProfile([NOTIFY_HOOK], ["claude", "codex"]);

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
    await writeProfile([NOTIFY_HOOK], ["opencode"]);

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
    await writeProfile([NOTIFY_HOOK], ["claude", "opencode"]);

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
    await writeProfile([NOTIFY_HOOK], ["opencode"]);

    const result = await cli("install", "--dry-run");

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toContain('hook "notify" (Stop) not installed');
    expect(await pathExists(STATE_DIRNAME)).toBe(false);
  });

  it("carries the skip in `--json`, as the reason rather than the sentence", async () => {
    await writeProfile([NOTIFY_HOOK], ["opencode"]);

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
    await writeProfile([NOTIFY_HOOK], ["claude", "cursor"]);

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

/**
 * A hook that ships its own script — the thing dotagents cannot do at all.
 *
 * The only case here that needs a catalog: shipping bytes needs a directory to ship them from, and
 * `ambit.yml` has none. So the hook's directory is materialized under `.agents/hooks/<name>/` exactly
 * as a skill's is under `.agents/skills/<name>/`, which is what makes a hook a dependency a project
 * resolves rather than a script every consumer commits for themselves.
 *
 * `hook-dir` is a new artifact kind, and a new kind is dispatched on in five places where the wrong
 * branch **typechecks clean**. Each of those has a test below saying so in its own name, because a
 * passing build says nothing about any of them: a kind routed into the config arm, or left out of an
 * allow-list, is a silent wrong answer rather than a failure.
 */
describe("a hook that ships its own script", () => {
  const SCRIPT_HOOK = "block-rm";
  const HOOK_DIR = `.agents/hooks/${SCRIPT_HOOK}`;
  const SCRIPT = "hook.sh";
  const SCRIPT_BODY = "#!/bin/sh\nexit 0\n";

  /**
   * Where each harness family is pointed at the materialized script.
   *
   * The declaration is `command: hook.sh`, which names a file relative to the hook's directory *in the
   * catalog* — so what reaches a config file has to name the installed copy instead, spelled the way
   * that harness resolves a path. Claude and VS Code get Claude's documented `${CLAUDE_PROJECT_DIR}`;
   * Cursor and Codex interpolate nothing, so they get the path project-relative.
   */
  const CLAUDE_COMMAND = `\${CLAUDE_PROJECT_DIR}/${HOOK_DIR}/${SCRIPT}`;
  const RELATIVE_COMMAND = `${HOOK_DIR}/${SCRIPT}`;

  /**
   * What the hook renders as in Claude's file.
   *
   * Kept in one place because the digest — and so every managed key state records — is taken over
   * exactly these bytes: one constant changes when the rendering does.
   */
  const SCRIPT_ENTRY = {
    matcher: "Bash",
    hooks: [{ type: "command", command: CLAUDE_COMMAND }],
  };

  /** The hook in the same catalog whose `command` is a command line, so it ships nothing. */
  const ANNOUNCE_ENTRY = { hooks: [{ type: "command", command: "npx --yes say done" }] };

  /** Both entries' keys, in the order state records them. */
  const HOOK_KEYS = [
    managedKey("hooks", arrayEntryKey("PreToolUse", SCRIPT_ENTRY)),
    managedKey("hooks", arrayEntryKey("Stop", ANNOUNCE_ENTRY)),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  /**
   * A catalog beside the project holding one hook that ships a script and one that does not.
   *
   * Two hooks rather than one, because "only a script-shipping hook plans a directory" is half the
   * claim: a command-line hook in the same bundle has to plan a config entry and nothing else.
   *
   * @param harnesses the `harnesses` list; the default is the one file most of these cases read.
   */
  async function writeCatalog(harnesses: readonly string[] = ["claude"]): Promise<void> {
    const catalogDir = path.join(root, "catalog");
    const files: Readonly<Record<string, string>> = {
      [`hooks/${SCRIPT_HOOK}/HOOK.yml`]: [
        `name: ${SCRIPT_HOOK}`,
        "tags: [core]",
        "event: PreToolUse",
        "matcher: Bash",
        "type: script",
        `command: ${SCRIPT}`,
        "",
      ].join("\n"),
      [`hooks/${SCRIPT_HOOK}/${SCRIPT}`]: SCRIPT_BODY,
      "hooks/announce/HOOK.yml": [
        "name: announce",
        "tags: [core]",
        "event: Stop",
        "type: command",
        "command: npx --yes say done",
        "",
      ].join("\n"),
    };
    for (const [relative, body] of Object.entries(files)) {
      const target = path.join(catalogDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    }
    // Executable in the catalog, which is the only reason `--copy` preserving it is a claim.
    await chmod(path.join(catalogDir, `hooks/${SCRIPT_HOOK}/${SCRIPT}`), 0o755);

    await writeFile(
      path.join(projectDir, "ambit.yml"),
      `version: 1
harnesses: [${harnesses.join(", ")}]
catalogs:
  - name: company
    source: path:../catalog
scopes: [core]
`,
      "utf8",
    );
  }

  beforeEach(async () => {
    await writeCatalog();
  });

  it("materializes the hook's directory, and records it as a hook-dir", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The script is reachable at the shared location, and the settings entry is written beside it.
    expect(await fileText(`${HOOK_DIR}/${SCRIPT}`)).toBe(SCRIPT_BODY);
    expect(await settings()).toEqual({
      hooks: { PreToolUse: [SCRIPT_ENTRY], Stop: [ANNOUNCE_ENTRY] },
    });

    // `hook-dir`, not `skill-dir`: state is what prune, `clean` and `status` act from, and a hook's
    // directory reported as a skill's would be a lie in each of them. The catalog is a `path:` source,
    // so the mode is `link` — the same rule a skill follows.
    expect(await stateArtifacts()).toEqual([
      { path: HOOK_DIR, kind: "hook-dir", mode: "link" },
      {
        path: SETTINGS,
        kind: "harness-config",
        format: "json",
        shape: "array",
        managedKeys: HOOK_KEYS,
      },
    ]);
  });

  it("plans no directory for the command-line hook beside it", async () => {
    await cli("install");

    // `npx --yes say done` names no file the catalog holds, so it is a command line: config entry, no
    // bytes. Only the script-shipping hook has anything to materialize.
    expect(await pathExists(".agents/hooks/announce")).toBe(false);
    expect(
      (await stateArtifacts()).filter((artifact) => artifact.kind === "hook-dir"),
    ).toHaveLength(1);
  });

  /**
   * The command each harness is actually given, from an install rather than from a renderer.
   *
   * The one string the whole increment turns on: `command: hook.sh` is relative to a directory in the
   * catalog, which is a place no harness has heard of, so an unrewritten command installs a hook that
   * silently never fires. Four harnesses, one materialized script, two spellings of the way to it — and
   * exact strings, because a placeholder a harness does not interpolate is not a near miss.
   */
  it("writes the materialized path the way each harness resolves one", async () => {
    await writeCatalog(["claude", "codex", "cursor", "vscode"]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // One script, however many harnesses read it.
    expect(await fileText(`${HOOK_DIR}/${SCRIPT}`)).toBe(SCRIPT_BODY);

    // Claude, and VS Code out of the same file: Claude's own documented placeholder, which holds the
    // project root, so the script is found whatever a session's cwd is.
    expect(await settings()).toEqual({
      hooks: { PreToolUse: [SCRIPT_ENTRY], Stop: [ANNOUNCE_ENTRY] },
    });
    expect(await settingsText()).toContain(CLAUDE_COMMAND);

    // Codex: Claude's entry shape, and not Claude's path — it interpolates nothing. Notably *not*
    // `$(git rev-parse --show-toplevel)/…`, which its own docs suggest and ambit will not write.
    expect(JSON.parse(await fileText(".codex/hooks.json"))).toEqual({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: RELATIVE_COMMAND }] }],
        Stop: [ANNOUNCE_ENTRY],
      },
    });

    // Cursor: its own flat entry, its own camelCased events, and the same project-relative path.
    expect(JSON.parse(await fileText(".cursor/hooks.json"))).toEqual({
      version: 1,
      hooks: {
        preToolUse: [{ command: RELATIVE_COMMAND }],
        stop: [{ command: "npx --yes say done" }],
      },
    });

    // And the hook that ships nothing is written verbatim into all three: prefixing a command line with
    // a directory would break it, and there are no bytes there to point at.
    for (const file of [SETTINGS, ".codex/hooks.json", ".cursor/hooks.json"]) {
      expect(await fileText(file), file).toContain("npx --yes say done");
      expect(await fileText(file), file).not.toContain(`hooks/announce`);
    }
  });

  /**
   * `plannedPaths` (`project/prune.ts`) — the allow-list that decides which owned paths this run still
   * writes.
   *
   * A `hook-dir` missing from it makes the directory look stale on every install: pruning runs after
   * `apply`, so ambit would delete the script it just wrote, recreate it next run, and leave the
   * settings entry pointing at nothing in between. It typechecks perfectly.
   */
  it("keeps the directory on a second install rather than deleting and rewriting it", async () => {
    await cli("install");
    const written = await settingsText();

    // What a second run would remove, answered from state and the plan alone: nothing at all.
    const preview = await cli("install", "--dry-run", "--json");
    expect(preview.code, preview.stderr).toBe(ExitCode.Success);
    expect((JSON.parse(preview.stdout) as { pruned: unknown[] }).pruned).toEqual([]);

    expect((await cli("install")).code).toBe(ExitCode.Success);

    // And pruning runs *after* `apply`, so a directory wrongly judged stale is deleted having just
    // been written — leaving the settings entry naming a script the project does not hold.
    expect(await fileText(`${HOOK_DIR}/${SCRIPT}`)).toBe(SCRIPT_BODY);
    expect(await settingsText()).toBe(written);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  /**
   * `compareArtifacts` (`project/status.ts`) — which verdict function a kind is compared by.
   *
   * Without a branch of its own a `hook-dir` falls past both path branches into the config arm, where
   * `configVerdict` reads the directory as a document. Also clean under the typechecker.
   */
  it("reports the directory as a hook-dir, compared as a directory", async () => {
    await cli("install");

    const result = await cli("status", "--json");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const { artifacts } = JSON.parse(result.stdout) as {
      artifacts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(artifacts).toContainEqual({ kind: "hook-dir", path: HOOK_DIR, state: "ok" });
  });

  /**
   * `compareArtifacts` again, from the other side: a verdict has to be able to say `modified`.
   *
   * A row that reads `ok` whatever the directory holds would satisfy the test above while reporting
   * nothing, so the comparison is also asked about a script someone edited.
   */
  it("reports an edited script as modified, naming the file", async () => {
    await cli("install", "--copy");
    await writeFile(path.join(projectDir, HOOK_DIR, SCRIPT), "#!/bin/sh\nexit 1\n", "utf8");

    const result = await cli("status", "--json");

    const { artifacts } = JSON.parse(result.stdout) as {
      artifacts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(artifacts).toContainEqual({
      detail: `${SCRIPT} differs from its source`,
      kind: "hook-dir",
      path: HOOK_DIR,
      state: "modified",
    });
  });

  /**
   * `apply` (`harness/profile.ts`) — which writer a kind is handed to.
   *
   * The trailing `else` there is `applyHarnessConfig`, so a `hook-dir` without a branch of its own
   * would have a `hooks` section merged into it as though the directory were a JSON file.
   */
  it("writes the script's bytes, in both materialization modes", async () => {
    await cli("install");
    expect(await linkTarget(HOOK_DIR)).toContain(`hooks/${SCRIPT_HOOK}`);
    expect(await fileText(`${HOOK_DIR}/${SCRIPT}`)).toBe(SCRIPT_BODY);

    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);

    // A real directory now, holding the bytes rather than pointing at them.
    expect(await linkTarget(HOOK_DIR)).toBeUndefined();
    expect(await fileText(`${HOOK_DIR}/${SCRIPT}`)).toBe(SCRIPT_BODY);
  });

  it("keeps the script executable through a --copy install", async () => {
    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);

    // `fs.cp` preserves mode, and a hook the harness cannot execute is a hook that does not run — so
    // the bit is part of what the catalog ships rather than something the project has to restore.
    const mode = (await lstat(path.join(projectDir, HOOK_DIR, SCRIPT))).mode;
    expect(mode & 0o111).toBe(0o111);
  });

  /**
   * `gitignoreBlocks` (`project/gitignore.ts`) — which kinds are listed at all.
   *
   * The loop skips anything it does not recognize, so a `hook-dir` left out means every copied script
   * shows up as untracked in `git status`. The path is under `.agents/`, so it lands in the volatile
   * nested block for free once the kind is admitted.
   */
  it("lists the directory in the volatile .agents/.gitignore block", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);

    const lines = (await fileText(SHARED_GITIGNORE_FILE)).split("\n");
    const start = lines.findIndex((line) => line.startsWith(BLOCK_BEGIN));
    const end = lines.findIndex((line) => line.startsWith(BLOCK_END));
    expect(start).toBeGreaterThanOrEqual(0);
    // Anchored and without a trailing slash, exactly as a skill's pattern is: the default install is a
    // symlink, which git does not match a `dir/` pattern against.
    expect(lines.slice(start + 1, end)).toEqual([`/hooks/${SCRIPT_HOOK}`]);
  });

  /**
   * `modeFindings` (`project/doctor.ts`) — which kinds the mode check counts.
   *
   * `status` is deliberately silent about materialization mode, so this is the only command that can
   * report it. Counting only `skill-dir` means a hook's script installed with `--copy` out of a working
   * copy is never mentioned anywhere.
   */
  it("reports the directory's mode divergence in doctor", async () => {
    await cli("install", "--copy");

    const report = await diagnoseProject(projectDir);
    const found = report.findings.filter((finding) => finding.message.includes(HOOK_DIR));

    // A warning, not a failure: `--copy` is a per-run flag, and both modes put the same bytes in front
    // of the harness. What is worth saying is that the next plain install will swap it back.
    expect(
      found.map((finding) => `${finding.check}/${finding.severity}: ${finding.message}`),
    ).toEqual([`mode/warn: ${HOOK_DIR} is installed as a copy`]);
  });

  it("takes the directory back on clean, and leaves the catalog's copy alone", async () => {
    await cli("install", "--copy");

    expect((await cli("clean")).code).toBe(ExitCode.Success);

    expect(await pathExists(HOOK_DIR)).toBe(false);
    // The bytes it was copied from are the catalog's, and `clean` is about the project.
    expect(
      await readFile(path.join(root, "catalog", `hooks/${SCRIPT_HOOK}/${SCRIPT}`), "utf8"),
    ).toBe(SCRIPT_BODY);
  });

  it("stops materializing the directory once the hook leaves the bundle", async () => {
    await cli("install");
    await writeProfile([]);

    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The other half of `plannedPaths`: a path the plan no longer writes *is* stale, and pruning it is
    // what stops a withdrawn hook's script from sitting in the project forever.
    expect(await pathExists(HOOK_DIR)).toBe(false);
    expect(await stateArtifacts()).toEqual([]);
  });
});
