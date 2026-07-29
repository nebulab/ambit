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

/** One `requires` entry, for the cases about which file was read rather than about what it said. */
const ONE_ENTRY = 'requires: [{ name: "c/core", capabilities: [skills] }]\n';

const ONE_ENTRY_PARSED = {
  field: "name",
  pattern: "core",
  catalog: "c",
  capabilities: ["skills"],
};

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

requires:
  - tag: "company/function.engineering"
    capabilities: [skills, mcps, hooks]
  - name: "company/core.*"
    capabilities: [skills]
  - name: "personal/luma"
    capabilities: [skills]

catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4"
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main
`;

describe("project config", () => {
  it("parses the spec's own example into a typed object", () => {
    expect(parseProjectConfig(FULL_CONFIG, FILE)).toEqual({
      version: 1,
      origin: {
        file: FILE,
        entryLines: new Map([
          ['- { tag: "company/function.engineering", capabilities: [skills, mcps, hooks] }', 5],
          ['- { name: "company/core.*", capabilities: [skills] }', 7],
          ['- { name: "personal/luma", capabilities: [skills] }', 9],
        ]),
      },
      harnesses: ["claude"],
      catalogs: [
        { name: "company", source: "git@github.com:acme/skills.git", ref: "a1b2c3d4" },
        { name: "personal", source: "git@github.com:jane/skills-private.git", ref: "main" },
      ],
      requires: [
        {
          field: "tag",
          pattern: "function.engineering",
          catalog: "company",
          capabilities: ["skills", "mcps", "hooks"],
        },
        { field: "name", pattern: "core.*", catalog: "company", capabilities: ["skills"] },
        { field: "name", pattern: "luma", catalog: "personal", capabilities: ["skills"] },
      ],
    });
  });

  it("defaults everything but the version", () => {
    expect(parseProjectConfig("version: 1\n", FILE)).toEqual({
      version: 1,
      origin: { file: FILE, entryLines: new Map() },
      harnesses: DEFAULT_HARNESSES,
      catalogs: [],
      requires: [],
    });
  });

  it("records the line each `requires` entry was written on", () => {
    // Resolution rejects an entry that matches nothing long after this parse, and the error is still
    // expected to name the line, so the positions have to survive parsing.
    const config = parseProjectConfig(
      ["version: 1", "requires:", "  - { tag: c/core, capabilities: [skills] }", ""].join("\n"),
      FILE,
    );

    expect(config.origin).toEqual({
      file: FILE,
      entryLines: new Map([['- { tag: "c/core", capabilities: [skills] }', 3]]),
    });
  });

  it("keys the lines by the whole entry, so two that differ only in capabilities keep both", () => {
    // `formatEntry` drops the capability list, and these two entries agree on everything it keeps —
    // yet they sit on separate lines, and a refusal about either has to name its own.
    const config = parseProjectConfig(
      [
        "version: 1",
        "requires:",
        "  - { tag: c/core, capabilities: [skills] }",
        "  - { tag: c/core, capabilities: [hooks] }",
        "",
      ].join("\n"),
      FILE,
    );

    expect(config.origin.entryLines).toEqual(
      new Map([
        ['- { tag: "c/core", capabilities: [skills] }', 3],
        ['- { tag: "c/core", capabilities: [hooks] }', 4],
      ]),
    );
  });

  it("keeps the first line of an entry written twice, and the entry once", () => {
    const config = parseProjectConfig(
      [
        "version: 1",
        "requires:",
        "  - { tag: c/core, capabilities: [skills] }",
        "  - { tag: c/core, capabilities: [skills] }",
        "",
      ].join("\n"),
      FILE,
    );

    expect(config.requires).toHaveLength(1);
    expect(config.origin.entryLines.get('- { tag: "c/core", capabilities: [skills] }')).toBe(3);
  });

  it("keeps the entries exactly as listed, adding nothing", () => {
    // Spec §2: nothing is implicit. A config that selects one thing selects one thing.
    const config = parseProjectConfig(
      'version: 1\nrequires: [{ tag: "c/function.sales", capabilities: [skills] }]\n',
      FILE,
    );

    expect(config.requires).toEqual([
      { field: "tag", pattern: "function.sales", catalog: "c", capabilities: ["skills"] },
    ]);
  });

  it("reads an empty requires list as selecting nothing", () => {
    expect(parseProjectConfig("version: 1\nrequires: []\n", FILE).requires).toEqual([]);
  });

  it("omits an absent catalog ref rather than inventing one", () => {
    const config = parseProjectConfig(
      "version: 1\ncatalogs:\n  - name: company\n    source: acme/skills\n",
      FILE,
    );

    expect(config.catalogs[0]).toEqual({ name: "company", source: "acme/skills" });
    expect(Object.keys(config.catalogs[0]!)).not.toContain("ref");
  });

  it("keeps catalogs in config order, which is what the config says and nothing more", () => {
    const config = parseProjectConfig(
      "version: 1\ncatalogs:\n  - name: b\n    source: x/b\n  - name: a\n    source: x/a\n",
      FILE,
    );

    expect(config.catalogs.map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  describe("rejections", () => {
    it("rejects an unknown top-level key", () => {
      const error = rejection("version: 1\nrequire:\n  - core\n");

      expect(error.format()).toContain(`unknown key "require" (${FILE} line 2)`);
      expect(error.format()).toContain("accepted keys: catalogs, harnesses, requires, version");
    });

    it("requires a version", () => {
      expect(rejection("harnesses: [claude]\n").format()).toContain(
        'missing required key "version"',
      );
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

    it("rejects a `requires` entry that declares no capabilities", () => {
      // The grammar's own refusals are `pattern.test.ts`'s; this is the claim that a project config
      // reads its `requires` through them rather than through a second, looser parser.
      expect(rejection('version: 1\nrequires: [{ tag: "c/core" }]\n').format()).toContain(
        '`requires` entry "c/core" declares no capabilities',
      );
    });

    it("rejects a `requires` address that names no catalog", () => {
      const error = rejection('version: 1\nrequires: [{ tag: "core", capabilities: [skills] }]\n');

      expect(error.format()).toContain('`requires` entry "core" names no catalog');
      expect(error.format()).toContain("qualify it: `<catalog>/core`");
    });
  });

  /**
   * The three forms that used to put a definition in `ambit.yml` itself.
   *
   * Every one of them is a hard break with no compatibility reader, so the refusal *is* the migration
   * path — which means each message has to carry both halves of the move: the file the definition goes
   * into, and the `catalogs:` entry that makes the file reachable.
   */
  describe("inline definitions, refused", () => {
    it("refuses a top-level `mcps`, naming the file and the catalog entry", () => {
      const error = rejection(
        "version: 1\nmcps:\n  - name: x\n    transport:\n      stdio:\n        command: npx\n",
      );

      expect(error.format()).toContain(`top-level \`mcps\` is gone (${FILE} line 2)`);
      expect(error.format()).toContain(
        "an MCP server is defined by a file of its own: move each entry to `mcps/<name>.yml`",
      );
      expect(error.format()).toContain(
        "then list this project as a catalog: `- name: local` with `source: path:.`",
      );
    });

    it("refuses a top-level `hooks`, naming the file and the catalog entry", () => {
      const error = rejection(
        "version: 1\nhooks:\n  - name: x\n    event: Stop\n    type: command\n    command: x.sh\n",
      );

      expect(error.format()).toContain(`top-level \`hooks\` is gone (${FILE} line 2)`);
      expect(error.format()).toContain(
        "a hook is defined by a file of its own: move each entry to `hooks/<name>/HOOK.yml`",
      );
      expect(error.format()).toContain(
        "then list this project as a catalog: `- name: local` with `source: path:.`",
      );
    });

    it("refuses them ahead of the unknown-key check, which would call one a typo", () => {
      // `mcps` is not in the accepted set any more, so `rejectUnknownKeys` would fire first and say
      // the wrong thing — that the key is misspelled, rather than that its contents moved.
      expect(rejection("version: 1\nmcps: []\n").format()).not.toContain("unknown key");
    });
  });

  /**
   * The two keys a project used to select with.
   *
   * Both are a hard break with no compatibility reader, so the refusal *is* the migration path —
   * which means it has to carry the rewrite per line, not merely announce that the key is gone. The
   * catalog alias is in the same file, so the printed entry is the one the reader can paste.
   */
  describe("the deleted selection keys, refused", () => {
    const CATALOGS = "catalogs:\n  - name: company\n    source: acme/skills\n";

    it("refuses a top-level `scopes`, naming the entry each held scope becomes", () => {
      const error = rejection(
        `version: 1\n${CATALOGS}scopes:\n  - core\n  - function.engineering\n`,
      );

      expect(error.format()).toContain(`top-level \`scopes\` is gone (${FILE} line 5)`);
      expect(error.format()).toContain(
        'line 6: `core` becomes `- { tag: "company/core", capabilities: [skills, mcps, hooks] }`',
      );
      expect(error.format()).toContain(
        'line 7: `function.engineering` becomes `- { tag: "company/function.engineering", capabilities: [skills, mcps, hooks] }`',
      );
      // The subtree rule went with the key, and a pattern says so explicitly, so a faithful rewrite
      // of one held scope is two entries.
      expect(error.format()).toContain("also reached every tag beneath it");
      expect(error.format()).toContain("rename the key to `requires`");
    });

    it("refuses a top-level `skills`, naming the name entry each becomes", () => {
      const error = rejection(`version: 1\n${CATALOGS}skills:\n  - house-style\n`);

      expect(error.format()).toContain(`top-level \`skills\` is gone (${FILE} line 5)`);
      expect(error.format()).toContain(
        'line 6: `house-style` becomes `- { name: "company/house-style", capabilities: [skills] }`',
      );
      // A name entry says nothing about a subtree, so nothing about one is suggested.
      expect(error.format()).not.toContain("beneath it");
    });

    it("stands in for the alias when the config declares more than one catalog", () => {
      // A held scope reached every catalog at once; which of several an entry should now name is the
      // reader's call, and proposing one would be a guess.
      const error = rejection(
        [
          "version: 1",
          "catalogs:",
          "  - name: company",
          "    source: acme/skills",
          "  - name: personal",
          "    source: jane/skills",
          "scopes: [core]",
          "",
        ].join("\n"),
      );

      expect(error.format()).toContain(
        '`core` becomes `- { tag: "<catalog>/core", capabilities: [skills, mcps, hooks] }`',
      );
      expect(error.format()).toContain(
        "qualifying each entry with the alias it should select from",
      );
    });

    it("still names the rewrite when `catalogs` is malformed, rather than reporting that first", () => {
      // The alias is a courtesy in this message; a broken `catalogs:` is refused on its own terms
      // once the removed key is gone.
      expect(rejection("version: 1\ncatalogs: nope\nscopes: [core]\n").format()).toContain(
        "top-level `scopes` is gone",
      );
    });

    it("refuses them ahead of the unknown-key check, which would call one a typo", () => {
      expect(rejection("version: 1\nscopes: []\n").format()).not.toContain("unknown key");
      expect(rejection("version: 1\nskills: []\n").format()).not.toContain("unknown key");
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
        "version: 1\nrequires: [a]\nrequires: [b]\n",
        /duplicate key "requires" \(ambit\.yml line 3\)/,
      ],
      [
        "tab indentation",
        "version: 1\nharnesses:\n\t- claude\n",
        /tabs for indentation \(ambit\.yml line 3\)/,
      ],
      [
        "a custom tag",
        "version: 1\nrequires: !!python/object []\n",
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
      await writeFile(path.join(dir, "ambit.yml"), `version: 1\n${ONE_ENTRY}`, "utf8");

      expect(await findConfigFile(dir)).toEqual({
        path: path.join(dir, "ambit.yml"),
        file: "ambit.yml",
      });
      expect((await loadProjectConfig(dir)).requires).toEqual([ONE_ENTRY_PARSED]);
    });

    it("accepts ambit.yaml", async () => {
      await writeFile(path.join(dir, "ambit.yaml"), `version: 1\n${ONE_ENTRY}`, "utf8");

      expect((await findConfigFile(dir)).file).toBe("ambit.yaml");
      expect((await loadProjectConfig(dir)).requires).toEqual([ONE_ENTRY_PARSED]);
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
      await writeFile(path.join(dir, "ambit.yaml"), "version: 1\nrequires: core\n", "utf8");

      const error = await loadProjectConfig(dir).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(AmbitError);
      expect((error as AmbitError).format()).toContain(
        '"requires" must be a sequence of strings or mappings (ambit.yaml line 2)',
      );
    });
  });
});
