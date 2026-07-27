/**
 * The five harness profiles, as a table of exact server shapes.
 *
 * This file is the specification for the property the whole harness layer rests on: an installed
 * config is indistinguishable from one a person wrote by hand. That is not a matter of taste — it is
 * what makes a harness willing to read the file and a person willing to look at it. So every case
 * asserts the *whole* emitted object rather than probing a field, and the key order too, since a
 * hand-written server does not put `url` before `type`.
 *
 * The layouts come from dotagents 1.19.0's own target definitions rather than from memory, with one
 * deliberate deviation for VS Code that is called out where it is asserted.
 */
import { describe, expect, it } from "vitest";

import {
  claude,
  codex,
  cursor,
  opencode,
  PROFILES,
  vscode,
} from "../../src/harness/definitions.js";
import type { ProjectPaths } from "../../src/harness/adapter.js";
import type { HarnessProfile } from "../../src/harness/profile.js";
import { SHARED_SKILLS_DIR, skippedHooks } from "../../src/harness/profile.js";
import type { MergedHook, MergedMcp } from "../../src/model/catalog.js";
import type { HookEvent } from "../../src/model/hook-entity.js";
import { HOOK_EVENTS } from "../../src/model/hook-entity.js";

/** Where Claude Code and Cursor read skills, and so the one link ambit plans. */
const CLAUDE_SKILLS_LINK = ".claude/skills";

const URL = "https://mcp.invalid/fixture";

/** An http server carrying both header shapes: one embedded reference and one bare one. */
function http(headers: Readonly<Record<string, string>> = {}): MergedMcp {
  return {
    name: "fixture",
    scopes: [],
    env: [],
    catalog: "company",
    transport: { kind: "http", url: URL, headers },
  };
}

const HEADERS = { "X-Api-Key": "${API_KEY}", Authorization: "Bearer ${TOKEN}" } as const;

/** The same server at some other url, for the claims about the url itself. */
function httpAt(at: string): MergedMcp {
  return { ...http(), transport: { kind: "http", url: at, headers: {} } };
}

/** A stdio server whose arguments carry a credential, which is the case translation exists for. */
function stdio(args: readonly string[] = [], env: readonly string[] = []): MergedMcp {
  return {
    name: "fixture",
    scopes: [],
    env,
    catalog: "company",
    transport: { kind: "stdio", command: "npx", args },
  };
}

const BRIDGE_ARGS = [
  "-y",
  "mcp-remote",
  URL,
  "--header",
  "Authorization: Bearer ${TOKEN}",
] as const;

describe("the harness table", () => {
  it("ships exactly five profiles, in the order errors and `--help` list them", () => {
    expect(PROFILES.map((profile) => profile.name)).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "vscode",
    ]);
  });

  it("names each harness's config file, section and format", () => {
    expect(Object.fromEntries(PROFILES.map((profile) => [profile.name, profile.mcp]))).toEqual({
      claude: { file: ".mcp.json", section: "mcpServers", format: "json" },
      codex: { file: ".codex/config.toml", section: "mcp_servers", format: "toml" },
      cursor: { file: ".cursor/mcp.json", section: "mcpServers", format: "json" },
      opencode: { file: ".opencode/opencode.jsonc", section: "mcp", format: "jsonc" },
      vscode: { file: ".vscode/mcp.json", section: "servers", format: "json" },
    });
  });

  it("gives the two harnesses that need one the same skills link, and the other three none", () => {
    // Claude Code and Cursor read `.claude/skills`; Codex, VS Code and opencode read the shared
    // directory natively. Naming the same link is what makes a project using both plan it once.
    expect(claude.skillsLink).toBe(CLAUDE_SKILLS_LINK);
    expect(cursor.skillsLink).toBe(CLAUDE_SKILLS_LINK);
    expect(codex.skillsLink).toBeUndefined();
    expect(vscode.skillsLink).toBeUndefined();
    expect(opencode.skillsLink).toBeUndefined();
    // And the link is not the shared directory itself, or it would point at itself.
    expect(CLAUDE_SKILLS_LINK).not.toBe(SHARED_SKILLS_DIR);
  });

  it("writes each harness's config where that harness looks for a project-local one", () => {
    // Every path is project-relative and inside the project: ambit installs into a checkout, never
    // into someone's home directory.
    for (const profile of PROFILES) {
      expect(profile.mcp.file.startsWith("/")).toBe(false);
      expect(profile.mcp.file.startsWith("..")).toBe(false);
    }
  });
});

/**
 * One case per harness per transport, asserted whole.
 *
 * Table-driven because the interesting content is the table: reading down a column is how someone
 * checks a harness's shape against that harness's documentation, and how the deviations between them
 * stay visible rather than buried in five separate assertions.
 */
describe("the server each profile emits", () => {
  const CASES: readonly {
    readonly profile: HarnessProfile;
    readonly stdio: unknown;
    readonly bareStdio: unknown;
    readonly http: unknown;
    readonly bareHttp: unknown;
  }[] = [
    {
      profile: claude,
      // `type` is omitted for stdio, where `command` already says so, and emitted for http, because
      // Claude Code reads a server without one as stdio.
      stdio: {
        command: "npx",
        args: ["-y", "mcp-remote", URL, "--header", "Authorization: Bearer ${TOKEN}"],
        env: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}", TOKEN: "${TOKEN}" },
      },
      bareStdio: { command: "npx" },
      http: {
        type: "http",
        url: URL,
        headers: { Authorization: "Bearer ${TOKEN}", "X-Api-Key": "${API_KEY}" },
      },
      bareHttp: { type: "http", url: URL },
    },
    {
      profile: cursor,
      stdio: {
        command: "npx",
        args: ["-y", "mcp-remote", URL, "--header", "Authorization: Bearer ${TOKEN}"],
        env: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}", TOKEN: "${TOKEN}" },
      },
      bareStdio: { command: "npx" },
      // No `type` at all: Cursor infers the transport from the presence of `url`.
      http: {
        url: URL,
        headers: { Authorization: "Bearer ${env:TOKEN}", "X-Api-Key": "${env:API_KEY}" },
      },
      bareHttp: { url: URL },
    },
    {
      profile: vscode,
      // An explicit `type` on both transports, and `${env:VAR}` throughout — including in `env`,
      // where dotagents writes `${input:VAR}`. That form only works when the file also declares a
      // matching `inputs` array, which ambit does not write, so emitting it would reference a prompt
      // that does not exist.
      stdio: {
        type: "stdio",
        command: "npx",
        args: ["-y", "mcp-remote", URL, "--header", "Authorization: Bearer ${env:TOKEN}"],
        env: { FIXTURE_API_KEY: "${env:FIXTURE_API_KEY}", TOKEN: "${env:TOKEN}" },
      },
      bareStdio: { type: "stdio", command: "npx" },
      http: {
        type: "http",
        url: URL,
        headers: { Authorization: "Bearer ${env:TOKEN}", "X-Api-Key": "${env:API_KEY}" },
      },
      bareHttp: { type: "http", url: URL },
    },
    {
      profile: codex,
      stdio: {
        command: "npx",
        args: ["-y", "mcp-remote", URL, "--header", "Authorization: Bearer ${TOKEN}"],
        env: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}", TOKEN: "${TOKEN}" },
      },
      bareStdio: { command: "npx" },
      // The one harness with a first-class way to keep a credential out of the file: a header that is
      // nothing but a reference names its variable in `env_http_headers`, and one with a reference
      // embedded in a larger string has to stay in `http_headers`.
      http: {
        url: URL,
        http_headers: { Authorization: "Bearer ${TOKEN}" },
        env_http_headers: { "X-Api-Key": "API_KEY" },
      },
      bareHttp: { url: URL },
    },
    {
      profile: opencode,
      // Its own vocabulary throughout: `local`/`remote`, one `command` array, and `environment`.
      stdio: {
        type: "local",
        command: ["npx", "-y", "mcp-remote", URL, "--header", "Authorization: Bearer ${TOKEN}"],
        environment: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}", TOKEN: "${TOKEN}" },
      },
      bareStdio: { type: "local", command: ["npx"] },
      http: {
        type: "remote",
        url: URL,
        headers: { Authorization: "Bearer {env:TOKEN}", "X-Api-Key": "{env:API_KEY}" },
      },
      bareHttp: { type: "remote", url: URL },
    },
  ];

  for (const { profile, ...expected } of CASES) {
    describe(profile.name, () => {
      it("writes a stdio server with its arguments and its environment", () => {
        const emitted = profile.serverConfig(stdio(BRIDGE_ARGS, ["TOKEN", "FIXTURE_API_KEY"]));

        expect(emitted).toEqual(expected.stdio);
        expect(Object.keys(emitted as object)).toEqual(Object.keys(expected.stdio as object));
      });

      it("omits `args` and `env` a stdio server does not declare", () => {
        // A server with nothing to say about either gets neither key, rather than an empty array and
        // an empty map nobody wrote.
        expect(profile.serverConfig(stdio())).toEqual(expected.bareStdio);
      });

      it("writes an http server with its headers", () => {
        const emitted = profile.serverConfig(http(HEADERS));

        expect(emitted).toEqual(expected.http);
        expect(Object.keys(emitted as object)).toEqual(Object.keys(expected.http as object));
      });

      it("omits `headers` an http server does not declare", () => {
        expect(profile.serverConfig(http())).toEqual(expected.bareHttp);
      });

      it("sorts the headers it writes, so the file does not churn on the catalog's key order", () => {
        const emitted = profile.serverConfig(http(HEADERS)) as Record<string, unknown>;
        const written = (emitted.headers ?? emitted.http_headers) as Record<string, unknown>;

        expect(Object.keys(written).sort()).toEqual(Object.keys(written));
      });

      it("resolves no variable, whatever the environment holds", () => {
        process.env.TOKEN = "s3cret";
        try {
          const both = [
            JSON.stringify(profile.serverConfig(http(HEADERS))),
            JSON.stringify(profile.serverConfig(stdio(BRIDGE_ARGS, ["TOKEN"]))),
          ].join("");

          expect(both).not.toContain("s3cret");
          expect(both).toContain("TOKEN");
        } finally {
          delete process.env.TOKEN;
        }
      });
    });
  }
});

/**
 * The gap this change was made to close: a bridge like `mcp-remote` takes its credential as a
 * command-line argument, and before this ambit interpolated only into http headers — so that server
 * could not carry its token at all.
 */
describe("a reference in an http server's url", () => {
  it("is translated too, so a per-tenant endpoint works on every harness", () => {
    const tenant = (profile: HarnessProfile): unknown =>
      (profile.serverConfig(httpAt("https://${TENANT}.mcp.invalid/fixture")) as { url: string })
        .url;

    expect(tenant(claude)).toBe("https://${TENANT}.mcp.invalid/fixture");
    expect(tenant(codex)).toBe("https://${TENANT}.mcp.invalid/fixture");
    expect(tenant(cursor)).toBe("https://${env:TENANT}.mcp.invalid/fixture");
    expect(tenant(vscode)).toBe("https://${env:TENANT}.mcp.invalid/fixture");
    expect(tenant(opencode)).toBe("https://{env:TENANT}.mcp.invalid/fixture");
  });
});

describe("a credential in a stdio server's arguments", () => {
  it("reaches every harness, in that harness's own spelling", () => {
    const args = ["mcp-remote", "--header", "Authorization: Bearer ${TOKEN}"];
    const argsFor = (profile: HarnessProfile): readonly string[] => {
      const emitted = profile.serverConfig(stdio(args)) as {
        args?: readonly string[];
        command?: string | readonly string[];
      };
      return emitted.args ?? (emitted.command as readonly string[]);
    };

    expect(argsFor(claude).at(-1)).toBe("Authorization: Bearer ${TOKEN}");
    expect(argsFor(codex).at(-1)).toBe("Authorization: Bearer ${TOKEN}");
    expect(argsFor(cursor).at(-1)).toBe("Authorization: Bearer ${TOKEN}");
    expect(argsFor(opencode).at(-1)).toBe("Authorization: Bearer ${TOKEN}");
    expect(argsFor(vscode).at(-1)).toBe("Authorization: Bearer ${env:TOKEN}");
  });
});

/**
 * The hook each profile emits.
 *
 * Four harnesses express hooks, in two shapes: Claude, VS Code and Codex render one entry — the first
 * two into one shared file, Codex into its own — and Cursor shares nothing with any of them. So the
 * claims are each entry's exact shape, its key order, and which harnesses render the same bytes. Key
 * order is load-bearing here in a way it is not for a server: the managed key is a digest of these
 * bytes, so reordering them renames every hook every project owns.
 *
 * The fifth harness expresses none, which is the other thing asserted here: opencode carries no layout,
 * and `skippedHooks` turns that absence into something the run reports.
 */
describe("the hook each profile emits", () => {
  const PROJECT: ProjectPaths = { root: "/tmp/ambit-project" };

  /** A hook carrying both optional fields, which is where the shape has anything to say. */
  const HOOK: MergedHook = {
    name: "block-rm",
    catalog: "company",
    shipsScript: false,
    scopes: [],
    env: [],
    event: "PreToolUse",
    matcher: "Bash",
    command: "./bin/block-rm",
    timeout: 30,
  };

  /** A hook carrying neither, on the event a `matcher` is not even allowed on. */
  const BARE: MergedHook = {
    name: "greet",
    catalog: "company",
    shipsScript: false,
    scopes: [],
    env: [],
    event: "SessionStart",
    command: "./bin/greet",
  };

  it("gives Claude and VS Code one shared file, and Codex one of its own", () => {
    const layout = {
      file: ".claude/settings.json",
      section: "hooks",
      format: "json",
      shape: "array",
    };

    expect(claude.hooks).toEqual(layout);
    // The same file, so a project configuring both writes it once.
    expect(vscode.hooks).toEqual(layout);
    // Codex differs in the file and in nothing else — Claude's section, Claude's shape, Claude's
    // entries. Not `[hooks]` in `.codex/config.toml`, which Codex also reads: that is an
    // array-of-tables, which the TOML driver refuses, so it would cost a second driver to write a
    // document Codex is equally happy to read as JSON.
    expect(codex.hooks).toEqual({ ...layout, file: ".codex/hooks.json" });
    // No `events` on any of the three: all read ambit's own PascalCase spellings. And no `rootDefaults`
    // either — Claude's file is a person's and Codex's holds hooks alone, so ambit seeds no key in
    // either beyond the hooks it was asked for.
    expect(opencode.hooks).toBeUndefined();
  });

  it("leaves opencode without hooks, which is what makes a hook for it a skip", () => {
    // The one harness with no declarative mechanism at all: it runs TypeScript plugins, which is code
    // rather than config. So the profile carries no layout and no renderer, and `skippedHooks` reads
    // that absence as the reason.
    expect(opencode.hooks).toBeUndefined();
    expect(opencode.hookConfig).toBeUndefined();
    expect(PROFILES.filter((profile) => profile.hooks === undefined).map((p) => p.name)).toEqual([
      "opencode",
    ]);
  });

  it("gives Cursor a file of its own, a `version` to seed, and its own event names", () => {
    expect(cursor.hooks).toEqual({
      file: ".cursor/hooks.json",
      section: "hooks",
      format: "json",
      shape: "array",
      rootDefaults: { version: 1 },
      events: {
        SessionStart: "sessionStart",
        UserPromptSubmit: "userPromptSubmit",
        PreToolUse: "preToolUse",
        PostToolUse: "postToolUse",
        Stop: "stop",
        SubagentStop: "subagentStop",
        PreCompact: "preCompact",
        SessionEnd: "sessionEnd",
      },
    });
  });

  it("spells every event ambit knows, so no hook lands in an array Cursor never reads", () => {
    // Total over the vocabulary rather than nearly so: a missing spelling would write an entry into an
    // array named the Claude way, which Cursor would ignore in silence.
    expect(Object.keys(cursor.hooks?.events ?? {})).toEqual([...HOOK_EVENTS]);
  });

  it("pairs a layout with a renderer, so a profile carries both or neither", () => {
    for (const profile of PROFILES) {
      expect(profile.hookConfig === undefined, profile.name).toBe(profile.hooks === undefined);
    }
  });

  it("writes the entry Claude Code's own documentation describes, in that key order", () => {
    const emitted = claude.hookConfig?.(HOOK, PROJECT);

    expect(emitted).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "./bin/block-rm", timeout: 30 }],
    });
    expect(Object.keys(emitted as object)).toEqual(["matcher", "hooks"]);
    const [command] = (emitted as { hooks: readonly object[] }).hooks;
    expect(Object.keys(command as object)).toEqual(["type", "command", "timeout"]);
  });

  it("omits a `matcher` and a `timeout` the hook does not declare", () => {
    expect(claude.hookConfig?.(BARE, PROJECT)).toEqual({
      hooks: [{ type: "command", command: "./bin/greet" }],
    });
  });

  it("renders one entry for the three harnesses that read Claude's shape", () => {
    // Byte equality, not structural: the digest that identifies the entry is taken over exactly these
    // bytes, so two renderings that differ only in key order would be two entries in one array. For
    // Claude and VS Code that is what lets them share the file; for Codex it is what makes the same
    // hook carry the same digest in a file of its own.
    const claudes = JSON.stringify(claude.hookConfig?.(HOOK, PROJECT));

    expect(JSON.stringify(vscode.hookConfig?.(HOOK, PROJECT))).toBe(claudes);
    expect(JSON.stringify(codex.hookConfig?.(HOOK, PROJECT))).toBe(claudes);
  });

  it("writes Cursor's flat entry, which nests nothing and carries no matcher", () => {
    const emitted = cursor.hookConfig?.(HOOK, PROJECT);

    // Cursor has no field for a tool `matcher`, so `Bash` is dropped rather than written through into a
    // key the harness would ignore — and no inner `hooks` array, because one entry is one command.
    expect(emitted).toEqual({ command: "./bin/block-rm", timeout: 30 });
    expect(Object.keys(emitted as object)).toEqual(["command", "timeout"]);
  });

  it("omits a `timeout` a Cursor hook does not declare", () => {
    expect(cursor.hookConfig?.(BARE, PROJECT)).toEqual({ command: "./bin/greet" });
  });

  it("renders Cursor's entry differently from Claude's, which is why the files stay separate", () => {
    // Not a detail: the two renderings have different digests, so `planFor` cannot collapse them and a
    // project on both harnesses gets two artifacts rather than one written twice.
    expect(JSON.stringify(cursor.hookConfig?.(HOOK, PROJECT))).not.toBe(
      JSON.stringify(claude.hookConfig?.(HOOK, PROJECT)),
    );
  });

  /**
   * The command a shipped script is written as, per harness.
   *
   * The one string that decides whether a materialized hook actually runs, and it is genuinely
   * per-harness: a catalog declares `command: hook.sh`, which names a file relative to the hook's own
   * directory in the catalog — a location no harness has ever heard of. So the rendered command has to
   * say where the *installed* script is, spelled the way that harness resolves a path.
   *
   * Asserted as exact strings rather than by pattern, because a placeholder a harness does not
   * interpolate is not a near miss: it is a hook that never fires, and it fails silently.
   */
  describe("a hook that ships its own script", () => {
    /** The script-shipping counterpart of {@link HOOK}: the same declaration, `shipsScript` set. */
    const SCRIPT: MergedHook = {
      ...HOOK,
      catalogRoot: "/catalogs/company",
      path: "hooks/block-rm",
      command: "hook.sh",
      shipsScript: true,
    };

    /** The command out of one profile's rendering, whichever shape it wrote. */
    function commandOf(profile: HarnessProfile, hook: MergedHook): string {
      const emitted = profile.hookConfig?.(hook, PROJECT) as {
        command?: string;
        hooks?: readonly { command: string }[];
      };
      return emitted.command ?? emitted.hooks?.[0]?.command ?? "";
    }

    it("points Claude and VS Code at the project root through Claude's own placeholder", () => {
      // `${CLAUDE_PROJECT_DIR}` is documented — by Claude — as interpolated in `command` and as holding
      // the project root, so the script is found however deep in the tree the session's cwd sits. VS Code
      // reads this same file and gets the same string, documented or not: a second spelling would put two
      // entries in one array for one declared hook, and both harnesses would run both.
      expect(commandOf(claude, SCRIPT)).toBe(
        "${CLAUDE_PROJECT_DIR}/.agents/hooks/block-rm/hook.sh",
      );
      expect(commandOf(vscode, SCRIPT)).toBe(
        "${CLAUDE_PROJECT_DIR}/.agents/hooks/block-rm/hook.sh",
      );
    });

    it("writes Cursor and Codex a project-relative path, and no subshell", () => {
      // Neither interpolates anything in a `command`, so the path as written is all there is. Codex's
      // own docs suggest `$(git rev-parse --show-toplevel)/…`; ambit does not write it — it assumes git
      // and a POSIX shell, and a config file holding a subshell is not a value a reader can check.
      expect(commandOf(cursor, SCRIPT)).toBe(".agents/hooks/block-rm/hook.sh");
      expect(commandOf(codex, SCRIPT)).toBe(".agents/hooks/block-rm/hook.sh");
      for (const profile of [cursor, codex]) {
        expect(commandOf(profile, SCRIPT)).not.toContain("git rev-parse");
        expect(commandOf(profile, SCRIPT)).not.toContain("${");
      }
    });

    it("gives Codex a different command from Claude's, sharing the entry shape and not the path", () => {
      // Which is why `root` is a parameter of the Claude renderer rather than a constant inside it: the
      // three harnesses agree on the shape of an entry and disagree on how to name a file.
      expect(commandOf(codex, SCRIPT)).not.toBe(commandOf(claude, SCRIPT));
      expect(Object.keys(claude.hookConfig?.(SCRIPT, PROJECT) as object)).toEqual(
        Object.keys(codex.hookConfig?.(SCRIPT, PROJECT) as object),
      );
    });

    it("rewrites the program and keeps every argument", () => {
      // `command` is a shell fragment ambit does not parse, so only the first token — the one thing that
      // can name a shipped file — is rewritten. An argument that happens to look like a path is the
      // program's business, not ambit's.
      const withArgs: MergedHook = { ...SCRIPT, command: "./hook.sh --strict bin/other" };

      expect(commandOf(claude, withArgs)).toBe(
        "${CLAUDE_PROJECT_DIR}/.agents/hooks/block-rm/hook.sh --strict bin/other",
      );
      expect(commandOf(cursor, withArgs)).toBe(".agents/hooks/block-rm/hook.sh --strict bin/other");
    });

    it("leaves a hook that ships nothing exactly as declared", () => {
      // The command line case, which is most hooks: prefixing `npx --yes prettier` with a directory
      // would break it, and there are no bytes at that directory to point at anyway.
      const inline: MergedHook = { ...HOOK, command: "npx --yes prettier --check" };

      for (const profile of [claude, codex, cursor, vscode]) {
        expect(commandOf(profile, inline), profile.name).toBe("npx --yes prettier --check");
      }
      // Including one whose command reads as a path but ships nothing: `shipsScript` is the answer, and
      // the catalog derived it by looking. Rewriting on the spelling alone would point at a file the
      // hook's directory never held.
      expect(commandOf(claude, HOOK)).toBe("./bin/block-rm");
    });
  });

  it("resolves no variable in a command, and rewrites no reference either", () => {
    process.env.TOKEN = "s3cret";
    try {
      const emitted = claude.hookConfig?.({ ...BARE, command: "./bin/greet ${TOKEN}" }, PROJECT);

      // Unlike an MCP transport: a hook's command is run by a shell the harness spawns, so `${TOKEN}`
      // already means the right thing and translating it would be rewriting a shell fragment.
      expect(JSON.stringify(emitted)).toContain("${TOKEN}");
      expect(JSON.stringify(emitted)).not.toContain("s3cret");
    } finally {
      delete process.env.TOKEN;
    }
  });

  /**
   * What a harness declines, as the other half of what it writes.
   *
   * One predicate answers both — a hook is planned for the array it belongs in, or skipped because there
   * is none — so these cases and the ones above partition every hook a bundle can hold.
   */
  describe("skippedHooks", () => {
    it("accounts for every hook on the harness that expresses none", () => {
      expect(skippedHooks(opencode, [HOOK, BARE])).toEqual([
        { harness: "opencode", hook: "block-rm", event: "PreToolUse", reason: "no-mechanism" },
        { harness: "opencode", hook: "greet", event: "SessionStart", reason: "no-mechanism" },
      ]);
    });

    it("skips nothing on the four harnesses that do, for every event ambit knows", () => {
      for (const profile of PROFILES.filter((candidate) => candidate.hooks !== undefined)) {
        const every = HOOK_EVENTS.map((event) => ({ ...BARE, event }));
        expect(skippedHooks(profile, every), profile.name).toEqual([]);
      }
    });

    it("skips a hook whose event a harness has no spelling for", () => {
      // Unreachable through the profiles this build ships — `HookLayout.events` is total over
      // `HookEvent`, so a missing spelling is a type error at the declaration. This is the second line
      // of defence for the day the vocabulary grows: the hook is skipped and named, rather than written
      // into an array named the Claude way that Cursor would ignore in silence.
      const partial: HarnessProfile = {
        ...cursor,
        hooks: {
          ...(cursor.hooks as NonNullable<HarnessProfile["hooks"]>),
          events: { SessionStart: "sessionStart" } as Readonly<Record<HookEvent, string>>,
        },
      };

      expect(skippedHooks(partial, [BARE])).toEqual([]);
      expect(skippedHooks(partial, [HOOK])).toEqual([
        { harness: "cursor", hook: "block-rm", event: "PreToolUse", reason: "no-event" },
      ]);
    });
  });
});
