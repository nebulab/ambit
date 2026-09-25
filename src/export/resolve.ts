import type { MergedCatalog, MergedPack } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { configError, resolutionError } from "../errors.js";
import { matches } from "../model/pattern.js";
import type { PluginMetadata } from "../model/plugin.js";
import type { Bundle, Requirer } from "../resolution/resolve.js";
import {
  assertEntriesMatch,
  closeOverRequires,
  requiredItems,
  resolveBundle,
} from "../resolution/resolve.js";

export interface PluginBundle {
  readonly pack: MergedPack;
  readonly metadata: PluginMetadata;
  readonly directory: string;
  readonly dependencies: readonly string[];
  readonly bundle: Bundle;
}

/** Resolves each plugin separately, stopping content expansion at other plugin packs. */
export function resolvePlugins(
  config: ProjectConfig,
  merged: MergedCatalog,
): readonly PluginBundle[] {
  if (config.requires.length === 0 || config.requires.some((entry) => entry.kind !== "pack")) {
    throw configError(`${config.origin.file}: export requires a selection of packs`, [
      "select exportable packs with `requires: [{ pack: catalog/name }]`",
    ]);
  }

  assertEntriesMatch(config, merged);
  const roots = merged.packs.filter((pack) =>
    config.requires.some((entry) => matches(entry, { ...pack, kind: "pack" })),
  );

  for (const pack of roots) {
    if (!pack.plugin) {
      throw configError(`${pack.file}: pack "${pack.name}" has no plugin metadata`, [
        "add a `plugin` mapping with at least a `name`",
      ]);
    }
  }

  // Validate the complete graph before cutting boundary edges, so cycles cannot disappear.
  const selection = closeOverRequires(
    roots.map((pack) => ({ ...pack, kind: "pack" })),
    [],
    [],
    merged,
  );
  const packs = selection.packs.filter((pack) => pack.plugin !== undefined);
  const names = new Set<string>();
  const directories = new Set<string>();

  return packs.map((pack) => {
    const metadata = pack.plugin!;
    const directory = metadata.directory ?? metadata.name;

    if (names.has(metadata.name) || directories.has(directory)) {
      throw resolutionError(
        `${pack.file}: duplicate plugin name or output directory "${directory}"`,
        ["give each exported pack a distinct plugin name and directory"],
      );
    }

    names.add(metadata.name);
    directories.add(directory);
    const bounded = {
      ...merged,
      packs: merged.packs.map((other) =>
        other !== pack && other.plugin ? { ...other, requires: [] } : other,
      ),
    };
    const bundle = resolveBundle(
      { ...config, requires: [{ kind: "pack", catalog: pack.catalog, pattern: pack.name }] },
      bounded,
    );
    const dependencies = new Set(metadata.dependencies ?? []);
    const visited = new Set<string>();
    const follow = (node: Requirer): void => {
      const key = `${node.kind}:${node.catalog}/${node.name}`;

      if (visited.has(key)) {
        return;
      }

      visited.add(key);
      // Manifest arrays retain declaration order, including order within helper packs.
      for (const entry of node.requires) {
        const found = requiredItems(entry, node, merged);

        for (const child of found.packs) {
          if (child.plugin) {
            dependencies.add(child.plugin.name);
          } else {
            follow({ ...child, kind: "pack" });
          }
        }

        for (const child of found.skills) {
          follow({ ...child, kind: "skill", file: `${child.path}/SKILL.md` });
        }
      }
    };

    follow({ ...pack, kind: "pack" });

    return { pack, metadata, directory, dependencies: [...dependencies], bundle };
  });
}
