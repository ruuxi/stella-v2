import { session, type IpcMainInvokeEvent } from "electron";
import {
  IPC_APP_SOURCE_APPLY,
  IPC_APP_SOURCE_APPLY_REMOTE,
  IPC_APP_SOURCE_APPLY_UPSTREAM,
  IPC_APP_SOURCE_GET_STATE,
  IPC_APP_SOURCE_SKIP,
  IPC_APP_SOURCE_UNDO,
} from "@stella/contracts/desktop/ipc-channels";
import type { AppSourceActionResult } from "@stella/contracts/desktop/app-source";
import type { AppSourceService } from "../services/app-source/app-source-service.js";
import {
  registerPrivilegedHandle,
  type PrivilegedIpcOptions,
} from "./privileged-ipc.js";

const unavailable: AppSourceActionResult = {
  ok: false,
  error: "Updates are not available here.",
};

/** Present on every build; the service exists only when running from source. */
export const registerAppSourceHandlers = (
  options: PrivilegedIpcOptions & {
    getService: () => AppSourceService | null;
    appPartition: string;
  },
) => {
  // Draft previews share the app's preload and origin but not its session;
  // they may look at the state but never change the checkout.
  const service = (event: IpcMainInvokeEvent) =>
    event.sender.session === session.fromPartition(options.appPartition)
      ? options.getService()
      : null;

  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_GET_STATE,
    () => options.getService()?.getState() ?? null,
  );
  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_APPLY,
    (event, name: unknown) =>
      typeof name === "string"
        ? (service(event)?.applyDraft(name) ?? unavailable)
        : unavailable,
  );
  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_UNDO,
    (event, sha: unknown) =>
      typeof sha === "string"
        ? (service(event)?.undo(sha) ?? unavailable)
        : unavailable,
  );
  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_APPLY_REMOTE,
    (event) => service(event)?.applyRemote() ?? unavailable,
  );
  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_APPLY_UPSTREAM,
    (event) => service(event)?.applyUpstream() ?? unavailable,
  );
  registerPrivilegedHandle(
    options,
    IPC_APP_SOURCE_SKIP,
    (event, key: unknown) =>
      typeof key === "string"
        ? (service(event)?.skip(key) ?? unavailable)
        : unavailable,
  );
};
