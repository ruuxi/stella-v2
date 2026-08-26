// Best-effort Linux desktop integration for the AppImage beta.
//
// AppImages are not "installed", so nothing registers the stella:// scheme for
// us: `app.setAsDefaultProtocolClient` on Linux only flips xdg-mime defaults,
// which requires a .desktop file to already exist in an XDG applications
// directory. Without one, deep links (auth callback OTTs, connector OAuth
// callbacks) never reach the app. Sign-in itself is NOT blocked — the
// magic-link flow polls the backend and completes without a deep link —
// but the round-trip links are nice to have, so on first run we
// install a .desktop entry + icon into the user's XDG data dir and point the
// x-scheme-handler/stella default at it.
//
// Everything here is strictly best-effort: a sandboxed or read-only HOME, a
// missing xdg-utils, or AppImageLauncher having already integrated the app
// must never break startup.
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
    // %U forwards stella:// URLs into argv, where the single-instance and
    // cold-boot deep-link handlers already pick them up (same path Windows
    // uses).
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

/**
 * Install/refresh the user-level .desktop entry that makes stella:// deep
 * links routable back to this AppImage. Safe no-op off Linux, in dev runs,
 * and for non-AppImage installs (deb/rpm packages ship their own entry).
 */
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
      // First run (or unreadable) — write below.
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

    // Point the scheme default at our entry even when the file was already
    // current — another handler may have claimed it since the last run.
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

/**
 * The Linux beta ships no bundled git runtime and relies on system git
 * (bundled-runtime-environment.ts leaves STELLA_GIT_BIN unset). Surface a
 * clear, early signal when git is missing instead of letting individual git
 * invocations fail cryptically later.
 */
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
