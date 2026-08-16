/**
 * The array-section driver — the piece that makes hooks co-ownable.
 *
 * Every claim here is about coexistence, because that is the whole reason this driver exists rather
 * than the map-shaped JSON one: a harness's hooks root is `event → array`, arrays have no identity
 * key, and the tool ambit replaces answers that by rewriting the entire root and destroying whatever
 * a person wrote in it. So the fixtures below always hold a foreign hook in the *same* event array
 * ambit writes into — the case a merge keyed on anything but content gets wrong — and the assertions
 * are on bytes wherever bytes are the promise.
 */
import { describe, expect, it } from "bun:test";

import { AmbitError, ExitCode } from "../../../src/errors.js";
import type { ConfigEntry } from "../../../src/model/documents/format.js";
import { driverFor, jsonDriver } from "../../../src/model/documents/index.js";
import {
  arrayEntryKey,
  arraySectionDriver,
  entryDigest,
} from "../../../src/model/documents/json-array.js";

/** The driver as every harness but Cursor gets it: nothing to seed at the document's root. */
const driver = arraySectionDriver();

const SECTION = "hooks";
const FILE = ".claude/settings.json";

/** The entry ambit renders for a `PostToolUse` hook, in Claude's shape. */
const FORMAT_VALUE = {
  matcher: "Edit",
  hooks: [{ type: "command", command: "npx prettier --write" }],
};

const FORMAT: ConfigEntry = {
  key: arrayEntryKey("PostToolUse", FORMAT_VALUE),
  value: FORMAT_VALUE,
};

/** A second one, on an event the fixture's own hooks do not use. */
const GREET_VALUE = { hooks: [{ type: "command", command: "./greet.sh" }] };

const GREET: ConfigEntry = { key: arrayEntryKey("Stop", GREET_VALUE), value: GREET_VALUE };

/**
 * Settings of the kind a person actually has: two hooks they wrote themselves — one on the very event
 * ambit is about to write to — and root keys that are none of ambit's business.
 *
 * Written in the layout `JSON.stringify(…, null, 2)` produces, so that "unchanged" can be asserted on
 * the bytes rather than on parsed values.
 */
const HANDWRITTEN = `{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(git status)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "./mine.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./welcome.sh"
          }
        ]
      }
    ]
  }
}
`;

function merge(text: string | undefined, ...entries: readonly ConfigEntry[]): string {
  return driver.mergeSection(text, SECTION, entries, FILE);
}

function parsed(text: string | undefined): Record<string, unknown> {
  return JSON.parse(text ?? "") as Record<string, unknown>;
}

/** The `hooks` object of a document, as arrays of entries. */
function hooksOf(text: string | undefined): Record<string, readonly unknown[]> {
  return parsed(text)[SECTION] as Record<string, readonly unknown[]>;
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

describe("the managed key", () => {
  it("is the event and the first twelve hex of the entry's digest", () => {
    expect(FORMAT.key).toMatch(/^PostToolUse@[0-9a-f]{12}$/);
  });

  it("is a function of the entry alone, so two machines agree", () => {
    expect(entryDigest(FORMAT_VALUE)).toBe(entryDigest({ ...FORMAT_VALUE }));
    expect(entryDigest(FORMAT_VALUE)).not.toBe(entryDigest(GREET_VALUE));
  });

  it("digests the entry in the order the renderer built it", () => {
    // Deliberately *not* order-insensitive: the digest describes the bytes ambit writes, and an entry
    // read back off disk keeps the order it was written in. A reordered entry is a different entry,
    // which is what makes a hand-edit show up as drift instead of being silently accepted.
    const reordered = { hooks: FORMAT_VALUE.hooks, matcher: FORMAT_VALUE.matcher };

    expect(entryDigest(reordered)).not.toBe(entryDigest(FORMAT_VALUE));
  });
});

describe("merging a hook into hand-written settings", () => {
  it("appends to the event array and leaves every other byte identical", () => {
    expect(merge(HANDWRITTEN, FORMAT)).toBe(`{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(git status)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "./mine.sh"
          }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./welcome.sh"
          }
        ]
      }
    ]
  }
}
`);
  });

  it("keeps the foreign entry first, and keeps it whole", () => {
    const hooks = hooksOf(merge(HANDWRITTEN, FORMAT));

    expect(hooks.PostToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "./mine.sh" }] },
      FORMAT_VALUE,
    ]);
    expect(hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "./welcome.sh" }] }]);
  });

  it("creates an event array the document has none of, and keeps the ones it has", () => {
    const hooks = hooksOf(merge(HANDWRITTEN, FORMAT, GREET));

    expect(Object.keys(hooks)).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    expect(hooks.Stop).toEqual([GREET_VALUE]);
  });

  it("writes a whole document when the file does not exist yet", () => {
    expect(merge(undefined, FORMAT)).toBe(
      `${JSON.stringify({ hooks: { PostToolUse: [FORMAT_VALUE] } }, null, 2)}\n`,
    );
  });

  it("creates the section in a document that has none", () => {
    const merged = merge('{\n  "model": "opus"\n}\n', FORMAT);

    expect(parsed(merged)).toEqual({ model: "opus", hooks: { PostToolUse: [FORMAT_VALUE] } });
  });

  it("is idempotent: a second merge of the same entries is a no-op", () => {
    const once = merge(HANDWRITTEN, FORMAT, GREET);

    // Byte-identical, not merely equivalent: this is the claim `ambit install` twice rests on, and
    // getting it wrong grows the array by one duplicate hook per run.
    expect(merge(once, FORMAT, GREET)).toBe(once);
  });

  it("does not append a second copy of an entry a person wrote by hand", () => {
    // Same digest, so as far as this driver is concerned it is already there. Whether ambit is allowed
    // to claim it is `ownership.ts`'s question, not the driver's.
    const byHand = merge(undefined, FORMAT);

    expect(merge(byHand, FORMAT)).toBe(byHand);
  });
});

describe("removing hooks", () => {
  it("drops only the matching digests and leaves the foreign entry in place", () => {
    const once = merge(HANDWRITTEN, FORMAT, GREET);

    const removed = driver.removeKeys(once, SECTION, [FORMAT.key, GREET.key], FILE);

    expect(hooksOf(removed).PostToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "./mine.sh" }] },
    ]);
    expect(hooksOf(removed).SessionStart).toEqual([
      { hooks: [{ type: "command", command: "./welcome.sh" }] },
    ]);
    expect(parsed(removed).model).toBe("opus");
    expect(parsed(removed).permissions).toEqual({ allow: ["Bash(git status)"] });
  });

  it("leaves an emptied event array behind rather than deleting it", () => {
    const once = merge(HANDWRITTEN, GREET);

    const removed = driver.removeKeys(once, SECTION, [GREET.key], FILE);

    // The array is a container ambit created but does not own the way it owns the entries in it, and a
    // person may be about to put a hook of their own in it — the stance the map driver takes on `{}`.
    expect(hooksOf(removed).Stop).toEqual([]);
  });

  it("reports nothing to do rather than rewriting a file it would not change", () => {
    // Each of these is a prune that must leave the file byte-identical: an entry already gone, an
    // event array that never existed, a file with no hooks at all, and a file that is not there.
    expect(driver.removeKeys(HANDWRITTEN, SECTION, [FORMAT.key], FILE)).toBeUndefined();
    expect(driver.removeKeys(HANDWRITTEN, SECTION, [GREET.key], FILE)).toBeUndefined();
    expect(driver.removeKeys('{"model": "opus"}\n', SECTION, [FORMAT.key], FILE)).toBe(undefined);
    expect(driver.removeKeys(undefined, SECTION, [FORMAT.key], FILE)).toBeUndefined();
  });
});

describe("reading the section", () => {
  it("derives every key from the file alone, foreign entries included", () => {
    // Nothing here knows a hook's name, and nothing needs to: the digest is the identity, so the keys
    // ownership compares a plan against are readable off any settings file, however it was written.
    expect(driver.sectionKeys(HANDWRITTEN, SECTION, FILE)).toEqual(
      new Set([
        arrayEntryKey("PostToolUse", {
          matcher: "Write",
          hooks: [{ type: "command", command: "./mine.sh" }],
        }),
        arrayEntryKey("SessionStart", {
          hooks: [{ type: "command", command: "./welcome.sh" }],
        }),
      ]),
    );
  });

  it("names ambit's entry once it is merged in", () => {
    expect(driver.sectionKeys(merge(HANDWRITTEN, FORMAT), SECTION, FILE)).toContain(FORMAT.key);
  });

  it("reads an absent file, an absent section and an unusable one as holding none", () => {
    expect(driver.sectionKeys(undefined, SECTION, FILE)).toEqual(new Set());
    expect(driver.sectionKeys('{"model": "opus"}', SECTION, FILE)).toEqual(new Set());
    expect(driver.sectionKeys('{"hooks": []}', SECTION, FILE)).toEqual(new Set());
    expect(driver.sectionKeys('{"hooks": {"Stop": "nope"}}', SECTION, FILE)).toEqual(new Set());
  });
});

describe("whether an entry is already what install would write", () => {
  it("says yes for the entry install wrote", () => {
    expect(driver.entryMatches(merge(HANDWRITTEN, FORMAT), SECTION, FORMAT, FILE)).toBe(true);
  });

  it("says no for an absent file, an absent entry, and one edited by hand", () => {
    const edited = merge(HANDWRITTEN, FORMAT).replace(
      "npx prettier --write",
      "npx prettier --check",
    );

    expect(driver.entryMatches(undefined, SECTION, FORMAT, FILE)).toBe(false);
    expect(driver.entryMatches(HANDWRITTEN, SECTION, FORMAT, FILE)).toBe(false);
    expect(driver.entryMatches(edited, SECTION, FORMAT, FILE)).toBe(false);
  });
});

describe("root defaults", () => {
  const versioned = arraySectionDriver({ version: 1 });

  it("adds the key when ambit creates the file", () => {
    expect(versioned.mergeSection(undefined, SECTION, [FORMAT], FILE)).toBe(
      `${JSON.stringify({ version: 1, hooks: { PostToolUse: [FORMAT_VALUE] } }, null, 2)}\n`,
    );
  });

  it("never overwrites a version someone else wrote", () => {
    const theirs = '{\n  "version": 2,\n  "hooks": {}\n}\n';

    const merged = versioned.mergeSection(theirs, SECTION, [FORMAT], FILE);

    expect(parsed(merged).version).toBe(2);
    expect(Object.keys(parsed(merged))).toEqual(["version", "hooks"]);
  });

  it("adds nothing on a removal", () => {
    // A file with no `version` — one Cursor wrote itself, say — being pruned by a build that has
    // defaults. Defaults belong to writing a document, and pruning is not that: `prune` and `clean`
    // must take entries out and add nothing.
    const once = merge(HANDWRITTEN, GREET);

    const removed = versioned.removeKeys(once, SECTION, [GREET.key], FILE);

    expect(parsed(removed).version).toBeUndefined();
    expect(Object.keys(parsed(removed))).toEqual(["model", "permissions", "hooks"]);
  });
});

describe("selecting the driver", () => {
  it("takes the shape, since the format cannot tell the two JSON files apart", () => {
    // An array-section driver is built per call — it carries the caller's root defaults — so the claim
    // is what it writes rather than which object it is.
    expect(driverFor("json", "array").mergeSection(undefined, SECTION, [FORMAT], FILE)).toBe(
      merge(undefined, FORMAT),
    );
    expect(driverFor("json", "map")).toBe(jsonDriver);
  });

  it("reads an absent shape as a map, exactly as an absent format reads as json", () => {
    expect(driverFor("json")).toBe(jsonDriver);
  });

  it("hands the root defaults it is given to the driver it builds", () => {
    // The route Cursor's `version: 1` travels: a profile's layout declares it, the planned artifact
    // carries it, and `applyHarnessConfig` passes it here — nothing else in ambit seeds a root key.
    const merged = driverFor("json", "array", { version: 1 }).mergeSection(
      undefined,
      SECTION,
      [FORMAT],
      FILE,
    );

    expect(parsed(merged).version).toBe(1);
    // And an absent argument seeds nothing, which is what Claude's and Codex's files want.
    expect(parsed(merge(undefined, FORMAT)).version).toBeUndefined();
  });

  it("refuses a format with no array-section driver", () => {
    // Nothing plans one — every hooks file is JSON — so answering with the TOML driver would mean
    // editing arrays as if they were tables. Exit 1: a bug in ambit, not something a project did.
    expect(caught(() => driverFor("toml", "array")).code).toBe(ExitCode.Internal);
  });
});

describe("what it refuses", () => {
  it("refuses a document it cannot parse, in the map driver's words", () => {
    const error = caught(() => merge("{ not json\n", FORMAT));

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toBe(`${FILE} is not valid JSON`);
  });

  it("refuses a section holding something other than an object", () => {
    const error = caught(() => merge('{"hooks": []}\n', FORMAT));

    expect(error.message).toBe(`"hooks" in ${FILE} is not a JSON object`);
    expect(error.detail).toEqual([
      "ambit appends its entries to the arrays inside `hooks`",
      "make `hooks` an object, or move its current value aside",
    ]);
  });

  it("refuses an event holding something other than an array", () => {
    const error = caught(() => merge('{"hooks": {"PostToolUse": {}}}\n', FORMAT));

    expect(error.message).toBe(`"hooks.PostToolUse" in ${FILE} is not a JSON array`);
    expect(error.detail).toEqual([
      "ambit appends one entry per managed hook to `hooks.PostToolUse`",
      "make `hooks.PostToolUse` an array, or move its current value aside",
    ]);
  });

  it("refuses a key that names no event, as a bug rather than a config error", () => {
    // Only this build writes these keys, so a key with no `@` in it cannot have come from a project.
    // Guessing at it would mean appending a duplicate hook, or leaving a claimed entry forever.
    const error = caught(() => merge(HANDWRITTEN, { key: "PostToolUse", value: FORMAT_VALUE }));

    expect(error.code).toBe(ExitCode.Internal);
    expect(error.message).toBe(`cannot address "PostToolUse" in ${FILE}`);
    expect(caught(() => driver.removeKeys(HANDWRITTEN, SECTION, ["Stop"], FILE)).code).toBe(
      ExitCode.Internal,
    );
  });
});
