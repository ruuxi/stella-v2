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

const resolveConfiguredStellaHome = (options = {}) => {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const packagedHome = path.join(homeDir, ".stella");
  const explicitDevHome =
    options.devHomeOverride?.trim() ||
    process.env.STELLA_V2_DEV_DATA_DIR?.trim() ||
    "";
  if (!explicitDevHome) return packagedHome;
  const stellaHome = path.resolve(explicitDevHome);
  assertIsolatedDevPath(
    stellaHome,
    homeDir,
    packagedHome,
    "Development Stella home",
  );
  return stellaHome;
};

export const resolveDevStellaHome = (options = {}) => {
  const explicitDevHome =
    options.devHomeOverride?.trim() ||
    process.env.STELLA_V2_DEV_DATA_DIR?.trim() ||
    "";
  if (!explicitDevHome) {
    throw new Error(
      "Dev reset requires STELLA_V2_DEV_DATA_DIR so it cannot target the shared ~/.stella home.",
    );
  }
  return resolveConfiguredStellaHome(options);
};

export const resolveDevElectronUserDataDir = (options = {}) => {
  return path.join(resolveConfiguredStellaHome(options), "electron-user-data");
};
