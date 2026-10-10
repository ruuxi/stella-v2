import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type {
  IpcInvokeArgs,
  IpcInvokeChannel,
  IpcInvokeResult,
  IpcSendArgs,
  IpcSendChannel,
} from "@stella/contracts/desktop/ipc-contract";

/**
 * Main-process side of the typed IPC contract
 * (`@stella/contracts/desktop/ipc-contract`). Register every renderer-facing
 * channel through these instead of `ipcMain` directly, so the handler's
 * arguments and result are checked against the preload bridge.
 *
 * Arguments come from a renderer and are typed as what the bridge sends, not
 * as validated input: handlers keep their own runtime checks.
 */

export type IpcInvokeHandler<C extends IpcInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IpcInvokeArgs<C>
) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>;

export type IpcSendListener<C extends IpcSendChannel> = (
  event: IpcMainEvent,
  ...args: IpcSendArgs<C>
) => void | Promise<void>;

/** `ipcMain.handle` for a contract invoke channel. */
export function handleIpc<C extends IpcInvokeChannel>(
  channel: C,
  handler: IpcInvokeHandler<C>,
): void {
  ipcMain.handle(
    channel,
    handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  );
}

/** `ipcMain.on` for a contract send channel. */
export function onIpc<C extends IpcSendChannel>(
  channel: C,
  listener: IpcSendListener<C>,
): void {
  ipcMain.on(
    channel,
    listener as (event: IpcMainEvent, ...args: unknown[]) => void,
  );
}

/** `ipcMain.removeListener` for a listener registered with `onIpc`. */
export function offIpc<C extends IpcSendChannel>(
  channel: C,
  listener: IpcSendListener<C>,
): void {
  ipcMain.removeListener(
    channel,
    listener as (event: IpcMainEvent, ...args: unknown[]) => void,
  );
}
