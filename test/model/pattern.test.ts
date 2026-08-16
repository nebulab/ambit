/**
 * The glob matcher and the `requires` entry grammar.
 *
 * Resolution and validation both go through this module, but this is the only place its refusals are
 * pinned directly rather than through a command. Each malformed case asserts the {@link AmbitError}
 * code the CLI turns into an exit status (exit 2 for every grammar problem) and that the message names
 * the key and the line, which is the whole contract every refusal above it inherits.
 */
import { describe, expect, it } from "bun:test";

import { AmbitError, ExitCode } from "../../src/errors.js";
import type { Addressing, PatternEntry, PatternItem } from "../../src/model/pattern.js";
import {
  entryAddress,
  entryYaml,
  formatEntry,
  matches,
  matchesPattern,
  parseEntries,
  sameEntry,
  uniqueEntries,
} from "../../src/model/pattern.js";
import { ITEM_KINDS } from "../../src/model/requirement.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const FILE = "ambit.yml";

/** Parses a `requires:` block under `addressing`, from the document root. */
function parse(text: string, addressing: Addressing): readonly PatternEntry[] {
  return parseEntries(parseYamlMapping(text, FILE), addressing);
}

/** Parses `text`, asserting it was rejected as a config error (exit 2). */
function rejection(text: string, addressing: Addressing): AmbitError {
  try {
    parse(text, addressing);
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error("expected the entry to be rejected");
}

/** An item as a pattern sees one, with the tedious half defaulted. */
function item(overrides: Partial<PatternItem> = {}): PatternItem {
  return { kind: "skill", catalog: "company", name: "core.a", ...overrides };
}

/** An entry, with the tedious half defaulted. */
function entry(overrides: Partial<PatternEntry> = {}): PatternEntry {
  return { kind: "skill", pattern: "core.a", ...overrides };
}

describe("the glob matcher", () => {
  it("treats a pattern with no wildcard as an exact name", () => {
    expect(matchesPattern("core", "core")).toBe(true);
    expect(matchesPattern("core", "core.a")).toBe(false);
    expect(matchesPattern("core", "Core")).toBe(false);
    expect(matchesPattern("core", "")).toBe(false);
  });

  it("excludes the prefix itself from `core.*`, so selecting both takes two entries", () => {
    expect(matchesPattern("core.*", "core.a")).toBe(true);
    expect(matchesPattern("core.*", "core.a.b")).toBe(true);
    expect(matchesPattern("core.*", "core")).toBe(false);
    // The two-entry remedy the asymmetry costs.
    expect(["core.*", "core"].some((pattern) => matchesPattern(pattern, "core"))).toBe(true);
  });

  it("spans dots, because a dot is a character and not a level separator", () => {
    expect(matchesPattern("core.*", "core.a.b.c")).toBe(true);
    expect(matchesPattern("*", "core.a.b")).toBe(true);
    expect(matchesPattern("function.*.develop", "function.engineering.develop")).toBe(true);
  });

  it("matches an empty run, so a trailing star does not require a suffix", () => {
    expect(matchesPattern("core.*", "core.")).toBe(true);
    expect(matchesPattern("core*", "core")).toBe(true);
  });

  it("accepts a wildcard anywhere, any number of times", () => {
    expect(matchesPattern("*house-style", "core.house-style")).toBe(true);
    expect(matchesPattern("*style", "core.house-style")).toBe(true);
    expect(matchesPattern("*core*", "acme.core.a")).toBe(true);
    expect(matchesPattern("*.*.*", "a.b.c")).toBe(true);
    // The two dots in `*.*.*` are literal, so the name has to hold two of them.
    expect(matchesPattern("*.*.*", "a.b")).toBe(false);
    expect(matchesPattern("*.*", "a.b")).toBe(true);
    expect(matchesPattern("**", "anything")).toBe(true);
    expect(matchesPattern("*guards*hooks*", "guards.hooks")).toBe(true);
    expect(matchesPattern("*guards*hooks*", "hooks.guards")).toBe(false);
  });

  it("matches every other metacharacter literally", () => {
    // The bug a naive `replace("*", ".*")` has: the dot would match any character.
    expect(matchesPattern("core.a", "coreXa")).toBe(false);
    expect(matchesPattern("core.*", "coreXa")).toBe(false);
    expect(matchesPattern("a+b", "a+b")).toBe(true);
    expect(matchesPattern("a+b", "aab")).toBe(false);
    expect(matchesPattern("a(b)", "a(b)")).toBe(true);
    expect(matchesPattern("a[bc]", "a[bc]")).toBe(true);
    expect(matchesPattern("a[bc]", "ab")).toBe(false);
    expect(matchesPattern("a$", "a$")).toBe(true);
    expect(matchesPattern("a|b", "a|b")).toBe(true);
    expect(matchesPattern("a|b", "a")).toBe(false);
    expect(matchesPattern("^a", "^a")).toBe(true);
    expect(matchesPattern("^a", "a")).toBe(false);
    expect(matchesPattern("a\\b", "a\\b")).toBe(true);
    expect(matchesPattern("a?", "a?")).toBe(true);
    expect(matchesPattern("a?", "a")).toBe(false); // `?` is not a metacharacter of this grammar
    expect(matchesPattern("a{2}", "a{2}")).toBe(true);
    // Metacharacters survive around a wildcard too, not only on their own.
    expect(matchesPattern("a.*+b", "a.x+b")).toBe(true);
    expect(matchesPattern("a.*+b", "aXx+b")).toBe(false);
  });

  it("does not read `!` as negation, which belongs to a later exclusion syntax", () => {
    expect(matchesPattern("!core.*", "core.a")).toBe(false);
    expect(matchesPattern("!core.*", "!core.a")).toBe(true);
  });

  it("anchors at both ends, so a pattern is never a substring test", () => {
    expect(matchesPattern("core", "xcorex")).toBe(false);
    expect(matchesPattern("core.a", "core.a.b")).toBe(false);
  });
});

describe("matching one item", () => {
  it("matches on the namespace the entry's key named, and never on another", () => {
    const skill = item({ kind: "skill", name: "house-style" });

    expect(matches(entry({ kind: "skill", pattern: "house-style" }), skill)).toBe(true);
    expect(matches(entry({ kind: "pack", pattern: "house-style" }), skill)).toBe(false);
    expect(matches(entry({ kind: "mcp", pattern: "house-style" }), skill)).toBe(false);
    expect(matches(entry({ kind: "hook", pattern: "house-style" }), skill)).toBe(false);
  });

  it("keeps a pack and a skill of one name apart, which is why the key is written out", () => {
    const pack = item({ kind: "pack", name: "core" });
    const skill = item({ kind: "skill", name: "core" });

    expect(matches(entry({ kind: "pack", pattern: "core" }), pack)).toBe(true);
    expect(matches(entry({ kind: "pack", pattern: "core" }), skill)).toBe(false);
    expect(matches(entry({ kind: "skill", pattern: "core" }), skill)).toBe(true);
    expect(matches(entry({ kind: "skill", pattern: "core" }), pack)).toBe(false);
  });

  it("restricts a qualified entry to its own catalog, and leaves an unqualified one blind", () => {
    const qualified = entry({ pattern: "*", catalog: "company" });
    expect(matches(qualified, item({ catalog: "company" }))).toBe(true);
    expect(matches(qualified, item({ catalog: "personal" }))).toBe(false);

    // An unqualified entry carries no catalog to compare, so restricting it to one is the caller's
    // job — it matches whatever it is offered.
    const unqualified = entry({ pattern: "*" });
    expect(matches(unqualified, item({ catalog: "company" }))).toBe(true);
    expect(matches(unqualified, item({ catalog: "personal" }))).toBe(true);
  });

  it("matches every namespace with the same glob rules, packs included", () => {
    for (const kind of ITEM_KINDS) {
      const wide = entry({ kind, pattern: "core.*" });
      expect(matches(wide, item({ kind, name: "core.a.b" }))).toBe(true);
      expect(matches(wide, item({ kind, name: "core" }))).toBe(false);
    }
  });
});

describe("writing an entry back out", () => {
  it("recomposes the address it was parsed from", () => {
    expect(entryAddress(entry({ pattern: "core.*", catalog: "company" }))).toBe("company/core.*");
    expect(entryAddress(entry({ pattern: "core.*" }))).toBe("core.*");
  });

  it("prints the namespace and the address, in `ambit why`'s own shape", () => {
    expect(formatEntry(entry({ kind: "pack", pattern: "core", catalog: "company" }))).toBe(
      "pack:company/core",
    );
    expect(formatEntry(entry({ kind: "skill", pattern: "core.*" }))).toBe("skill:core.*");
  });

  it("renders advice as one block-style line, which one key fits on", () => {
    const yaml = entryYaml(entry({ kind: "skill", pattern: "core.*", catalog: "company" }));
    expect(yaml).toBe(`- skill: "company/core.*"`);
    expect(yaml).not.toContain("\n");
    // The advice has to round-trip: what a refusal tells a reader to write must parse.
    expect(parse(`requires:\n  ${yaml}\n`, "qualified")).toEqual([
      { kind: "skill", pattern: "core.*", catalog: "company" },
    ]);
  });
});

describe("literal equality and deduplication", () => {
  it("does not let a wildcard absorb a name it matches", () => {
    const star = entry({ pattern: "core.*" });
    const exact = entry({ pattern: "core.a" });

    expect(sameEntry(star, exact)).toBe(false);
    expect(uniqueEntries([star, exact])).toHaveLength(2);
  });

  it("separates the namespaces, the catalogs, and the patterns", () => {
    const base = entry({ kind: "skill", pattern: "x", catalog: "company" });
    expect(sameEntry(base, { ...base, kind: "pack" })).toBe(false);
    expect(sameEntry(base, { ...base, pattern: "y" })).toBe(false);
    expect(sameEntry(base, { ...base, catalog: "personal" })).toBe(false);
    expect(sameEntry(base, { ...base })).toBe(true);
    // An unqualified entry is not the qualified one with the alias dropped: it says less.
    expect(sameEntry(base, entry({ kind: "skill", pattern: "x" }))).toBe(false);
  });

  it("keeps the first of each duplicate and the order the list was written in", () => {
    const a = entry({ pattern: "a" });
    const b = entry({ pattern: "b" });
    expect(uniqueEntries([b, a, b, a])).toEqual([b, a]);
    expect(uniqueEntries([])).toEqual([]);
  });
});

describe("parsing a `requires` list", () => {
  it("reads the design's own example, qualified", () => {
    const entries = parse(
      `requires:
  - pack: "company/function.engineering"
  - skill: "company/core.*"
  - mcp: "local/*"
  - hook: "company/guards.*"
`,
      "qualified",
    );

    expect(entries).toEqual([
      { kind: "pack", catalog: "company", pattern: "function.engineering" },
      { kind: "skill", catalog: "company", pattern: "core.*" },
      { kind: "mcp", catalog: "local", pattern: "*" },
      { kind: "hook", catalog: "company", pattern: "guards.*" },
    ]);
  });

  it("reads a catalog's own list, unqualified", () => {
    expect(parse(`requires:\n  - hook: guards\n`, "unqualified")).toEqual([
      { kind: "hook", pattern: "guards" },
    ]);
  });

  it("reads a pack requiring another pack, which is what makes them composable", () => {
    expect(parse(`requires:\n  - pack: core\n  - skill: code-review\n`, "unqualified")).toEqual([
      { kind: "pack", pattern: "core" },
      { kind: "skill", pattern: "code-review" },
    ]);
  });

  it("treats an absent key as no entries, and an empty list as exactly that", () => {
    expect(parse("version: 1\n", "qualified")).toEqual([]);
    expect(parse("requires: []\n", "qualified")).toEqual([]);
  });

  it("keeps the order the list was written in, duplicates included", () => {
    const entries = parse(
      `requires:
  - skill: "b/*"
  - skill: "a/*"
  - skill: "b/*"
`,
      "qualified",
    );
    expect(entries.map(entryAddress)).toEqual(["b/*", "a/*", "b/*"]);
    expect(uniqueEntries(entries).map(entryAddress)).toEqual(["b/*", "a/*"]);
  });
});

describe("refusing a malformed entry", () => {
  it("refuses a bare pattern, naming what it fails to say", () => {
    const error = rejection(`requires:\n  - "company/core.*"\n`, "qualified");
    expect(error.message).toContain(`"company/core.*"`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("does not say which namespace it selects from");
    expect(error.format()).toContain("`pack`, `skill`, `mcp`, `hook`");
    expect(error.format()).toContain(`- skill: "company/core.*"`);
  });

  it("proposes a placeholder alias rather than guessing one, for a bare unqualified pattern", () => {
    const error = rejection(`requires:\n  - "core.*"\n`, "qualified");
    expect(error.format()).toContain(`- skill: "<catalog>/core.*"`);
  });

  it("refuses a key this grammar does not have, listing the four that it does", () => {
    const error = rejection(`requires:\n  - description: hello\n`, "qualified");
    expect(error.message).toContain(`unknown key "requires[0].description"`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("accepted keys: hook, mcp, pack, skill");
  });

  it("refuses an empty entry, which names no namespace at all", () => {
    const error = rejection(`requires:\n  - {}\n`, "qualified");
    expect(error.message).toContain("selects from no namespace");
    expect(error.format()).toContain("`pack`, `skill`, `mcp`, `hook`");
  });

  it("refuses an entry naming two namespaces, rather than picking one", () => {
    const error = rejection(`requires:\n  - pack: "c/a"\n    skill: "c/b"\n`, "qualified");
    expect(error.message).toContain("selects from 2 namespaces: pack, skill");
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("one entry per namespace");
  });

  it("refuses the two-key spelling this grammar replaced, as the unknown keys they are", () => {
    // `tag:` and `capabilities:` are gone with the labels they selected on: a grouping is a pack
    // now, and the generic refusal names the four keys an entry may have.
    const tagged = rejection(
      `requires:\n  - tag: "c/core"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(tagged.message).toContain(`unknown key "requires[0].tag"`);
    expect(tagged.format()).toContain("accepted keys: hook, mcp, pack, skill");

    const capped = rejection(
      `requires:\n  - skill: "c/core"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(capped.message).toContain(`unknown key "requires[0].capabilities"`);
  });

  it("refuses a pattern that is not a string, and an empty one", () => {
    expect(rejection(`requires:\n  - skill: 1\n`, "qualified").message).toContain(
      "must be a string",
    );
    expect(rejection(`requires:\n  - skill: ""\n`, "qualified").message).toContain(
      "must not be empty",
    );
  });
});

describe("the two spellings of an address", () => {
  it("requires a qualifier in a project, naming the key and the line", () => {
    const error = rejection(`requires:\n  - skill: "core.*"\n`, "qualified");
    expect(error.message).toContain(`"core.*" names no catalog`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("`<catalog>/core.*`");
    expect(error.format()).toContain("`catalogs:`");
  });

  it("refuses a qualifier in a catalog, saying why an author cannot write one", () => {
    const error = rejection(`requires:\n  - hook: "company/guards"\n`, "unqualified");
    expect(error.message).toContain(`"company/guards" names a catalog`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("belongs to the consumer's config");
    expect(error.format()).toContain(`- hook: "guards"`);
  });

  it("refuses a second separator in either spelling, since a name holds none", () => {
    for (const addressing of ["qualified", "unqualified"] as const) {
      const error = rejection(`requires:\n  - skill: "c/core/a"\n`, addressing);
      expect(error.message).toContain("line 2");
      expect(error.code).toBe(ExitCode.Config);
    }
    expect(rejection(`requires:\n  - skill: "c/core/a"\n`, "qualified").message).toContain(
      "2 `/` separators",
    );
  });

  it("refuses an empty half of a qualified address", () => {
    expect(rejection(`requires:\n  - skill: "/core.*"\n`, "qualified").message).toContain(
      "names an empty catalog",
    );
    expect(rejection(`requires:\n  - skill: "company/"\n`, "qualified").message).toContain(
      "names an empty pattern",
    );
  });

  it("takes `<catalog>/*` as the catalog-wide selector, with no root to synthesize", () => {
    const [only] = parse(`requires:\n  - skill: "company/*"\n`, "qualified");
    expect(only).toEqual({ kind: "skill", catalog: "company", pattern: "*" });
    expect(matches(only!, item({ catalog: "company", name: "anything.at.all" }))).toBe(true);
    expect(matches(only!, item({ catalog: "personal" }))).toBe(false);
  });

  it("keeps a catalog alias holding a dot addressable, which is why the separator is `/`", () => {
    const [only] = parse(`requires:\n  - skill: "my.catalog/core.*"\n`, "qualified");
    expect(only).toEqual({ kind: "skill", catalog: "my.catalog", pattern: "core.*" });
  });
});

describe("the vocabulary itself", () => {
  it("lists the namespaces in report order, with packs first", () => {
    expect(ITEM_KINDS).toEqual(["pack", "skill", "mcp", "hook"]);
  });
});
