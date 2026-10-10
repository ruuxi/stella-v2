import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { IpcInvokeChannel } from "@stella/contracts/desktop/ipc-contract";
import { handleIpc, type IpcInvokeHandler } from "./typed-ipc.js";

export type PrivilegedIpcOptions = {
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export function assertPrivilegedRequest(
  options: PrivilegedIpcOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
) {
  if (!options.assertPrivilegedSender(event, channel)) {
    throw new Error(`Blocked untrusted ${channel} request.`);
  }
}

export function registerPrivilegedHandle<C extends IpcInvokeChannel>(
  options: PrivilegedIpcOptions,
  channel: C,
  handler: IpcInvokeHandler<C>,
) {
  handleIpc(channel, async (event, ...args) => {
    assertPrivilegedRequest(options, event, channel);
    return await handler(event, ...args);
  });
}
