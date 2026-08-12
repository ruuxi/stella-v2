import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Electron ships its helper apps with a stock CFBundleName of "Electron Helper"
// (and " (GPU)"/" (Renderer)"/" (Plugin)" variants). electron-builder renames the
// helper executables, .app folders, CFBundleDisplayName, and CFBundleIdentifier to
// the product name, but it never rewrites CFBundleName. macOS attributes TCC
// prompts (Screen Recording, Input Monitoring, Automation) to the helper via that
// CFBundleName, so releases can still surface as "Electron Helper" -> "Electron".
//
// This hook runs from electron-builder's `afterPack`, which fires AFTER the app and
// helper bundles are assembled/renamed but BEFORE code signing (and before the
// electron fuses step). Rewriting the plists here means the eventual signature
// covers the corrected CFBundleName, so signing/notarization stay valid. We only
// touch CFBundleName (never the executable name or bundle id Electron resolves
// helpers by), and we only rewrite bundles that still carry the stock "Electron"
// name, which keeps the hook idempotent.
const readPlistString = async (plistPath, key) => {
  try {
    const { stdout } = await execFileAsync("plutil", [
      "-extract",
      key,
      "raw",
      plistPath,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
};

const writePlistString = async (plistPath, key, value) => {
  await execFileAsync("plutil", [
    "-replace",
    key,
    "-string",
    value,
    plistPath,
  ]);
};

const renameHelperBundleNames = async (frameworksDir) => {
  if (!existsSync(frameworksDir)) return [];

  let entries;
  try {
    entries = await readdir(frameworksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const renamed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;

    const infoPlist = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(infoPlist)) continue;

    const current = await readPlistString(infoPlist, "CFBundleName");
    // Only rewrite bundles that still carry Electron's stock helper name. The
    // .app folder was already renamed to the product identity (e.g.
    // "Stella Helper (GPU).app"), so its basename is the correct CFBundleName.
    if (current == null || !current.startsWith("Electron")) continue;

    const desired = entry.name.slice(0, -".app".length);
    await writePlistString(infoPlist, "CFBundleName", desired);
    renamed.push(`${current} -> ${desired}`);
  }

  return renamed;
};

export default async function prunePackagedInstallAssets(context) {
  const isMac = context.electronPlatformName === "darwin";
  const appContentsDirectory = isMac
    ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
      )
    : null;
  const resourcesDirectory = isMac
    ? join(appContentsDirectory, "Resources")
    : join(context.appOutDir, "resources");

  // These archives are installer inputs for older Electron versions. The
  // current native module already lives in build/Release, so shipping the
  // archives only adds dead weight and makes Apple inspect unsigned binaries
  // nested inside them during notarization.
  await rm(
    join(
      resourcesDirectory,
      "app.asar.unpacked",
      "node_modules",
      "mac-screen-capture-permissions",
      "prebuilds",
    ),
    { recursive: true, force: true },
  );

  // Align helper CFBundleName with the already-renamed executables/display names
  // so macOS permission dialogs never fall back to "Electron Helper" -> "Electron".
  // Runs before signing, so the corrected plists are covered by the signature.
  if (isMac) {
    const renamed = await renameHelperBundleNames(
      join(appContentsDirectory, "Frameworks"),
    );
    if (renamed.length > 0) {
      console.log(
        `[afterPack] Renamed helper CFBundleName entries: ${renamed.join(", ")}`,
      );
    }
  }
}
