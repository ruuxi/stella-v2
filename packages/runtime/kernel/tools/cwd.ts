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

/**
 * Resolve an implicit tool cwd. Explicit user-supplied workdirs stay untouched
 * so invalid paths produce an actionable spawn diagnostic; inherited runtime
 * fallbacks must be real directories and otherwise collapse to the user's
 * home instead of poisoning every child-process launch.
 */
export const resolveToolFallbackCwd = (
  preferredCwd?: string | null,
): string => {
  const candidate = preferredCwd?.trim() || safeProcessCwd();
  if (candidate) {
    try {
      const resolved = path.resolve(candidate);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Missing paths and packaged app.asar files are invalid cwd fallbacks.
    }
  }
  return os.homedir();
};
