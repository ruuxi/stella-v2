import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_SCAN_LOCAL,
} from "@stella/contracts/desktop/ipc-channels";
import { scanOwnedLocalCloudHome } from "../services/cloud-home-local-import.js";
import {
  confirmLocalCloudHomeImportOwnership,
  getLocalCloudHomeImportOwnership,
} from "../services/cloud-home-import-owner.js";
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
};
