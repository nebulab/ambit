import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";

import { configError } from "../errors.js";

const LOCK_DIR = ".ambit-operation.lock";

/** Serializes setup mutations across CLI and desktop processes. */
export async function withSetupLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, LOCK_DIR);

  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw configError(`another Ambit operation is using ${root}`, [
        "wait for it to finish, then retry",
        `if Ambit stopped unexpectedly, remove ${lock} after checking no operation is running`,
      ]);
    }

    throw error;
  }

  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}
