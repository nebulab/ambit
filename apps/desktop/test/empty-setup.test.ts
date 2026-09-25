import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  applyEmptySetup,
  inspectLocalCatalog,
  previewEmptySetup,
  previewExistingLocalCatalog,
  retryEmptySetup,
} from "../../../src/project/empty-setup.js";
import { installProject } from "../../../src/project/install.js";
import { withSetupLock } from "../../../src/project/operation-lock.js";
import { loadProjectConfig } from "../../../src/model/config.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ambit-desktop-create-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("empty Personal setup", () => {
  it("adds a catalog to an existing yaml config while preserving other bytes", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "ambit-local-catalog-"));

    try {
      const original =
        "# My setup\nversion: 1\nharnesses: [codex] # keep this\ncatalogs: []\nrequires: []\n";

      await writeFile(path.join(home, "ambit.yaml"), original);
      const catalog = await inspectLocalCatalog(folder, "example");
      const review = await previewExistingLocalCatalog(home, catalog);

      expect(await readFile(path.join(home, "ambit.yaml"), "utf8")).toBe(original);
      expect(review.configText).toContain("harnesses: [codex] # keep this");
      expect(await applyEmptySetup(review)).toEqual({ status: "installed" });
      expect(await readdir(home)).not.toContain("ambit.yml");
      expect((await loadProjectConfig(home)).catalogs).toEqual([
        { name: "example", source: `path:${folder}` },
      ]);
      expect(await readFile(path.join(home, "ambit.yaml"), "utf8")).toBe(review.configText);
      expect(await readdir(folder)).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("rejects an external edit to an existing setup after review", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "ambit-local-catalog-"));

    try {
      const original = "version: 1\nharnesses: [codex]\n";

      await writeFile(path.join(home, "ambit.yaml"), original);
      const review = await previewExistingLocalCatalog(
        home,
        await inspectLocalCatalog(folder, "local"),
      );

      await writeFile(path.join(home, "ambit.yaml"), `${original}# outside edit\n`);

      await expect(applyEmptySetup(review)).rejects.toThrow("changed since review");
      expect(await readFile(path.join(home, "ambit.yaml"), "utf8")).toBe(
        `${original}# outside edit\n`,
      );
      expect(await readdir(home)).toEqual(["ambit.yaml"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("connects a verified local catalog without authoring files in it", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "ambit-local-catalog-"));

    try {
      await mkdir(path.join(folder, "skills", "sample"), { recursive: true });
      await writeFile(
        path.join(folder, "skills", "sample", "SKILL.md"),
        "---\nname: sample\ndescription: Example\n---\n# Sample\n",
      );
      const before = await readFile(path.join(folder, "skills", "sample", "SKILL.md"), "utf8");
      const catalog = await inspectLocalCatalog(folder, "my.catalog");

      expect(catalog.counts.skills).toBe(1);
      const review = await previewEmptySetup(home, "codex", catalog);

      expect(await readdir(home)).toEqual([]);
      expect(await applyEmptySetup(review)).toEqual({ status: "installed" });
      expect((await loadProjectConfig(home)).catalogs).toEqual([
        { name: "my.catalog", source: `path:${folder}` },
      ]);
      expect(await readFile(path.join(folder, "skills", "sample", "SKILL.md"), "utf8")).toBe(
        before,
      );
      expect(await readdir(folder)).toEqual(["skills"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("rejects invalid names, broken catalog files, and content changed after review", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "ambit-local-catalog-"));

    try {
      await mkdir(path.join(folder, "skills", "sample"), { recursive: true });
      const skill = path.join(folder, "skills", "sample", "SKILL.md");

      await writeFile(skill, "---\nname: wrong\n---\n# Sample\n");
      await expect(inspectLocalCatalog(folder, "bad/name")).rejects.toThrow("holds a `/`");
      await expect(inspectLocalCatalog(folder, "local")).rejects.toThrow("does not match");
      await writeFile(skill, "---\nname: sample\n---\n# Sample\n");
      const review = await previewEmptySetup(
        home,
        "codex",
        await inspectLocalCatalog(folder, "local"),
      );

      await writeFile(skill, "---\nname: sample\n---\n# Changed\n");
      await expect(applyEmptySetup(review)).rejects.toThrow("Local catalog changed since review");
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("keeps the home untouched until Apply and installs through the core", async () => {
    const review = await previewEmptySetup(home, "codex");

    expect(await readdir(home)).toEqual([]);

    expect(await applyEmptySetup(review)).toEqual({ status: "installed" });
    expect((await loadProjectConfig(home)).harnesses).toEqual(["codex"]);
    expect((await loadProjectConfig(home)).catalogs).toEqual([]);
    expect((await loadProjectConfig(home)).requires).toEqual([]);
    expect(await readFile(path.join(home, "ambit.yml"), "utf8")).toBe(review.configText);
    expect(await readdir(home)).toContain("ambit.lock");
    expect(await readdir(home)).toContain(".ambit");
    expect(await readdir(home)).not.toContain("skills");
    expect(await readdir(home)).not.toContain("catalogs");
    expect(await readdir(home)).not.toContain(".ambit-operation.lock");
    await retryEmptySetup(review);
  });

  it("rejects a stale review without overwriting an external config", async () => {
    const review = await previewEmptySetup(home, "claude");
    const external = "version: 1\nharnesses: [vscode]\n";

    await writeFile(path.join(home, "ambit.yaml"), external);
    await expect(applyEmptySetup(review)).rejects.toThrow("refusing to overwrite ambit.yaml");
    expect(await readFile(path.join(home, "ambit.yaml"), "utf8")).toBe(external);
    expect(await readdir(home)).toEqual(["ambit.yaml"]);
  });

  it("rejects changed install inputs after review", async () => {
    const review = await previewEmptySetup(home, "cursor");

    await writeFile(path.join(home, "ambit.lock"), "external");
    await expect(applyEmptySetup(review)).rejects.toThrow("changed since review");
    expect(await readdir(home)).toEqual(["ambit.lock"]);
  });

  it("preflights an ambiguous managed ignore block before saving", async () => {
    const original = "# BEGIN ambit\n";

    await writeFile(path.join(home, ".gitignore"), original);
    await expect(previewEmptySetup(home, "claude")).rejects.toThrow("unterminated ambit block");
    expect(await readFile(path.join(home, ".gitignore"), "utf8")).toBe(original);
    expect(await readdir(home)).toEqual([".gitignore"]);
  });

  it("coordinates desktop and CLI mutations", async () => {
    const review = await previewEmptySetup(home, "vscode");

    await withSetupLock(home, async () => {
      await expect(applyEmptySetup(review)).rejects.toThrow("another Ambit operation");
      await expect(installProject(home)).rejects.toThrow("another Ambit operation");
      expect(await readdir(home)).toEqual([".ambit-operation.lock"]);
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("keeps the saved config and offers retry after an installation failure", async () => {
    const stateDir = path.join(home, ".ambit");

    await mkdir(stateDir);
    await chmod(stateDir, 0o500);
    try {
      const review = await previewEmptySetup(home, "opencode");
      const result = await applyEmptySetup(review);

      expect(result.status).toBe("partial");
      expect(await readFile(path.join(home, "ambit.yml"), "utf8")).toBe(review.configText);
      await chmod(stateDir, 0o700);
      await retryEmptySetup(review);
      expect(await readdir(stateDir)).toContain("state.json");
    } finally {
      await chmod(stateDir, 0o700);
    }
  });
});
