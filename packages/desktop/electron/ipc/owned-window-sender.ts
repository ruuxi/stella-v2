import type { IpcMainInvokeEvent, WebFrameMain } from "electron";

type OwnedWindow = {
  isDestroyed: () => boolean;
  webContents: { id: number };
};

type OwnedWindowSenderEvent = Pick<
  IpcMainInvokeEvent,
  "sender" | "senderFrame"
>;

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
