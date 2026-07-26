/**
 * The `source` grammar and the cache layout (spec §3.1, §5).
 *
 * These are the two pure halves of fetching, and both are worth pinning on their own: the grammar
 * because a format that stops being recognized turns a working config into an error message, and the
 * cache key because it decides when two projects share a clone — a silent change there costs a
 * refetch, or worse, hands one repository's contents back for another's URL.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AmbitError, ExitCode } from "../../src/errors.js";
import { CACHE_DIRNAME, cacheRoot, gitCacheKey } from "../../src/model/git.js";
import type { Source } from "../../src/model/sources.js";
import { parseSource } from "../../src/model/sources.js";

const SUBJECT = 'catalog "company"';
const WHERE = "(ambit.yml)";

function parse(source: string, ref?: string): Source {
  return parseSource({
    source,
    ...(ref !== undefined && { ref }),
    subject: SUBJECT,
    where: WHERE,
  });
}

/** Parses a source, asserting it was rejected as a config error (exit 2). */
function rejection(source: string, ref?: string): AmbitError {
  try {
    parse(source, ref);
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error(`expected \`${source}\` to be rejected`);
}

describe("source formats", () => {
  it("reads a bare `owner/repo` as a GitHub repository", () => {
    expect(parse("acme/skills")).toEqual({
      kind: "git",
      url: "https://github.com/acme/skills.git",
    });
  });

  it("takes the ref from an `owner/repo@ref` shorthand", () => {
    expect(parse("acme/skills@v1.2.0")).toEqual({
      kind: "git",
      url: "https://github.com/acme/skills.git",
      ref: "v1.2.0",
    });
  });

  it("accepts a shorthand ref that agrees with the entry's own", () => {
    expect(parse("acme/skills@main", "main")).toMatchObject({ ref: "main" });
  });

  it("refuses a shorthand ref that contradicts the entry's own", () => {
    const error = rejection("acme/skills@v1", "v2");

    expect(error.message).toBe(`${SUBJECT} names two refs ${WHERE}`);
    expect(error.detail.join("\n")).toContain('`source` ends with "@v1" and `ref` says "v2"');
  });

  it("takes an https URL exactly as written", () => {
    expect(parse("https://github.com/acme/skills", "main")).toEqual({
      kind: "git",
      url: "https://github.com/acme/skills",
      ref: "main",
    });
  });

  it("takes an ssh remote exactly as written", () => {
    expect(parse("git@github.com:acme/skills.git")).toEqual({
      kind: "git",
      url: "git@github.com:acme/skills.git",
    });
  });

  it("hands git whatever follows `git:`", () => {
    expect(parse("git:ssh://build@git.acme.test:2222/srv/skills.git")).toEqual({
      kind: "git",
      url: "ssh://build@git.acme.test:2222/srv/skills.git",
    });
  });

  it("reads `path:` as a directory, prefix stripped", () => {
    expect(parse("path:../catalog")).toEqual({ kind: "path", directory: "../catalog" });
  });

  it("refuses a source in no recognized format", () => {
    // A bare relative path is the mistake worth catching: `path:` is what expresses it.
    const error = rejection("../catalog");

    expect(error.message).toBe(`${SUBJECT} has an unrecognized source ${WHERE}`);
    expect(error.detail.join("\n")).toContain("use owner/repo, a git URL");
  });

  it("refuses a `path:` naming no directory", () => {
    expect(rejection("path:").message).toBe(`${SUBJECT} has an empty path source ${WHERE}`);
  });

  it("refuses a `git:` naming no repository", () => {
    expect(rejection("git:").message).toBe(`${SUBJECT} has an empty git source ${WHERE}`);
  });
});

describe("the cache key", () => {
  it("keys a repository by host, owner, and name", () => {
    expect(gitCacheKey("https://github.com/acme/skills.git")).toBe("github.com/acme/skills");
  });

  it("keys the two spellings of one repository the same way, so it is cloned once", () => {
    expect(gitCacheKey("https://github.com/acme/skills")).toBe(
      gitCacheKey("https://github.com/acme/skills.git"),
    );
  });

  it("keys an ssh remote by the host it names, not by the user", () => {
    expect(gitCacheKey("git@git.acme.test:acme/skills.git")).toBe("git.acme.test/acme/skills");
  });

  it("keys a URL with a port and a deep path by every segment", () => {
    expect(gitCacheKey("ssh://build@git.acme.test:2222/team/acme/skills.git")).toBe(
      "git.acme.test/team/acme/skills",
    );
  });

  it("keys a local repository under `local`", () => {
    expect(gitCacheKey("file:///srv/git/skills.git")).toBe("local/srv/git/skills");
  });

  it("keeps a key inside the cache, whatever a URL puts in a segment", () => {
    const key = gitCacheKey("https://git.acme.test/../../etc/skills.git");

    expect(key.split("/")).not.toContain("..");
    expect(path.resolve("/cache", key).startsWith("/cache/")).toBe(true);
  });
});

describe("the cache location", () => {
  it("sits under XDG_CACHE_HOME when the environment names one", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "/tmp/xdg", HOME: "/home/jane" })).toBe(
      path.join("/tmp/xdg", CACHE_DIRNAME),
    );
  });

  it("falls back to ~/.cache", () => {
    expect(cacheRoot({ HOME: "/home/jane" })).toBe(path.join("/home/jane", ".cache", CACHE_DIRNAME));
  });

  it("ignores an XDG_CACHE_HOME set to nothing", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "", HOME: "/home/jane" })).toBe(
      path.join("/home/jane", ".cache", CACHE_DIRNAME),
    );
  });
});
