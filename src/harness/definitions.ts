/**
 * Profiles for the five supported harnesses.
 *
 * Each profile's server shape matches what that tool's own documentation tells a person to write by
 * hand, so an ambit-generated config is indistinguishable from a hand-written one.
 *
 * Skills: Claude Code and Cursor read `.claude/skills`, so both get a link to the shared directory.
 * Codex, VS Code and opencode read `.agents/skills` natively and need no link.
 *
 * Hooks: Claude and VS Code share both the file (`.claude/settings.json`) and its renderer. Codex
 * shares the renderer but not the file (its entries live in `.codex/hooks.json`). Cursor shares
 * neither: its own file, its own event names, its own entry shape. opencode has no declarative hooks;
 * a hook selected for it is reported as skipped (`skippedHooks`, `profile.ts`).
 *
 * How a hook's script is addressed is the one thing no profile decides on its own: every harness reads
 * the file it is handed as user config when it sits under the home directory, and a user-level file has
 * no project to be relative to. See {@link hookRoot}.
 */
import type { ProjectPaths } from "./adapter.js";
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
import { expectedEnv } from "../model/expectation.js";
import type { HookEvent } from "../model/hook-entity.js";

/** Where Claude Code and Cursor look for skills. */
const CLAUDE_SKILLS_LINK = ".claude/skills";

/**
 * Claude Code's hooks file. Also read natively by VS Code.
 *
 * The section is `array`-shaped, not `map`-shaped, because the file is the user's own: their `model`,
 * `permissions`, and hand-written hooks live in it. ambit owns entries inside `hooks.<Event>` by
 * digest, not the `hooks` root.
 */
const CLAUDE_HOOKS: HookLayout = {
  file: ".claude/settings.json",
  section: "hooks",
  format: "json",
  shape: "array",
};

/**
 * Where Claude Code resolves a materialized hook script from, in a project install.
 *
 * `${CLAUDE_PROJECT_DIR}` is Claude's own documented placeholder for referencing hook scripts relative
 * to the project root, regardless of the session's working directory. A relative path cannot promise
 * that.
 *
 * Also written for VS Code, which reads this same file. Whether VS Code interpolates this placeholder
 * is undocumented either way; see {@link vscode}.
 */
const CLAUDE_HOOK_ROOT = `\${CLAUDE_PROJECT_DIR}/${SHARED_HOOKS_DIR}`;

/**
 * Where harnesses with no placeholder resolve a hook script from in a project install: the path as
 * written, project-relative.
 *
 * Cursor and Codex interpolate nothing in a `command`. Cursor documents project hooks as running from
 * the project root, with `./hooks/script.sh` resolving to `<project>/hooks/script.sh`; nothing confines
 * that to `.cursor/`, so a script under `.agents/` resolves the same way.
 *
 * Not Codex's own documented suggestion of `$(git rev-parse --show-toplevel)/…`: that requires git and
 * a POSIX shell. A relative path still misses if a session's cwd is not the project root, but that is
 * the harness's own limitation, the same one a person writing the hook by hand would hit.
 */
const RELATIVE_HOOK_ROOT = SHARED_HOOKS_DIR;

/**
 * Where a hook script is resolved from: `projectScoped` for a project install, the expanded install
 * root for a user-level one.
 *
 * A user-level file is read in every project on the machine, so nothing project-relative can reach the
 * scripts ambit installed. `${CLAUDE_PROJECT_DIR}` and a bare relative path both resolve inside
 * whatever project is open: in one that has no such file the hook silently never runs, and in one that
 * happens to ship `.agents/hooks/<name>/<name>.sh` the harness runs *that* project's script with the
 * user's settings behind it, which would make cloning a repository enough to get code run.
 *
 * Expanded rather than `$HOME/…`: Cursor and Codex interpolate nothing in a `command`, and ambit does
 * not assume a POSIX shell expands one (see {@link RELATIVE_HOOK_ROOT}). The path is therefore
 * machine-specific, which is what a user-level config file is anyway.
 *
 * `/` rather than `path.join`, since this is joined to a `/`-separated artifact path either way, and
 * every shell and harness accepts a forward slash on the platforms ambit runs on.
 */
function hookRoot(project: ProjectPaths, projectScoped: string): string {
  return project.scope === "user" ? `${project.root}/${SHARED_HOOKS_DIR}` : projectScoped;
}

/**
 * One hook, Claude-shaped: an entry in `hooks.<Event>` pairing an optional tool `matcher` with the
 * commands to run.
 *
 * One entry carries one command, because one declaration is one hook; grouping several under one entry
 * would make a digest name a set whose membership changes as other hooks come and go.
 *
 * VS Code reads exactly this shape and ignores `matcher`. Codex reads it too, differing only in
 * `root`, which is why `root` is a parameter here rather than a constant.
 *
 * Key order here is the digest's input, so it is fixed in this one place only.
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
 * Where Codex keeps its hooks: `.codex/hooks.json`, holding Claude's own entry shape.
 *
 * A separate file rather than `[hooks]` in `.codex/config.toml`, which Codex also reads: a TOML
 * `hooks` table is an array-of-tables (`[[hooks.PreToolUse]]`), and the TOML driver refuses that
 * shape. Reaching for `config.toml` would mean a second driver for no benefit, since Codex reads JSON
 * just as well. No `rootDefaults` either, since this file holds hooks and nothing else.
 *
 * Codex's hooks are experimental, gated behind `[features] codex_hooks = true` in the user's own
 * config, which ambit does not write into. `doctor` reports this.
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
 * The only harness that needs a map; Claude, VS Code and Codex read the PascalCase spellings verbatim.
 * Written out rather than derived, because the mapping is a fact about Cursor: the record is total
 * over {@link HookEvent}, so adding an event without a spelling here is a type error.
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
 * Where Cursor keeps its hooks: `.cursor/hooks.json`, with a `version` beside them.
 *
 * `version` is a `rootDefaults` value rather than something the renderer writes, because it belongs to
 * the document, not to an entry: ambit seeds it at 1 when creating the file, and leaves an existing
 * `version: 2` in place unless ambit replaces the whole document.
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
 * Cursor nests nothing (one entry is one command, so there is no inner `hooks` array) and has no field
 * for a tool `matcher`, so a matcher is dropped. Declaring a matcher on an unmatchable event is
 * therefore a parse-time error: a dropped matcher would otherwise install the hook unfiltered rather
 * than not at all, which is the surprising outcome.
 *
 * A shipped script is named project-relative, because Cursor interpolates nothing in a `command`; see
 * {@link RELATIVE_HOOK_ROOT}. `root` is a parameter for the same reason it is one on
 * {@link claudeHook}: a user-level install cannot name a path relative to a project.
 *
 * Key order here is the digest's input, so it is fixed in this one place only.
 */
function cursorHook(hook: MergedHook, root: string): unknown {
  return {
    command: hookCommand(hook, root),
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
  };
}

/**
 * The remote half of a server: its url, with references translated.
 *
 * Every string reaching a config file from the catalog is translated into the syntax the reading
 * harness expands (e.g. a tenant endpoint like `https://${TENANT}.example.com/mcp`), so it is not
 * left as a literal `${TENANT}` in the file.
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
 * `args` also carries `${VAR}` references translated, since a server invoked through a bridge like
 * `mcp-remote` can take its credential as an argument.
 */
function stdio(
  mcp: MergedMcp & { transport: { kind: "stdio" } },
  style: EnvRefStyle,
  envKey = "env",
): Record<string, unknown> {
  const env = envPassthrough(expectedEnv(mcp.expects), style);
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
  hookConfig: (hook, project) => claudeHook(hook, hookRoot(project, CLAUDE_HOOK_ROOT)),
};

/**
 * Cursor. Infers the transport from the presence of `url`, so it wants no `type`.
 *
 * Its hooks live in their own file, under their own event names, in an entry shape unlike Claude's.
 * All three differences are captured here: a layout, a map, and a renderer.
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
  hookConfig: (hook, project) => cursorHook(hook, hookRoot(project, RELATIVE_HOOK_ROOT)),
};

/**
 * VS Code (Copilot). Its section is `servers`, and it wants an explicit `type` on both transports.
 *
 * Uses `${env:VAR}` throughout, including in a stdio server's `env`. VS Code also supports
 * `${input:VAR}`, which prompts the user, but only when the file declares a matching entry in its own
 * `inputs` array; ambit does not write one, so this form is not used.
 *
 * Its hooks are Claude's outright: VS Code reads `.claude/settings.json` natively, so this profile
 * reuses Claude's layout and renderer, including the `${CLAUDE_PROJECT_DIR}` placeholder. That
 * placeholder is undocumented for VS Code specifically: VS Code documents parsing Claude's format and
 * expanding `${CLAUDE_PLUGIN_ROOT}` for Claude-format plugins, but no project-root token, so this may
 * resolve to a literal string rather than a path.
 *
 * Written anyway: a separate spelling would require two entries in one array for one declared hook,
 * and both VS Code and Claude would run it, so every project would see the hook twice. `doctor` is
 * where a harness limitation like this gets surfaced if it turns out to matter.
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
  hookConfig: (hook, project) => claudeHook(hook, hookRoot(project, CLAUDE_HOOK_ROOT)),
};

/**
 * Codex. TOML, and the one harness with a first-class way to keep a credential out of the file.
 *
 * A header whose value is nothing but a `${VAR}` reference becomes `env_http_headers`, naming the
 * variable for Codex to read at spawn time. A header with a variable embedded in a larger string
 * (`Bearer ${TOKEN}`) can't be expressed that way, so it goes in `http_headers` with the reference
 * left for Codex to expand.
 *
 * Its hooks live in `.codex/hooks.json` using Claude's own entry shape, so this profile reuses
 * Claude's renderer; the file itself is Codex's own.
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
  hookConfig: (hook, project) => claudeHook(hook, hookRoot(project, RELATIVE_HOOK_ROOT)),
};

/**
 * opencode. JSONC, `mcp` as its section, and its own vocabulary: `local`/`remote` rather than
 * stdio/http, one `command` array rather than a command and its arguments, and `environment` for the
 * env map.
 *
 * Has no declarative hooks; it runs TypeScript plugins instead, which ambit cannot generate from a
 * declaration. No `hooks` field is set, and a project that selects a hook for opencode is told the
 * hook was skipped.
 */
export const opencode: HarnessProfile = {
  name: "opencode",
  mcp: { file: ".opencode/opencode.jsonc", section: "mcp", format: "jsonc" },
  serverConfig: (mcp) => {
    if (mcp.transport.kind === "stdio") {
      const env = envPassthrough(expectedEnv(mcp.expects), shellRef);
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
