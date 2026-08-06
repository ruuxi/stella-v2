import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import electronUpdater from "electron-updater";
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
  DesktopUpdater,
  type DesktopUpdaterClient,
} from "../updates/desktop-updater.js";
import { isOwnedWindowMainFrameSender } from "./owned-window-sender.js";

const { autoUpdater } = electronUpdater;

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
    client: autoUpdater as unknown as DesktopUpdaterClient,
    currentVersion: app.getVersion(),
    enabled: app.isPackaged,
    onStateChanged: broadcast,
    log: {
      info: (message) => logger?.process("desktop-updater.info", { message }),
      warn: (message) => logger?.warn("desktop-updater.warn", { message }),
      error: (message) => logger?.error("desktop-updater.error", { message }),
    },
  });

  ipcMain.handle(IPC_UPDATES_GET_STATE, (event) => {
    assertTrusted(options, event, IPC_UPDATES_GET_STATE);
    return updater.getState();
  });
  ipcMain.handle(IPC_UPDATES_CHECK, async (event) => {
    assertTrusted(options, event, IPC_UPDATES_CHECK);
    return await updater.checkNow();
  });
  ipcMain.handle(IPC_UPDATES_DOWNLOAD, async (event) => {
    assertTrusted(options, event, IPC_UPDATES_DOWNLOAD);
    return await updater.download();
  });
  ipcMain.handle(IPC_UPDATES_RESTART_AND_INSTALL, (event) => {
    assertTrusted(options, event, IPC_UPDATES_RESTART_AND_INSTALL);
    return updater.restartAndInstall();
  });

  updater.start();
  return () => {
    updater.dispose();
    ipcMain.removeHandler(IPC_UPDATES_GET_STATE);
    ipcMain.removeHandler(IPC_UPDATES_CHECK);
    ipcMain.removeHandler(IPC_UPDATES_DOWNLOAD);
    ipcMain.removeHandler(IPC_UPDATES_RESTART_AND_INSTALL);
  };
};
