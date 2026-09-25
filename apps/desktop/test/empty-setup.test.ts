import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  applyEmptySetup,
  previewEmptySetup,
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
