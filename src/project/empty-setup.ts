import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isNode, parseDocument } from "yaml";

import { configError } from "../errors.js";
import {
  CONFIG_FILENAMES,
  existingConfigFiles,
  loadProjectConfig,
  parseProjectConfig,
} from "../model/config.js";
import { mergeCatalogs, parseCatalogDirectory } from "../model/catalog.js";
import { readState } from "../model/state.js";
import { resolveBundle } from "../resolution/resolve.js";
import { gitignoreStatus } from "./gitignore.js";
import { adaptersFor, installProjectUnderLock, installScope, planFor } from "./install.js";
import { authorizePlan } from "./ownership.js";
import { withSetupLock } from "./operation-lock.js";

export const SETUP_TOOLS = ["claude", "codex", "cursor", "opencode", "vscode"] as const;
export type SetupTool = (typeof SETUP_TOOLS)[number];

/** A reviewed Personal setup creation or local catalog addition. */
export interface EmptySetupReview {
  readonly root: string;
  readonly tool: SetupTool;
  readonly configText: string;
  readonly diskFingerprint: string;
  readonly catalog?: {
    readonly name: string;
    readonly folder: string;
    readonly fingerprint: string;
  };
  readonly existing?: { readonly configPath: string; readonly original: string };
}

export interface LocalCatalogDraft {
  readonly name: string;
  readonly folder: string;
  readonly counts: {
    readonly skills: number;
    readonly mcps: number;
    readonly hooks: number;
    readonly packs: number;
  };
}

/** Validates a local catalog using the same parser as an installation. */
export async function inspectLocalCatalog(
  folder: string,
  name: string,
): Promise<LocalCatalogDraft> {
  const config = parseProjectConfig(
    `version: 1\ncatalogs:\n  - name: ${JSON.stringify(name)}\n    source: ${JSON.stringify(`path:${folder}`)}\n`,
    CONFIG_FILENAMES[0],
  );

  if (!path.isAbsolute(folder) || !(await stat(folder).catch(() => null))?.isDirectory()) {
    throw configError("Choose an existing local catalog folder");
  }

  const catalog = await parseCatalogDirectory(name, config.catalogs[0]!.source, folder);

  return {
    name,
    folder,
    counts: {
      skills: catalog.skills.length,
      mcps: catalog.mcps.length,
      hooks: catalog.hooks.length,
      packs: catalog.packs.length,
    },
  };
}

async function catalogFingerprint(folder: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (
    directory: string,
    relative: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    const resolvedDirectory = await realpath(directory);

    if (ancestors.has(resolvedDirectory)) {
      hash.update(`cycle:${relative}`);

      return;
    }

    const nextAncestors = new Set(ancestors).add(resolvedDirectory);

    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      const name = path.posix.join(relative, entry.name);
      const kind = await lstat(file);

      hash.update(name);
      if (kind.isSymbolicLink()) {
        hash.update(`link:${await readlink(file)}`);
        const resolved = await stat(file);

        if (resolved.isFile()) {
          hash.update(await readFile(file));
        } else if (resolved.isDirectory()) {
          await walk(file, name, nextAncestors);
        }
      } else if (kind.isDirectory()) {
        hash.update("directory");
        await walk(file, name, nextAncestors);
      } else if (kind.isFile()) {
        hash.update("file");
        hash.update(await readFile(file));
      } else {
        hash.update(`other:${kind.mode}`);
      }
    }
  };

  // Only catalog content affects resolution; a setup can also be its own catalog.
  for (const name of ["skills", "mcps", "hooks", "packs", "scopes.yml"]) {
    const target = path.join(folder, name);

    try {
      const kind = await lstat(target);

      hash.update(name);
      if (kind.isDirectory()) {
        await walk(target, name, new Set());
      } else if (kind.isFile()) {
        hash.update(await readFile(target));
      } else if (kind.isSymbolicLink()) {
        hash.update(`link:${await readlink(target)}`);
        if ((await stat(target)).isDirectory()) {
          await walk(target, name, new Set());
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      hash.update(`absent:${name}`);
    }
  }

  return hash.digest("hex");
}

async function readInput(target: string): Promise<string> {
  try {
    const kind = await lstat(target);

    if (!kind.isFile()) {
      return `occupied:${kind.mode}`;
    }

    return `file:${(await readFile(target)).toString("base64")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }

    throw error;
  }
}

async function fingerprint(root: string): Promise<string> {
  const names = [
    ...CONFIG_FILENAMES,
    "ambit.lock",
    ".ambit/state.json",
    ".gitignore",
    ".agents/.gitignore",
  ];
  const values = await Promise.all(names.map((name) => readInput(path.join(root, name))));

  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function assertEmpty(root: string): Promise<void> {
  if (!(await stat(root)).isDirectory()) {
    throw configError(`${root} is not a folder`);
  }

  for (const name of CONFIG_FILENAMES) {
    if ((await readInput(path.join(root, name))) !== "absent") {
      throw configError(`refusing to overwrite ${name}`, ["reload this setup before applying"]);
    }
  }
}

/** Reviews creating a setup, optionally connecting one local catalog, without writing. */
export async function previewEmptySetup(
  root: string,
  tool: SetupTool,
  catalog?: LocalCatalogDraft,
): Promise<EmptySetupReview> {
  if (!SETUP_TOOLS.includes(tool)) {
    throw configError(`unknown agent tool "${tool}"`);
  }

  await assertEmpty(root);
  const configText =
    catalog === undefined
      ? `version: 1\nharnesses:\n  - ${tool}\ncatalogs: []\nrequires: []\n`
      : `version: 1\nharnesses:\n  - ${tool}\ncatalogs:\n  - name: ${JSON.stringify(catalog.name)}\n    source: ${JSON.stringify(`path:${catalog.folder}`)}\nrequires: []\n`;
  const config = parseProjectConfig(configText, CONFIG_FILENAMES[0]);
  const loaded =
    catalog === undefined
      ? []
      : [await parseCatalogDirectory(catalog.name, config.catalogs[0]!.source, catalog.folder)];
  const bundle = resolveBundle(config, mergeCatalogs(loaded));
  const plans = planFor(adaptersFor(config.harnesses), bundle, {
    root,
    scope: installScope(root, process.env),
  });

  await authorizePlan(
    plans.flatMap(({ plan }) => plan),
    await readState(root),
  );
  await gitignoreStatus(root, []);

  return {
    root,
    tool,
    configText,
    diskFingerprint: await fingerprint(root),
    ...(catalog === undefined
      ? {}
      : {
          catalog: {
            name: catalog.name,
            folder: catalog.folder,
            fingerprint: await catalogFingerprint(catalog.folder),
          },
        }),
  };
}

/** Reviews a local catalog addition while preserving the existing config's other bytes. */
export async function previewExistingLocalCatalog(
  root: string,
  catalog: LocalCatalogDraft,
): Promise<EmptySetupReview> {
  const files = await existingConfigFiles(root);

  if (files.length !== 1) {
    throw configError("Reload Personal setup before editing");
  }

  const configPath = path.join(root, files[0]!);

  if (!(await lstat(configPath)).isFile()) {
    throw configError("Configuration must be a regular file");
  }

  const original = await readFile(configPath, "utf8");
  const current = await loadProjectConfig(root);

  if (current.catalogs.length > 0 || current.requires.length > 0) {
    throw configError("This setup already has catalog selections", [
      "edit this setup with the CLI until catalog editing is available here",
    ]);
  }

  const entry = `\n  - name: ${JSON.stringify(catalog.name)}\n    source: ${JSON.stringify(`path:${catalog.folder}`)}`;
  const node = parseDocument(original).get("catalogs", true);
  const configText =
    !isNode(node) || node.range === undefined || node.range === null
      ? `${original}${original.endsWith("\n") ? "" : "\n"}catalogs:${entry}\n`
      : `${original.slice(0, node.range[0])}${entry}${original.slice(node.range[1])}`;
  const config = parseProjectConfig(configText, files[0]!);
  const loaded = await inspectLocalCatalog(catalog.folder, catalog.name);
  const parsed = await parseCatalogDirectory(
    catalog.name,
    config.catalogs[0]!.source,
    catalog.folder,
  );
  const bundle = resolveBundle(config, mergeCatalogs([parsed]));
  const plans = planFor(adaptersFor(config.harnesses), bundle, {
    root,
    scope: installScope(root, process.env),
  });

  await authorizePlan(
    plans.flatMap(({ plan }) => plan),
    await readState(root),
  );
  await gitignoreStatus(root, []);

  return {
    root,
    tool: SETUP_TOOLS.find((tool) => config.harnesses.includes(tool)) ?? "claude",
    configText,
    diskFingerprint: await fingerprint(root),
    catalog: {
      name: loaded.name,
      folder: loaded.folder,
      fingerprint: await catalogFingerprint(catalog.folder),
    },
    existing: { configPath, original },
  };
}

/** Saves the reviewed config atomically, then installs it through the shared engine. */
export async function applyEmptySetup(
  review: EmptySetupReview,
): Promise<{ readonly status: "installed" | "partial"; readonly message?: string }> {
  return withSetupLock(review.root, async () => {
    if (review.existing === undefined) {
      await assertEmpty(review.root);
    } else if ((await readFile(review.existing.configPath, "utf8")) !== review.existing.original) {
      throw configError("Personal setup changed since review", ["review the changes again"]);
    }

    if ((await fingerprint(review.root)) !== review.diskFingerprint) {
      throw configError("Personal setup changed since review", ["review the changes again"]);
    }

    if (review.catalog !== undefined) {
      await inspectLocalCatalog(review.catalog.folder, review.catalog.name);
      if ((await catalogFingerprint(review.catalog.folder)) !== review.catalog.fingerprint) {
        throw configError("Local catalog changed since review", ["review the changes again"]);
      }
    }

    const target = review.existing?.configPath ?? path.join(review.root, CONFIG_FILENAMES[0]);
    const temporary = path.join(review.root, `.ambit-${randomUUID()}.tmp`);

    try {
      await writeFile(temporary, review.configText, { encoding: "utf8", flag: "wx" });
      if (review.existing !== undefined) {
        await chmod(temporary, (await stat(target)).mode & 0o777);
      }

      if (review.existing === undefined) {
        // Linking publishes the completed file only if the config name is still free.
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw configError("Personal setup changed since review", ["review the changes again"]);
          }

          throw error;
        }
      } else {
        if ((await readFile(target, "utf8")) !== review.existing.original) {
          throw configError("Personal setup changed since review", ["review the changes again"]);
        }

        await rename(temporary, target);
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }

    try {
      await installProjectUnderLock(review.root);

      return { status: "installed" };
    } catch (error) {
      return {
        status: "partial",
        message:
          error instanceof Error && "format" in error && typeof error.format === "function"
            ? error.format()
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  });
}

/** Retries installation only while the saved config still matches the reviewed draft. */
export async function retryEmptySetup(review: EmptySetupReview): Promise<void> {
  await withSetupLock(review.root, async () => {
    const current = await readFile(
      review.existing?.configPath ?? path.join(review.root, CONFIG_FILENAMES[0]),
      "utf8",
    );

    if (current !== review.configText) {
      throw configError("Personal setup changed since Apply", ["reload before retrying"]);
    }

    await installProjectUnderLock(review.root);
  });
}
