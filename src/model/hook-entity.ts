/**
 * Hook entity parsing.
 *
 * The same shape appears in two places — `hooks/<name>/HOOK.yml` in a catalog, and inline `hooks`
 * entries in `ambit.yml` — so one parser serves both, told which surface it is reading by a
 * {@link HookOrigin}. That is the only thing the two disagree about: what a `type: script` path is
 * anchored to, and so how a message about one is worded. Every field means the same thing on either.
 */
import type { YamlMapping } from "./yaml.js";

/**
 * The events with a real mapping in two or more harnesses, in the order reports list them.
 *
 * Claude's PascalCase spellings are the neutral vocabulary rather than a Claude detail: Codex and
 * VS Code use them verbatim, so only Cursor needs a map, and inventing a fourth spelling would
 * leave every harness needing one.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The events a `matcher` means anything for. */
export const MATCHABLE_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/**
 * What a hook's `command` is: a command line, or a path to a file that has to be anchored before a
 * harness can find it.
 *
 * Declared rather than derived. The two kinds are not distinguishable by looking: `guard.sh` is a
 * script a hook ships and `prettier` is a program on the `PATH`, and nothing about either string says
 * which. Asking the author is the only way to know, and the alternative — guessing from whether the
 * first token carries a `/` or a `.` — got `python3.11` wrong in one direction and `node hook.js` in
 * the other, the second one silently.
 */
export const HOOK_TYPES = ["command", "script"] as const;

export type HookType = (typeof HOOK_TYPES)[number];

/**
 * Which surface a hook was written on — the one thing that changes what a `type: script` path means.
 *
 * - `catalog` — `hooks/<name>/HOOK.yml`. The script is a file the hook's own directory ships, named
 *   relative to it, and ambit materializes it to `.agents/hooks/<name>/`.
 * - `project` — a `hooks` entry in `ambit.yml`. The script is a file the consuming repo already holds,
 *   named relative to the project root. Nothing is materialized and nothing is owned: the bytes are
 *   already at a stable location, pinned by that repo's own history.
 *
 * Both are `type: script` — a file, not a command line — so the declaration says the same thing on
 * either surface and the parser is one function. What differs is only what the path is anchored to,
 * which is why this is the parser's single parameter rather than a second entity shape.
 */
export const HOOK_ORIGINS = ["catalog", "project"] as const;

export type HookOrigin = (typeof HOOK_ORIGINS)[number];

export interface HookEntity {
  readonly name: string;
  /** Carried into reports. */
  readonly description?: string;
  /** Declared scopes. Empty means reachable only via `requires` or an explicit listing. */
  readonly scopes: readonly string[];
  readonly event: HookEvent;
  /** Tool-name filter. Only ever set on one of {@link MATCHABLE_EVENTS}. */
  readonly matcher?: string;
  /** How to read {@link command}. */
  readonly type: HookType;
  /**
   * What the hook runs, read according to {@link type}: a command line the harness executes as
   * written, or a path to a script, followed by any arguments. A script's path is relative to whatever
   * holds it — the hook's own directory in a catalog, the project root in `ambit.yml` — which is the
   * {@link HookOrigin} the document was parsed under.
   *
   * `${VAR}` references are left intact, unlike an MCP transport's, where ambit rewrites them into
   * each harness's own reference syntax. A hook command is executed by a shell the harness spawns,
   * so `${VAR}` already means the right thing in the one place it can appear, and translating it
   * would be ambit rewriting a shell fragment it does not parse.
   */
  readonly command: string;
  /** Seconds. Rendered where the harness has a field for it. */
  readonly timeout?: number;
  /** Env vars this hook needs. */
  readonly env: readonly string[];
}

const ENTITY_KEYS = [
  "command",
  "description",
  "env",
  "event",
  "matcher",
  "name",
  "scopes",
  "timeout",
  "type",
] as const;

/**
 * The program a `command` runs: its first whitespace-separated token.
 *
 * For a `script` hook this is the shipped file, and everything after it is arguments — a shell
 * fragment ambit does not parse and must not rewrite. So `guard.sh --strict` ships `guard.sh` and
 * passes `--strict` through untouched.
 */
export function commandProgram(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * The file a `script` hook's program names, as the directory it is anchored to holds it.
 *
 * `./guard.sh` and `guard.sh` name the same file — the `./` is a person being explicit about a path,
 * which under `type: script` they no longer have to be. Dropped here so one spelling reaches disk,
 * which is what lets the existence check look for exactly what the rewrite later writes.
 */
export function scriptReference(program: string): string {
  return program.startsWith("./") ? program.slice(2) : program;
}

function parseEvent(mapping: YamlMapping): HookEvent {
  const event = mapping.requireString("event");

  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    throw mapping.keyError("event", `unknown hook event "${event}"`, [
      `supported events: ${HOOK_EVENTS.join(", ")}`,
      `replace \`${event}\` with one of them`,
    ]);
  }

  return event as HookEvent;
}

/**
 * A `matcher` filters on a tool name, so on an event that carries no tool it selects nothing.
 * Declaring it there is an error rather than a value quietly dropped on the way to the harness.
 */
function parseMatcher(mapping: YamlMapping, event: HookEvent): string | undefined {
  const matcher = mapping.optionalString("matcher");

  if (matcher !== undefined && !(MATCHABLE_EVENTS as readonly string[]).includes(event)) {
    throw mapping.keyError("matcher", `\`matcher\` is not meaningful for ${event}`, [
      `it filters on a tool name, so it applies to: ${MATCHABLE_EVENTS.join(", ")}`,
      "remove `matcher`, or declare the hook on one of those events",
    ]);
  }

  return matcher;
}

/**
 * How each surface says what a `type: script` is, in the three messages that have to name it.
 *
 * Written out per origin rather than composed from a directory name, because the sentences are about
 * *whose* file the script is — the hook's, or the repo's — and that is the distinction a reader has to
 * take away. Each field is used exactly once, in the message its name gives.
 */
const SCRIPT_WORDING: Readonly<
  Record<HookOrigin, { readonly inside: string; readonly summary: string; readonly hint: string }>
> = {
  catalog: {
    inside: "the hook",
    summary: "a file the hook's own directory ships",
    hint: "a script is a file the hook's own directory ships, named relative to it — `guard.sh`, `bin/guard.sh`",
  },
  project: {
    inside: "the project",
    summary: "a file the project itself holds",
    hint: "a script is a file this repo holds, named relative to the project root — `scripts/guard.sh`",
  },
};

function parseType(mapping: YamlMapping, origin: HookOrigin): HookType {
  const type = mapping.requireString("type");

  if (!(HOOK_TYPES as readonly string[]).includes(type)) {
    throw mapping.keyError("type", `unknown hook type "${type}"`, [
      `\`command\` runs a command line as written; \`script\` runs ${SCRIPT_WORDING[origin].summary}`,
      `replace \`${type}\` with one of them`,
    ]);
  }

  return type as HookType;
}

/**
 * Rejects a `type: script` whose `command` cannot name a file inside the directory it is anchored to.
 *
 * Shape only — whether the file is actually there is a question for whoever holds the directory, and
 * neither holder can be asked here: a catalog answers it when the catalog is read, and a project's own
 * working tree answers it in `doctor`. What is refused here is a reference that could not be inside
 * either under any contents: an absolute path, and one climbing out through `..`. An empty one cannot
 * reach this at all, because `requireString` has already refused a blank `command`.
 *
 * Under the old derivation these were silently reclassified as command lines, which is how
 * `command: /usr/bin/guard.sh` on a hook that meant to ship one installed a hook pointing at a file
 * outside the catalog. Now they are refused, and the fix is to say `type: command`.
 */
function assertScriptReference(mapping: YamlMapping, command: string, origin: HookOrigin): void {
  const reference = scriptReference(commandProgram(command));

  const problem = reference.startsWith("/")
    ? "it is an absolute path"
    : reference.split("/").includes("..")
      ? "it climbs out through `..`"
      : undefined;

  if (problem === undefined) return;

  throw mapping.keyError(
    "command",
    `\`type: script\` needs a path inside ${SCRIPT_WORDING[origin].inside}, and ${problem}`,
    [SCRIPT_WORDING[origin].hint, "to run something else, say `type: command` instead"],
  );
}

/**
 * Parses one hook entity.
 *
 * @param mapping the entity's mapping — a whole `hooks/<name>/HOOK.yml` document, or one item of
 *   `ambit.yml`'s `hooks` list.
 * @param origin which of those two it is, which decides what a `type: script` path is relative to —
 *   see {@link HOOK_ORIGINS}. Required rather than defaulted: a hook parsed under the wrong anchor is
 *   a command pointing at the wrong file, and nothing downstream could notice.
 * @throws {AmbitError} exit 2 for any shape violation.
 */
export function parseHookEntity(mapping: YamlMapping, origin: HookOrigin): HookEntity {
  mapping.rejectUnknownKeys(ENTITY_KEYS);

  const name = mapping.requireString("name");
  const description = mapping.optionalString("description");
  const event = parseEvent(mapping);
  const matcher = parseMatcher(mapping, event);
  const type = parseType(mapping, origin);
  const command = mapping.requireString("command");
  const timeout = mapping.optionalInteger("timeout");

  if (type === "script") assertScriptReference(mapping, command, origin);

  return {
    name,
    ...(description !== undefined && { description }),
    scopes: mapping.optionalStringList("scopes") ?? [],
    event,
    ...(matcher !== undefined && { matcher }),
    type,
    command,
    ...(timeout !== undefined && { timeout }),
    env: mapping.optionalStringList("env") ?? [],
  };
}
