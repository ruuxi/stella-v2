import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
