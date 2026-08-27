import { ipcMain } from "electron";
import { IPC_WEBSITE_GET_BASE_URL } from "@stella/contracts/desktop/ipc-channels";
import {
  assertPrivilegedRequest,
  type PrivilegedIpcOptions,
} from "./privileged-ipc.js";

export const registerWebsiteHandlers = (
  options: PrivilegedIpcOptions & { getWebsiteBaseUrl: () => string },
) => {
  ipcMain.handle(IPC_WEBSITE_GET_BASE_URL, (event) => {
    assertPrivilegedRequest(options, event, IPC_WEBSITE_GET_BASE_URL);
    return options.getWebsiteBaseUrl();
  });
};
