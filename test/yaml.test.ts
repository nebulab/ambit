/**
 * The shared YAML loader (spec §3.0). Every rule here exists because the alternative is silent
 * corruption, so each one is asserted to fail loudly — with the exit code, the offending
 * identifier, and the line.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../src/errors.js";
import { parseYamlMapping, readYamlMapping } from "../src/yaml.js";

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

    it("reads a list of strings or mappings", () => {
      const entries = load("skills:\n  - acme.one\n  - name: two\n").optionalEntryList("skills");

      expect(typeof entries?.[0]).toBe("string");
      expect(entries?.[0]).toBe("acme.one");
      expect(typeof entries?.[1]).toBe("object");
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
