import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { browseLocalSkills, readLocalSkill } from "../src/browser.js";

let home: string;
let catalog: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ambit-browser-home-"));
  catalog = await mkdtemp(path.join(tmpdir(), "ambit-browser-catalog-"));
  for (const name of ["selected", "dependency", "other"]) {
    await mkdir(path.join(catalog, "skills", name), { recursive: true });
    await writeFile(
      path.join(catalog, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n${name === "selected" ? "ambit:\n  requires:\n    - skill: dependency\n" : ""}---\n# ${name}\n<script>alert(1)</script>\n`,
    );
  }

  await writeFile(
    path.join(home, "ambit.yml"),
    `version: 1\nharnesses: [codex]\ncatalogs:\n  - name: local\n    source: ${JSON.stringify(`path:${catalog}`)}\n  - name: remote\n    source: example.invalid/never-fetch\nrequires:\n  - skill: local/selected\n`,
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
});

describe("local skill browser", () => {
  it("lists direct and dependency selections without fetching or writing", async () => {
    const before = await readFile(path.join(home, "ambit.yml"), "utf8");

    expect(await browseLocalSkills(home)).toEqual({
      skills: [
        {
          catalog: "local",
          name: "dependency",
          description: "dependency skill",
          selected: true,
          dependencyFree: true,
        },
        {
          catalog: "local",
          name: "other",
          description: "other skill",
          selected: false,
          dependencyFree: true,
        },
        {
          catalog: "local",
          name: "selected",
          description: "selected skill",
          selected: true,
          dependencyFree: false,
        },
      ],
      remoteCatalogs: ["remote"],
    });
    expect(await readLocalSkill(home, "local", "selected")).toContain("<script>alert(1)</script>");
    expect(await readFile(path.join(home, "ambit.yml"), "utf8")).toBe(before);
    expect(await readdir(catalog)).toEqual(["skills"]);
  });

  it("refuses arbitrary skill names and catalog names", async () => {
    await expect(readLocalSkill(home, "local", "../other")).rejects.toThrow();
    await expect(readLocalSkill(home, "remote", "selected")).rejects.toThrow();
  });
});
