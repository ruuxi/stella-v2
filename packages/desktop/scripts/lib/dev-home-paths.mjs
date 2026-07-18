import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const normalizeForComparison = (candidate) =>
  path.resolve(candidate).toLowerCase();

const hasSymlinkComponent = (candidate, boundary) => {
  const absolute = path.resolve(candidate);
  let cursor = path.resolve(boundary);
  try {
    if (lstatSync(cursor).isSymbolicLink()) return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const relative = path.relative(cursor, absolute);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
};

const isPathWithin = (candidate, root) => {
  const relative = path.relative(
    normalizeForComparison(root),
    normalizeForComparison(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const assertIsolatedDevPath = (candidate, homeDir, packagedHome, label) => {
  if (
    isPathWithin(candidate, packagedHome) ||
    isPathWithin(packagedHome, candidate)
  ) {
    throw new Error(
      `${label} must not overlap the packaged home: ${packagedHome}`,
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

export const resolveDevStellaHome = (options = {}) => {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const packagedHome = path.join(homeDir, ".stella");
  const devHome = path.resolve(
    options.devHomeOverride?.trim() ||
      process.env.STELLA_V2_DEV_DATA_DIR?.trim() ||
      path.join(homeDir, ".stella-v2-dev"),
  );
  assertIsolatedDevPath(
    devHome,
    homeDir,
    packagedHome,
    "Development Stella home",
  );
  return devHome;
};

export const resolveDevElectronUserDataDir = (options = {}) => {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const platform = options.platform ?? process.platform;
  let appDataDir;
  if (options.appDataDir) {
    appDataDir = path.resolve(options.appDataDir);
  } else if (platform === "darwin") {
    appDataDir = path.join(homeDir, "Library", "Application Support");
  } else if (platform === "win32") {
    appDataDir = path.resolve(
      process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
    );
  } else {
    appDataDir = path.resolve(
      process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
    );
  }
  const electronUserDataDir = path.join(appDataDir, "Stella Development");
  assertIsolatedDevPath(
    electronUserDataDir,
    homeDir,
    path.join(homeDir, ".stella"),
    "Development Electron userData",
  );
  return electronUserDataDir;
};
