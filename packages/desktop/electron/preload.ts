import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import { createElectronApi } from "@stella/contracts/desktop/electron-api";
import type { TypedIpcRenderer } from "@stella/contracts/desktop/ipc-contract";
import { IPC_UI_STATE_KV_SNAPSHOT } from "@stella/contracts/desktop/ipc-channels";

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: …" — unwrap for UI. */
const unwrapIpcInvokeError = (error: unknown): Error => {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const wrapped = error.message.match(
    /^Error invoking remote method '[^']+':\s*(.+)$/s,
  );
  if (!wrapped) {
    return error;
  }
  let inner = wrapped[1].trim();
  const nested = inner.match(/^Error:\s*(.+)$/s);
  if (nested) {
    inner = nested[1].trim();
  }
  return new Error(inner);
};

const ipc: TypedIpcRenderer = {
  invoke: async (channel, ...args) => {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (error) {
      throw unwrapIpcInvokeError(error);
    }
  },
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on: (channel, listener) => {
    const handler = (
      event: IpcRendererEvent,
      payload: Parameters<typeof listener>[1],
    ) => listener(event, payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

const api = createElectronApi(ipc, {
  platform: process.platform,
  arch: process.arch,
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
});

export type ElectronAPI = typeof api;

// Shared UI state (~/.stella/ui-state.json) snapshot, read synchronously so
// the boot script and module-load preference reads see it before first paint.
contextBridge.exposeInMainWorld(
  "__stellaUiState",
  (() => {
    try {
      const snapshot = ipc.sendSync(IPC_UI_STATE_KV_SNAPSHOT);
      return snapshot && typeof snapshot === "object" ? snapshot : {};
    } catch {
      return {};
    }
  })(),
);

contextBridge.exposeInMainWorld("electronAPI", api);
