/**
 * The diff renderer every authoring `--dry-run` prints through.
 *
 * The claims here are the ones a preview is only useful if it keeps: that a surgical edit renders as a
 * surgical diff rather than as a whole rewritten file — which is what tells a reader the mutation did
 * only what it said — and that one edit renders exactly one way, since a preview whose shape depends on
 * how the lines happened to be walked is a preview nobody can diff between runs.
 */
import { describe, expect, it } from "vitest";

import { changeKindOf, diffLines, diffSection } from "../../src/cli/diff.js";

/** Enough lines that context and elision are both exercised. */
function numbered(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
}

describe("diffLines", () => {
  it("renders a created file as nothing but additions", () => {
    expect(diffLines("", "one\ntwo\n")).toEqual(["+ one", "+ two"]);
  });

  it("renders a removed file as nothing but removals", () => {
    expect(diffLines("one\ntwo\n", "")).toEqual(["- one", "- two"]);
  });

  it("is empty when the two texts are the same", () => {
    expect(diffLines("one\n", "one\n")).toEqual([]);
  });

  it("shows an appended line with the lines above it for context", () => {
    // The shape a key appended to a nested mapping produces. A reader has to be able to see where in
    // the file it landed, which is what the context lines are for.
    const before = "headers:\n  A: one\n  B: two\n";
    const after = `${before}  C: three\n`;

    expect(diffLines(before, after)).toEqual([
      "  headers:",
      "    A: one",
      "    B: two",
      "+   C: three",
    ]);
  });

  it("shows a replaced line as a removal and an addition, in that order", () => {
    expect(diffLines("a\nb\nc\n", "a\nB\nc\n")).toEqual(["  a", "- b", "+ B", "  c"]);
  });

  it("elides the unchanged middle of a long file", () => {
    const before = numbered(20);
    const after = `changed\n${before.slice(before.indexOf("\n") + 1)}`;

    const lines = diffLines(before, after);

    // Three lines of context after the change, then the elision marker standing in for the rest.
    expect(lines).toEqual(["- line 1", "+ changed", "  line 2", "  line 3", "  line 4", "..."]);
  });

  it("shows two distant changes as two elided regions rather than one span", () => {
    const before = numbered(20);
    const after = before.replace("line 2\n", "second\n").replace("line 19\n", "nineteenth\n");

    const lines = diffLines(before, after);

    expect(lines.filter((line) => line === "...")).toHaveLength(1);
    expect(lines).toContain("+ second");
    expect(lines).toContain("+ nineteenth");
    expect(lines.some((line) => line === "  line 10")).toBe(false);
  });

  it("writes a blank added line as a bare `+`, carrying no trailing space", () => {
    // Every line of ambit's output is trimmed of trailing whitespace, and a diff is output.
    expect(diffLines("a\n", "a\n\nb\n")).toEqual(["  a", "+", "+ b"]);
  });

  it("renders a file with no final newline without inventing a line", () => {
    expect(diffLines("a", "a\nb")).toEqual(["  a", "+ b"]);
  });

  it("renders the same edit identically however the lines repeat", () => {
    // A file of repeated lines is where a diff algorithm's tie-breaking shows: the answer has to be a
    // function of the two texts, not of the walk.
    const before = "x\nx\nx\n";
    const after = "x\nx\n";

    expect(diffLines(before, after)).toEqual(diffLines(before, after));
    expect(diffLines(before, after)).toEqual(["  x", "  x", "- x"]);
  });
});

describe("changeKindOf", () => {
  it("reads a file with no prior bytes as created", () => {
    expect(changeKindOf({ file: "a.yml", text: "a\n" })).toBe("created");
  });

  it("reads a null text as removed", () => {
    expect(changeKindOf({ file: "a.yml", text: null, before: "a\n" })).toBe("removed");
  });

  it("reads bytes replacing bytes as updated", () => {
    expect(changeKindOf({ file: "a.yml", text: "b\n", before: "a\n" })).toBe("updated");
  });
});

describe("diffSection", () => {
  it("titles and counts the block, and closes it with a blank line", () => {
    const lines = diffSection("diff", [{ file: "a.yml", text: "one\n" }]);

    expect(lines).toEqual(["diff (1)", "  a.yml (created)", "    + one", ""]);
  });

  it("separates one file's block from the next with a blank line", () => {
    const lines = diffSection("diff", [
      { file: "a.yml", text: "one\n" },
      { file: "b.yml", text: null, before: "two\n" },
    ]);

    expect(lines).toEqual([
      "diff (2)",
      "  a.yml (created)",
      "    + one",
      "",
      "  b.yml (removed)",
      "    - two",
      "",
    ]);
  });

  it("says `(none)` for an edit that changes nothing, the way every other section does", () => {
    expect(diffSection("diff", [])).toEqual(["diff (0)", "  (none)", ""]);
  });
});
