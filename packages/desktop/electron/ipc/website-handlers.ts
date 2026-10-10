import { IPC_WEBSITE_GET_BASE_URL } from "@stella/contracts/desktop/ipc-channels";
import {
  assertPrivilegedRequest,
  type PrivilegedIpcOptions,
} from "./privileged-ipc.js";
import { handleIpc } from "./typed-ipc.js";

export const registerWebsiteHandlers = (
  options: PrivilegedIpcOptions & { getWebsiteBaseUrl: () => string },
) => {
  handleIpc(IPC_WEBSITE_GET_BASE_URL, (event) => {
    assertPrivilegedRequest(options, event, IPC_WEBSITE_GET_BASE_URL);
    return options.getWebsiteBaseUrl();
  });
};
