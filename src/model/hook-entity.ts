/**
 * Hook entity parsing.
 *
 * The same shape appears in two places — `hooks/<name>/HOOK.yml` in a catalog, and inline `hooks`
 * entries in `ambit.yml` — so one parser serves both.
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

export interface HookEntity {
  readonly name: string;
  /** Carried into reports. */
  readonly description?: string;
  /** Declared scopes. Empty means reachable only via `requires` or an explicit listing. */
  readonly scopes: readonly string[];
  readonly event: HookEvent;
  /** Tool-name filter. Only ever set on one of {@link MATCHABLE_EVENTS}. */
  readonly matcher?: string;
  /**
   * Either a bare command line, or a path to a file inside the hook's own directory. Which of the
   * two it is, is derived from what the catalog holds rather than declared, so this is an opaque
   * string here.
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
] as const;

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
  const timeout = mapping.optionalInteger("timeout");

  return {
    name,
    ...(description !== undefined && { description }),
    scopes: mapping.optionalStringList("scopes") ?? [],
    event,
    ...(matcher !== undefined && { matcher }),
    command: mapping.requireString("command"),
    ...(timeout !== undefined && { timeout }),
    env: mapping.optionalStringList("env") ?? [],
  };
}
