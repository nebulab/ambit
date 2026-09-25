import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { configError } from "../errors.js";
import { CONFIG_FILENAMES, parseProjectConfig } from "../model/config.js";
import { mergeCatalogs } from "../model/catalog.js";
import { readState } from "../model/state.js";
import { resolveBundle } from "../resolution/resolve.js";
import { gitignoreStatus } from "./gitignore.js";
import { adaptersFor, installProjectUnderLock, installScope, planFor } from "./install.js";
import { authorizePlan } from "./ownership.js";
import { withSetupLock } from "./operation-lock.js";

export const SETUP_TOOLS = ["claude", "codex", "cursor", "opencode", "vscode"] as const;
export type SetupTool = (typeof SETUP_TOOLS)[number];

/** A review of an empty setup with no catalog or selected capability. */
export interface EmptySetupReview {
  readonly root: string;
  readonly tool: SetupTool;
  readonly configText: string;
  readonly diskFingerprint: string;
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

/** Reviews an empty setup without writing to its root. */
export async function previewEmptySetup(root: string, tool: SetupTool): Promise<EmptySetupReview> {
  if (!SETUP_TOOLS.includes(tool)) {
    throw configError(`unknown agent tool "${tool}"`);
  }

  await assertEmpty(root);
  const configText = `version: 1\nharnesses:\n  - ${tool}\ncatalogs: []\nrequires: []\n`;
  const config = parseProjectConfig(configText, CONFIG_FILENAMES[0]);
  const bundle = resolveBundle(config, mergeCatalogs([]));
  const plans = planFor(adaptersFor(config.harnesses), bundle, {
    root,
    scope: installScope(root, process.env),
  });

  await authorizePlan(
    plans.flatMap(({ plan }) => plan),
    await readState(root),
  );
  await gitignoreStatus(root, []);

  return { root, tool, configText, diskFingerprint: await fingerprint(root) };
}

/** Saves the reviewed config atomically, then installs it through the shared engine. */
export async function applyEmptySetup(
  review: EmptySetupReview,
): Promise<{ readonly status: "installed" | "partial"; readonly message?: string }> {
  return withSetupLock(review.root, async () => {
    await assertEmpty(review.root);
    if ((await fingerprint(review.root)) !== review.diskFingerprint) {
      throw configError("Personal setup changed since review", ["review the changes again"]);
    }

    const target = path.join(review.root, CONFIG_FILENAMES[0]);
    const temporary = path.join(review.root, `.ambit-${randomUUID()}.tmp`);

    try {
      await writeFile(temporary, review.configText, { encoding: "utf8", flag: "wx" });
      // Linking publishes the completed file only if the config name is still free.
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw configError("Personal setup changed since review", ["review the changes again"]);
        }

        throw error;
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
    const current = await readFile(path.join(review.root, CONFIG_FILENAMES[0]), "utf8");

    if (current !== review.configText) {
      throw configError("Personal setup changed since Apply", ["reload before retrying"]);
    }

    await installProjectUnderLock(review.root);
  });
}
