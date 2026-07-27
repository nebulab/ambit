/**
 * Hook entity parsing.
 *
 * The same shape appears in two places — `hooks/<name>/HOOK.yml` in a catalog, and inline `hooks`
 * entries in `ambit.yml` — so one parser serves both.
 */
import type { Expectation } from "./expectation.js";
import { parseExpectations } from "./expectation.js";
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
 * What a hook's `command` is, which decides whether ambit rewrites it and ships bytes beside it.
 *
 * Declared rather than derived. The two kinds are not distinguishable by looking: `guard.sh` is a
 * script a hook ships and `prettier` is a program on the `PATH`, and nothing about either string says
 * which. Asking the author is the only way to know, and the alternative — guessing from whether the
 * first token carries a `/` or a `.` — got `python3.11` wrong in one direction and `node hook.js` in
 * the other, the second one silently.
 */
export const HOOK_TYPES = ["command", "script"] as const;

export type HookType = (typeof HOOK_TYPES)[number];

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
   * written, or a path — relative to the hook's own directory — to a script the hook ships, followed
   * by any arguments.
   *
   * `${VAR}` references are left intact, unlike an MCP transport's, where ambit rewrites them into
   * each harness's own reference syntax. A hook command is executed by a shell the harness spawns,
   * so `${VAR}` already means the right thing in the one place it can appear, and translating it
   * would be ambit rewriting a shell fragment it does not parse.
   */
  readonly command: string;
  /** Seconds. Rendered where the harness has a field for it. */
  readonly timeout?: number;
  /** What must be true of the world for this hook to work — what its command reads, today. */
  readonly expects: readonly Expectation[];
}

const ENTITY_KEYS = [
  "command",
  "description",
  "event",
  "expects",
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
 * The file a `script` hook's program names, as its own directory holds it.
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

function parseType(mapping: YamlMapping): HookType {
  const type = mapping.requireString("type");

  if (!(HOOK_TYPES as readonly string[]).includes(type)) {
    throw mapping.keyError("type", `unknown hook type "${type}"`, [
      "`command` runs a command line as written; `script` runs a file the hook's own directory ships",
      `replace \`${type}\` with one of them`,
    ]);
  }

  return type as HookType;
}

/**
 * Rejects a `type: script` whose `command` cannot name a file inside the hook's own directory.
 *
 * Shape only — whether the file is actually there is a question for whoever holds the directory, and
 * an inline hook holds none. What is refused here is a reference that could not be inside it under any
 * contents: an absolute path, and one climbing out through `..`. An empty one cannot reach this at all,
 * because `requireString` has already refused a blank `command`.
 *
 * Under the old derivation these were silently reclassified as command lines, which is how
 * `command: /usr/bin/guard.sh` on a hook that meant to ship one installed a hook pointing at a file
 * outside the catalog. Now they are refused, and the fix is to say `type: command`.
 */
function assertScriptReference(mapping: YamlMapping, command: string): void {
  const reference = scriptReference(commandProgram(command));

  const problem = reference.startsWith("/")
    ? "it is an absolute path"
    : reference.split("/").includes("..")
      ? "it climbs out through `..`"
      : undefined;

  if (problem === undefined) return;

  throw mapping.keyError(
    "command",
    `\`type: script\` needs a path inside the hook, and ${problem}`,
    [
      "a script is a file the hook's own directory ships, named relative to it — `guard.sh`, `bin/guard.sh`",
      "to run something else, say `type: command` instead",
    ],
  );
}

/**
 * Parses one hook entity.
 *
 * @param mapping the entity's mapping — a whole `hooks/<name>/HOOK.yml` document, or one item of
 *   `ambit.yml`'s `hooks` list.
 * @throws {AmbitError} exit 2 for any shape violation.
 */
export function parseHookEntity(mapping: YamlMapping): HookEntity {
  mapping.rejectUnknownKeys(ENTITY_KEYS);

  const name = mapping.requireString("name");
  const description = mapping.optionalString("description");
  const event = parseEvent(mapping);
  const matcher = parseMatcher(mapping, event);
  const type = parseType(mapping);
  const command = mapping.requireString("command");
  const timeout = mapping.optionalInteger("timeout");

  if (type === "script") assertScriptReference(mapping, command);

  return {
    name,
    ...(description !== undefined && { description }),
    scopes: mapping.optionalStringList("scopes") ?? [],
    event,
    ...(matcher !== undefined && { matcher }),
    type,
    command,
    ...(timeout !== undefined && { timeout }),
    expects: parseExpectations(mapping),
  };
}
