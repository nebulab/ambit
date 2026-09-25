import path from "node:path";

import { AmbitError } from "../../../src/errors.js";
import { existingConfigFiles, loadProjectConfig } from "../../../src/model/config.js";

/** Data the Personal setup screen may display. No parsed config or source text crosses IPC. */
export type PersonalSetup =
  | { readonly status: "unconfigured"; readonly root: string }
  | {
      readonly status: "configured";
      readonly root: string;
      readonly configPath: string;
      readonly tools: readonly string[];
    }
  | {
      readonly status: "error";
      readonly root: string;
      readonly configPath: string;
      readonly message: string;
    };

/** Reads the home setup without fetching catalogs or writing installation state. */
export async function inspectPersonalSetup(root: string): Promise<PersonalSetup> {
  const files = await existingConfigFiles(root);

  if (files.length === 0) {
    return { status: "unconfigured", root };
  }

  const configPath = path.join(root, files[0]!);

  try {
    const config = await loadProjectConfig(root);

    return { status: "configured", root, configPath, tools: config.harnesses };
  } catch (error) {
    return {
      status: "error",
      root,
      configPath: files.length > 1 ? root : configPath,
      message:
        error instanceof AmbitError
          ? error.format()
          : `Unable to read ${configPath}: ${String(error)}`,
    };
  }
}
