/**
 * The managed `.gitignore` block, as a text transformation.
 *
 * The whole claim is about lines ambit does not own: they must come back byte for byte, wherever
 * they sit relative to the block. So every case here pins the *surrounding* file as well as the
 * block, and the two ambiguous shapes — a second block, a block whose end marker is gone — are
 * asserted to stop rather than to pick a span of lines.
 *
 * The install-time behaviour is in `test/install.test.ts`; this is the part that needs no filesystem.
 */
import { describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  gitignoreEntries,
  removeGitignoreText,
  updateGitignoreText,
} from "../../src/project/gitignore.js";
import type { OwnedArtifact } from "../../src/model/state.js";

const SKILLS_DIR = ".agents/skills";
const ENTRIES = [".ambit/", `${SKILLS_DIR}/acme.core`];

/** The file as lines, which is how every assertion here reads. */
function lines(text: string | undefined): readonly string[] {
  expect(text).toBeDefined();
  return (text ?? "").split("\n");
}

/** Runs `body`, asserting it rejected the file as a config error (exit 2). */
function rejection(body: () => unknown): AmbitError {
  try {
    body();
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the managed block's contents", () => {
  it("lists ambit's state directory and every installed skill directory", () => {
    const artifacts: readonly OwnedArtifact[] = [
      { path: `${SKILLS_DIR}/acme.core`, kind: "skill-dir", mode: "link" },
      { path: `${SKILLS_DIR}/acme.frontend`, kind: "skill-dir", mode: "copy" },
    ];

    expect(gitignoreEntries(artifacts)).toEqual([
      ".ambit/",
      `${SKILLS_DIR}/acme.core`,
      `${SKILLS_DIR}/acme.frontend`,
    ]);
  });

  it("leaves a co-owned config file out: `.mcp.json` is a file a team commits", () => {
    const artifacts: readonly OwnedArtifact[] = [
      { path: ".mcp.json", kind: "harness-config", managedKeys: ["mcpServers.scoped"] },
    ];

    expect(gitignoreEntries(artifacts)).toEqual([".ambit/"]);
  });

  it("gives a skill directory no trailing slash, so the pattern also covers a symlinked one", () => {
    const artifacts: readonly OwnedArtifact[] = [
      { path: `${SKILLS_DIR}/acme.core`, kind: "skill-dir", mode: "link" },
    ];

    expect(gitignoreEntries(artifacts)).not.toContain(`${SKILLS_DIR}/acme.core/`);
  });
});

describe("writing the block into a file that has none", () => {
  it("creates the whole file when the project has no .gitignore", () => {
    expect(lines(updateGitignoreText(undefined, ENTRIES))).toEqual([
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("appends after the lines already there, separated by one blank line", () => {
    expect(lines(updateGitignoreText("node_modules/\ndist/\n", ENTRIES))).toEqual([
      "node_modules/",
      "dist/",
      "",
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("adds no second blank line to a file that already ends in one", () => {
    expect(lines(updateGitignoreText("node_modules/\n\n", ENTRIES))).toEqual([
      "node_modules/",
      "",
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("gives a file with no trailing newline one, rather than joining onto its last line", () => {
    expect(lines(updateGitignoreText("dist/", ENTRIES))).toEqual([
      "dist/",
      "",
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("sorts and deduplicates the paths, so two identical installs write identical bytes", () => {
    const shuffled = [`${SKILLS_DIR}/b`, ".ambit/", `${SKILLS_DIR}/a`, `${SKILLS_DIR}/b`];

    expect(updateGitignoreText(undefined, shuffled)).toBe(
      updateGitignoreText(undefined, [".ambit/", `${SKILLS_DIR}/a`, `${SKILLS_DIR}/b`]),
    );
  });

  it("escapes the glob characters that would make a path match something else", () => {
    expect(lines(updateGitignoreText(undefined, [`${SKILLS_DIR}/acme[core]`]))).toContain(
      `${SKILLS_DIR}/acme\\[core]`,
    );
  });
});

describe("rewriting a block that is already there", () => {
  const INSTALLED = updateGitignoreText("node_modules/\n", ENTRIES) ?? "";

  it("replaces the block in place, disturbing nothing above or below it", () => {
    const surrounded = `${INSTALLED}\n# mine\ncoverage/\n`;

    expect(lines(updateGitignoreText(surrounded, [".ambit/", `${SKILLS_DIR}/acme.other`]))).toEqual(
      [
        "node_modules/",
        "",
        expect.stringContaining(BLOCK_BEGIN),
        `${SKILLS_DIR}/acme.other`,
        ".ambit/",
        BLOCK_END,
        "",
        "# mine",
        "coverage/",
        "",
      ],
    );
  });

  it("drops a path the new install no longer owns", () => {
    const narrowed = updateGitignoreText(INSTALLED, [".ambit/"]) ?? "";

    expect(narrowed).not.toContain("acme.core");
    expect(lines(narrowed)).toEqual([
      "node_modules/",
      "",
      expect.stringContaining(BLOCK_BEGIN),
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("reports no change when the block already says what this install would write", () => {
    expect(updateGitignoreText(INSTALLED, ENTRIES)).toBeUndefined();
  });

  it("rewrites a block whose opening line was written by another version of ambit", () => {
    const older = `${BLOCK_BEGIN}\n.ambit/\n${BLOCK_END}\n`;

    expect(lines(updateGitignoreText(older, ENTRIES))).toEqual([
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });

  it("keeps a CRLF file's line endings on the lines it does not own", () => {
    const crlf = `node_modules/\r\ndist/\r\n${BLOCK_BEGIN}\r\n.ambit/\r\n${BLOCK_END}\r\n`;

    expect(lines(updateGitignoreText(crlf, ENTRIES))).toEqual([
      "node_modules/\r",
      "dist/\r",
      expect.stringContaining(BLOCK_BEGIN),
      `${SKILLS_DIR}/acme.core`,
      ".ambit/",
      BLOCK_END,
      "",
    ]);
  });
});

/**
 * Removing the block — what `clean` needs.
 *
 * The claim is the inverse of writing it: install then clean must give a file back exactly as it was,
 * so every case here compares against the *input* to `updateGitignoreText` rather than against a
 * hand-written expectation of what removal should leave.
 */
describe("removing the block", () => {
  it("gives a file that had lines of its own back byte for byte", () => {
    const before = "node_modules/\ndist/\n";

    expect(removeGitignoreText(updateGitignoreText(before, ENTRIES))).toBe(before);
  });

  it("reports an empty file when the block was the whole of it, so the caller deletes it", () => {
    expect(removeGitignoreText(updateGitignoreText(undefined, ENTRIES))).toBe("");
  });

  it("leaves the lines below the block where they were", () => {
    const surrounded = `${updateGitignoreText("node_modules/\n", ENTRIES) ?? ""}\n# mine\ncoverage/\n`;

    expect(lines(removeGitignoreText(surrounded))).toEqual([
      "node_modules/",
      "",
      "# mine",
      "coverage/",
      "",
    ]);
  });

  it("reports no change for a file that holds no block", () => {
    expect(removeGitignoreText("node_modules/\n")).toBeUndefined();
    expect(removeGitignoreText(undefined)).toBeUndefined();
  });

  it("exits 2 rather than guessing at an unterminated block", () => {
    const orphaned = `dist/\n${BLOCK_BEGIN}\n.ambit/\ncoverage/\n`;

    expect(rejection(() => removeGitignoreText(orphaned)).message).toContain(
      "unterminated ambit block",
    );
  });
});

describe("a .gitignore whose markers cannot be read", () => {
  it("exits 2 rather than choosing between two blocks", () => {
    const two = `${BLOCK_BEGIN}\n.ambit/\n${BLOCK_END}\ndist/\n${BLOCK_BEGIN}\n.ambit/\n${BLOCK_END}\n`;

    const error = rejection(() => updateGitignoreText(two, ENTRIES));

    expect(error.message).toContain("more than one ambit block");
    expect(error.format()).toContain("line 1 and line 5");
  });

  it("exits 2 rather than swallowing every line below an unterminated block", () => {
    const orphaned = `dist/\n${BLOCK_BEGIN}\n.ambit/\ncoverage/\n`;

    const error = rejection(() => updateGitignoreText(orphaned, ENTRIES));

    expect(error.message).toContain("unterminated ambit block");
    expect(error.format()).toContain("line 2");
    expect(error.format()).toContain(BLOCK_END);
  });
});
