import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_UPDATES_CHECK,
  IPC_UPDATES_DOWNLOAD,
  IPC_UPDATES_GET_STATE,
  IPC_UPDATES_RESTART_AND_INSTALL,
  IPC_UPDATES_STATE_CHANGED,
} from "@stella/contracts/desktop/ipc-channels";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import { getMainLogger } from "../observability/main-logger.js";
import {
  DEFAULT_UPDATE_STARTUP_DELAY_MS,
  DesktopUpdater,
  type DesktopUpdaterClient,
} from "../updates/desktop-updater.js";
import { launchWindowsUpdateSplash } from "../updates/update-splash.js";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { isOwnedWindowMainFrameSender } from "./owned-window-sender.js";

// electron-updater is ~25-40ms of module loading plus a platform updater
// constructed on first `autoUpdater` access. A static import paid that on
// every launch before `ready` (esbuild hoists external imports to the top of
// the bundle), although nothing touches the updater until its first check.
// Load it on first use instead; unpackaged builds, where the updater is
// disabled, never load it at all.
const requireFromMain = createRequire(import.meta.url);

const createLazyAutoUpdaterClient = (): DesktopUpdaterClient => {
  let client: DesktopUpdaterClient | null = null;
  const load = (): DesktopUpdaterClient => {
    client ??= (
      requireFromMain("electron-updater") as typeof import("electron-updater")
    ).autoUpdater as unknown as DesktopUpdaterClient;
    return client;
  };
  return {
    get autoDownload() {
      return load().autoDownload;
    },
    set autoDownload(value) {
      load().autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return load().autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value) {
      load().autoInstallOnAppQuit = value;
    },
    get allowDowngrade() {
      return load().allowDowngrade;
    },
    set allowDowngrade(value) {
      load().allowDowngrade = value;
    },
    get allowPrerelease() {
      return load().allowPrerelease;
    },
    set allowPrerelease(value) {
      load().allowPrerelease = value;
    },
    get disableWebInstaller() {
      return load().disableWebInstaller;
    },
    set disableWebInstaller(value) {
      load().disableWebInstaller = value;
    },
    setFeedURL: (options) => load().setFeedURL(options),
    checkForUpdates: () => load().checkForUpdates(),
    downloadUpdate: () => load().downloadUpdate(),
    quitAndInstall: (isSilent, isForceRunAfter) =>
      load().quitAndInstall(isSilent, isForceRunAfter),
    on: (event, listener) => load().on(event, listener),
    // Nothing can be attached to an updater that was never loaded.
    removeListener: (event, listener) => client?.removeListener(event, listener),
  };
};

// `updater.start()` configures the client, which loads electron-updater in
// packaged builds, so it waits until the window has had time to paint. The
// first background check keeps its original schedule: start deferral plus the
// updater's own startup delay still add up to the default delay.
const UPDATER_START_DEFER_MS = 4_000;

type UpdatesHandlersOptions = {
  getAllWindows: () => Array<{
    isDestroyed: () => boolean;
    webContents: {
      id: number;
      send: (channel: string, payload: unknown) => void;
    };
  }>;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  // Invoked synchronously on the main process when a restart-to-install is
  // accepted, before the updater begins quitting. See DesktopUpdater.
  onBeforeRestart?: () => void;
};

const assertTrusted = (
  options: UpdatesHandlersOptions,
  event: IpcMainInvokeEvent,
  channel: string,
) => {
  if (isOwnedWindowMainFrameSender(event, options.getAllWindows())) {
    return;
  }
  if (options.assertPrivilegedSender(event, channel)) {
    return;
  }
  throw new Error(`Blocked untrusted ${channel} request.`);
};

export const registerUpdatesHandlers = (
  options: UpdatesHandlersOptions,
): (() => void) => {
  const logger = getMainLogger();
  const broadcast = (snapshot: DesktopUpdateSnapshot) => {
    for (const window of options.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_UPDATES_STATE_CHANGED, snapshot);
      }
    }
  };
  const updater = new DesktopUpdater({
    client: createLazyAutoUpdaterClient(),
    currentVersion: app.getVersion(),
    enabled: app.isPackaged && process.env.STELLA_DESKTOP_AUTO_UPDATE !== "false",
    startupDelayMs: Math.max(
      0,
      DEFAULT_UPDATE_STARTUP_DELAY_MS - UPDATER_START_DEFER_MS,
    ),
    onStateChanged: broadcast,
    onBeforeRestart: () => {
      // Windows installs run the NSIS installer fully silent (/S), so this
      // detached, staged-outside-the-install-dir splash is the only thing on
      // screen while the install directory is swapped. Best-effort by design:
      // launchWindowsUpdateSplash never throws and is a no-op off Windows.
      launchWindowsUpdateSplash({
        platform: process.platform,
        resolveHelperPath: resolveNativeHelperPath,
        resourcesPath: process.resourcesPath ?? null,
        stagingRoot: app.getPath("temp"),
        execPath: process.execPath,
        pid: process.pid,
        mkdirSync: (dir) => {
          mkdirSync(dir, { recursive: true });
        },
        copyFileSync,
        spawnDetached: (command, args) => {
          spawn(command, args, { detached: true, stdio: "ignore" }).unref();
        },
        log: {
          info: (message) =>
            logger?.process("desktop-updater.info", { message }),
          warn: (message) => logger?.warn("desktop-updater.warn", { message }),
        },
      });
      options.onBeforeRestart?.();
    },
    log: {
      info: (message) => logger?.process("desktop-updater.info", { message }),
      warn: (message) => logger?.warn("desktop-updater.warn", { message }),
      error: (message) => logger?.error("desktop-updater.error", { message }),
    },
  });

  // Idempotent: DesktopUpdater.start() ignores repeat calls. Any request that
  // needs a configured client starts it early rather than racing the timer.
  const startUpdater = () => updater.start();

  ipcMain.handle(IPC_UPDATES_GET_STATE, (event) => {
    assertTrusted(options, event, IPC_UPDATES_GET_STATE);
    return updater.getState();
  });
  ipcMain.handle(IPC_UPDATES_CHECK, async (event) => {
    assertTrusted(options, event, IPC_UPDATES_CHECK);
    startUpdater();
    return await updater.checkNow();
  });
  ipcMain.handle(IPC_UPDATES_DOWNLOAD, async (event) => {
    assertTrusted(options, event, IPC_UPDATES_DOWNLOAD);
    startUpdater();
    return await updater.download();
  });
  ipcMain.handle(IPC_UPDATES_RESTART_AND_INSTALL, (event) => {
    assertTrusted(options, event, IPC_UPDATES_RESTART_AND_INSTALL);
    startUpdater();
    return updater.restartAndInstall();
  });

  const startTimer = setTimeout(startUpdater, UPDATER_START_DEFER_MS);
  startTimer.unref?.();
  return () => {
    clearTimeout(startTimer);
    updater.dispose();
    ipcMain.removeHandler(IPC_UPDATES_GET_STATE);
    ipcMain.removeHandler(IPC_UPDATES_CHECK);
    ipcMain.removeHandler(IPC_UPDATES_DOWNLOAD);
    ipcMain.removeHandler(IPC_UPDATES_RESTART_AND_INSTALL);
  };
};
