import type { IpcMainInvokeEvent, WebFrameMain } from "electron";

type OwnedWindow = {
  isDestroyed: () => boolean;
  webContents: { id: number };
};

type OwnedWindowSenderEvent = Pick<
  IpcMainInvokeEvent,
  "sender" | "senderFrame"
>;

/**
 * Trust the main frame of a BrowserWindow Stella created itself.
 *
 * Packaged Windows file URLs can differ from the on-disk path used to seed
 * renderer URL trust (drive aliases and path normalization are the common
 * offenders). The WebContents identity is stable across those differences.
 * Child frames remain excluded so embedded content cannot inherit this trust.
 */
export const isOwnedWindowMainFrameSender = (
  event: OwnedWindowSenderEvent,
  windows: readonly OwnedWindow[],
): boolean => {
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame as WebFrameMain | undefined;
  if (senderFrame && mainFrame && senderFrame !== mainFrame) {
    return false;
  }

  return windows.some(
    (window) =>
      !window.isDestroyed() && window.webContents.id === event.sender.id,
  );
};
