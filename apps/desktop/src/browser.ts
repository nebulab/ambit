import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  mergeCatalogs,
  parseCatalogDirectory,
  SKILL_FILENAME,
} from "../../../src/model/catalog.js";
import { loadProjectConfig } from "../../../src/model/config.js";
import { matches } from "../../../src/model/pattern.js";
import { resolveBundle } from "../../../src/resolution/resolve.js";
import { configError } from "../../../src/errors.js";

export interface BrowsedSkill {
  readonly catalog: string;
  readonly name: string;
  readonly description?: string;
  readonly selected: boolean;
}

export interface LocalSkillBrowser {
  readonly skills: readonly BrowsedSkill[];
  readonly remoteCatalogs: readonly string[];
}

async function localCatalogs(home: string) {
  const config = await loadProjectConfig(home);
  const catalogs = await Promise.all(
    config.catalogs
      .filter((entry) => entry.source.startsWith("path:"))
      .map(async (entry) => {
        const root = path.resolve(home, entry.source.slice(5));

        return parseCatalogDirectory(entry.name, entry.source, root);
      }),
  );

  return { config, catalogs };
}

/** Lists local skills and their selection status without resolving remote sources. */
export async function browseLocalSkills(home: string): Promise<LocalSkillBrowser> {
  const { config, catalogs } = await localCatalogs(home);
  const merged = mergeCatalogs(catalogs);
  const items = [
    ...merged.packs.map((item) => ({ ...item, kind: "pack" as const })),
    ...merged.skills.map((item) => ({ ...item, kind: "skill" as const })),
    ...merged.mcps.map((item) => ({ ...item, kind: "mcp" as const })),
    ...merged.hooks.map((item) => ({ ...item, kind: "hook" as const })),
  ];
  const localRequires = config.requires.filter((entry) =>
    items.some((item) => matches(entry, item)),
  );
  const selected = new Set(
    resolveBundle({ ...config, requires: localRequires }, merged).skills.map(
      (skill) => `${skill.catalog}/${skill.name}`,
    ),
  );

  return {
    skills: merged.skills.map((skill) => ({
      catalog: skill.catalog,
      name: skill.name,
      ...(skill.description !== undefined && { description: skill.description }),
      selected: selected.has(`${skill.catalog}/${skill.name}`),
    })),
    remoteCatalogs: config.catalogs
      .filter((entry) => !entry.source.startsWith("path:"))
      .map((entry) => entry.name),
  };
}

/** Reads a skill chosen by catalog and name from the current local setup. */
export async function readLocalSkill(
  home: string,
  catalogName: string,
  skillName: string,
): Promise<string> {
  const { catalogs } = await localCatalogs(home);
  const catalog = catalogs.find((item) => item.name === catalogName);
  const skill = catalog?.skills.find((item) => item.name === skillName);

  if (!catalog || !skill) {
    throw configError("Skill is not in a connected local catalog");
  }

  const root = await realpath(catalog.root);
  const file = await realpath(path.join(catalog.root, skill.path, SKILL_FILENAME));

  if (!file.startsWith(`${root}${path.sep}`)) {
    throw configError("Skill file is outside the local catalog");
  }

  const content = await readFile(file, "utf8");

  if (content.length > 1024 * 1024) {
    throw configError("Skill file is too large to preview");
  }

  return content;
}
