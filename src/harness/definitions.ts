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
 */
import type { HarnessProfile } from "./profile.js";
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

/** Where Claude Code and Cursor look for skills. */
const CLAUDE_SKILLS_LINK = ".claude/skills";

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
};

/** Cursor. Infers the transport from the presence of `url`, so it wants no `type`. */
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
};

/**
 * VS Code (Copilot). Its section is `servers`, and it wants an explicit `type` on both transports.
 *
 * `${env:VAR}` throughout, including in a stdio server's `env`. VS Code also has `${input:VAR}`, which
 * prompts the user — but only when the file declares a matching entry in its own `inputs` array, which
 * ambit does not write. Emitting one without the other would reference a prompt that does not exist.
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
