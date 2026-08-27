import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
  IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT,
  IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
  IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_SCAN_LOCAL,
} from "@stella/contracts/desktop/ipc-channels";
import { scanOwnedLocalCloudHome } from "../services/cloud-home-local-import.js";
import {
  confirmLocalCloudHomeImportOwnership,
  getLocalCloudHomeImportOwnership,
} from "../services/cloud-home-import-owner.js";
import { createCloudHomeMemoryExportService } from "../services/cloud-home-memory-export.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";

export type CloudHomeSyncHandlersOptions = {
  getStellaDataDir: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerCloudHomeSyncHandlers = (
  options: CloudHomeSyncHandlersOptions,
): void => {
  const memoryExports = createCloudHomeMemoryExportService();
  const observedSenders = new Set<number>();
  const observeSenderLifetime = (event: IpcMainInvokeEvent): void => {
    const senderId = event.sender.id;
    if (observedSenders.has(senderId)) return;
    observedSenders.add(senderId);
    event.sender.once("destroyed", () => {
      observedSenders.delete(senderId);
      memoryExports.cancelForSender(senderId);
    });
  };

  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_SCAN_LOCAL,
    async (_event, accountScope: string) => {
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        throw new Error("Stella data is not ready for Cloud Home import.");
      }
      // No renderer-supplied path is accepted. Tests exercise the pure scanner
      // with a temporary fixture, while production always uses lifecycle state.
      return await scanOwnedLocalCloudHome(stellaDataDir, accountScope);
    },
  );
  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
    async (_event, accountScope: string) => {
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        throw new Error("Stella data is not ready for Cloud Home import.");
      }
      return await getLocalCloudHomeImportOwnership(
        stellaDataDir,
        accountScope,
      );
    },
  );
  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP,
    async (_event, accountScope: string) => {
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        throw new Error("Stella data is not ready for Cloud Home import.");
      }
      return await confirmLocalCloudHomeImportOwnership(
        stellaDataDir,
        accountScope,
      );
    },
  );
  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
    async (event, payload: unknown) => {
      observeSenderLifetime(event);
      return await memoryExports.begin({
        senderId: event.sender.id,
        payload,
        isSenderAlive: () => !event.sender.isDestroyed(),
        showSaveDialog: async (dialogOptions) => {
          const owner = BrowserWindow.fromWebContents(event.sender);
          return owner
            ? await dialog.showSaveDialog(owner, dialogOptions)
            : await dialog.showSaveDialog(dialogOptions);
        },
      });
    },
  );
  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
    async (event, payload: unknown) =>
      await memoryExports.commit({ senderId: event.sender.id, payload }),
  );
  registerPrivilegedHandle(
    options,
    IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT,
    (event, payload: unknown) =>
      memoryExports.cancel({ senderId: event.sender.id, payload }),
  );
};
