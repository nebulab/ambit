/**
 * The glob matcher and the `requires` entry grammar.
 *
 * Resolution and validation both go through this module, but this is the only place its refusals are
 * pinned directly rather than through a command. Each malformed case asserts the {@link AmbitError}
 * code the CLI turns into an exit status (exit 2 for every grammar problem) and that the message names
 * the key and the line, which is the whole contract every refusal above it inherits.
 */
import { describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import type { Addressing, Capability, PatternEntry, PatternItem } from "../../src/model/pattern.js";
import {
  CAPABILITIES,
  CAPABILITY_OF_KIND,
  PATTERN_FIELDS,
  entryAddress,
  entryYaml,
  formatEntry,
  matches,
  matchesPattern,
  parseEntries,
  sameEntry,
  uniqueEntries,
} from "../../src/model/pattern.js";
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
  return { capability: "skills", catalog: "company", name: "core.a", tags: [], ...overrides };
}

/** An entry, with the tedious half defaulted. */
function entry(overrides: Partial<PatternEntry> = {}): PatternEntry {
  return { field: "name", pattern: "core.a", capabilities: ["skills"], ...overrides };
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
  it("matches on the field the entry declared, and never on the other", () => {
    const tagged = item({ name: "house-style", tags: ["core", "function.engineering"] });

    expect(matches(entry({ field: "name", pattern: "house-style" }), tagged)).toBe(true);
    expect(matches(entry({ field: "tag", pattern: "house-style" }), tagged)).toBe(false);
    expect(matches(entry({ field: "tag", pattern: "core" }), tagged)).toBe(true);
    expect(matches(entry({ field: "name", pattern: "core" }), tagged)).toBe(false);
  });

  it("matches any one of an item's tags, since an author may label it for several audiences", () => {
    const both = item({ tags: ["function.sales", "function.engineering"] });
    expect(matches(entry({ field: "tag", pattern: "function.sales" }), both)).toBe(true);
    expect(matches(entry({ field: "tag", pattern: "function.engineering" }), both)).toBe(true);
    expect(matches(entry({ field: "tag", pattern: "function.*" }), both)).toBe(true);
    expect(matches(entry({ field: "tag", pattern: "guards" }), both)).toBe(false);
    expect(matches(entry({ field: "tag", pattern: "*" }), item({ tags: [] }))).toBe(false);
  });

  it("selects only the namespaces the entry named", () => {
    const selects: readonly Capability[] = ["skills", "hooks"];
    const wide = entry({ pattern: "*", capabilities: selects });

    expect(matches(wide, item({ capability: "skills" }))).toBe(true);
    expect(matches(wide, item({ capability: "hooks" }))).toBe(true);
    expect(matches(wide, item({ capability: "mcps" }))).toBe(false);
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

  it("does not depend on the order the item's tags or the entry's capabilities were written in", () => {
    const forwards = entry({ field: "tag", pattern: "b", capabilities: ["skills", "hooks"] });
    const backwards = entry({ field: "tag", pattern: "b", capabilities: ["hooks", "skills"] });

    for (const tags of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      expect(matches(forwards, item({ tags, capability: "hooks" }))).toBe(true);
      expect(matches(backwards, item({ tags, capability: "hooks" }))).toBe(true);
    }
  });

  it("bridges the singular kind vocabulary onto the plural capability one", () => {
    expect(CAPABILITY_OF_KIND).toEqual({ skill: "skills", mcp: "mcps", hook: "hooks" });
    expect(Object.values(CAPABILITY_OF_KIND).sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe("writing an entry back out", () => {
  it("recomposes the address it was parsed from", () => {
    expect(entryAddress(entry({ pattern: "core.*", catalog: "company" }))).toBe("company/core.*");
    expect(entryAddress(entry({ pattern: "core.*" }))).toBe("core.*");
  });

  it("prints the field and the address, and never the capability list", () => {
    const printed = formatEntry(
      entry({ field: "tag", pattern: "core", catalog: "company", capabilities: CAPABILITIES }),
    );
    expect(printed).toBe("tag:company/core");
    for (const capability of CAPABILITIES) expect(printed).not.toContain(capability);
  });

  it("renders advice as a one-line flow mapping, which block style could not do", () => {
    const yaml = entryYaml(
      entry({ field: "name", pattern: "core.*", catalog: "company", capabilities: CAPABILITIES }),
    );
    expect(yaml).toBe(`- { name: "company/core.*", capabilities: [skills, mcps, hooks] }`);
    expect(yaml).not.toContain("\n");
    // The advice has to round-trip: what a refusal tells a reader to write must parse.
    expect(parse(`requires:\n  ${yaml}\n`, "qualified")).toEqual([
      { field: "name", pattern: "core.*", catalog: "company", capabilities: [...CAPABILITIES] },
    ]);
  });
});

describe("literal equality and deduplication", () => {
  it("is exact, and does not let a wider entry absorb a narrower one", () => {
    const wide = entry({ field: "tag", pattern: "x", capabilities: ["skills", "mcps"] });
    const narrow = entry({ field: "tag", pattern: "x", capabilities: ["skills"] });

    expect(sameEntry(wide, narrow)).toBe(false);
    expect(uniqueEntries([wide, narrow])).toEqual([wide, narrow]);
  });

  it("does not let a wildcard absorb a name it matches", () => {
    const star = entry({ pattern: "core.*" });
    const exact = entry({ pattern: "core.a" });

    expect(sameEntry(star, exact)).toBe(false);
    expect(uniqueEntries([star, exact])).toHaveLength(2);
  });

  it("separates the two fields, the two catalogs, and the two patterns", () => {
    const base = entry({ field: "name", pattern: "x", catalog: "company" });
    expect(sameEntry(base, { ...base, field: "tag" })).toBe(false);
    expect(sameEntry(base, { ...base, pattern: "y" })).toBe(false);
    expect(sameEntry(base, { ...base, catalog: "personal" })).toBe(false);
    expect(sameEntry(base, { ...base })).toBe(true);
    // An unqualified entry is not the qualified one with the alias dropped: it says less.
    expect(sameEntry(base, entry({ field: "name", pattern: "x" }))).toBe(false);
  });

  it("compares capabilities as a set, so an entry is judged on what it says", () => {
    const forwards = entry({ capabilities: ["skills", "hooks"] });
    const backwards = entry({ capabilities: ["hooks", "skills"] });
    expect(sameEntry(forwards, backwards)).toBe(true);
    expect(uniqueEntries([forwards, backwards])).toEqual([forwards]);
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
  - tag: "company/function.engineering"
    capabilities: [skills, mcps, hooks]
  - name: "company/core.*"
    capabilities: [skills]
  - name: "local/*"
    capabilities: [skills, mcps, hooks]
  - name: "company/guards.*"
    capabilities: [hooks]
`,
      "qualified",
    );

    expect(entries).toEqual([
      {
        field: "tag",
        catalog: "company",
        pattern: "function.engineering",
        capabilities: ["skills", "mcps", "hooks"],
      },
      { field: "name", catalog: "company", pattern: "core.*", capabilities: ["skills"] },
      { field: "name", catalog: "local", pattern: "*", capabilities: ["skills", "mcps", "hooks"] },
      { field: "name", catalog: "company", pattern: "guards.*", capabilities: ["hooks"] },
    ]);
  });

  it("reads a catalog's own list, unqualified", () => {
    expect(parse(`requires:\n  - tag: guards\n    capabilities: [hooks]\n`, "unqualified")).toEqual(
      [{ field: "tag", pattern: "guards", capabilities: ["hooks"] }],
    );
  });

  it("treats an absent key as no entries, and an empty list as exactly that", () => {
    expect(parse("version: 1\n", "qualified")).toEqual([]);
    expect(parse("requires: []\n", "qualified")).toEqual([]);
  });

  it("keeps the order the list was written in, duplicates included", () => {
    const entries = parse(
      `requires:
  - name: "b/*"
    capabilities: [skills]
  - name: "a/*"
    capabilities: [skills]
  - name: "b/*"
    capabilities: [skills]
`,
      "qualified",
    );
    expect(entries.map(entryAddress)).toEqual(["b/*", "a/*", "b/*"]);
    expect(uniqueEntries(entries).map(entryAddress)).toEqual(["b/*", "a/*"]);
  });

  it("normalizes capabilities into one canonical order however they were written", () => {
    const one = parse(
      `requires:\n  - name: "c/*"\n    capabilities: [hooks, skills, mcps]\n`,
      "qualified",
    );
    const two = parse(
      `requires:\n  - name: "c/*"\n    capabilities: [mcps, hooks, skills]\n`,
      "qualified",
    );

    expect(one[0]!.capabilities).toEqual([...CAPABILITIES]);
    expect(one).toEqual(two);
  });

  it("deduplicates a repeated capability rather than counting it twice", () => {
    const [only] = parse(
      `requires:\n  - name: "c/*"\n    capabilities: [skills, skills]\n`,
      "qualified",
    );
    expect(only!.capabilities).toEqual(["skills"]);
  });
});

describe("refusing a malformed entry", () => {
  it("refuses a bare pattern, naming both things it fails to say", () => {
    const error = rejection(`requires:\n  - "company/core.*"\n`, "qualified");
    expect(error.message).toContain(`"company/core.*"`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("neither which field it matches");
    expect(error.format()).toContain("capabilities");
    expect(error.format()).toContain(`- { name: "company/core.*", capabilities: [skills] }`);
  });

  it("proposes a placeholder alias rather than guessing one, for a bare unqualified pattern", () => {
    const error = rejection(`requires:\n  - "core.*"\n`, "qualified");
    expect(error.format()).toContain(`- { name: "<catalog>/core.*", capabilities: [skills] }`);
  });

  it("refuses an entry that declares no field", () => {
    const error = rejection(`requires:\n  - capabilities: [skills]\n`, "qualified");
    expect(error.message).toContain("matches on no field");
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("`name`, `tag`");
    expect(error.format()).toContain("a plausible name prefix and a plausible tag");
  });

  it("refuses an entry that declares both fields, rather than picking one", () => {
    const error = rejection(
      `requires:\n  - name: "c/a"\n    tag: "c/b"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(error.message).toContain("matches on both `name`, `tag`");
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("one entry per field");
  });

  it("refuses the `<namespace>: <name>` spelling, naming the entry it becomes", () => {
    // The pre-pattern shape, and the whole of the migration path: no compatibility reader, one
    // refusal carrying the rewrite. The namespace becomes the single capability, and the name becomes
    // an exact pattern.
    const error = rejection(`requires:\n  - skill: company-context\n`, "unqualified");
    expect(error.message).toContain("names the namespace `skill`, which an entry no longer does");
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("`name`, `tag`");
    expect(error.format()).toContain("skills, mcps, hooks");
    expect(error.format()).toContain(`- { name: "company-context", capabilities: [skills] }`);
  });

  it("maps each namespace onto its own capability, and qualifies the rewrite in a project", () => {
    expect(rejection(`requires:\n  - mcp: sentry\n`, "unqualified").format()).toContain(
      `- { name: "sentry", capabilities: [mcps] }`,
    );
    expect(rejection(`requires:\n  - hook: block-rm\n`, "unqualified").format()).toContain(
      `- { name: "block-rm", capabilities: [hooks] }`,
    );
    // A project's rewrite has to carry a qualifier, and the alias is the reader's to pick.
    expect(rejection(`requires:\n  - skill: house-style\n`, "qualified").format()).toContain(
      `- { name: "<catalog>/house-style", capabilities: [skills] }`,
    );
  });

  it("refuses the old spelling ahead of the unknown-key message, which reads as a typo", () => {
    // `- skill: x` is an unknown key to this grammar, and *unknown key* is exactly the wrong thing to
    // tell somebody holding a list that used to work.
    const error = rejection(`requires:\n  - skill: x\n    capabilities: [skills]\n`, "unqualified");
    expect(error.message).toContain("names the namespace `skill`");
  });

  it("refuses an unknown key before complaining about anything else", () => {
    const error = rejection(
      `requires:\n  - tags: "c/a"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(error.message).toContain(`unknown key "requires[0].tags"`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("accepted keys: capabilities, name, tag");
  });

  it("refuses a missing `capabilities`, because hooks execute", () => {
    const error = rejection(`requires:\n  - name: "c/core.*"\n`, "qualified");
    expect(error.message).toContain("declares no capabilities");
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("not defaulted");
    expect(error.format()).toContain("hooks execute");
    expect(error.format()).toContain("skills, mcps, hooks");
  });

  it("refuses an empty `capabilities`, which would select nothing", () => {
    const error = rejection(`requires:\n  - name: "c/core.*"\n    capabilities: []\n`, "qualified");
    expect(error.message).toContain("selects no capabilities");
    expect(error.message).toContain("line 3");
  });

  it("refuses a capability outside the three, including the singular spelling", () => {
    const error = rejection(
      `requires:\n  - name: "c/core.*"\n    capabilities: [skill]\n`,
      "qualified",
    );
    expect(error.message).toContain(`unknown capability "skill"`);
    expect(error.message).toContain("line 3");
    expect(error.format()).toContain("capabilities are: skills, mcps, hooks");
  });

  it("refuses a `capabilities` that is not a list at all", () => {
    const error = rejection(
      `requires:\n  - name: "c/core.*"\n    capabilities: skills\n`,
      "qualified",
    );
    expect(error.message).toContain("must be a sequence of strings");
  });

  it("refuses a pattern that is not a string, and an empty one", () => {
    expect(
      rejection(`requires:\n  - name: 1\n    capabilities: [skills]\n`, "qualified").message,
    ).toContain("must be a string");
    expect(
      rejection(`requires:\n  - name: ""\n    capabilities: [skills]\n`, "qualified").message,
    ).toContain("must not be empty");
  });
});

describe("the two spellings of an address", () => {
  it("requires a qualifier in a project, naming the key and the line", () => {
    const error = rejection(
      `requires:\n  - name: "core.*"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(error.message).toContain(`"core.*" names no catalog`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("`<catalog>/core.*`");
    expect(error.format()).toContain("`catalogs:`");
  });

  it("refuses a qualifier in a catalog, saying why an author cannot write one", () => {
    const error = rejection(
      `requires:\n  - tag: "company/guards"\n    capabilities: [hooks]\n`,
      "unqualified",
    );
    expect(error.message).toContain(`"company/guards" names a catalog`);
    expect(error.message).toContain("line 2");
    expect(error.format()).toContain("belongs to the consumer's config");
    expect(error.format()).toContain(`- { tag: "guards", capabilities: [skills] }`);
  });

  it("refuses a second separator in either spelling, since a name holds none", () => {
    for (const addressing of ["qualified", "unqualified"] as const) {
      const error = rejection(
        `requires:\n  - name: "c/core/a"\n    capabilities: [skills]\n`,
        addressing,
      );
      expect(error.message).toContain("line 2");
      expect(error.code).toBe(ExitCode.Config);
    }
    expect(
      rejection(`requires:\n  - name: "c/core/a"\n    capabilities: [skills]\n`, "qualified")
        .message,
    ).toContain("2 `/` separators");
  });

  it("refuses an empty half of a qualified address", () => {
    expect(
      rejection(`requires:\n  - name: "/core.*"\n    capabilities: [skills]\n`, "qualified")
        .message,
    ).toContain("names an empty catalog");
    expect(
      rejection(`requires:\n  - name: "company/"\n    capabilities: [skills]\n`, "qualified")
        .message,
    ).toContain("names an empty pattern");
  });

  it("takes `<catalog>/*` as the catalog-wide selector, with no root to synthesize", () => {
    const [only] = parse(
      `requires:\n  - name: "company/*"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(only).toEqual({
      field: "name",
      catalog: "company",
      pattern: "*",
      capabilities: ["skills"],
    });
    expect(matches(only!, item({ catalog: "company", name: "anything.at.all" }))).toBe(true);
    expect(matches(only!, item({ catalog: "personal" }))).toBe(false);
  });

  it("keeps a catalog alias holding a dot addressable, which is why the separator is `/`", () => {
    const [only] = parse(
      `requires:\n  - name: "my.catalog/core.*"\n    capabilities: [skills]\n`,
      "qualified",
    );
    expect(only).toEqual({
      field: "name",
      catalog: "my.catalog",
      pattern: "core.*",
      capabilities: ["skills"],
    });
  });
});

describe("the vocabularies themselves", () => {
  it("lists the three capabilities and the two fields, in report order", () => {
    expect(CAPABILITIES).toEqual(["skills", "mcps", "hooks"]);
    expect(PATTERN_FIELDS).toEqual(["name", "tag"]);
  });
});
