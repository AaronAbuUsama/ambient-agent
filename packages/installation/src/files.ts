import { lstat } from "node:fs/promises";

import { errorCode } from "@ambient-agent/engine/shared/errors.ts";

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};
