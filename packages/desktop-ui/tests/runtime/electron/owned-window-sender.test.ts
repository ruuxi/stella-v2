import { describe, expect, it } from "vitest";

import { isOwnedWindowMainFrameSender } from "@stella/desktop/electron/ipc/owned-window-sender";

const createWindow = (id: number, destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { id },
});

const createEvent = (
  senderId: number,
  options: { childFrame?: boolean; senderFrame?: boolean } = {},
) => {
  const mainFrame = {};
  return {
    sender: { id: senderId, mainFrame },
    senderFrame:
      options.senderFrame === false
        ? null
        : options.childFrame
          ? {}
          : mainFrame,
  } as never;
};

describe("owned update-window sender trust", () => {
  it("accepts the main frame of a live Stella window by WebContents identity", () => {
    expect(
      isOwnedWindowMainFrameSender(createEvent(42), [createWindow(42)]),
    ).toBe(true);
  });

  it("accepts an owned sender when Electron omits senderFrame", () => {
    expect(
      isOwnedWindowMainFrameSender(
        createEvent(42, { senderFrame: false }),
        [createWindow(42)],
      ),
    ).toBe(true);
  });

  it("rejects child frames, foreign WebContents, and destroyed windows", () => {
    expect(
      isOwnedWindowMainFrameSender(createEvent(42, { childFrame: true }), [
        createWindow(42),
      ]),
    ).toBe(false);
    expect(
      isOwnedWindowMainFrameSender(createEvent(7), [createWindow(42)]),
    ).toBe(false);
    expect(
      isOwnedWindowMainFrameSender(createEvent(42), [createWindow(42, true)]),
    ).toBe(false);
  });
});
