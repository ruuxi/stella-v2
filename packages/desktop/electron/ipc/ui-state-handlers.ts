import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { UiStateStore } from "@stella/runtime/kernel/ui-state/store";
import {
  sanitizeUiStateChanges,
  type UiStateChanges,
} from "@stella/contracts/ui-state";
import {
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_UI_STATE_KV_SNAPSHOT,
} from "@stella/contracts/desktop/ipc-channels";
import {
  applyUiStateLocaleChanges,
  bindUiStateLocale,
} from "../services/i18n-service.js";

export type UiStateKvHandlersOptions = {
  stellaDataDirPath: string;
  getAllWindows: () => BrowserWindow[];
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
};

export const registerUiStateKvHandlers = (
  options: UiStateKvHandlersOptions,
): UiStateStore => {
  const store = new UiStateStore(options.stellaDataDirPath);

  bindUiStateLocale(store);

  const broadcast = (
    changes: UiStateChanges,
    excludeWebContentsId?: number,
  ) => {
    if (Object.keys(changes).length === 0) return;
    applyUiStateLocaleChanges(changes);
    for (const window of options.getAllWindows()) {
      if (window.isDestroyed()) continue;
      if (
        excludeWebContentsId != null &&
        window.webContents.id === excludeWebContentsId
      ) {
        continue;
      }
      window.webContents.send(IPC_UI_STATE_KV_CHANGED, changes);
    }
    options.getBroadcastToMobile?.()?.(IPC_UI_STATE_KV_CHANGED, changes);
  };

  ipcMain.on(IPC_UI_STATE_KV_SNAPSHOT, (event) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_SNAPSHOT)) {
      event.returnValue = {};
      return;
    }
    event.returnValue = store.snapshot();
  });

  ipcMain.on(IPC_UI_STATE_KV_APPLY, (event, rawChanges: unknown) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_APPLY)) return;
    const changes = sanitizeUiStateChanges(rawChanges);
    if (!changes) return;
    broadcast(store.apply(changes), event.sender.id);
  });

  ipcMain.on(IPC_UI_STATE_KV_CLEAR, (event) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_CLEAR)) return;
    broadcast(store.clear(), event.sender.id);
  });

  store.onExternalChange((changes) => broadcast(changes));

  app.on("before-quit", () => {
    store.flushSync();
  });

  return store;
};
