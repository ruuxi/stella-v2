import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

const DEV_APP_NAME = "Stella";
// Development runs under a distinct bundle id so dev TCC/LaunchServices grants
// never pollute the packaged release's row. The release keeps com.stella.app
// (see the electron-builder `build.appId`); only the ad-hoc dev bundle diverges.
const DEV_BUNDLE_ID = "com.stella.app.dev";
const MICROPHONE_USAGE_DESCRIPTION =
  "Stella uses your microphone for voice conversations.";

const readPlistString = (plistPath, key) => {
  try {
    return execFileSync(
      "plutil",
      ["-extract", key, "raw", plistPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
};

const writePlistString = (plistPath, key, value) => {
  const current = readPlistString(plistPath, key);
  if (current === value) return false;

  const operation = current === null ? "-insert" : "-replace";
  execFileSync(
    "plutil",
    [operation, key, "-string", value, plistPath],
    { stdio: "ignore" },
  );
  return true;
};

const filesEqual = (leftPath, rightPath) => {
  if (!existsSync(leftPath) || !existsSync(rightPath)) return false;
  return readFileSync(leftPath).equals(readFileSync(rightPath));
};

/**
 * Keep the stock Electron dev host recognizable to LaunchServices and TCC.
 *
 * This deliberately does not restore v1's relaunch wrapper or launcher-owned
 * lifecycle. It only aligns the bundle's executable/name/id with the process
 * we actually spawn, then re-seals the ad-hoc development signature.
 */
export const prepareMacDevPermissionIdentity = ({
  electronBinary,
  desktopDir,
}) => {
  if (process.platform !== "darwin") return;

  const appBundle = path.resolve(path.dirname(electronBinary), "..", "..");
  const infoPlist = path.join(appBundle, "Contents", "Info.plist");
  if (!appBundle.endsWith(".app") || !existsSync(infoPlist)) {
    throw new Error(
      `Could not resolve the Electron development app bundle from ${electronBinary}.`,
    );
  }

  let changed = false;
  changed =
    writePlistString(
      infoPlist,
      "CFBundleExecutable",
      path.basename(electronBinary),
    ) || changed;
  changed = writePlistString(infoPlist, "CFBundleName", DEV_APP_NAME) || changed;
  changed =
    writePlistString(infoPlist, "CFBundleDisplayName", DEV_APP_NAME) || changed;
  changed =
    writePlistString(infoPlist, "CFBundleIdentifier", DEV_BUNDLE_ID) || changed;
  changed =
    writePlistString(
      infoPlist,
      "NSMicrophoneUsageDescription",
      MICROPHONE_USAGE_DESCRIPTION,
    ) || changed;

  const sourceIcon = path.join(desktopDir, "build", "icon.icns");
  const targetIcon = path.join(appBundle, "Contents", "Resources", "electron.icns");
  if (existsSync(sourceIcon) && !filesEqual(sourceIcon, targetIcon)) {
    copyFileSync(sourceIcon, targetIcon);
    changed = true;
  }

  if (changed) {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", appBundle],
      { stdio: "ignore" },
    );
  }
};

export const resolveMacDevResponsibilityLauncher = ({ desktopDir }) => {
  if (process.platform !== "darwin") return null;

  const sourcePath = path.join(desktopDir, "scripts", "disclaim-spawn.c");
  if (!existsSync(sourcePath)) return null;

  const outputDir = path.join(desktopDir, ".stella-dev-runtime");
  const outputPath = path.join(outputDir, "disclaim-spawn");
  const needsBuild =
    !existsSync(outputPath) ||
    statSync(outputPath).mtimeMs < statSync(sourcePath).mtimeMs;

  if (needsBuild) {
    mkdirSync(outputDir, { recursive: true });
    execFileSync("clang", ["-O2", "-o", outputPath, sourcePath], {
      stdio: "ignore",
      timeout: 15_000,
    });
  }

  return outputPath;
};
