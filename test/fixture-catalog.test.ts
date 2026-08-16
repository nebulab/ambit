import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parse } from "yaml";

import {
  FIXTURE_MARKER,
  buildFixtureCatalog,
  buildFixtureGitCatalog,
  commitFixtureGitRevision,
} from "../scripts/fixture-catalog.js";

/** Every file under `dir`, as `/`-separated relative paths, sorted. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(path.join(dir, entry.name), relative)));
    } else {
      found.push(relative);
    }
  }
  return found.sort();
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const relative of await listFiles(dir)) {
    contents[relative] = await readFile(path.join(dir, relative), "utf8");
  }
  return contents;
}

/** Splits a `---`-delimited frontmatter block off the top of a document. */
function frontmatter(source: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  expect(match, "document has no frontmatter block").not.toBeNull();
  return parse(match![1]!) as Record<string, unknown>;
}

/**
 * The `ambit:` block of a frontmatter, where every annotation §3.2 defines lives.
 *
 * Read through the raw `yaml` parser rather than through ambit's own, like everything else in this
 * file: the fixture is what proves ambit's parser right, so a test that used it to read the fixture
 * would prove nothing.
 */
function annotations(source: string): Record<string, unknown> {
  const block = frontmatter(source).ambit;
  expect(block, "frontmatter has no `ambit:` block").toBeTypeOf("object");
  return (block ?? {}) as Record<string, unknown>;
}

const EXPECTED_FILES = [
  FIXTURE_MARKER,
  "hooks/acme-standup/hook.yml",
  "hooks/guard-secrets/hook.yml",
  "hooks/guard-secrets/guard.sh",
  "hooks/session-notes/hook.yml",
  "mcps/fixture.yml",
  "mcps/linter.yml",
  "packs/core.yml",
  "packs/function/engineering.yml",
  "packs/function/engineering/frontend.yml",
  "packs/project/acme.yml",
  "skills/company-context/SKILL.md",
  "skills/design-tokens/SKILL.md",
  "skills/code-review/SKILL.md",
  "skills/acme-brief/SKILL.md",
].sort();

const SKILL_PATHS = EXPECTED_FILES.filter((file) => file.endsWith("SKILL.md"));

const HOOK_PATHS = EXPECTED_FILES.filter((file) => file.endsWith("hook.yml"));

const PACK_PATHS = EXPECTED_FILES.filter((file) => file.startsWith("packs/"));

/** The name↔path convention, which hooks share with skills: path under `dirname`, `/` → `.`. */
function nameFromPath(documentPath: string, dirname: "skills" | "hooks"): string {
  return path.posix
    .dirname(documentPath)
    .replace(new RegExp(`^${dirname}/`), "")
    .replaceAll("/", ".");
}

describe("fixture catalog", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ambit-fixture-"));
    dir = path.join(root, "catalog");
    await buildFixtureCatalog(dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes exactly the expected tree", async () => {
    expect(await listFiles(dir)).toEqual(EXPECTED_FILES);
  });

  it("carries no catalog-side config, and groups its items into packs instead", async () => {
    // A catalog is a directory and nothing else, so the interesting claim is what the fixture does
    // *not* hold. What replaced the free-form labels is a document per grouping, so the groupings can
    // be listed — which is exactly what this reads.
    expect(EXPECTED_FILES).not.toContain("scopes.yml");
    expect(EXPECTED_FILES).not.toContain("ambit.yml");

    const declared: string[] = [];
    for (const pack of PACK_PATHS) {
      const parsed = parse(await readFile(path.join(dir, pack), "utf8")) as {
        name: string;
        description?: string;
      };
      expect(parsed.description, `${pack} has no description`).toBeTruthy();
      declared.push(parsed.name);
    }

    expect(declared.sort()).toEqual([
      "core",
      "function.engineering",
      "function.engineering.frontend",
      "project.acme",
    ]);
  });

  it("names every pack after its path, nested or flat", async () => {
    // A pack is a file rather than a directory, and its name is still its path with the extension
    // dropped and `/` read as `.` — so the fixture ships one at each depth.
    for (const pack of PACK_PATHS) {
      const parsed = parse(await readFile(path.join(dir, pack), "utf8")) as { name: string };
      const derived = pack
        .replace(/^packs\//, "")
        .replace(/\.yml$/, "")
        .replaceAll("/", ".");
      expect(parsed.name).toBe(derived);
    }
  });

  it("names every skill after its path", async () => {
    for (const skill of SKILL_PATHS) {
      const meta = frontmatter(await readFile(path.join(dir, skill), "utf8"));
      expect(meta.name).toBe(nameFromPath(skill, "skills"));
      expect(meta.description).toBeTruthy();
    }
  });

  it("names every hook after its path", async () => {
    for (const hook of HOOK_PATHS) {
      const entity = parse(await readFile(path.join(dir, hook), "utf8")) as {
        name: string;
        description?: string;
      };
      expect(entity.name).toBe(nameFromPath(hook, "hooks"));
      expect(entity.description).toBeTruthy();
    }
  });

  it("gathers one skill into each pack, one of them through another pack", async () => {
    const membership: Record<string, unknown> = {};
    for (const pack of PACK_PATHS) {
      const parsed = parse(await readFile(path.join(dir, pack), "utf8")) as {
        name: string;
        requires: unknown;
      };
      membership[parsed.name] = parsed.requires;
    }

    expect(membership).toEqual({
      core: [{ skill: "company-context" }, { hook: "session-notes" }],
      "function.engineering": [
        { pack: "core" },
        { skill: "code-review" },
        { mcp: "linter" },
        { hook: "guard-secrets" },
      ],
      "function.engineering.frontend": [
        { pack: "function.engineering" },
        { skill: "design-tokens" },
      ],
      "project.acme": [{ skill: "acme-brief" }],
    });
  });

  it("has a project skill that reaches a skill, an MCP and a hook by requires alone", async () => {
    const meta = annotations(await readFile(path.join(dir, "skills/acme-brief/SKILL.md"), "utf8"));

    // One key per entry, naming a namespace, unqualified — read through the raw parser, so this is
    // the document's shape rather than ambit's reading of it.
    expect(meta.requires).toEqual([
      { skill: "company-context" },
      { mcp: "fixture" },
      { hook: "acme-standup" },
    ]);
  });

  it("declares preconditions a bundle can be missing", async () => {
    const frontend = annotations(
      await readFile(path.join(dir, "skills/design-tokens/SKILL.md"), "utf8"),
    );

    expect(frontend.expects).toEqual([{ env: "ACME_FIGMA_TOKEN" }]);
  });

  it("defines a requires-only stdio server and a packed http server", async () => {
    const required = parse(await readFile(path.join(dir, "mcps/fixture.yml"), "utf8"));
    const packed = parse(await readFile(path.join(dir, "mcps/linter.yml"), "utf8"));

    expect(required).toEqual({
      name: "fixture",
      transport: { stdio: { command: "npx", args: ["-y", "@acme/fixture-mcp"] } },
      expects: [{ env: "FIXTURE_API_KEY" }],
    });
    expect(packed).toEqual({
      name: "linter",
      transport: {
        http: {
          url: "https://mcp.invalid/fixture",
          headers: { Authorization: "Bearer ${LINTER_API_KEY}" },
        },
      },
      expects: [{ env: "LINTER_API_KEY" }],
    });

    // `transport` is the discriminator, so it must never carry more or less than one kind.
    for (const entity of [required, packed] as { transport: Record<string, unknown> }[]) {
      expect(Object.keys(entity.transport)).toHaveLength(1);
    }
  });

  it("defines an inline hook, a script-shipping hook, and a requires-only hook", async () => {
    const read = async (file: string): Promise<unknown> =>
      parse(await readFile(path.join(dir, file), "utf8"));

    expect(await read("hooks/session-notes/hook.yml")).toEqual({
      name: "session-notes",
      description: "Reminds a session that Acme's conventions apply.",
      event: "SessionStart",
      type: "command",
      command: 'echo "acme conventions apply"',
    });
    expect(await read("hooks/guard-secrets/hook.yml")).toEqual({
      name: "guard-secrets",
      description: "Inspects a Bash command before Acme's tooling runs it.",
      event: "PreToolUse",
      matcher: "Bash",
      type: "script",
      command: "guard.sh",
      timeout: 10,
    });
    expect(await read("hooks/acme-standup/hook.yml")).toEqual({
      name: "acme-standup",
      description: "Records what the session touched, for the Acme standup.",
      event: "SessionEnd",
      type: "command",
      command: 'echo "acme session ended"',
    });
  });

  it("ships the script its script-shipping hook names, and only there", async () => {
    // A `type: script` hook is the only one that ships bytes, so the fixture's proof of the
    // distinction is the file's presence: one hook's `command` names a file beside its `hook.yml`,
    // and the other two directories hold nothing but their own document.
    const shipped = HOOK_PATHS.map((hook) => path.posix.dirname(hook)).filter((hookDir) =>
      EXPECTED_FILES.some((file) => file.startsWith(`${hookDir}/`) && !file.endsWith("hook.yml")),
    );

    expect(shipped).toEqual(["hooks/guard-secrets"]);
    expect(await readFile(path.join(dir, "hooks/guard-secrets/guard.sh"), "utf8")).toContain(
      "#!/bin/sh",
    );
  });

  it("ships that script executable, since a harness runs it rather than reading it", async () => {
    // Found by the manual end-to-end (`plan.md` §Verification): the hook installed correctly and
    // Claude Code still could not fire it, because `/bin/sh` answered `Permission denied`. The bit is
    // part of what the catalog ships — `test/project/hooks.test.ts` chmods its own script for the
    // same reason, and this fixture is what the end-to-end and the git-source tests install.
    const mode = (await lstat(path.join(dir, "hooks/guard-secrets/guard.sh"))).mode;

    expect(mode & 0o111).toBe(0o111);
  });

  it("names each MCP entity after its filename stem", async () => {
    for (const file of ["mcps/fixture.yml", "mcps/linter.yml"]) {
      const entity = parse(await readFile(path.join(dir, file), "utf8")) as { name: string };
      expect(entity.name).toBe(path.posix.basename(file, ".yml"));
    }
  });

  it("is idempotent — a rebuild reproduces the tree byte for byte", async () => {
    const before = await snapshot(dir);
    await buildFixtureCatalog(dir);

    expect(await snapshot(dir)).toEqual(before);
  });

  it("removes stale files left by a previous build", async () => {
    await writeFile(path.join(dir, "stale.yml"), "name: stale\n", "utf8");
    await mkdir(path.join(dir, "skills/stale"), { recursive: true });
    await writeFile(path.join(dir, "skills/stale/SKILL.md"), "---\nname: stale\n---\n", "utf8");

    await buildFixtureCatalog(dir);

    expect(await listFiles(dir)).toEqual(EXPECTED_FILES);
  });

  it("refuses to overwrite a directory it did not create", async () => {
    const foreign = path.join(root, "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "notes.md"), "mine\n", "utf8");

    await expect(buildFixtureCatalog(foreign)).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(path.join(foreign, "notes.md"), "utf8")).toBe("mine\n");
  });

  it("builds into an existing empty directory", async () => {
    const empty = path.join(root, "empty");
    await mkdir(empty, { recursive: true });

    await expect(buildFixtureCatalog(empty)).resolves.toBe(empty);
    expect(await listFiles(empty)).toEqual(EXPECTED_FILES);
  });
});

/**
 * The same catalog as a local bare repository, which is how git sources are tested offline.
 */
describe("fixture git catalog", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ambit-fixture-git-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commits the fixture tree at a commit two builds agree on", async () => {
    const first = await buildFixtureGitCatalog(path.join(root, "a"));
    const second = await buildFixtureGitCatalog(path.join(root, "b"));

    // Fixed identity and dates, so the SHA is a property of the fixture rather than of the run —
    // which is what lets a test name the cache path a fetch produces.
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(second.commit).toBe(first.commit);
    expect(first.url).toBe(`file://${first.repo}`);
    expect(await readFile(path.join(first.repo, "HEAD"), "utf8")).toBe(
      `ref: refs/heads/${first.branch}\n`,
    );
  });

  it("moves the branch and leaves the tag behind when a second revision is committed", async () => {
    const fixture = await buildFixtureGitCatalog(path.join(root, "a"));

    const moved = await commitFixtureGitRevision(fixture, {
      "skills/second/SKILL.md": "---\nname: second\nambit:\n  tags: [core]\n---\n\n# second\n",
    });

    const git = promisify(execFile);
    const revision = async (ref: string): Promise<string> =>
      (
        await git("git", ["--git-dir", fixture.repo, "rev-parse", ref], { encoding: "utf8" })
      ).stdout.trim();

    // What `ambit outdated` needs and no other suite does: one repository whose branch has somewhere
    // new to point and whose tag still names the commit the first build made.
    expect(moved).not.toBe(fixture.commit);
    expect(await revision(fixture.branch)).toBe(moved);
    expect(await revision(fixture.tag)).toBe(fixture.commit);
  });

  it("records the hook script as executable in the commit", async () => {
    const { repo, commit } = await buildFixtureGitCatalog(path.join(root, "a"));

    // git stores only the one bit, as `100755` — which is what carries the fixture's exec bit through
    // a `git:` source, the path `test/model/git-source.test.ts` installs from.
    const { stdout } = await promisify(execFile)(
      "git",
      ["--git-dir", repo, "ls-tree", commit, "hooks/guard-secrets/guard.sh"],
      { encoding: "utf8" },
    );

    expect(stdout).toMatch(/^100755 blob /);
  });
});
