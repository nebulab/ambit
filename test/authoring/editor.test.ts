/**
 * The catalog editor (spec §6, "Catalog authoring") — the guarantees every later mutation inherits.
 *
 * Two claims carry this suite, and both are about bytes rather than about behaviour. The first is
 * fidelity: a catalog is hand-maintained, so an edit that reformats a comment, reorders a key, or
 * rewraps a body is a bug even when the result parses identically. Every case here therefore asserts
 * whole files, not fields.
 *
 * The second is that a refusal costs nothing. A path outside the root and a result that would not
 * validate must both leave every file exactly as it was — which is only worth asserting against the
 * bytes, since an exit code says nothing about what was already half-written.
 *
 * Everything runs against a per-test copy of the fixture catalog. The shared fixture must stay clean:
 * it is what the golden profiles resolve against.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIXTURE_CATALOG_FILES, FIXTURE_MARKER, buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { CatalogDocument, applyCatalogEdit, mcpDocumentPath, skillDocumentPath } from "../../src/authoring/editor.js";
import { AmbitError, ExitCode } from "../../src/errors.js";
import { isValid, validateCatalogDirectory } from "../../src/resolution/validate.js";

/** The fixture's YAML-bearing files: everything but the marker, which is prose. */
const FIXTURE_DOCUMENTS = Object.keys(FIXTURE_CATALOG_FILES)
  .filter((file) => file !== FIXTURE_MARKER)
  .sort();

/** A skill carrying a harness key ambit knows nothing about, a comment, and a body. */
const ANNOTATED_SKILL_PATH = skillDocumentPath("acme.sales.use-close");

const ANNOTATED_SKILL = `---
name: acme.sales.use-close
description: Calls the Close CRM REST API.
# Bash stays out of this one: the skill only ever reads.
allowed-tools: [Read, Grep]
ambit:
  scopes: [core]
  requires:
    - acme.commons.use-company-context
  env: [CLOSE_API_KEY]
---

# Close CRM

The body, which no edit may touch.
`;

let root: string;
let catalogDir: string;

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

async function write(file: string, text: string): Promise<void> {
  const target = path.join(catalogDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

/** Every file in the catalog with its bytes, so "nothing was written" can be asserted as a whole. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const inner = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), inner);
      else files[inner] = await readFile(path.join(dir, entry.name), "utf8");
    }
  };
  await walk(catalogDir, "");
  return files;
}

/** Runs `body`, asserting it was rejected with `code`. */
async function rejection(body: () => Promise<unknown>, code: ExitCode): Promise<AmbitError> {
  try {
    await body();
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${code}: ${error.format()}`).toBe(code);
    return error;
  }
  throw new Error(`expected a rejection with exit ${code}`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-editor-"));
  catalogDir = path.join(root, "catalog");
  await buildFixtureCatalog(catalogDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the catalog editor: round-tripping", () => {
  it("re-emits every document of the fixture catalog byte-identically", async () => {
    // The whole premise of editing in place: if opening and re-rendering is not a no-op, then every
    // mutation carries an unrelated reformatting with it.
    expect(FIXTURE_DOCUMENTS.length).toBeGreaterThan(0);

    for (const file of FIXTURE_DOCUMENTS) {
      const document = await CatalogDocument.open(catalogDir, file);

      expect(document.text(), file).toBe(await read(file));
      expect(document.changed, file).toBe(false);
    }
  });

  it("keeps a trailing blank line, which the parser does not", async () => {
    // A parser drops what it reads as insignificant whitespace, so the bytes around the document have
    // to survive as bytes.
    await write("mcps/spaced.yml", "name: spaced\n\ntransport:\n  stdio:\n    command: spaced\n\n");

    const document = await CatalogDocument.open(catalogDir, "mcps/spaced.yml");

    expect(document.text()).toBe(await read("mcps/spaced.yml"));
  });

  it("adds a scope to a SKILL.md without disturbing anything else in it", async () => {
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const document = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);

    document.setStringList(["ambit", "scopes"], ["core", "function.engineering"]);
    await applyCatalogEdit(catalogDir, [document.change()]);

    // The unknown key, the comment above it, the key order, the flow layout of the list, the block
    // layout of `requires`, and the body: all as written.
    expect(await read(ANNOTATED_SKILL_PATH)).toBe(
      ANNOTATED_SKILL.replace("scopes: [core]", "scopes: [core, function.engineering]"),
    );
  });

  it("writes a list ambit adds as a block sequence, the way `emitYaml` would", async () => {
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL.replace("  env: [CLOSE_API_KEY]\n", ""));
    const document = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);

    document.setStringList(["ambit", "env"], ["CLOSE_API_KEY"]);

    // A key the author never wrote has no layout to preserve, so it takes ambit's own (spec §3.0),
    // and it lands after the keys that were already there rather than being sorted into them.
    expect(document.text()).toContain("  env:\n    - CLOSE_API_KEY\n---");
  });

  it("leaves an emptied list as an empty list rather than a null", async () => {
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const document = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);

    document.setStringList(["ambit", "requires"], []);

    // "declares none" and "says nothing" are different claims about a skill (spec §3.2), and only the
    // first survives a re-parse under §3.0, which rejects an explicit null.
    expect(document.text()).toContain("requires: []\n");
    expect(document.text()).not.toContain("requires:\n");
  });

  it("adds a registry entry without touching the comment above the file", async () => {
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");

    document.setString(["scopes", "function.sales", "description"], "Selling the work");
    await applyCatalogEdit(catalogDir, [document.change()]);

    const before = FIXTURE_CATALOG_FILES["scopes.yml"] ?? "";
    expect(await read("scopes.yml")).toBe(
      `${before}  function.sales:\n    description: Selling the work\n`,
    );
  });

  it("renames a set of keys in place, through a name one of them still holds", async () => {
    // Renaming a scope's subtree passes through a state where two entries share a name, so every pair has
    // to be located before any of them is touched — and each keeps its position and its comment, which
    // `remove` plus `setString` could not do.
    await write(
      "scopes.yml",
      [
        "scopes:",
        "  # Everyone.",
        "  core:",
        "    description: The floor",
        "  a:",
        "    description: A",
        "  a.b:",
        "    description: B",
        "",
      ].join("\n"),
    );
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");

    document.renameKeys(["scopes"], new Map([["a", "a.b"], ["a.b", "a.b.b"], ["absent", "x"]]));

    expect(document.text()).toBe(
      [
        "scopes:",
        "  # Everyone.",
        "  core:",
        "    description: The floor",
        "  a.b:",
        "    description: A",
        "  a.b.b:",
        "    description: B",
        "",
      ].join("\n"),
    );
  });

  it("creates the mappings a nested key needs, and reads back what it wrote", async () => {
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");

    expect(document.has(["scopes", "function.sales"])).toBe(false);
    document.setString(["scopes", "function.sales", "description"], "Selling the work");

    expect(document.has(["scopes", "function.sales", "description"])).toBe(true);
  });
});

describe("the catalog editor: writing", () => {
  it("writes nothing at all when the edit changes nothing", async () => {
    // Re-running a mutation must leave the catalog alone down to the modification time: a rewrite of
    // identical bytes still shows up in a build cache, and in a `git status` on a checkout.
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");
    const past = new Date("2001-01-01T00:00:00Z");
    await utimes(path.join(catalogDir, "scopes.yml"), past, past);

    const result = await applyCatalogEdit(catalogDir, [document.change()]);

    expect(result).toEqual({ changes: [], trees: [], written: false });
    expect((await stat(path.join(catalogDir, "scopes.yml"))).mtimeMs).toBe(past.getTime());
  });

  it("leaves no partial write behind", async () => {
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");
    document.setString(["scopes", "function.sales", "description"], "Selling the work");

    await applyCatalogEdit(catalogDir, [document.change()]);

    expect(Object.keys(await snapshot()).filter((file) => file.includes(".ambit-incoming"))).toEqual([]);
  });

  it("reports every changed file in path order, with the bytes it holds now", async () => {
    const registry = await CatalogDocument.open(catalogDir, "scopes.yml");
    registry.setString(["scopes", "function.sales", "description"], "Selling the work");
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const skill = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);
    skill.setStringList(["ambit", "scopes"], ["core", "function.sales"]);

    const result = await applyCatalogEdit(catalogDir, [skill.change(), registry.change()]);

    expect(result.written).toBe(true);
    expect(result.changes.map((change) => change.file)).toEqual([
      "scopes.yml",
      ANNOTATED_SKILL_PATH,
    ]);
    expect(result.changes[0]?.before).toBe(FIXTURE_CATALOG_FILES["scopes.yml"]);
  });

  it("judges an edit as a whole, so a change one file needs may live in another", async () => {
    // The claim the overlay exists for: neither half of this edit validates on its own — the skill
    // declares a scope nothing registers, and it is the same edit that registers it.
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const registry = await CatalogDocument.open(catalogDir, "scopes.yml");
    registry.setString(["scopes", "function.sales", "description"], "Selling the work");
    const skill = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);
    skill.setStringList(["ambit", "scopes"], ["core", "function.sales"]);

    const result = await applyCatalogEdit(catalogDir, [registry.change(), skill.change()]);

    expect(result.written).toBe(true);
    expect(isValid(await validateCatalogDirectory(catalogDir))).toBe(true);
  });

  it("creates a file, and validates it as part of the catalog it is joining", async () => {
    const file = skillDocumentPath("acme.sales.use-pipeline");
    const text = [
      "---",
      "name: acme.sales.use-pipeline",
      "ambit:",
      "  scopes: [core]",
      "---",
      "",
      "# Pipeline",
      "",
    ].join("\n");

    const result = await applyCatalogEdit(catalogDir, [{ file, text }]);

    expect(result.written).toBe(true);
    expect(await read(file)).toBe(text);
    expect((await validateCatalogDirectory(catalogDir)).checked.skills).toBe(5);
  });

  it("removes a file nothing depends on", async () => {
    const file = mcpDocumentPath("scoped");

    const result = await applyCatalogEdit(catalogDir, [{ file, text: null }]);

    expect(result.written).toBe(true);
    expect(await stat(path.join(catalogDir, file)).catch(() => undefined)).toBeUndefined();
    expect((await validateCatalogDirectory(catalogDir)).checked.mcps).toBe(1);
  });

  it("under `--dry-run`, validates and reports the change and writes none of it", async () => {
    const before = await snapshot();
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");
    document.setString(["scopes", "function.sales", "description"], "Selling the work");

    const result = await applyCatalogEdit(catalogDir, [document.change()], { dryRun: true });

    expect(result.written).toBe(false);
    expect(result.changes).toEqual([
      { file: "scopes.yml", text: document.text(), before: FIXTURE_CATALOG_FILES["scopes.yml"] },
    ]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("the catalog editor: refusals", () => {
  it("refuses a path that climbs above the catalog root, writing nothing", async () => {
    const escape = "../escaped.yml";

    const error = await rejection(
      () => applyCatalogEdit(catalogDir, [{ file: escape, text: "name: escaped\n" }]),
      ExitCode.Config,
    );

    expect(error.message).toBe(`refusing to write outside the catalog: "${escape}"`);
    expect(error.detail[0]).toBe("it climbs above the catalog root");
    expect(await stat(path.join(root, "escaped.yml")).catch(() => undefined)).toBeUndefined();
  });

  it("refuses an absolute path, which no report may carry either", async () => {
    const target = path.join(root, "escaped.yml");

    const error = await rejection(
      () => applyCatalogEdit(catalogDir, [{ file: target, text: "name: escaped\n" }]),
      ExitCode.Config,
    );

    expect(error.detail[0]).toBe("it is an absolute path");
    expect(await stat(target).catch(() => undefined)).toBeUndefined();
  });

  it("refuses to open a document outside the root before it reads anything", async () => {
    await writeFile(path.join(root, "outside.yml"), "name: outside\n", "utf8");

    const error = await rejection(
      () => CatalogDocument.open(catalogDir, "../outside.yml"),
      ExitCode.Config,
    );

    expect(error.message).toContain("refusing to write outside the catalog");
  });

  it("refuses a path outside the root even when another change is fine", async () => {
    const before = await snapshot();
    const document = await CatalogDocument.open(catalogDir, "scopes.yml");
    document.setString(["scopes", "function.sales", "description"], "Selling the work");

    await rejection(
      () =>
        applyCatalogEdit(catalogDir, [
          document.change(),
          { file: "../escaped.yml", text: "name: escaped\n" },
        ]),
      ExitCode.Config,
    );

    expect(await snapshot()).toEqual(before);
  });

  it("refuses a write whose result would not validate, leaving the file byte-identical", async () => {
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const document = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);
    document.setStringList(["ambit", "scopes"], ["core", "function.sails"]);

    const error = await rejection(
      () => applyCatalogEdit(catalogDir, [document.change()]),
      ExitCode.Resolution,
    );

    expect(error.message).toBe("refusing to write: the result would not validate");
    expect(error.detail).toContain(
      `unregistered scope "function.sails" (${ANNOTATED_SKILL_PATH})`,
    );
    expect(await read(ANNOTATED_SKILL_PATH)).toBe(ANNOTATED_SKILL);
  });

  it("says how many problems it found, and where the whole report is", async () => {
    await write(ANNOTATED_SKILL_PATH, ANNOTATED_SKILL);
    const document = await CatalogDocument.open(catalogDir, ANNOTATED_SKILL_PATH);
    document.setStringList(["ambit", "scopes"], ["one.unknown", "two.unknown"]);

    const error = await rejection(
      () => applyCatalogEdit(catalogDir, [document.change()]),
      ExitCode.Resolution,
    );

    expect(error.detail[0]).toBe("2 problems in the result, so nothing was written");
    expect(error.detail.at(-1)).toBe(
      `correct what this command was asked to change, or run \`ambit validate --catalog ${catalogDir}\` for the whole report`,
    );
  });

  it("refuses a removal that would leave a requirement dangling", async () => {
    // `acme.projects.use-acme-brief` requires `mcp.fixture`, so deleting the entity breaks the catalog
    // even though the file itself is unreferenced from anywhere else.
    const file = mcpDocumentPath("fixture");
    const before = await read(file);

    const error = await rejection(
      () => applyCatalogEdit(catalogDir, [{ file, text: null }]),
      ExitCode.Resolution,
    );

    expect(error.detail).toContain(
      `unresolvable requirement "mcp.fixture" (skills/acme/projects/use-acme-brief/SKILL.md)`,
    );
    expect(await read(file)).toBe(before);
  });

  it("refuses a document that does not parse rather than rewriting it", async () => {
    await write("mcps/broken.yml", "name: broken\n\ttransport: {}\n");

    const error = await rejection(
      () => CatalogDocument.open(catalogDir, "mcps/broken.yml"),
      ExitCode.Config,
    );

    expect(error.message).toContain("YAML does not permit tabs for indentation");
  });

  it("refuses a file that is not there", async () => {
    const error = await rejection(
      () => CatalogDocument.open(catalogDir, mcpDocumentPath("absent")),
      ExitCode.Config,
    );

    expect(error.message).toBe("cannot read mcps/absent.yml");
  });
});
