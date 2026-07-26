/**
 * Hook entity parsing, on top of the shared loader.
 *
 * Nothing reads a hook yet, so the malformed cases assert the {@link AmbitError} code the CLI
 * turns into an exit status — exit 2 for every config problem.
 */
import { describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import { HOOK_EVENTS, MATCHABLE_EVENTS, parseHookEntity } from "../../src/model/hook-entity.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const FILE = "hooks/block-rm/HOOK.yml";

function parse(text: string) {
  return parseHookEntity(parseYamlMapping(text, FILE));
}

/** Parses `text`, asserting it was rejected as a config error (exit 2). */
function rejection(text: string): AmbitError {
  try {
    parse(text);
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error("expected the hook to be rejected");
}

describe("hook entity", () => {
  it("reads every field", () => {
    expect(
      parse(
        [
          "name: block-rm",
          "description: Refuses a destructive rm before it runs",
          "scopes: [function.engineering, core]",
          "event: PreToolUse",
          "matcher: Bash",
          "command: hook.sh",
          "timeout: 30",
          "env: [SOME_TOKEN]",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      name: "block-rm",
      description: "Refuses a destructive rm before it runs",
      scopes: ["function.engineering", "core"],
      event: "PreToolUse",
      matcher: "Bash",
      command: "hook.sh",
      timeout: 30,
      env: ["SOME_TOKEN"],
    });
  });

  it("defaults every optional field, and omits the ones that have no default", () => {
    const hook = parse("name: greet\nevent: SessionStart\ncommand: echo hi\n");

    expect(hook).toEqual({
      name: "greet",
      scopes: [],
      event: "SessionStart",
      command: "echo hi",
      env: [],
    });
    expect(hook).not.toHaveProperty("description");
    expect(hook).not.toHaveProperty("matcher");
    expect(hook).not.toHaveProperty("timeout");
  });

  it("accepts every event it publishes", () => {
    for (const event of HOOK_EVENTS) {
      expect(parse(`name: h\nevent: ${event}\ncommand: run\n`).event).toBe(event);
    }
  });

  it("accepts a matcher on every matchable event", () => {
    for (const event of MATCHABLE_EVENTS) {
      expect(parse(`name: h\nevent: ${event}\nmatcher: Bash\ncommand: run\n`).matcher).toBe("Bash");
    }
  });

  it("takes `command` as an opaque string", () => {
    // Whether it names a script the hook ships is derived from the catalog, not from the string,
    // and a `${VAR}` reference is the shell's to expand rather than ambit's to rewrite.
    expect(parse("name: h\nevent: Stop\ncommand: ${AMBIT_BIN} --write\n").command).toBe(
      "${AMBIT_BIN} --write",
    );
  });

  it("rejects an unknown event, naming the supported set", () => {
    const error = rejection("name: h\nevent: PostToolUsage\ncommand: run\n");

    expect(error.format()).toBe(
      [
        `error: unknown hook event "PostToolUsage" (${FILE} line 2)`,
        "       supported events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, PreCompact, SessionEnd",
        "       replace `PostToolUsage` with one of them",
      ].join("\n"),
    );
  });

  it("rejects a matcher on an event that carries no tool name", () => {
    const error = rejection("name: h\nevent: SessionStart\nmatcher: Bash\ncommand: run\n");

    expect(error.format()).toContain(
      `error: \`matcher\` is not meaningful for SessionStart (${FILE} line 3)`,
    );
    expect(error.format()).toContain(
      "it filters on a tool name, so it applies to: PreToolUse, PostToolUse",
    );
  });

  it("requires a name", () => {
    expect(rejection("event: Stop\ncommand: run\n").format()).toContain(
      'missing required key "name"',
    );
  });

  it("requires an event", () => {
    expect(rejection("name: h\ncommand: run\n").format()).toContain('missing required key "event"');
  });

  it("requires a command", () => {
    expect(rejection("name: h\nevent: Stop\n").format()).toContain(
      'missing required key "command"',
    );
  });

  it("requires a whole-number timeout", () => {
    expect(rejection("name: h\nevent: Stop\ncommand: run\ntimeout: 1.5\n").format()).toContain(
      '"timeout" must be an integer',
    );
  });

  it("rejects an unknown key", () => {
    const error = rejection("name: h\nevent: Stop\ncommand: run\nmatchers: Bash\n");

    expect(error.format()).toContain('unknown key "matchers"');
    expect(error.format()).toContain(
      "accepted keys: command, description, env, event, matcher, name, scopes, timeout",
    );
  });
});
