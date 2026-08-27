import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const safeProcessCwd = (): string | undefined => {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
};

export const resolveToolFallbackCwd = (
  preferredCwd?: string | null,
): string => {
  const candidate = preferredCwd?.trim() || safeProcessCwd();
  if (candidate) {
    try {
      const resolved = path.resolve(candidate);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {

    }
  }
  return os.homedir();
};
