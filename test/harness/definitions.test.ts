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
import { SHARED_SKILLS_DIR } from "../../src/harness/profile.js";
import type { MergedMcp } from "../../src/model/catalog.js";
import type { HookEntity } from "../../src/model/hook-entity.js";
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
 * Three harnesses express hooks in this build, in two shapes: Claude and VS Code share one file and one
 * entry, and Cursor shares nothing with either. So the claims are each entry's exact shape, its key
 * order, and which harnesses render the same bytes. Key order is load-bearing here in a way it is not
 * for a server: the managed key is a digest of these bytes, so reordering them renames every hook every
 * project owns.
 */
describe("the hook each profile emits", () => {
  const PROJECT: ProjectPaths = { root: "/tmp/ambit-project" };

  /** A hook carrying both optional fields, which is where the shape has anything to say. */
  const HOOK: HookEntity = {
    name: "block-rm",
    scopes: [],
    env: [],
    event: "PreToolUse",
    matcher: "Bash",
    command: "./bin/block-rm",
    timeout: 30,
  };

  /** A hook carrying neither, on the event a `matcher` is not even allowed on. */
  const BARE: HookEntity = {
    name: "greet",
    scopes: [],
    env: [],
    event: "SessionStart",
    command: "./bin/greet",
  };

  it("gives Claude and VS Code one shared file, and the other two no hooks at all", () => {
    const layout = {
      file: ".claude/settings.json",
      section: "hooks",
      format: "json",
      shape: "array",
    };

    expect(claude.hooks).toEqual(layout);
    // The same file, so a project configuring both writes it once.
    expect(vscode.hooks).toEqual(layout);
    // No `events`: both read ambit's own PascalCase spellings, and no `rootDefaults` either — the file
    // is a person's, and ambit adds no key to it beyond the hooks it was asked for.
    expect(codex.hooks).toBeUndefined();
    expect(opencode.hooks).toBeUndefined();
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

  it("renders one entry for both harnesses, which is what lets them share the file", () => {
    // Byte equality, not structural: the digest that identifies the entry is taken over exactly these
    // bytes, so two renderings that differ only in key order would be two entries in one array.
    expect(JSON.stringify(vscode.hookConfig?.(HOOK, PROJECT))).toBe(
      JSON.stringify(claude.hookConfig?.(HOOK, PROJECT)),
    );
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
});
