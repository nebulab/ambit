import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  FIXTURE_MARKER,
  buildFixtureCatalog,
  buildFixtureGitCatalog,
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

const EXPECTED_FILES = [
  FIXTURE_MARKER,
  "mcps/fixture.yml",
  "mcps/scoped.yml",
  "scopes.yml",
  "skills/acme/commons/use-company-context/SKILL.md",
  "skills/acme/engineering/frontend/use-design-tokens/SKILL.md",
  "skills/acme/engineering/use-code-review/SKILL.md",
  "skills/acme/projects/use-acme-brief/SKILL.md",
].sort();

const SKILL_PATHS = EXPECTED_FILES.filter((file) => file.endsWith("SKILL.md"));

/** The name↔path convention from spec §2: path under `skills/`, with `/` → `.`. */
function nameFromPath(skillPath: string): string {
  return path.posix.dirname(skillPath).replace(/^skills\//, "").replaceAll("/", ".");
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

  it("registers every scope a skill or MCP declares, with a description", async () => {
    const registry = parse(await readFile(path.join(dir, "scopes.yml"), "utf8")) as {
      scopes: Record<string, { description: string }>;
    };

    expect(Object.keys(registry.scopes).sort()).toEqual([
      "core",
      "function.engineering",
      "function.engineering.frontend",
      "project.acme",
    ]);
    for (const [name, entry] of Object.entries(registry.scopes)) {
      expect(entry.description, `${name} has no description`).toBeTruthy();
    }

    const declared = new Set<string>();
    for (const skill of SKILL_PATHS) {
      for (const scope of (frontmatter(await readFile(path.join(dir, skill), "utf8")).scopes ??
        []) as string[]) {
        declared.add(scope);
      }
    }
    for (const mcp of ["mcps/fixture.yml", "mcps/scoped.yml"]) {
      const entity = parse(await readFile(path.join(dir, mcp), "utf8")) as { scopes?: string[] };
      for (const scope of entity.scopes ?? []) declared.add(scope);
    }

    for (const scope of declared) {
      expect(Object.keys(registry.scopes), `${scope} is unregistered`).toContain(scope);
    }
  });

  it("names every skill after its path", async () => {
    for (const skill of SKILL_PATHS) {
      const meta = frontmatter(await readFile(path.join(dir, skill), "utf8"));
      expect(meta.name).toBe(nameFromPath(skill));
      expect(meta.description).toBeTruthy();
    }
  });

  it("covers one skill per scope, including a nested one", async () => {
    const scopesByName: Record<string, unknown> = {};
    for (const skill of SKILL_PATHS) {
      const meta = frontmatter(await readFile(path.join(dir, skill), "utf8"));
      scopesByName[meta.name as string] = meta.scopes;
    }

    expect(scopesByName).toEqual({
      "acme.commons.use-company-context": ["core"],
      "acme.engineering.use-code-review": ["function.engineering"],
      "acme.engineering.frontend.use-design-tokens": ["function.engineering.frontend"],
      "acme.projects.use-acme-brief": ["project.acme"],
    });
  });

  it("has a project skill that reaches a skill and an MCP by requires alone", async () => {
    const meta = frontmatter(
      await readFile(path.join(dir, "skills/acme/projects/use-acme-brief/SKILL.md"), "utf8"),
    );

    expect(meta.requires).toEqual(["acme.commons.use-company-context", "mcp.fixture"]);
  });

  it("declares env vars a bundle can be missing", async () => {
    const frontend = frontmatter(
      await readFile(
        path.join(dir, "skills/acme/engineering/frontend/use-design-tokens/SKILL.md"),
        "utf8",
      ),
    );

    expect(frontend.env).toEqual(["ACME_FIGMA_TOKEN"]);
  });

  it("defines a requires-only stdio server and a scoped http server", async () => {
    const required = parse(await readFile(path.join(dir, "mcps/fixture.yml"), "utf8"));
    const scoped = parse(await readFile(path.join(dir, "mcps/scoped.yml"), "utf8"));

    expect(required).toEqual({
      name: "fixture",
      transport: { stdio: { command: "npx", args: ["-y", "@acme/fixture-mcp"] } },
      env: ["FIXTURE_API_KEY"],
    });
    expect(scoped).toEqual({
      name: "scoped",
      scopes: ["function.engineering"],
      transport: {
        http: {
          url: "https://mcp.invalid/fixture",
          headers: { Authorization: "Bearer ${SCOPED_API_KEY}" },
        },
      },
      env: ["SCOPED_API_KEY"],
    });

    // `transport` is the discriminator, so it must never carry more or less than one kind.
    for (const entity of [required, scoped] as { transport: Record<string, unknown> }[]) {
      expect(Object.keys(entity.transport)).toHaveLength(1);
    }
  });

  it("names each MCP entity after its filename stem", async () => {
    for (const file of ["mcps/fixture.yml", "mcps/scoped.yml"]) {
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
    await writeFile(path.join(dir, "scopes.yaml"), "scopes: {}\n", "utf8");
    await mkdir(path.join(dir, "skills/acme/stale"), { recursive: true });
    await writeFile(path.join(dir, "skills/acme/stale/SKILL.md"), "---\nname: stale\n---\n", "utf8");

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
 * The same catalog as a local bare repository, which is how git sources are tested offline
 * (spec §7).
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
});
