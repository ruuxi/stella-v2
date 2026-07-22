import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PACKAGED_STELLA_HOME_DIRNAME = ".stella";
export const ELECTRON_USER_DATA_DIRNAME = "electron-user-data";

export type DesktopDataPaths = {
  /** User-owned durable data: DB, memory, skills, prompts, connectors, config. */
  stellaHomeDir: string;
  /** Electron/Chromium runtime state: caches, session data, windows, updater. */
  electronUserDataDir: string;
};

type StellaHomeOptions = {
  isPackaged: boolean;
  homeDir?: string;
  devHomeOverride?: string | null;
};

const normalizePathForSafetyComparison = (candidate: string): string =>
  path.resolve(candidate).toLowerCase();

const hasSymlinkComponent = (candidate: string, boundary: string): boolean => {
  const absolute = path.resolve(candidate);
  let cursor = path.resolve(boundary);
  try {
    if (lstatSync(cursor).isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const relative = path.relative(cursor, absolute);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
};

const isPathWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(
    normalizePathForSafetyComparison(root),
    normalizePathForSafetyComparison(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const assertIsolatedDevPath = (
  candidate: string,
  homeDir: string,
  packagedStellaHomeDir: string,
  label: string,
): void => {
  if (
    isPathWithin(candidate, packagedStellaHomeDir) ||
    isPathWithin(packagedStellaHomeDir, candidate)
  ) {
    throw new Error(
      `${label} must not overlap the packaged home: ${packagedStellaHomeDir}`,
    );
  }
  const allowedBoundary = [homeDir, os.tmpdir()]
    .map((boundary) => path.resolve(boundary))
    .find((boundary) => isPathWithin(candidate, boundary));
  if (!allowedBoundary) {
    throw new Error(`${label} must stay within the user home or OS temp.`);
  }
  if (hasSymlinkComponent(candidate, allowedBoundary)) {
    throw new Error(`${label} must not use symlink aliases.`);
  }
};

export const resolveStellaHomeDir = (options: StellaHomeOptions): string => {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const packagedStellaHomeDir = path.join(
    homeDir,
    PACKAGED_STELLA_HOME_DIRNAME,
  );
  const explicitDevHome = options.isPackaged
    ? ""
    : options.devHomeOverride?.trim() || "";
  const stellaHomeDir = explicitDevHome
    ? path.resolve(explicitDevHome)
    : packagedStellaHomeDir;
  if (explicitDevHome) {
    assertIsolatedDevPath(
      stellaHomeDir,
      homeDir,
      packagedStellaHomeDir,
      "Development Stella home",
    );
  }
  return stellaHomeDir;
};

export const resolveLifecycleVerificationHome = (options: {
  explicitPath?: string | null;
  homeDir?: string;
}): string => {
  const explicitPath = options.explicitPath?.trim();
  if (!explicitPath) {
    throw new Error(
      "Lifecycle verification requires STELLA_V2_LIFECYCLE_VERIFY_DATA_DIR.",
    );
  }
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const resolved = path.resolve(explicitPath);
  assertIsolatedDevPath(
    resolved,
    homeDir,
    path.join(homeDir, PACKAGED_STELLA_HOME_DIRNAME),
    "Lifecycle verification home",
  );
  return resolved;
};

/**
 * Resolve the durable Stella home independently from Electron's runtime state.
 *
 * Packaged and ordinary development launches share the normal Stella home.
 * Development ignores generic STELLA_DATA_DIR state and can only be redirected
 * through the v2-specific opt-in override supplied by bootstrap. Explicit
 * overrides remain isolated: the guard compares case-folded paths and rejects
 * symlink components without following them.
 */
export const resolveDesktopDataPaths = (options: {
  isPackaged: boolean;
  homeDir?: string;
  devHomeOverride?: string | null;
}): DesktopDataPaths => {
  const stellaHomeDir = resolveStellaHomeDir(options);
  const electronUserDataDir = path.join(
    stellaHomeDir,
    ELECTRON_USER_DATA_DIRNAME,
  );

  return {
    stellaHomeDir,
    electronUserDataDir,
  };
};
