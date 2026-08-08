/**
 * Hook entity parsing.
 *
 * One shape, one place it can be written: `hooks/<name>/hook.yml` in a catalog. A project that defines
 * a hook of its own lists itself as a catalog and puts it there, so this parser has one caller and no
 * variant to reconcile.
 */
import type { Expectation } from "./expectation.js";
import { parseExpectations } from "./expectation.js";
import type { YamlMapping } from "./yaml.js";

/**
 * The events with a real mapping in two or more harnesses, in the order reports list them.
 *
 * These use Claude's PascalCase spellings as the neutral vocabulary. Codex and VS Code use them
 * verbatim, so only Cursor needs a mapping; a new, fourth spelling would mean every harness needs one.
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
 * Declared rather than derived. `guard.sh` (a shipped script) and `prettier` (a program on `PATH`)
 * are not distinguishable by looking, so the author must say which. Guessing from whether the first
 * token carries a `/` or a `.` was tried and got `python3.11` and `node hook.js` wrong.
 */
export const HOOK_TYPES = ["command", "script"] as const;

export type HookType = (typeof HOOK_TYPES)[number];

export interface HookEntity {
  readonly name: string;
  /** Carried into reports. */
  readonly description?: string;
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
   * each harness's own reference syntax. A hook command runs in a shell the harness spawns, so
   * `${VAR}` already expands correctly there, and ambit does not parse the shell fragment to
   * translate it.
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
 * `./guard.sh` and `guard.sh` name the same file; the leading `./` is optional under
 * `type: script` and stripped here so one spelling reaches disk. That lets the existence check
 * look for exactly what the rewrite later writes.
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
 * Shape only. Whether the file actually exists is checked by the catalog, not this parser. Refused
 * here: an absolute path, and one climbing out through `..` — neither can be inside the hook's
 * directory under any contents. An empty `command` cannot reach this check, since `requireString`
 * already refuses it.
 *
 * Under an earlier derivation these were silently reclassified as command lines, so
 * `command: /usr/bin/guard.sh` on a hook meant to ship a script installed a hook pointing outside
 * the catalog instead. They are refused now; the fix is `type: command`.
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
 * @param mapping the entity's mapping — a whole `hooks/<name>/hook.yml` document, or one item of
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
    event,
    ...(matcher !== undefined && { matcher }),
    type,
    command,
    ...(timeout !== undefined && { timeout }),
    expects: parseExpectations(mapping),
  };
}
