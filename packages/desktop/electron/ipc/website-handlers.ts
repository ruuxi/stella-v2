/**
 * IPC handler exposing the Stella website base URL to the renderer.
 *
 * Stripe Checkout / Portal return the user to the website's `/billing`
 * page, so the billing surface needs the same origin main resolves from
 * `STELLA_WEB_URL` (or the production default).
 */

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
