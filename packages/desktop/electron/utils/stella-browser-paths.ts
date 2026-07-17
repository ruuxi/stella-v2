import { existsSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = import.meta.dirname;

/**
 * Locate the Stella browser service and extension directory.
 *
 * In development the service lives at `packages/stella-browser/`. Packaged
 * builds copy its command shim, native binaries, and extension into Electron's
 * resources directory.
 *
 * The source helper and bundled Electron main both sit three levels below the
 * `packages/` directory, so the workspace path is stable in both layouts.
 *
 *   packages/desktop/dist-electron/electron/stella-browser-paths.js
 *                                           ^ __dirname
 *   ../../../stella-browser = packages/stella-browser
 *
 * If the layout changes, fix it here once.
 */
const workspaceStellaBrowserRoot = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "stella-browser",
);

export const resolveStellaBrowserRoot = (): string => {
  if (existsSync(workspaceStellaBrowserRoot)) {
    return workspaceStellaBrowserRoot;
  }

  // Production: electron-builder copies stella-browser next to the asar at
  // Contents/Resources/stella-browser. `process.resourcesPath` is only defined
  // inside the Electron main process, which is where this helper runs.
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "stella-browser");
    if (existsSync(packaged)) {
      return packaged;
    }
  }

  return workspaceStellaBrowserRoot;
};

export const currentStellaBrowserPlatformKey = (): string | null => {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "win32" && arch === "x64") {
    return "win-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }
  return null;
};

const legacyStellaBrowserBinaryName = (platformKey: string): string => {
  if (platformKey === "win-x64") return "stella-browser-win32-x64.exe";
  return `stella-browser-${platformKey}`;
};

const hydratedStellaBrowserBinaryName = (): string =>
  process.platform === "win32" ? "stella-browser.exe" : "stella-browser";

export const resolveHydratedStellaBrowserBinaryPath = (
  stellaBrowserRoot = resolveStellaBrowserRoot(),
): string | null => {
  const platformKey = currentStellaBrowserPlatformKey();
  if (!platformKey) return null;
  return path.join(
    stellaBrowserRoot,
    "out",
    platformKey,
    hydratedStellaBrowserBinaryName(),
  );
};

export const resolveLegacyStellaBrowserBinaryPath = (
  stellaBrowserRoot = resolveStellaBrowserRoot(),
): string | null => {
  const platformKey = currentStellaBrowserPlatformKey();
  if (!platformKey) return null;
  return path.join(
    stellaBrowserRoot,
    "bin",
    legacyStellaBrowserBinaryName(platformKey),
  );
};

/** Prefer the hydrated artifact, with a temporary tracked-bin fallback. */
export const resolveStellaBrowserBinaryPath = (
  stellaBrowserRoot = resolveStellaBrowserRoot(),
): string | null => {
  const hydrated = resolveHydratedStellaBrowserBinaryPath(stellaBrowserRoot);
  if (hydrated && existsSync(hydrated)) return hydrated;
  const legacy = resolveLegacyStellaBrowserBinaryPath(stellaBrowserRoot);
  return legacy && existsSync(legacy) ? legacy : null;
};

const promoteStagedBinary = (binaryPath: string): boolean => {
  const stagedPath = `${binaryPath}.update`;
  if (!existsSync(stagedPath)) return false;

  const previousPath = `${binaryPath}.previous`;
  try {
    rmSync(previousPath, { force: true });
    if (existsSync(binaryPath)) renameSync(binaryPath, previousPath);
    renameSync(stagedPath, binaryPath);
    rmSync(previousPath, { force: true });
    return true;
  } catch (error) {
    if (!existsSync(binaryPath) && existsSync(previousPath)) {
      try {
        renameSync(previousPath, binaryPath);
      } catch {
        // Preserve the original activation failure below.
      }
    }
    throw new Error(
      `Cannot activate Stella Browser service update: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** Promote a verified browser artifact before any service/native-host spawn. */
export const activateStagedStellaBrowserBinary = (
  stellaBrowserRoot = resolveStellaBrowserRoot(),
): boolean => {
  const hydrated = resolveHydratedStellaBrowserBinaryPath(stellaBrowserRoot);
  const legacy = resolveLegacyStellaBrowserBinaryPath(stellaBrowserRoot);
  if (!hydrated || !legacy) return false;
  // Browser binary hydration stages into ignored out/<platform>. Also finish
  // any legacy bin/<platform>.update left during the binary-layout migration.
  const hydratedActivated = promoteStagedBinary(hydrated);
  const legacyActivated = promoteStagedBinary(legacy);
  return hydratedActivated || legacyActivated;
};
