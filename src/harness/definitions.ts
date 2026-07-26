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
 * The hooks side splits along a different seam again, and into three. VS Code reads Claude's own
 * `.claude/settings.json`, so the two share a file *and* a renderer where they share nothing on the MCP
 * side. A project configuring both writes that file once, exactly as one configuring Claude and Cursor
 * plans one skills link. Codex shares the renderer and not the file: its entries are Claude-shaped, in
 * `.codex/hooks.json`. Cursor shares neither — its own file, its own event names, its own entry shape.
 *
 * opencode expresses hooks nowhere at all, so it carries no layout, and a project that selects a hook
 * while configuring it is told the hook was skipped (`skippedHooks`, `profile.ts`).
 */
import type { HarnessProfile, HookLayout } from "./profile.js";
import { SHARED_HOOKS_DIR } from "./profile.js";
import type { EnvRefStyle } from "./env.js";
import {
  bracedRef,
  envPassthrough,
  namespacedRef,
  shellRef,
  soleReference,
  translateRefs,
} from "./env.js";
import type { MergedHook, MergedMcp } from "../model/catalog.js";
import { hookCommand } from "../model/catalog.js";
import type { HookEvent } from "../model/hook-entity.js";

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
 * Where Claude Code resolves a materialized hook script from.
 *
 * `${CLAUDE_PROJECT_DIR}` is Claude's own documented placeholder, and its documentation says exactly
 * what this is for: "use these placeholders to reference hook scripts relative to the project or plugin
 * root, regardless of the working directory when the hook runs". So the script is found however deep in
 * the tree a session's cwd happens to sit — which a relative path cannot promise.
 *
 * Written for VS Code too, which reads this same file. Whether VS Code interpolates it is *not*
 * documented either way — see {@link vscode}, where that is set out.
 */
const CLAUDE_HOOK_ROOT = `\${CLAUDE_PROJECT_DIR}/${SHARED_HOOKS_DIR}`;

/**
 * Where the harnesses with no placeholder resolve one from: the path as written, project-relative.
 *
 * Cursor and Codex interpolate nothing in a `command`, so the plain project-relative path is all there
 * is to write. Cursor documents the resolution and documents it as the project root's — "project hooks
 * (`.cursor/hooks.json` in a repository): run from the project root" — with a caution that spells out
 * this exact case: `./hooks/script.sh` "would look for `<project>/hooks/script.sh`". Nothing scopes it to
 * `.cursor/`, so a script under `.agents/` is found the same way.
 *
 * Deliberately *not* Codex's own documented suggestion of `$(git rev-parse --show-toplevel)/…`: that
 * assumes git and a POSIX shell, and a config file holding a subshell is the opposite of a value a reader
 * can check. A relative path misses if a session's cwd is not the project root, which is the harness's
 * own limitation and exactly what a person writing the hook by hand would hit.
 */
const RELATIVE_HOOK_ROOT = SHARED_HOOKS_DIR;

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
 * the file. Codex reads it too, and differs in one string: `root`, which is why that is a parameter
 * rather than a constant read from here — the three harnesses share an entry shape and not a way to
 * name a file.
 *
 * Key order here is the digest's input, so it is fixed in this one place and read off nowhere else.
 */
function claudeHook(hook: MergedHook, root: string): unknown {
  return {
    ...(hook.matcher !== undefined && { matcher: hook.matcher }),
    hooks: [
      {
        type: "command",
        command: hookCommand(hook, root),
        ...(hook.timeout !== undefined && { timeout: hook.timeout }),
      },
    ],
  };
}

/**
 * Where Codex keeps its hooks: a file of its own, holding Claude's own entry shape.
 *
 * A file rather than `[hooks]` in `.codex/config.toml`, which Codex also reads. A TOML `hooks` table is
 * an array-of-tables — `[[hooks.PreToolUse]]` — and the TOML driver splices named-table spans and
 * refuses that shape outright, so reaching for `config.toml` would mean a second driver to write a
 * document Codex is equally happy to read as JSON. Which is also why there is no `rootDefaults` here:
 * `.codex/hooks.json` holds hooks and nothing else, so ambit seeds no key beside them.
 *
 * Codex's hooks are experimental and gated behind `[features] codex_hooks = true` in a user's own
 * config, which is not a file ambit writes into. `doctor` is where that is said out loud.
 */
const CODEX_HOOKS: HookLayout = {
  file: ".codex/hooks.json",
  section: "hooks",
  format: "json",
  shape: "array",
};

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
 * A shipped script is named project-relative, because Cursor interpolates nothing in a `command` —
 * {@link RELATIVE_HOOK_ROOT} is where that is argued.
 *
 * Key order here is the digest's input, so it is fixed in this one place and read off nowhere else.
 */
function cursorHook(hook: MergedHook): unknown {
  return {
    command: hookCommand(hook, RELATIVE_HOOK_ROOT),
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
  hookConfig: (hook) => claudeHook(hook, CLAUDE_HOOK_ROOT),
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
 * Claude's layout and Claude's renderer rather than any of its own — including its `${CLAUDE_PROJECT_DIR}`
 * spelling of a shipped script's path, which is the one thing here that is not documented either way.
 * VS Code documents reading the file and parsing Claude's format; it documents expanding
 * `${CLAUDE_PLUGIN_ROOT}` in a hook command for Claude-format plugins, and documents no project-root
 * token at all. So this may be a literal `${CLAUDE_PROJECT_DIR}` to VS Code rather than a path.
 *
 * Written anyway, because the alternative is worse in a way this is not: a second spelling would put two
 * entries in one array for one declared hook — VS Code would run both, and Claude would too — and every
 * project reading the file would see the same hook twice. If it turns out to bite, it is one string in
 * one place, and `doctor` is where §6 puts a harness limitation ambit cannot write its way out of.
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
  hookConfig: (hook) => claudeHook(hook, CLAUDE_HOOK_ROOT),
};

/**
 * Codex. TOML, and the one harness with a first-class way to keep a credential out of the file.
 *
 * A header whose value is nothing but a `${VAR}` reference becomes `env_http_headers`, which names the
 * variable and lets Codex read it at spawn time. A header with a variable *embedded* in a larger string
 * — `Bearer ${TOKEN}` — cannot be expressed that way, so it goes in `http_headers` with the reference
 * left in place for Codex to expand.
 *
 * Its hooks are the one place the TOML stops: they live in `.codex/hooks.json`, and are Claude's own
 * entries — so the profile names Claude's renderer, and Claude's file is the only thing it does not
 * share.
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
  hooks: CODEX_HOOKS,
  hookConfig: (hook) => claudeHook(hook, RELATIVE_HOOK_ROOT),
};

/**
 * opencode. JSONC, `mcp` as its section, and its own vocabulary: `local`/`remote` rather than
 * stdio/http, one `command` array rather than a command and its arguments, and `environment` for the
 * env map.
 *
 * The one harness with no declarative hooks at all — it runs TypeScript plugins instead, which is code
 * rather than config and so nothing ambit can write from a declaration. No `hooks`, therefore, and a
 * project that configures opencode and selects a hook is told the hook was skipped for it.
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
