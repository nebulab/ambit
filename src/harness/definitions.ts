/**
 * The five harnesses, as profiles.
 *
 * Each one's server shape is what that tool's own documentation tells a person to write by hand, so an
 * installed config is indistinguishable from a hand-written one — which is the property that makes a
 * harness willing to read it and a person willing to look at it.
 *
 * Two families, on the skills side. Claude Code and Cursor read `.claude/skills`, so they get a link
 * to the shared directory. Codex, VS Code and opencode read `.agents/skills` natively and need nothing.
 * Both Claude and Cursor name the same link, so a project using both plans it once.
 *
 * Two families on the hooks side as well, and along a different seam: VS Code reads Claude's own
 * `.claude/settings.json`, so the two share a file and a renderer where they share nothing on the MCP
 * side. A project configuring both writes that file once, exactly as one configuring Claude and Cursor
 * plans one skills link. Cursor is the other family, and shares nothing with either — its own file, its
 * own event names, its own entry shape.
 */
import type { HarnessProfile, HookLayout } from "./profile.js";
import type { EnvRefStyle } from "./env.js";
import {
  bracedRef,
  envPassthrough,
  namespacedRef,
  shellRef,
  soleReference,
  translateRefs,
} from "./env.js";
import type { MergedMcp } from "../model/catalog.js";
import type { HookEntity, HookEvent } from "../model/hook-entity.js";

/** Where Claude Code and Cursor look for skills. */
const CLAUDE_SKILLS_LINK = ".claude/skills";

/**
 * Where Claude Code keeps its hooks — and VS Code with it, which reads this file natively.
 *
 * The file is a person's before it is ambit's: their `model`, their `permissions`, and hooks they wrote
 * themselves live in it. Which is why the section is `array`-shaped rather than `map`-shaped — ambit
 * owns entries inside `hooks.<Event>` by digest, not the `hooks` root.
 */
const CLAUDE_HOOKS: HookLayout = {
  file: ".claude/settings.json",
  section: "hooks",
  format: "json",
  shape: "array",
};

/**
 * One hook, Claude-shaped: an entry in `hooks.<Event>` pairing an optional tool `matcher` with the
 * commands to run.
 *
 * The nesting is the harness's rather than ambit's, and one entry carries one command because one
 * declaration is one hook — grouping several under one entry would make a digest name a set whose
 * membership changes as other hooks come and go.
 *
 * VS Code reads exactly this and ignores `matcher`, so it needs no rendering of its own. A second
 * spelling would put two entries in one array for one declared hook, which is the opposite of sharing
 * the file.
 *
 * Key order here is the digest's input, so it is fixed in this one place and read off nowhere else.
 */
function claudeHook(hook: HookEntity): unknown {
  return {
    ...(hook.matcher !== undefined && { matcher: hook.matcher }),
    hooks: [
      {
        type: "command",
        command: hook.command,
        ...(hook.timeout !== undefined && { timeout: hook.timeout }),
      },
    ],
  };
}

/**
 * How Cursor spells each of ambit's events: the same names, camelCased.
 *
 * The one harness that needs a map at all — Claude, VS Code and Codex read the PascalCase spellings
 * verbatim. Written out rather than derived from the neutral name, because the mapping is a fact about
 * Cursor rather than a rule: the record is total over {@link HookEvent}, so an event added to the
 * vocabulary is a type error here until someone has looked up what Cursor calls it.
 */
const CURSOR_EVENTS: Readonly<Record<HookEvent, string>> = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  Stop: "stop",
  SubagentStop: "subagentStop",
  PreCompact: "preCompact",
  SessionEnd: "sessionEnd",
};

/**
 * Where Cursor keeps its hooks: a file of its own, and a `version` beside them.
 *
 * The `version` is `rootDefaults` rather than something the renderer writes, because it is the
 * document's and not an entry's: ambit seeds it creating the file and leaves a `version: 2` someone
 * else wrote exactly where it is — where the tool ambit replaces forces it back to `1`, having claimed
 * the whole document.
 */
const CURSOR_HOOKS: HookLayout = {
  file: ".cursor/hooks.json",
  section: "hooks",
  format: "json",
  shape: "array",
  rootDefaults: { version: 1 },
  events: CURSOR_EVENTS,
};

/**
 * One hook, Cursor-shaped: a flat entry naming the command, in the array for its camelCased event.
 *
 * Two things go missing on the way here, and both are the harness's doing. Cursor nests nothing — one
 * entry is one command, so there is no inner `hooks` array to build — and it has no field for a tool
 * `matcher`, so a matcher is **dropped**. Which is why declaring one on an unmatchable event is an
 * error at parse time: that is the case where a person would be surprised, whereas a `matcher` reaching
 * Cursor is a filter Cursor simply cannot express, and dropping it installs the hook unfiltered rather
 * than not at all.
 *
 * Key order here is the digest's input, so it is fixed in this one place and read off nowhere else.
 */
function cursorHook(hook: HookEntity): unknown {
  return {
    command: hook.command,
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
  };
}

/**
 * The remote half of a server: its url, with references translated.
 *
 * The url is translated for the same reason the headers and the stdio arguments are — a tenant's
 * endpoint is `https://${TENANT}.example.com/mcp`, and every string that reaches a config file from
 * the catalog has to be spelled in the syntax the harness reading it expands. Missing one of them
 * would leave a literal `${TENANT}` in the file for three of the five harnesses.
 */
function url(mcp: MergedMcp & { transport: { kind: "http" } }, style: EnvRefStyle): string {
  return translateRefs(mcp.transport.url, style);
}

/** Headers with `${VAR}` rewritten into one harness's syntax, sorted by name. */
function headersFor(
  mcp: MergedMcp & { transport: { kind: "http" } },
  style: EnvRefStyle,
): Readonly<Record<string, string>> | undefined {
  const declared = Object.entries(mcp.transport.headers).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (declared.length === 0) return undefined;

  const headers: Record<string, string> = {};
  for (const [name, value] of declared) headers[name] = translateRefs(value, style);
  return headers;
}

/**
 * The stdio half of a server, shared by every harness that spells it `command`/`args`/`env`.
 *
 * `args` carries the entity's `${VAR}` references translated too: a server invoked through a bridge
 * like `mcp-remote` takes its credential as an argument, and that is the case the translation exists
 * for.
 */
function stdio(
  mcp: MergedMcp & { transport: { kind: "stdio" } },
  style: EnvRefStyle,
  envKey = "env",
): Record<string, unknown> {
  const env = envPassthrough(mcp.env, style);
  return {
    command: mcp.transport.command,
    ...(mcp.transport.args.length > 0 && {
      args: mcp.transport.args.map((arg) => translateRefs(arg, style)),
    }),
    ...(env !== undefined && { [envKey]: env }),
  };
}

/**
 * Claude Code.
 *
 * `type` is emitted for `http` because the harness treats a server without one as stdio, and omitted
 * for stdio itself, where `command` already says so.
 */
export const claude: HarnessProfile = {
  name: "claude",
  skillsLink: CLAUDE_SKILLS_LINK,
  mcp: { file: ".mcp.json", section: "mcpServers", format: "json" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio")
      return stdio({ ...mcp, transport: mcp.transport }, shellRef);
    const remote = { ...mcp, transport: mcp.transport };
    const headers = headersFor(remote, shellRef);
    return {
      type: "http",
      url: url(remote, shellRef),
      ...(headers !== undefined && { headers }),
    };
  },
  hooks: CLAUDE_HOOKS,
  hookConfig: claudeHook,
};

/**
 * Cursor. Infers the transport from the presence of `url`, so it wants no `type`.
 *
 * The harness that makes the neutral vocabulary pay for itself: its hooks live in their own file, under
 * its own event names, in an entry shaped nothing like Claude's. All of which is stated here — a layout,
 * a map and a renderer — and none of which the install path knows about.
 */
export const cursor: HarnessProfile = {
  name: "cursor",
  skillsLink: CLAUDE_SKILLS_LINK,
  mcp: { file: ".cursor/mcp.json", section: "mcpServers", format: "json" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio")
      return stdio({ ...mcp, transport: mcp.transport }, shellRef);
    const remote = { ...mcp, transport: mcp.transport };
    const headers = headersFor(remote, namespacedRef);
    return { url: url(remote, namespacedRef), ...(headers !== undefined && { headers }) };
  },
  hooks: CURSOR_HOOKS,
  hookConfig: cursorHook,
};

/**
 * VS Code (Copilot). Its section is `servers`, and it wants an explicit `type` on both transports.
 *
 * `${env:VAR}` throughout, including in a stdio server's `env`. VS Code also has `${input:VAR}`, which
 * prompts the user — but only when the file declares a matching entry in its own `inputs` array, which
 * ambit does not write. Emitting one without the other would reference a prompt that does not exist.
 *
 * Its hooks are Claude's outright: it reads `.claude/settings.json` natively, so the profile names
 * Claude's layout and Claude's renderer rather than any of its own.
 */
export const vscode: HarnessProfile = {
  name: "vscode",
  mcp: { file: ".vscode/mcp.json", section: "servers", format: "json" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio") {
      return { type: "stdio", ...stdio({ ...mcp, transport: mcp.transport }, namespacedRef) };
    }
    const remote = { ...mcp, transport: mcp.transport };
    const headers = headersFor(remote, namespacedRef);
    return {
      type: "http",
      url: url(remote, namespacedRef),
      ...(headers !== undefined && { headers }),
    };
  },
  hooks: CLAUDE_HOOKS,
  hookConfig: claudeHook,
};

/**
 * Codex. TOML, and the one harness with a first-class way to keep a credential out of the file.
 *
 * A header whose value is nothing but a `${VAR}` reference becomes `env_http_headers`, which names the
 * variable and lets Codex read it at spawn time. A header with a variable *embedded* in a larger string
 * — `Bearer ${TOKEN}` — cannot be expressed that way, so it goes in `http_headers` with the reference
 * left in place for Codex to expand.
 */
export const codex: HarnessProfile = {
  name: "codex",
  mcp: { file: ".codex/config.toml", section: "mcp_servers", format: "toml" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio")
      return stdio({ ...mcp, transport: mcp.transport }, shellRef);

    const literal: Record<string, string> = {};
    const fromEnv: Record<string, string> = {};
    const declared = Object.entries(mcp.transport.headers).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [name, value] of declared) {
      const sole = soleReference(value);
      if (sole === undefined) literal[name] = translateRefs(value, shellRef);
      else fromEnv[name] = sole;
    }

    return {
      url: url({ ...mcp, transport: mcp.transport }, shellRef),
      ...(Object.keys(literal).length > 0 && { http_headers: literal }),
      ...(Object.keys(fromEnv).length > 0 && { env_http_headers: fromEnv }),
    };
  },
};

/**
 * opencode. JSONC, `mcp` as its section, and its own vocabulary: `local`/`remote` rather than
 * stdio/http, one `command` array rather than a command and its arguments, and `environment` for the
 * env map.
 */
export const opencode: HarnessProfile = {
  name: "opencode",
  mcp: { file: ".opencode/opencode.jsonc", section: "mcp", format: "jsonc" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio") {
      const env = envPassthrough(mcp.env, shellRef);
      return {
        type: "local",
        command: [
          mcp.transport.command,
          ...mcp.transport.args.map((arg) => translateRefs(arg, shellRef)),
        ],
        ...(env !== undefined && { environment: env }),
      };
    }
    const remote = { ...mcp, transport: mcp.transport };
    const headers = headersFor(remote, bracedRef);
    return {
      type: "remote",
      url: url(remote, bracedRef),
      ...(headers !== undefined && { headers }),
    };
  },
};

/** Every profile this build ships, in the order `--help` and error messages list them. */
export const PROFILES: readonly HarnessProfile[] = [claude, codex, cursor, opencode, vscode];
