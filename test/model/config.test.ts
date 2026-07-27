/**
 * `ambit.yml` parsing, on top of the shared loader.
 *
 * No command reads config yet, so the malformed cases assert the {@link AmbitError} code the
 * CLI turns into an exit status — exit 2 for every config problem.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HARNESSES,
  findConfigFile,
  loadProjectConfig,
  parseProjectConfig,
} from "../../src/model/config.js";
import { AmbitError, ExitCode } from "../../src/errors.js";

const FILE = "ambit.yml";

/** Parses `text`, asserting it was rejected as a config error (exit 2). */
function rejection(text: string): AmbitError {
  try {
    parseProjectConfig(text, FILE);
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error("expected the config to be rejected");
}

const FULL_CONFIG = `version: 1
harnesses: [claude]

scopes:
  - core
  - function.engineering
  - project.vision-group

catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4"
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main

skills:
  - luma
  - name: readwise-cli
    source: https://github.com/readwiseio/readwise-skills
    path: skills/readwise-cli

mcps:
  - name: custom
    transport:
      stdio:
        command: npx
        args: ["-y", "some-server"]
    env: [SOME_TOKEN]
  - name: remote
    scopes: [function.sales]
    transport:
      http:
        url: https://api.close.com/mcp
        headers:
          Authorization: "Bearer \${CLOSE_API_KEY}"
    env: [CLOSE_API_KEY]

hooks:
  - name: format-on-write
    event: PostToolUse
    matcher: "Edit|Write"
    type: command
    command: npm run format
    timeout: 60
    env: [SOME_TOKEN]
`;

describe("project config", () => {
  it("parses the spec's own example into a typed object", () => {
    expect(parseProjectConfig(FULL_CONFIG, FILE)).toEqual({
      version: 1,
      origin: {
        file: FILE,
        scopeLines: new Map([
          ["core", 5],
          ["function.engineering", 6],
          ["project.vision-group", 7],
        ]),
        skillLines: new Map([
          ["luma", 18],
          ["readwise-cli", 19],
        ]),
        mcpLines: new Map([
          ["custom", 24],
          ["remote", 30],
        ]),
        hookLines: new Map([["format-on-write", 40]]),
      },
      harnesses: ["claude"],
      scopes: ["core", "function.engineering", "project.vision-group"],
      catalogs: [
        { name: "company", source: "git@github.com:acme/skills.git", ref: "a1b2c3d4" },
        { name: "personal", source: "git@github.com:jane/skills-private.git", ref: "main" },
      ],
      skills: [
        { kind: "catalog", name: "luma" },
        {
          kind: "source",
          name: "readwise-cli",
          source: "https://github.com/readwiseio/readwise-skills",
          path: "skills/readwise-cli",
        },
      ],
      mcps: [
        {
          name: "custom",
          scopes: [],
          transport: { kind: "stdio", command: "npx", args: ["-y", "some-server"] },
          env: ["SOME_TOKEN"],
        },
        {
          name: "remote",
          scopes: ["function.sales"],
          transport: {
            kind: "http",
            url: "https://api.close.com/mcp",
            headers: { Authorization: "Bearer ${CLOSE_API_KEY}" },
          },
          env: ["CLOSE_API_KEY"],
        },
      ],
      hooks: [
        {
          name: "format-on-write",
          scopes: [],
          event: "PostToolUse",
          matcher: "Edit|Write",
          type: "command",
          command: "npm run format",
          timeout: 60,
          env: ["SOME_TOKEN"],
        },
      ],
    });
  });

  it("defaults everything but the version", () => {
    expect(parseProjectConfig("version: 1\n", FILE)).toEqual({
      version: 1,
      origin: {
        file: FILE,
        scopeLines: new Map(),
        skillLines: new Map(),
        mcpLines: new Map(),
        hookLines: new Map(),
      },
      harnesses: DEFAULT_HARNESSES,
      scopes: [],
      catalogs: [],
      skills: [],
      mcps: [],
      hooks: [],
    });
  });

  it("records the line each held scope was written on", () => {
    // Resolution rejects an unregistered scope long after this parse, and the error is still expected
    // to name the line, so the positions have to survive parsing.
    const config = parseProjectConfig("version: 1\nscopes:\n  - core\n  - function.sales\n", FILE);

    expect(config.origin).toEqual({
      file: FILE,
      scopeLines: new Map([
        ["core", 3],
        ["function.sales", 4],
      ]),
      skillLines: new Map(),
      mcpLines: new Map(),
      hookLines: new Map(),
    });
  });

  it("records the line each `skills` and `mcps` entry was written on", () => {
    // The same reason scopes carry theirs: an explicit skill no catalog provides is
    // rejected long after this parse, and the error still has to name the line.
    const config = parseProjectConfig(
      [
        "version: 1",
        "skills:",
        "  - house-style",
        "  - name: two",
        "    source: path:../two",
        "mcps:",
        "  - name: three",
        "    transport:",
        "      stdio:",
        "        command: three-mcp",
        "",
      ].join("\n"),
      FILE,
    );

    expect(config.origin.skillLines).toEqual(
      new Map([
        ["house-style", 3],
        ["two", 4],
      ]),
    );
    expect(config.origin.mcpLines).toEqual(new Map([["three", 7]]));
  });

  it("records the line each `hooks` entry was written on", () => {
    const config = parseProjectConfig(
      [
        "version: 1",
        "hooks:",
        "  - name: one",
        "    event: SessionStart",
        "    type: command",
        "    command: one.sh",
        "  - name: two",
        "    event: Stop",
        "    type: command",
        "    command: two.sh",
        "",
      ].join("\n"),
      FILE,
    );

    expect(config.origin.hookLines).toEqual(
      new Map([
        ["one", 3],
        ["two", 7],
      ]),
    );
  });

  it("keeps the first line of a scope listed twice", () => {
    const config = parseProjectConfig("version: 1\nscopes:\n  - core\n  - core\n", FILE);

    expect(config.origin.scopeLines.get("core")).toBe(3);
  });

  it("keeps held scopes exactly as listed, adding nothing", () => {
    // Spec §2: nothing is implicit. A config that forgets `core` gets no `core`.
    const config = parseProjectConfig("version: 1\nscopes: [function.sales]\n", FILE);

    expect(config.scopes).toEqual(["function.sales"]);
  });

  it("reads an empty scopes list as selecting nothing", () => {
    expect(parseProjectConfig("version: 1\nscopes: []\n", FILE).scopes).toEqual([]);
  });

  it("omits an absent catalog ref rather than inventing one", () => {
    const config = parseProjectConfig(
      "version: 1\ncatalogs:\n  - name: company\n    source: acme/skills\n",
      FILE,
    );

    expect(config.catalogs[0]).toEqual({ name: "company", source: "acme/skills" });
    expect(Object.keys(config.catalogs[0]!)).not.toContain("ref");
  });

  it("keeps catalogs in config order, since the first wins a collision", () => {
    const config = parseProjectConfig(
      "version: 1\ncatalogs:\n  - name: b\n    source: x/b\n  - name: a\n    source: x/a\n",
      FILE,
    );

    expect(config.catalogs.map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  describe("rejections", () => {
    it("rejects an unknown top-level key", () => {
      const error = rejection("version: 1\nscope:\n  - core\n");

      expect(error.format()).toContain(`unknown key "scope" (${FILE} line 2)`);
      expect(error.format()).toContain(
        "accepted keys: catalogs, harnesses, hooks, mcps, scopes, skills, version",
      );
    });

    it("requires a version", () => {
      expect(rejection("scopes: [core]\n").format()).toContain('missing required key "version"');
    });

    it("rejects a version it does not understand", () => {
      const error = rejection("version: 2\n");

      expect(error.format()).toContain(`unsupported config version 2 (${FILE} line 1)`);
      expect(error.format()).toContain("set `version: 1`, or upgrade ambit");
    });

    it("rejects a numeric ref rather than stringifying it", () => {
      const error = rejection(
        "version: 1\ncatalogs:\n  - name: company\n    source: acme/skills\n    ref: 1234567\n",
      );

      expect(error.format()).toContain(`"catalogs[0].ref" must be a string (${FILE} line 5)`);
      expect(error.format()).toContain('quote it: `ref: "1234567"`');
    });

    it("rejects two catalogs with the same name, naming both lines", () => {
      const error = rejection(
        "version: 1\ncatalogs:\n  - name: c\n    source: a/b\n  - name: c\n    source: c/d\n",
      );

      expect(error.format()).toContain(`duplicate catalog name "c" (${FILE} line 5)`);
      expect(error.format()).toContain("first declared on line 3");
    });

    it("rejects an unknown key inside a catalog entry", () => {
      expect(
        rejection(
          "version: 1\ncatalogs:\n  - name: c\n    source: a/b\n    branch: main\n",
        ).format(),
      ).toContain('unknown key "catalogs[0].branch"');
    });

    it("rejects two `skills` entries naming the same skill, naming both lines", () => {
      // Resolution looks each name up once, so a repeat is never a merge — and a bare name beside
      // a mapping for the same name is two answers to which source provides it.
      const error = rejection(
        "version: 1\nskills:\n  - a.b\n  - name: a.b\n    source: path:../a\n",
      );

      expect(error.format()).toContain(`duplicate skills entry "a.b" (${FILE} line 4)`);
      expect(error.format()).toContain("first declared on line 3");
    });

    it("rejects two `mcps` entries defining the same server", () => {
      const error = rejection(
        [
          "version: 1",
          "mcps:",
          "  - name: x",
          "    transport:",
          "      stdio:",
          "        command: one",
          "  - name: x",
          "    transport:",
          "      stdio:",
          "        command: two",
          "",
        ].join("\n"),
      );

      expect(error.format()).toContain(`duplicate mcps entry "x" (${FILE} line 7)`);
      expect(error.format()).toContain("define each server once");
    });

    it("rejects two `hooks` entries defining the same hook", () => {
      const error = rejection(
        [
          "version: 1",
          "hooks:",
          "  - name: x",
          "    event: SessionStart",
          "    type: command",
          "    command: one.sh",
          "  - name: x",
          "    event: Stop",
          "    type: command",
          "    command: two.sh",
          "",
        ].join("\n"),
      );

      expect(error.format()).toContain(`duplicate hooks entry "x" (${FILE} line 7)`);
      expect(error.format()).toContain("define each hook once");
    });

    it("rejects an inline hook that says it ships a script, which it has nowhere to put", () => {
      // The one hook rule this surface adds of its own: `type: script` is legal in a catalog and
      // impossible here, because the script lives in a directory `ambit.yml` does not have.
      const error = rejection(
        "version: 1\nhooks:\n  - name: x\n    event: Stop\n    type: script\n    command: guard.sh\n",
      );

      expect(error.format()).toContain(
        `hook "x" cannot ship a script from ${FILE} (${FILE} line 5)`,
      );
      expect(error.format()).toContain(
        "say `type: command`, or move the hook into a catalog at `hooks/<name>/HOOK.yml`",
      );
    });

    it("names the `hooks` entry's key path when the hook itself is malformed", () => {
      // The entity parser is shared with `HOOK.yml`, so the only thing this surface adds is where
      // in the config the offending value sits.
      expect(
        rejection("version: 1\nhooks:\n  - name: x\n    event: Stop\n    type: command\n").format(),
      ).toContain('missing required key "hooks[0].command"');
    });

    it("rejects an unknown hook event, listing the supported set", () => {
      const error = rejection(
        "version: 1\nhooks:\n  - name: x\n    event: OnSave\n    type: command\n    command: x.sh\n",
      );

      expect(error.format()).toContain(`unknown hook event "OnSave" (${FILE} line 4)`);
      expect(error.format()).toContain("supported events: SessionStart");
    });

    it("rejects an unknown key inside a skill entry", () => {
      expect(
        rejection(
          "version: 1\nskills:\n  - name: s\n    source: a/b\n    dir: skills/s\n",
        ).format(),
      ).toContain('unknown key "skills[0].dir"');
    });

    it("requires a source on a mapping skill entry", () => {
      expect(rejection("version: 1\nskills:\n  - name: s\n").format()).toContain(
        'missing required key "skills[0].source"',
      );
    });

    it("rejects a transport naming no kind", () => {
      const error = rejection("version: 1\nmcps:\n  - name: x\n    transport: {}\n");

      expect(error.format()).toContain("`transport` names no transport kind");
      expect(error.format()).toContain("supported kinds: http, stdio");
    });

    it("rejects a transport naming two kinds", () => {
      const error = rejection(
        [
          "version: 1",
          "mcps:",
          "  - name: x",
          "    transport:",
          "      stdio:",
          "        command: npx",
          "      http:",
          "        url: https://x.invalid",
          "",
        ].join("\n"),
      );

      expect(error.format()).toContain("`transport` names 2 transport kinds: http, stdio");
    });

    it("rejects an unrecognized transport kind", () => {
      const error = rejection(
        "version: 1\nmcps:\n  - name: x\n    transport:\n      sse:\n        url: https://x.invalid\n",
      );

      expect(error.format()).toContain('unknown transport kind "sse"');
    });

    it("requires a command for a stdio transport", () => {
      expect(
        rejection("version: 1\nmcps:\n  - name: x\n    transport:\n      stdio: {}\n").format(),
      ).toContain('missing required key "mcps[0].transport.stdio.command"');
    });
  });

  /**
   * The §3.0 rules reach `ambit.yml` through the shared loader. Asserted here too, because a
   * config is the document a person hand-writes and so the one these mistakes land in.
   */
  describe("YAML rules, as seen from a config", () => {
    const CASES: readonly [label: string, text: string, expected: RegExp][] = [
      [
        "a duplicate key",
        "version: 1\nscopes: [a]\nscopes: [b]\n",
        /duplicate key "scopes" \(ambit\.yml line 3\)/,
      ],
      [
        "tab indentation",
        "version: 1\nharnesses:\n\t- claude\n",
        /tabs for indentation \(ambit\.yml line 3\)/,
      ],
      [
        "a custom tag",
        "version: 1\nscopes: !!python/object []\n",
        /custom YAML tag .* \(ambit\.yml line 2\)/,
      ],
      ["an empty document", "", /ambit\.yml is empty/],
      ["a non-mapping root", "- version: 1\n", /root is not a mapping \(ambit\.yml line 1\)/],
      [
        "an unknown key",
        "version: 1\nharness: claude\n",
        /unknown key "harness" \(ambit\.yml line 2\)/,
      ],
      ["an explicit null", "version: null\n", /"version" must not be null \(ambit\.yml line 1\)/],
      [
        "a ref that parsed as a number",
        "version: 1\ncatalogs:\n  - name: c\n    source: a/b\n    ref: 1234567\n",
        /"catalogs\[0\]\.ref" must be a string \(ambit\.yml line 5\)/,
      ],
    ];

    for (const [label, text, expected] of CASES) {
      it(`exits 2 on ${label}, naming the problem and its line`, () => {
        expect(rejection(text).format()).toMatch(expected);
      });
    }
  });

  describe("config discovery", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "ambit-config-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("loads ambit.yml", async () => {
      await writeFile(path.join(dir, "ambit.yml"), "version: 1\nscopes: [core]\n", "utf8");

      expect(await findConfigFile(dir)).toEqual({
        path: path.join(dir, "ambit.yml"),
        file: "ambit.yml",
      });
      expect((await loadProjectConfig(dir)).scopes).toEqual(["core"]);
    });

    it("accepts ambit.yaml", async () => {
      await writeFile(path.join(dir, "ambit.yaml"), "version: 1\nscopes: [core]\n", "utf8");

      expect((await findConfigFile(dir)).file).toBe("ambit.yaml");
      expect((await loadProjectConfig(dir)).scopes).toEqual(["core"]);
    });

    it("refuses to guess when both exist", async () => {
      await writeFile(path.join(dir, "ambit.yml"), "version: 1\n", "utf8");
      await writeFile(path.join(dir, "ambit.yaml"), "version: 1\n", "utf8");

      await expect(loadProjectConfig(dir)).rejects.toMatchObject({
        code: ExitCode.Config,
        message: "ambit.yml and ambit.yaml both exist in " + dir,
      });
    });

    it("reports a project with no config", async () => {
      await expect(loadProjectConfig(dir)).rejects.toMatchObject({
        code: ExitCode.Config,
        message: `no ambit config in ${dir}`,
      });
    });

    it("names the file it actually read in errors", async () => {
      await writeFile(path.join(dir, "ambit.yaml"), "version: 1\nscopes: core\n", "utf8");

      const error = await loadProjectConfig(dir).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(AmbitError);
      expect((error as AmbitError).format()).toContain(
        '"scopes" must be a sequence of strings (ambit.yaml line 2)',
      );
    });
  });
});
