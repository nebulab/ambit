/**
 * Environment variables in harness configs.
 *
 * A catalog writes `${VAR}` in an MCP entity's headers, and lists in `env` the variables a server
 * needs. ambit does **not** resolve either into the config file it writes. It translates them into
 * the reference syntax the target harness expands at spawn time — `${VAR}` for Claude Code and Codex,
 * `${env:VAR}` for Cursor and VS Code, `{env:VAR}` for opencode — and leaves the value in the
 * environment where it lives.
 *
 * That is a deliberate reversal of the obvious design. Writing the resolved value would put a live
 * credential into `.mcp.json`, a file ambit does not gitignore because teams legitimately commit it;
 * one `git add -A` later the token is in history. Writing a reference cannot leak, is what every
 * harness's own documentation tells people to write by hand, and makes the installed config identical
 * on every machine — so two people resolving the same bundle get byte-identical files, and `ambit
 * status` never reports drift just because someone else's shell holds a different token.
 *
 * The cost is that ambit can no longer tell from the file whether a variable is set. `ambit doctor`
 * answers that by reading the environment directly, which is where the answer actually is.
 */

/**
 * A `${VAR}` reference as a catalog writes it.
 *
 * Anchored to the shell-variable character set, so a `${...}` meaning something else in some other
 * syntax is left alone rather than rewritten into a variable reference.
 */
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** How one harness spells a reference to an environment variable in its own config. */
export type EnvRefStyle = (name: string) => string;

/** Claude Code and Codex: plain shell syntax. */
export const shellRef: EnvRefStyle = (name) => `\${${name}}`;

/** Cursor and VS Code. */
export const namespacedRef: EnvRefStyle = (name) => `\${env:${name}}`;

/** opencode. */
export const bracedRef: EnvRefStyle = (name) => `{env:${name}}`;

/**
 * Rewrites every `${VAR}` in a value into the harness's own reference syntax.
 *
 * A no-op for the harnesses whose syntax already *is* `${VAR}`, which is why the catalog's spelling is
 * the shell one: the common case costs nothing and reads as what it means.
 */
export function translateRefs(value: string, style: EnvRefStyle): string {
  return value.replaceAll(ENV_PLACEHOLDER, (_match, name: string) => style(name));
}

/** Every variable a value references, in first-appearance order. */
export function referencedNames(value: string): readonly string[] {
  return [...value.matchAll(ENV_PLACEHOLDER)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The variable a value is *entirely* one reference to, if it is.
 *
 * Codex takes a header whose value is a bare variable reference as `env_http_headers`, naming the
 * variable rather than embedding it — so this is what distinguishes a header it can express that way
 * from one that has to be written literally.
 */
export function soleReference(value: string): string | undefined {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  return match?.[1];
}

/**
 * The env map a stdio server is given, so the harness passes the variables through to the process.
 *
 * Every name the entity declared in `env`, mapped to a reference the harness expands. Returns
 * `undefined` for an empty list so a caller can leave the key out entirely rather than writing one
 * carrying nothing.
 */
export function envPassthrough(
  names: readonly string[],
  style: EnvRefStyle,
): Readonly<Record<string, string>> | undefined {
  if (names.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const name of [...names].sort()) env[name] = style(name);
  return env;
}
