import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { inspectPersonalSetup } from "../src/setup.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ambit-desktop-personal-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("Personal setup inspection", () => {
  it("reports an untouched home as unconfigured", async () => {
    expect(await inspectPersonalSetup(home)).toEqual({ status: "unconfigured", root: home });
    expect(await readdir(home)).toEqual([]);
  });

  for (const filename of ["ambit.yml", "ambit.yaml"]) {
    it(`reads ${filename} and its configured tools without writing`, async () => {
      const source = "version: 1\nharnesses: [claude, codex, cursor, opencode, vscode]\n";
      const configPath = path.join(home, filename);

      await writeFile(configPath, source);

      expect(await inspectPersonalSetup(home)).toEqual({
        status: "configured",
        root: home,
        configPath,
        tools: ["claude", "codex", "cursor", "opencode", "vscode"],
      });
      expect(await readdir(home)).toEqual([filename]);
      expect(await readFile(configPath, "utf8")).toBe(source);
    });
  }

  it("reads configured tools without resolving a remote catalog", async () => {
    const source =
      "version: 1\nharnesses: [vscode]\ncatalogs:\n  - name: remote\n    source: example.invalid/never-fetch\n";

    await writeFile(path.join(home, "ambit.yml"), source);

    const result = await inspectPersonalSetup(home);

    expect(result.status).toBe("configured");
    if (result.status === "configured") {
      expect(result.tools).toEqual(["vscode"]);
    }

    expect(await readdir(home)).toEqual(["ambit.yml"]);
  });

  it("shows a malformed configuration with line information and leaves it alone", async () => {
    const configPath = path.join(home, "ambit.yaml");
    const source = "version: 1\nrequires: core\n";

    await writeFile(configPath, source);

    const result = await inspectPersonalSetup(home);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.configPath).toBe(configPath);
      expect(result.message).toContain("ambit.yaml line 2");
    }

    expect(await readFile(configPath, "utf8")).toBe(source);
    expect(await readdir(home)).toEqual(["ambit.yaml"]);
  });

  it("shows the shared loader's conflict when both filenames exist", async () => {
    await writeFile(path.join(home, "ambit.yml"), "version: 1\n");
    await writeFile(path.join(home, "ambit.yaml"), "version: 1\n");

    const result = await inspectPersonalSetup(home);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.configPath).toBe(home);
      expect(result.message).toContain("ambit.yml and ambit.yaml both exist");
    }

    expect((await readdir(home)).sort()).toEqual(["ambit.yaml", "ambit.yml"]);
  });
});
