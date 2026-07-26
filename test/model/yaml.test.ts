/**
 * The shared YAML loader. Every rule here exists because the alternative is silent
 * corruption, so each one is asserted to fail loudly — with the exit code, the offending
 * identifier, and the line.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import {
  YamlMapping,
  emitYaml,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
} from "../../src/model/yaml.js";

/** Runs `body`, asserting it rejected the document as a config error (exit 2). */
function rejection(body: () => unknown): AmbitError {
  let result: unknown;
  try {
    result = body();
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
}

const FILE = "sample.yml";

function load(text: string) {
  return parseYamlMapping(text, FILE);
}

describe("YAML loader", () => {
  it("reads a mapping into positioned, typed accessors", () => {
    const root = load(
      ["version: 1", "name: acme", "scopes:", "  - core", "  - function.engineering", ""].join("\n"),
    );

    expect(root.file).toBe(FILE);
    expect(root.keys()).toEqual(["version", "name", "scopes"]);
    expect(root.requireInteger("version")).toBe(1);
    expect(root.requireString("name")).toBe("acme");
    expect(root.optionalStringList("scopes")).toEqual(["core", "function.engineering"]);
    expect(root.lineOf("scopes")).toBe(3);
  });

  it("treats an absent key as absent, not as a value", () => {
    const root = load("version: 1\n");

    expect(root.has("scopes")).toBe(false);
    expect(root.optionalString("scopes")).toBeUndefined();
    expect(root.optionalStringList("scopes")).toBeUndefined();
    expect(root.optionalMapping("scopes")).toBeUndefined();
    expect(root.optionalMappingList("scopes")).toBeUndefined();
    expect(root.optionalEntryList("scopes")).toBeUndefined();
  });

  it("distinguishes an empty sequence from an absent one", () => {
    expect(load("scopes: []\n").optionalStringList("scopes")).toEqual([]);
  });

  it("pairs each sequence item with its own line, block style and flow style alike", () => {
    // A rule enforced after parsing has no node left to point at, so the position has to come
    // out of the document with the value.
    expect(
      load("scopes:\n  - core\n  - function.engineering\n").optionalPositionedStringList("scopes"),
    ).toEqual([
      { value: "core", line: 2 },
      { value: "function.engineering", line: 3 },
    ]);
    expect(load("version: 1\nscopes: [core]\n").optionalPositionedStringList("scopes")).toEqual([
      { value: "core", line: 2 },
    ]);
  });

  it("rejects a duplicate key, naming both lines", () => {
    const error = rejection(() => load("version: 1\nscopes:\n  - core\nscopes:\n  - other\n"));

    expect(error.format()).toContain(`duplicate key "scopes" (${FILE} line 4)`);
    expect(error.format()).toContain("first defined on line 2");
  });

  it("rejects tabs used for indentation", () => {
    const error = rejection(() => load("version: 1\nharnesses:\n\t- claude\n"));

    expect(error.format()).toContain(
      `YAML does not permit tabs for indentation (${FILE} line 3)`,
    );
  });

  it("rejects custom tags, shorthand and local alike", () => {
    expect(rejection(() => load("version: 1\nthing: !!python/object:x {}\n")).format()).toContain(
      "custom YAML tag `!!python/object:x` is not permitted (sample.yml line 2)",
    );
    expect(rejection(() => load("thing: !mine value\n")).format()).toContain(
      "custom YAML tag `!mine` is not permitted (sample.yml line 1)",
    );
  });

  it("accepts the core schema's own tags", () => {
    expect(load('ref: !!str 1234567\n').requireString("ref")).toBe("1234567");
  });

  it("rejects an empty document rather than reading it as an empty mapping", () => {
    expect(rejection(() => load("")).format()).toContain(`${FILE} is empty`);
    expect(rejection(() => load("# just a comment\n")).format()).toContain(`${FILE} is empty`);
  });

  it("rejects a document whose root is not a mapping", () => {
    expect(rejection(() => load("- core\n- other\n")).format()).toContain(
      `root is not a mapping (${FILE} line 1)`,
    );
    expect(rejection(() => load("hello\n")).format()).toContain("found a string at the document root");
  });

  it("rejects a non-string mapping key", () => {
    const error = rejection(() => load("version: 1\n1: two\n"));

    expect(error.format()).toContain(`mapping keys must be strings (${FILE} line 2)`);
  });

  it("reports a syntax error with its line", () => {
    const error = rejection(() => load("version: 1\n  bad: indentation\n"));

    expect(error.format()).toMatch(new RegExp(`invalid YAML \\(${FILE} line \\d+\\)`));
  });

  describe("string values", () => {
    it("rejects a number where a string is required, quoting the original text", () => {
      const error = rejection(() => load("ref: 1234567\n").requireString("ref"));

      expect(error.format()).toContain(`"ref" must be a string (${FILE} line 1)`);
      expect(error.format()).toContain("YAML parsed `1234567` as a number");
      expect(error.format()).toContain('quote it: `ref: "1234567"`');
    });

    it("suggests the fix in the form it was written, not the parsed value", () => {
      // `1e5` parses to 100000; suggesting `ref: "100000"` would point at a different commit.
      expect(rejection(() => load("ref: 1e5\n").requireString("ref")).format()).toContain(
        'quote it: `ref: "1e5"`',
      );
    });

    it("rejects a boolean where a string is required", () => {
      expect(rejection(() => load("name: true\n").requireString("name")).format()).toContain(
        "YAML parsed `true` as a boolean",
      );
    });

    it("rejects an empty string", () => {
      expect(rejection(() => load('name: ""\n').requireString("name")).format()).toContain(
        `"name" must not be empty (${FILE} line 1)`,
      );
    });

    it("names sequence items by index and suggests a pastable fix", () => {
      const error = rejection(() => load("scopes:\n  - 1234\n").optionalStringList("scopes"));

      expect(error.format()).toContain(`"scopes[0]" must be a string (${FILE} line 2)`);
      expect(error.format()).toContain('quote it: `- "1234"`');
    });
  });

  describe("required and null values", () => {
    it("reports a missing required key", () => {
      const error = rejection(() => load("scopes: [core]\n").requireString("name"));

      expect(error.format()).toContain(`missing required key "name" (${FILE} line 1)`);
      expect(error.format()).toContain("add `name:` with a value");
    });

    it("rejects an explicit null where a value is required", () => {
      const error = rejection(() => load("version: null\n").requireInteger("version"));

      expect(error.format()).toContain(`"version" must not be null (${FILE} line 1)`);
      expect(error.format()).toContain("give it a value");
    });

    it("rejects an explicit null on an optional key, pointing at omission instead", () => {
      const error = rejection(() => load("scopes: ~\n").optionalStringList("scopes"));

      expect(error.format()).toContain(`"scopes" must not be null (${FILE} line 1)`);
      expect(error.format()).toContain("remove the key to take its default");
    });

    it("rejects a key written with no value at all", () => {
      expect(rejection(() => load("name:\n").requireString("name")).format()).toContain(
        `"name" must not be null (${FILE} line 1)`,
      );
    });
  });

  describe("unknown keys", () => {
    it("rejects them, listing what is accepted", () => {
      const error = rejection(() => load("version: 1\nscope: core\n").rejectUnknownKeys(["scopes", "version"]));

      expect(error.format()).toContain(`unknown key "scope" (${FILE} line 2)`);
      expect(error.format()).toContain("accepted keys: scopes, version");
    });

    it("labels a nested unknown key by its path", () => {
      const error = rejection(() =>
        load("transport:\n  stdio:\n    cmd: npx\n")
          .requireMapping("transport")
          .requireMapping("stdio")
          .rejectUnknownKeys(["args", "command"]),
      );

      expect(error.format()).toContain('unknown key "transport.stdio.cmd"');
    });
  });

  describe("structured values", () => {
    it("reads nested mappings, keeping the path for errors", () => {
      const root = load("transport:\n  http:\n    url: https://acme.invalid/mcp\n");
      const http = root.requireMapping("transport").requireMapping("http");

      expect(http.requireString("url")).toBe("https://acme.invalid/mcp");
      expect(rejection(() => http.requireString("method")).format()).toContain(
        '"transport.http.method"',
      );
    });

    it("reads a free-form string map", () => {
      const headers = load('headers:\n  Authorization: "Bearer ${TOKEN}"\n  X-Trace: "1"\n')
        .requireMapping("headers")
        .stringEntries();

      expect(headers).toEqual({ Authorization: "Bearer ${TOKEN}", "X-Trace": "1" });
    });

    it("reads a list of mappings, indexing the path", () => {
      const catalogs = load("catalogs:\n  - name: one\n  - name: two\n").optionalMappingList(
        "catalogs",
      );

      expect(catalogs?.map((entry) => entry.requireString("name"))).toEqual(["one", "two"]);
      expect(rejection(() => catalogs![1]!.requireString("source")).format()).toContain(
        '"catalogs[1].source"',
      );
    });

    it("rejects a non-mapping in a list of mappings", () => {
      const error = rejection(() => load("catalogs:\n  - acme/skills\n").optionalMappingList("catalogs"));

      expect(error.format()).toContain(`"catalogs[0]" must be a mapping (${FILE} line 2)`);
    });

    it("reads a list of strings or mappings, positioning the bare names", () => {
      const entries = load("skills:\n  - acme.one\n  - name: two\n").optionalEntryList("skills");

      expect(entries?.[0]).toEqual({ value: "acme.one", line: 2 });
      expect(entries?.[1]).toBeInstanceOf(YamlMapping);
    });

    it("rejects an entry that is neither a string nor a mapping", () => {
      const error = rejection(() => load("skills:\n  - [nested]\n").optionalEntryList("skills"));

      expect(error.format()).toContain(`"skills[0]" must be a string or a mapping (${FILE} line 2)`);
    });

    it("rejects a scalar where a sequence belongs", () => {
      const error = rejection(() => load("scopes: core\n").optionalStringList("scopes"));

      expect(error.format()).toContain(`"scopes" must be a sequence of strings (${FILE} line 1)`);
    });

    it("rejects a scalar where a mapping belongs", () => {
      expect(rejection(() => load("transport: stdio\n").requireMapping("transport")).format()).toContain(
        `"transport" must be a mapping (${FILE} line 1)`,
      );
    });
  });

  describe("integers", () => {
    it("rejects a string that looks like one", () => {
      expect(rejection(() => load('version: "1"\n').requireInteger("version")).format()).toContain(
        `"version" must be an integer (${FILE} line 1)`,
      );
    });

    it("rejects a non-integer number", () => {
      expect(rejection(() => load("version: 1.5\n").requireInteger("version")).format()).toContain(
        "found a number",
      );
    });
  });

  describe("frontmatter", () => {
    const DOC = "SKILL.md";

    function frontmatter(text: string) {
      return parseFrontmatterMapping(text, DOC);
    }

    it("parses the block under the same rules as a file", () => {
      const root = frontmatter(
        ["---", "name: acme.sales.use-close", "scopes: [function.sales]", "---", "", "# Close", ""].join("\n"),
      );

      expect(root.keys()).toEqual(["name", "scopes"]);
      expect(root.requireString("name")).toBe("acme.sales.use-close");
      expect(root.optionalStringList("scopes")).toEqual(["function.sales"]);
    });

    it("reports lines of the document, not of the block", () => {
      // The reader is told a line number to go to, so it has to be the document's own.
      const text = ["---", "name: acme.a", "ref: 1e5", "---", "body", ""].join("\n");

      expect(rejection(() => frontmatter(text).requireString("ref")).format()).toContain(
        `(${DOC} line 3)`,
      );
    });

    it("applies every §3.0 rule to the block", () => {
      const duplicate = ["---", "name: a", "name: b", "---", ""].join("\n");
      expect(rejection(() => frontmatter(duplicate)).message).toBe(
        `duplicate key "name" (${DOC} line 3)`,
      );

      const tabbed = ["---", "scopes:", "\t- core", "---", ""].join("\n");
      expect(rejection(() => frontmatter(tabbed)).message).toContain("does not permit tabs");
    });

    it("rejects a document with no block", () => {
      expect(rejection(() => frontmatter("# Close\n")).message).toBe(
        `${DOC} has no frontmatter block`,
      );
    });

    it("rejects a block holding nothing", () => {
      for (const text of ["---\n---\n", "---\n\n---\n", "---\n# only a comment\n---\n"]) {
        expect(rejection(() => frontmatter(text)).message).toBe(
          `${DOC} has an empty frontmatter block`,
        );
      }
    });

    it("rejects a non-mapping block", () => {
      expect(rejection(() => frontmatter("---\n- core\n---\n")).message).toContain(
        "root is not a mapping",
      );
    });

    it("rejects a language tag naming anything but YAML", () => {
      expect(rejection(() => frontmatter('---json\n{"name": "a"}\n---\n')).message).toBe(
        `${DOC} declares its frontmatter as "json"`,
      );
      expect(rejection(() => frontmatter('---toml\nname = "a"\n---\n')).message).toBe(
        `cannot read the frontmatter of ${DOC}`,
      );
    });

    it("reads a file and names it as asked in errors", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ambit-frontmatter-"));
      try {
        const target = path.join(dir, "SKILL.md");
        await writeFile(target, "---\nname: acme.a\n---\n", "utf8");

        expect((await readFrontmatterMapping(target, DOC)).file).toBe(DOC);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("readYamlMapping", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "ambit-yaml-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads a file and names it as asked in errors", async () => {
      const target = path.join(dir, "scopes.yml");
      await writeFile(target, "scopes:\n  core: {}\n", "utf8");

      const root = await readYamlMapping(target, "scopes.yml");

      expect(root.file).toBe("scopes.yml");
      expect(root.keys()).toEqual(["scopes"]);
    });

    it("reports an unreadable file as a config error", async () => {
      const missing = path.join(dir, "absent.yml");

      await expect(readYamlMapping(missing, "absent.yml")).rejects.toMatchObject({
        code: ExitCode.Config,
        message: "cannot read absent.yml",
      });
    });
  });
});

/**
 * The emit half of §3.0. The rules are about *bytes*, not about meaning, because the two artifacts
 * that use them — `ambit.lock` and the `init` scaffold — are diffed and compared as text. So each
 * test asserts the exact output rather than that it re-parses.
 */
describe("YAML emitter", () => {
  it("sorts keys at every depth, whatever order they were built in", () => {
    expect(emitYaml({ version: 1, catalogs: { personal: { source: "b" }, company: { source: "a" } } })).toBe(
      ["catalogs:", "  company:", "    source: a", "  personal:", "    source: b", "version: 1", ""].join("\n"),
    );
  });

  it("quotes a string a core-schema parser would otherwise read as a number", () => {
    // The trap §3.0 names: an all-digit commit SHA, and a ref like `1e5`. Both must come back as
    // the strings they went in as, or the lock pins a different commit than the one installed.
    const text = emitYaml({ commit: "1234567", ref: "1e5", count: 12 });

    expect(text).toBe('commit: "1234567"\ncount: 12\nref: "1e5"\n');
    const parsed = load(text);
    expect(parsed.requireString("commit")).toBe("1234567");
    expect(parsed.requireString("ref")).toBe("1e5");
    expect(parsed.requireInteger("count")).toBe(12);
  });

  it("writes no anchor for two entries that happen to hold equal values", () => {
    const shared = { catalog: "company" };

    expect(emitYaml({ a: shared, b: shared })).toBe(
      "a:\n  catalog: company\nb:\n  catalog: company\n",
    );
  });

  it("keeps a long value on its own line rather than wrapping it", () => {
    const url = `https://example.invalid/${"a".repeat(200)}`;

    expect(emitYaml({ url })).toBe(`url: ${url}\n`);
  });

  it("escapes an awkward value inline rather than reaching for a block scalar", () => {
    expect(emitYaml({ description: "two\nlines" })).toBe('description: "two\\nlines"\n');
  });

  it("emits an empty mapping rather than dropping the key", () => {
    expect(emitYaml({ mcps: {}, version: 1 })).toBe("mcps: {}\nversion: 1\n");
  });

  it("is byte-stable across calls", () => {
    const document = { skills: { "acme.b": { path: "b" }, "acme.a": { path: "a" } }, version: 1 };

    expect(emitYaml(document)).toBe(emitYaml(document));
  });
});
