import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMainLogger } from "./observability/main-logger.js";

const DESKTOP_FILE_NAME = "stella-v2.desktop";
const ICON_NAME = "stella-v2";

const runQuietly = (command, args) => {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout: 10_000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
};

const xdgDataHome = () =>
  process.env.XDG_DATA_HOME?.trim() ||
  path.join(os.homedir(), ".local", "share");

const desktopEntryContent = (appImagePath) =>
  [
    "[Desktop Entry]",
    "Name=Stella",
    "Comment=Stella desktop assistant",

    `Exec="${appImagePath}" %U`,
    "Terminal=false",
    "Type=Application",
    `Icon=${ICON_NAME}`,
    "StartupWMClass=Stella",
    "Categories=Utility;",
    "MimeType=x-scheme-handler/stella;",
    "X-AppImage-Integrated-By=Stella",
    "",
  ].join("\n");

const installIcon = (logger) => {
  const appDir = process.env.APPDIR?.trim();
  if (!appDir) return;
  const candidates = [
    path.join(appDir, `${ICON_NAME}.png`),
    path.join(appDir, "stella.png"),
    path.join(appDir, ".DirIcon"),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) return;
  try {
    const iconDir = path.join(
      xdgDataHome(),
      "icons",
      "hicolor",
      "512x512",
      "apps",
    );
    mkdirSync(iconDir, { recursive: true });
    copyFileSync(source, path.join(iconDir, `${ICON_NAME}.png`));
  } catch (error) {
    logger?.warn("main.linux-desktop-icon-install-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const registerLinuxDesktopIntegration = () => {
  if (process.platform !== "linux") return;
  const logger = getMainLogger();
  try {
    const appImagePath = process.env.APPIMAGE?.trim();
    if (!appImagePath || !existsSync(appImagePath)) return;

    const applicationsDir = path.join(xdgDataHome(), "applications");
    const desktopFilePath = path.join(applicationsDir, DESKTOP_FILE_NAME);
    const content = desktopEntryContent(appImagePath);

    let existing = null;
    try {
      existing = readFileSync(desktopFilePath, "utf8");
    } catch {

    }

    if (existing !== content) {
      mkdirSync(applicationsDir, { recursive: true });
      writeFileSync(desktopFilePath, content);
      installIcon(logger);
      runQuietly("update-desktop-database", [applicationsDir]);
      logger?.process("main.linux-desktop-entry-installed", {
        desktopFilePath,
        appImagePath,
      });
    }

    runQuietly("xdg-mime", [
      "default",
      DESKTOP_FILE_NAME,
      "x-scheme-handler/stella",
    ]);
  } catch (error) {
    logger?.warn("main.linux-desktop-integration-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const warnIfSystemGitMissing = () => {
  if (process.platform !== "linux") return;
  const probe = spawnSync("git", ["--version"], {
    stdio: "ignore",
    timeout: 10_000,
  });
  if (probe.error || probe.status !== 0) {
    const message =
      "System git was not found on PATH. Stella for Linux uses the system " +
      "git installation; install it with your distribution's package manager " +
      "(for example, `sudo apt install git` or `sudo pacman -S git`) to enable " +
      "git-based features.";
    console.warn(`[linux] ${message}`);
    getMainLogger()?.warn("main.linux-system-git-missing", { message });
  }
};
