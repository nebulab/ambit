/**
 * The TOML driver, which edits `.codex/config.toml` lexically.
 *
 * Every claim here is about *bytes*, because that is the whole reason this driver exists rather than a
 * TOML library: the file holds a person's model, sandbox and approval settings, usually with comments
 * explaining them, and a parse-and-stringify round trip loses all of it. So the assertions compare whole
 * documents rather than parsed values — a test that parsed the result would pass while the comments went
 * missing, which is precisely the bug this code is written to avoid.
 *
 * The refusals are asserted just as hard. Working lexically means some legal TOML has no span to
 * replace, and for those the promised behavior is exit 2 with the file untouched, never a guess.
 */
import { describe, expect, it } from "bun:test";

import { ExitCode } from "../../../src/errors.js";
import { AmbitError } from "../../../src/errors.js";
import { tomlDriver } from "../../../src/model/documents/toml.js";

const SECTION = "mcp_servers";
const FILE = ".codex/config.toml";

/** A stdio server, in the shape the codex profile emits. */
const FIXTURE = {
  key: "fixture",
  value: { command: "npx", args: ["-y", "@acme/fixture-mcp"] },
};

/** One with a sub-table, which is how `env` and `http_headers` are rendered. */
const WITH_ENV = {
  key: "fixture",
  value: {
    command: "npx",
    args: ["-y", "@acme/fixture-mcp"],
    env: { FIXTURE_API_KEY: "${FIXTURE_API_KEY}" },
  },
};

/**
 * A config of the kind a person actually has: settings at the root, a foreign table, and comments
 * explaining both. None of it is ambit's, so none of it may move.
 */
const HANDWRITTEN = `# My Codex config. Comments here are load-bearing — they say why.
model = "gpt-5-codex"

# Read-only until I say otherwise.
[sandbox]
mode = "read-only"
`;

function merge(text: string | undefined, ...entries: readonly { key: string; value: unknown }[]) {
  return tomlDriver.mergeSection(text, SECTION, entries, FILE);
}

/** The error a refusal raises, so a test can assert its code and its wording together. */
function refusal(text: string): AmbitError {
  try {
    merge(text, FIXTURE);
  } catch (error) {
    if (error instanceof AmbitError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the merge succeeded");
}

describe("merging a server into a Codex config", () => {
  it("appends the table, leaving every other byte of the file identical", () => {
    const merged = merge(HANDWRITTEN, FIXTURE);

    expect(merged).toBe(`${HANDWRITTEN}
[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]
`);
    // Stated separately from the byte comparison above, because "the comments survived" is the claim
    // this driver exists for and it should fail by name when it stops being true.
    expect(merged).toContain("# My Codex config. Comments here are load-bearing — they say why.");
    expect(merged).toContain("# Read-only until I say otherwise.");
  });

  it("writes a whole document when the file does not exist yet", () => {
    expect(merge(undefined, FIXTURE)).toBe(`[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]
`);
  });

  it("renders a nested object as a sub-table rather than an inline one", () => {
    // `env = { FIXTURE_API_KEY = "..." }` would be legal TOML and unreadable at three keys; it is also
    // a shape this driver could not later replace in place.
    expect(merge(undefined, WITH_ENV)).toBe(`[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]

[mcp_servers.fixture.env]
FIXTURE_API_KEY = "\${FIXTURE_API_KEY}"
`);
  });

  it("separates an appended table from what precedes it, and does not double the separator", () => {
    const once = merge(HANDWRITTEN, FIXTURE);

    // Appending a second server sees a file already ending in a table, so it adds one blank line —
    // not two, and not none.
    expect(merge(once, { key: "other", value: { command: "other-mcp" } })).toBe(`${once}
[mcp_servers.other]
command = "other-mcp"
`);
  });

  it("appends every entry it is given, in the order it is given them", () => {
    const merged = merge(
      undefined,
      { key: "alpha", value: { command: "a" } },
      { key: "beta", value: { command: "b" } },
    );

    expect(merged).toBe(`[mcp_servers.alpha]
command = "a"

[mcp_servers.beta]
command = "b"
`);
  });

  it("is idempotent: merging what the file already says changes nothing", () => {
    const once = merge(HANDWRITTEN, WITH_ENV);

    expect(merge(once, WITH_ENV)).toBe(once);
  });
});

describe("replacing a server already in the file", () => {
  const BEFORE = `# top matter
model = "gpt-5-codex"

[mcp_servers.fixture]
command = "old-command"

[mcp_servers.other]
command = "keep"

# A table after the servers, which must stay after them.
[sandbox]
mode = "read-only"
`;

  it("replaces the table in place, keeping its position and its neighbours", () => {
    expect(merge(BEFORE, FIXTURE)).toBe(`# top matter
model = "gpt-5-codex"

[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]

[mcp_servers.other]
command = "keep"

# A table after the servers, which must stay after them.
[sandbox]
mode = "read-only"
`);
  });

  it("replaces a server's sub-tables along with it, and stops at the next server", () => {
    const before = `[mcp_servers.fixture]
command = "old-command"

[mcp_servers.fixture.env]
STALE = "\${STALE}"

[mcp_servers.other]
command = "keep"
`;

    // The stale sub-table is gone rather than left behind next to the new table: ambit owns the whole
    // `[mcp_servers.fixture]` span, sub-tables included.
    expect(merge(before, FIXTURE)).toBe(`[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]

[mcp_servers.other]
command = "keep"
`);
  });

  it("does not swallow the blank line before whatever follows the table", () => {
    const before = `[mcp_servers.fixture]
command = "old-command"

[sandbox]
mode = "read-only"
`;

    expect(merge(before, { key: "fixture", value: { command: "new-command" } })).toBe(
      `[mcp_servers.fixture]
command = "new-command"

[sandbox]
mode = "read-only"
`,
    );
  });

  it("leaves a comment sitting above the table where it was", () => {
    const before = `# Why this server is here.
[mcp_servers.fixture]
command = "old-command"
`;

    // The comment is not part of the span — the span starts at the header — so a person's note about
    // the server survives ambit rewriting it.
    expect(merge(before, { key: "fixture", value: { command: "new-command" } })).toBe(
      `# Why this server is here.
[mcp_servers.fixture]
command = "new-command"
`,
    );
  });
});

describe("removing servers", () => {
  const BOTH = `# top matter

[mcp_servers.fixture]
command = "npx"

[mcp_servers.other]
command = "keep"
`;

  it("removes the table and the blank line that separated it", () => {
    expect(tomlDriver.removeKeys(BOTH, SECTION, ["fixture"], FILE)).toBe(`# top matter

[mcp_servers.other]
command = "keep"
`);
  });

  it("removes a server's sub-tables with it", () => {
    const text = `[mcp_servers.fixture]
command = "npx"

[mcp_servers.fixture.env]
FIXTURE_API_KEY = "\${FIXTURE_API_KEY}"

[sandbox]
mode = "read-only"
`;

    expect(tomlDriver.removeKeys(text, SECTION, ["fixture"], FILE)).toBe(`[sandbox]
mode = "read-only"
`);
  });

  it("leaves no blank line behind when the table it removed was the first thing in the file", () => {
    const servers = `[mcp_servers.fixture]
command = "npx"

[mcp_servers.other]
command = "keep"
`;

    // There is no preceding separator to absorb here, so the following one is taken instead.
    // Otherwise the document would start with a blank line, and — since nothing else ever rewrites
    // those bytes — it would stay there for good.
    expect(tomlDriver.removeKeys(servers, SECTION, ["fixture"], FILE)).toBe(`[mcp_servers.other]
command = "keep"
`);
  });

  it("leaves the servers it was not asked about, and everything else in the file", () => {
    const removed = tomlDriver.removeKeys(BOTH, SECTION, ["fixture"], FILE);

    expect(tomlDriver.sectionKeys(removed, SECTION, FILE)).toEqual(new Set(["other"]));
    expect(removed).toContain("# top matter");
  });

  it("reports nothing to do rather than rewriting a file it would not change", () => {
    // `undefined` is what lets a prune skip the write entirely, which is what keeps a project with
    // nothing stale byte-identical — and what stops pruning from recreating a deleted file.
    expect(tomlDriver.removeKeys(BOTH, SECTION, ["absent"], FILE)).toBeUndefined();
    expect(tomlDriver.removeKeys(undefined, SECTION, ["fixture"], FILE)).toBeUndefined();
  });

  it("leaves an empty section header behind rather than inventing a rewrite of the rest", () => {
    const only = `[mcp_servers.fixture]
command = "npx"
`;

    expect(tomlDriver.removeKeys(only, SECTION, ["fixture"], FILE)).toBe("");
  });
});

describe("the keys and strings it writes", () => {
  it("quotes a server name that is not a bare key, and finds it again afterwards", () => {
    const merged = merge(undefined, { key: "acme.fixture", value: { command: "npx" } });

    expect(merged).toBe(`[mcp_servers."acme.fixture"]
command = "npx"
`);
    // Written quoted and read back quoted, so the second install replaces the table rather than
    // appending a duplicate of it.
    expect(tomlDriver.sectionKeys(merged, SECTION, FILE)).toEqual(new Set(["acme.fixture"]));
    expect(merge(merged, { key: "acme.fixture", value: { command: "npx" } })).toBe(merged);
  });

  it("leaves a hyphenated header key bare, since TOML allows it", () => {
    // `"X-Api-Key" = ...` would also be legal, but nobody writes it that way by hand and looking
    // hand-written is the point.
    expect(merge(undefined, { key: "fixture", value: { http_headers: { "X-Api-Key": "${KEY}" } } }))
      .toBe(`[mcp_servers.fixture]

[mcp_servers.fixture.http_headers]
X-Api-Key = "\${KEY}"
`);
  });

  it("quotes a sub-table key TOML would not accept bare", () => {
    expect(merge(undefined, { key: "fixture", value: { env: { "not a bare key": "${KEY}" } } }))
      .toBe(`[mcp_servers.fixture]

[mcp_servers.fixture.env]
"not a bare key" = "\${KEY}"
`);
  });

  it("escapes what a TOML basic string cannot hold literally", () => {
    const merged = merge(undefined, {
      key: "fixture",
      value: { command: 'a"b\\c\td\ne' },
    });

    expect(merged).toBe(`[mcp_servers.fixture]
command = "a\\"b\\\\c\\td\\ne"
`);
  });

  it("renders booleans, numbers and arrays without quoting them", () => {
    expect(
      merge(undefined, {
        key: "fixture",
        value: { enabled: true, timeout: 30, args: ["-y", "pkg"] },
      }),
    ).toBe(`[mcp_servers.fixture]
enabled = true
timeout = 30
args = ["-y", "pkg"]
`);
  });

  it("preserves CRLF line endings", () => {
    const crlf = HANDWRITTEN.replaceAll("\n", "\r\n");

    const merged = merge(crlf, FIXTURE);

    expect(merged.startsWith(crlf)).toBe(true);
    // Every line, including the ones this merge added — a file that mixed endings would confuse both
    // git and the next reader.
    expect(merged.split("\r\n").length).toBe(merged.split("\n").length);
  });
});

describe("what it refuses to edit", () => {
  it("refuses a server declared as an inline table under [mcp_servers]", () => {
    const error = refusal(`[mcp_servers]
fixture = { command = "npx" }
`);

    expect(error.code).toBe(ExitCode.Config);
    expect(error.message).toBe(`cannot edit "mcp_servers" in ${FILE}`);
    expect(error.detail).toEqual([
      "line 2 sets `mcp_servers.fixture` outside a `[mcp_servers.<name>]` table",
      "rewrite it as a `[mcp_servers.<name>]` table, or move the file aside",
    ]);
  });

  it("refuses a dotted key under [mcp_servers]", () => {
    expect(
      refusal(`[mcp_servers]
fixture.command = "npx"
`).detail[0],
    ).toBe("line 2 sets `mcp_servers.fixture.command` outside a `[mcp_servers.<name>]` table");
  });

  it("refuses a dotted key at the document root", () => {
    expect(
      refusal(`model = "gpt-5-codex"
mcp_servers.fixture = { command = "npx" }
`).detail[0],
    ).toBe("line 2 sets `mcp_servers.fixture` outside a `[mcp_servers.<name>]` table");
  });

  it("refuses an array of tables", () => {
    const error = refusal(`[[mcp_servers.fixture]]
command = "npx"
`);

    expect(error.code).toBe(ExitCode.Config);
    expect(error.detail).toEqual([
      "line 1 declares `mcp_servers` as an array of tables",
      "rewrite it as `[mcp_servers.<name>]` tables, or move the file aside",
    ]);
  });

  it("edits a file whose *other* tables use the shapes it refuses for its own", () => {
    // The refusals are confined to the managed section. A person's inline tables and dotted keys
    // elsewhere are none of ambit's business, and refusing them would make the driver useless.
    const text = `profile = { name = "default" }
tools.web_search = true

[[history.entries]]
id = 1
`;

    expect(merge(text, FIXTURE)).toBe(`${text}
[mcp_servers.fixture]
command = "npx"
args = ["-y", "@acme/fixture-mcp"]
`);
  });
});

describe("what it refuses to render", () => {
  it("names itself as the culprit for an entry that is not a table", () => {
    let caught: AmbitError | undefined;
    try {
      merge(undefined, { key: "fixture", value: "npx" });
    } catch (error) {
      caught = error as AmbitError;
    }

    // A profile handing this driver a string is a bug in ambit, not something wrong with the file, and
    // the message has to say so or someone will go looking at their own config.
    expect(caught?.message).toBe(`cannot render "mcp_servers.fixture" for ${FILE} as TOML`);
    expect(caught?.detail).toEqual([
      "a managed entry must be a table of keys",
      "this is a bug in ambit; please report it",
    ]);
  });

  it("says the same for a value type TOML has no scalar for", () => {
    let caught: AmbitError | undefined;
    try {
      merge(undefined, { key: "fixture", value: { command: null } });
    } catch (error) {
      caught = error as AmbitError;
    }

    expect(caught?.message).toBe(`cannot render a value for ${FILE} as TOML`);
    expect(caught?.detail).toEqual([
      "unsupported value type: null",
      "this is a bug in ambit; please report it",
    ]);
  });
});

describe("reading the section", () => {
  it("names every server table, and nothing else in the file", () => {
    const text = `${HANDWRITTEN}
[mcp_servers.fixture]
command = "npx"

[mcp_servers.fixture.env]
KEY = "\${KEY}"

[mcp_servers."acme.other"]
command = "other"
`;

    expect(tomlDriver.sectionKeys(text, SECTION, FILE)).toEqual(new Set(["fixture", "acme.other"]));
  });

  it("reads an absent file, and a file with no servers, as holding none", () => {
    expect(tomlDriver.sectionKeys(undefined, SECTION, FILE)).toEqual(new Set());
    expect(tomlDriver.sectionKeys(HANDWRITTEN, SECTION, FILE)).toEqual(new Set());
  });
});

/**
 * Drift, for a format that cannot be compared structurally.
 *
 * The other two drivers parse and compare values, so reformatting is not drift. TOML has no such
 * option here, so the question is answered the only other honest way — would a merge change the
 * file — and a hand-reformatted table therefore *is* drift. That is a documented tradeoff, so it is
 * pinned rather than left as an accident.
 */
describe("whether an entry is already what install would write", () => {
  it("says yes for the table install wrote", () => {
    const text = merge(HANDWRITTEN, WITH_ENV);

    expect(tomlDriver.entryMatches(text, SECTION, WITH_ENV, FILE)).toBe(true);
  });

  it("says no for an absent file, an absent table, and a changed one", () => {
    expect(tomlDriver.entryMatches(undefined, SECTION, FIXTURE, FILE)).toBe(false);
    expect(tomlDriver.entryMatches(HANDWRITTEN, SECTION, FIXTURE, FILE)).toBe(false);
    expect(tomlDriver.entryMatches(merge(HANDWRITTEN, FIXTURE), SECTION, WITH_ENV, FILE)).toBe(
      false,
    );
  });

  it("reads a reformatted table as drift, which is the accepted cost of working lexically", () => {
    const reformatted = `[mcp_servers.fixture]
args = ["-y", "@acme/fixture-mcp"]
command = "npx"
`;

    expect(tomlDriver.entryMatches(reformatted, SECTION, FIXTURE, FILE)).toBe(false);
  });
});
