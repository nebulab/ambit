/**
 * Hook entity parsing, on top of the shared loader.
 *
 * Nothing reads a hook yet, so the malformed cases assert the {@link AmbitError} code the CLI
 * turns into an exit status — exit 2 for every config problem.
 */
import { describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import type { HookOrigin } from "../../src/model/hook-entity.js";
import { HOOK_EVENTS, MATCHABLE_EVENTS, parseHookEntity } from "../../src/model/hook-entity.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const FILE = "hooks/block-rm/HOOK.yml";

/**
 * Parses one document as a catalog hook — the surface every case below is about unless it says
 * otherwise, since `ambit.yml`'s own additions are `test/model/config.test.ts`'s subject.
 */
function parse(text: string, origin: HookOrigin = "catalog") {
  return parseHookEntity(parseYamlMapping(text, FILE), origin);
}

/** Parses `text`, asserting it was rejected as a config error (exit 2). */
function rejection(text: string, origin: HookOrigin = "catalog"): AmbitError {
  try {
    parse(text, origin);
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
          "type: script",
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
      type: "script",
      command: "hook.sh",
      timeout: 30,
      env: ["SOME_TOKEN"],
    });
  });

  it("defaults every optional field, and omits the ones that have no default", () => {
    const hook = parse("name: greet\nevent: SessionStart\ntype: command\ncommand: echo hi\n");

    expect(hook).toEqual({
      name: "greet",
      scopes: [],
      event: "SessionStart",
      type: "command",
      command: "echo hi",
      env: [],
    });
    expect(hook).not.toHaveProperty("description");
    expect(hook).not.toHaveProperty("matcher");
    expect(hook).not.toHaveProperty("timeout");
  });

  it("accepts every event it publishes", () => {
    for (const event of HOOK_EVENTS) {
      expect(parse(`name: h\nevent: ${event}\ntype: command\ncommand: run\n`).event).toBe(event);
    }
  });

  it("accepts a matcher on every matchable event", () => {
    for (const event of MATCHABLE_EVENTS) {
      expect(
        parse(`name: h\nevent: ${event}\nmatcher: Bash\ntype: command\ncommand: run\n`).matcher,
      ).toBe("Bash");
    }
  });

  it("takes a `command` type's `command` as an opaque string", () => {
    // `type` already said what it is, so nothing is read off the string — and a `${VAR}` reference
    // is the shell's to expand rather than ambit's to rewrite.
    expect(
      parse("name: h\nevent: Stop\ntype: command\ncommand: ${AMBIT_BIN} --write\n").command,
    ).toBe("${AMBIT_BIN} --write");
  });

  it("accepts a script whose name reads like a bare program, which no derivation could", () => {
    // The declaration is the whole answer: `guard` ships as `guard`, with no extension to read and
    // no list of script extensions for ambit to keep current.
    expect(parse("name: h\nevent: Stop\ntype: script\ncommand: guard\n").command).toBe("guard");
  });

  it("accepts a script handed to an interpreter, with the script first and the rest arguments", () => {
    // The failure the old derivation had no answer for: `node hook.js` classified on `node`, which
    // is a bare word, so the hook installed as a command line and never found its own file.
    expect(parse("name: h\nevent: Stop\ntype: script\ncommand: hook.js --strict\n").command).toBe(
      "hook.js --strict",
    );
  });

  it("rejects an unknown event, naming the supported set", () => {
    const error = rejection("name: h\nevent: PostToolUsage\ntype: command\ncommand: run\n");

    expect(error.format()).toBe(
      [
        `error: unknown hook event "PostToolUsage" (${FILE} line 2)`,
        "       supported events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, PreCompact, SessionEnd",
        "       replace `PostToolUsage` with one of them",
      ].join("\n"),
    );
  });

  it("rejects a matcher on an event that carries no tool name", () => {
    const error = rejection(
      "name: h\nevent: SessionStart\nmatcher: Bash\ntype: command\ncommand: run\n",
    );

    expect(error.format()).toContain(
      `error: \`matcher\` is not meaningful for SessionStart (${FILE} line 3)`,
    );
    expect(error.format()).toContain(
      "it filters on a tool name, so it applies to: PreToolUse, PostToolUse",
    );
  });

  it("requires a name", () => {
    expect(rejection("event: Stop\ntype: command\ncommand: run\n").format()).toContain(
      'missing required key "name"',
    );
  });

  it("requires an event", () => {
    expect(rejection("name: h\ntype: command\ncommand: run\n").format()).toContain(
      'missing required key "event"',
    );
  });

  it("requires a command", () => {
    expect(rejection("name: h\nevent: Stop\ntype: command\n").format()).toContain(
      'missing required key "command"',
    );
  });

  it("requires a type, because nothing else says how to read `command`", () => {
    expect(rejection("name: h\nevent: Stop\ncommand: guard.sh\n").format()).toContain(
      'missing required key "type"',
    );
  });

  it("rejects an unknown type, naming both", () => {
    const error = rejection("name: h\nevent: Stop\ntype: shell\ncommand: run\n");

    expect(error.format()).toBe(
      [
        `error: unknown hook type "shell" (${FILE} line 3)`,
        "       `command` runs a command line as written; `script` runs a file the hook's own directory ships",
        "       replace `shell` with one of them",
      ].join("\n"),
    );
  });

  it("requires a whole-number timeout", () => {
    expect(
      rejection("name: h\nevent: Stop\ntype: command\ncommand: run\ntimeout: 1.5\n").format(),
    ).toContain('"timeout" must be an integer');
  });

  it("rejects an unknown key", () => {
    const error = rejection("name: h\nevent: Stop\ntype: command\ncommand: run\nmatchers: Bash\n");

    expect(error.format()).toContain('unknown key "matchers"');
    expect(error.format()).toContain(
      "accepted keys: command, description, env, event, matcher, name, scopes, timeout, type",
    );
  });

  /**
   * Shape alone — whether the file is there is a question for whoever holds it: the catalog, when it is
   * read, or the project's own working tree, in `doctor`. What these three have in common is that no
   * directory contents could make them legal, which is why the parser can refuse them without looking.
   *
   * Under the old derivation each of these was silently reclassified as a command line, so a hook
   * meaning to ship a script installed pointing somewhere else entirely.
   */
  describe("a `type: script` whose command cannot be a path inside the hook", () => {
    it("rejects an absolute path", () => {
      const error = rejection("name: h\nevent: Stop\ntype: script\ncommand: /usr/bin/guard\n");

      expect(error.format()).toContain(
        "`type: script` needs a path inside the hook, and it is an absolute path",
      );
      expect(error.format()).toContain("to run something else, say `type: command` instead");
    });

    it("rejects one climbing out through `..`", () => {
      expect(
        rejection("name: h\nevent: Stop\ntype: script\ncommand: ../shared/guard.sh\n").format(),
      ).toContain("it climbs out through `..`");
    });

    it("accepts `./` and a nested path, which are both inside it", () => {
      expect(parse("name: h\nevent: Stop\ntype: script\ncommand: ./guard.sh\n").command).toBe(
        "./guard.sh",
      );
      expect(parse("name: h\nevent: Stop\ntype: script\ncommand: bin/guard.sh\n").command).toBe(
        "bin/guard.sh",
      );
    });
  });

  /**
   * The one thing the origin decides: what a `type: script` path is anchored to.
   *
   * The same two shapes are refused either way — an absolute path and one climbing out are outside both
   * a hook directory and a project — but the message has to name the anchor a reader is meant to write
   * from, since "inside the hook" is no help to someone editing `ambit.yml` and "inside the project" is
   * wrong for a catalog. Everything else about the entity is origin-blind, which is why one parser
   * serves both surfaces.
   */
  describe("parsed as a project's own hook", () => {
    it("takes a path from the project root, deeper than a hook directory would go", () => {
      expect(
        parse("name: h\nevent: Stop\ntype: script\ncommand: scripts/hooks/guard.sh\n", "project")
          .command,
      ).toBe("scripts/hooks/guard.sh");
    });

    it("anchors its refusals to the project, and points at a project-relative script", () => {
      const error = rejection(
        "name: h\nevent: Stop\ntype: script\ncommand: /usr/bin/guard\n",
        "project",
      );

      expect(error.format()).toContain(
        "`type: script` needs a path inside the project, and it is an absolute path",
      );
      expect(error.format()).toContain(
        "a script is a file this repo holds, named relative to the project root — `scripts/guard.sh`",
      );
    });

    it("still refuses one climbing out of the project through `..`", () => {
      expect(
        rejection(
          "name: h\nevent: Stop\ntype: script\ncommand: ../shared/guard.sh\n",
          "project",
        ).format(),
      ).toContain("it climbs out through `..`");
    });

    it("describes `script` as the project's own file when the type is unknown", () => {
      // The hint has to describe the surface being edited: told a script is "a file the hook's own
      // directory ships", someone writing `ambit.yml` would conclude they cannot have one.
      expect(
        rejection("name: h\nevent: Stop\ntype: shell\ncommand: run\n", "project").format(),
      ).toBe(
        [
          `error: unknown hook type "shell" (${FILE} line 3)`,
          "       `command` runs a command line as written; `script` runs a file the project itself holds",
          "       replace `shell` with one of them",
        ].join("\n"),
      );
    });
  });
});
