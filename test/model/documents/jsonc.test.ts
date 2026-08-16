/**
 * The JSONC driver — `.opencode/opencode.jsonc`.
 *
 * JSONC exists so that a person can annotate their config, so the claims here are the same ones the
 * TOML driver makes and for the same reason: comments, trailing commas, indentation and key order
 * everywhere ambit does not own survive being written into. What differs is drift — this format *can*
 * be parsed losslessly enough to compare values, so a reformatted entry is not a change.
 */
import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "bun:test";

import { AmbitError, ExitCode } from "../../../src/errors.js";
import { jsoncDriver } from "../../../src/model/documents/jsonc.js";

const SECTION = "mcp";
const FILE = ".opencode/opencode.jsonc";

/** A local server, in the shape the opencode profile emits. */
const FIXTURE = {
  key: "fixture",
  value: { type: "local", command: ["npx", "-y", "@acme/fixture-mcp"] },
};

/**
 * A config someone maintains by hand: a line comment, a block comment, a trailing comma, and keys
 * ambit has no business touching.
 */
const HANDWRITTEN = `{
  // The model I actually use.
  "model": "anthropic/claude-opus-4",

  /* Servers I added myself, long before ambit ran here. */
  "mcp": {
    "handmade": {
      "type": "local",
      "command": ["node", "./scripts/local-mcp.js"],
    },
  },
}
`;

function merge(text: string | undefined, ...entries: readonly { key: string; value: unknown }[]) {
  return jsoncDriver.mergeSection(text, SECTION, entries, FILE);
}

/**
 * The document a merge produced, parsed — for the claims that are about values, not bytes.
 *
 * Through `jsonc-parser` rather than `JSON.parse`, since the whole point of the fixtures here is that
 * they hold comments and trailing commas that plain JSON would reject.
 */
function parsed(text: string): Record<string, unknown> {
  return parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown>;
}

function caught(run: () => unknown): AmbitError {
  try {
    run();
  } catch (error) {
    if (error instanceof AmbitError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

describe("merging a server into an opencode config", () => {
  it("keeps every comment and the trailing commas around it", () => {
    const merged = merge(HANDWRITTEN, FIXTURE);

    expect(merged).toContain("// The model I actually use.");
    expect(merged).toContain("/* Servers I added myself, long before ambit ran here. */");
    // The trailing comma the person wrote is still there: this driver edits text rather than
    // re-serializing the document, so it has no opinion about their style.
    expect(merged).toContain('"command": ["node", "./scripts/local-mcp.js"],');
  });

  it("adds its own key and leaves the hand-written one in place, in order", () => {
    const merged = merge(HANDWRITTEN, FIXTURE);

    const document = parsed(merged);
    expect(document.model).toBe("anthropic/claude-opus-4");
    expect(Object.keys(document[SECTION] as object)).toEqual(["handmade", "fixture"]);
    expect((document[SECTION] as Record<string, unknown>).fixture).toEqual(FIXTURE.value);
  });

  it("writes a whole document when the file does not exist yet", () => {
    expect(JSON.parse(merge(undefined, FIXTURE))).toEqual({ mcp: { fixture: FIXTURE.value } });
  });

  it("creates the section in a document that has none", () => {
    const merged = merge('{\n  // just a model\n  "model": "x"\n}\n', FIXTURE);

    expect(merged).toContain("// just a model");
    expect(parsed(merged)).toEqual({ model: "x", mcp: { fixture: FIXTURE.value } });
  });

  it("merges several entries, each against the text the last one produced", () => {
    // One edit per key, so the offsets the next edit computes are the offsets of the file as it now
    // stands. Doing it any other way corrupts the second key.
    const merged = merge(HANDWRITTEN, FIXTURE, {
      key: "other",
      value: { type: "remote", url: "https://other.invalid/mcp" },
    });

    expect(Object.keys(parsed(merged)[SECTION] as object)).toEqual([
      "handmade",
      "fixture",
      "other",
    ]);
  });

  it("is idempotent: merging what the file already says changes nothing", () => {
    const once = merge(HANDWRITTEN, FIXTURE);

    expect(merge(once, FIXTURE)).toBe(once);
  });

  it("replaces an entry it already owns rather than appending a second one", () => {
    const once = merge(HANDWRITTEN, { key: "fixture", value: { type: "local", command: ["old"] } });

    const merged = merge(once, FIXTURE);

    expect(Object.keys(parsed(merged)[SECTION] as object)).toEqual(["handmade", "fixture"]);
    expect((parsed(merged)[SECTION] as Record<string, unknown>).fixture).toEqual(FIXTURE.value);
  });
});

describe("removing servers", () => {
  it("removes the key and keeps the comments, the commas and the foreign keys", () => {
    const once = merge(HANDWRITTEN, FIXTURE);

    const removed = jsoncDriver.removeKeys(once, SECTION, ["fixture"], FILE);

    expect(removed).toContain("// The model I actually use.");
    expect(removed).toContain("/* Servers I added myself, long before ambit ran here. */");
    expect(Object.keys(parsed(removed ?? "")[SECTION] as object)).toEqual(["handmade"]);
  });

  it("leaves the section behind when it empties out", () => {
    const only = merge('{\n  // mine\n  "model": "x"\n}\n', FIXTURE);

    const removed = jsoncDriver.removeKeys(only, SECTION, ["fixture"], FILE);

    // The section is a key ambit created but does not own the way it owns the entries in it, and a
    // person may be about to add their own server to it. `{}` is the honest state.
    expect(parsed(removed ?? "")).toEqual({ model: "x", mcp: {} });
  });

  it("reports nothing to do rather than rewriting a file it would not change", () => {
    expect(jsoncDriver.removeKeys(HANDWRITTEN, SECTION, ["absent"], FILE)).toBeUndefined();
    expect(jsoncDriver.removeKeys(undefined, SECTION, ["fixture"], FILE)).toBeUndefined();
    expect(jsoncDriver.removeKeys('{"model": "x"}\n', SECTION, ["fixture"], FILE)).toBeUndefined();
  });
});

describe("reading the section", () => {
  it("names every entry, through comments and trailing commas", () => {
    expect(jsoncDriver.sectionKeys(HANDWRITTEN, SECTION, FILE)).toEqual(new Set(["handmade"]));
  });

  it("reads an absent file, an absent section and a non-object section as holding none", () => {
    // None of the three is a *collision* with anything ambit would write; an unusable section is
    // `mergeSection`'s error to raise, since that is the code that cannot proceed with it.
    expect(jsoncDriver.sectionKeys(undefined, SECTION, FILE)).toEqual(new Set());
    expect(jsoncDriver.sectionKeys('{"model": "x"}', SECTION, FILE)).toEqual(new Set());
    expect(jsoncDriver.sectionKeys('{"mcp": []}', SECTION, FILE)).toEqual(new Set());
  });
});

describe("whether an entry is already what install would write", () => {
  it("says yes for the entry install wrote", () => {
    expect(jsoncDriver.entryMatches(merge(HANDWRITTEN, FIXTURE), SECTION, FIXTURE, FILE)).toBe(
      true,
    );
  });

  it("says yes for a reformatted, reordered entry, because ambit owns the value and not its layout", () => {
    // The opposite of the TOML driver's answer, deliberately: this format can be compared
    // structurally, so sending someone to look at a file that is already correct would be a bug.
    const reformatted = `{
  "mcp": { "fixture": { "command": ["npx", "-y", "@acme/fixture-mcp"], "type": "local" } }
}
`;

    expect(jsoncDriver.entryMatches(reformatted, SECTION, FIXTURE, FILE)).toBe(true);
  });

  it("says no for an absent file, an absent entry and a changed one", () => {
    expect(jsoncDriver.entryMatches(undefined, SECTION, FIXTURE, FILE)).toBe(false);
    expect(jsoncDriver.entryMatches(HANDWRITTEN, SECTION, FIXTURE, FILE)).toBe(false);
    expect(
      jsoncDriver.entryMatches(
        merge(HANDWRITTEN, { key: "fixture", value: { type: "local", command: ["old"] } }),
        SECTION,
        FIXTURE,
        FILE,
      ),
    ).toBe(false);
  });
});

describe("what it refuses", () => {
  it("refuses a document it cannot parse even tolerantly", () => {
    const error = caught(() => merge("{ not jsonc\n", FIXTURE));

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toBe(`${FILE} is not valid JSONC`);
    expect(error.detail[1]).toBe(
      "correct the syntax, so ambit can add its own keys without discarding the rest",
    );
  });

  it("refuses a document whose root is not an object", () => {
    expect(caught(() => merge("[1, 2]\n", FIXTURE)).message).toBe(`${FILE} is not a JSONC object`);
  });

  it("refuses a section holding something other than an object", () => {
    const error = caught(() => merge('{"mcp": []}\n', FIXTURE));

    expect(error.message).toBe(`"mcp" in ${FILE} is not a JSONC object`);
    expect(error.detail).toEqual([
      "ambit writes one key per managed entry inside `mcp`",
      "make `mcp` an object, or move its current value aside",
    ]);
  });
});
