import { describe, expect, it } from "vitest";
import {
  runMobileHello,
  waitForSelectedCloudConversation,
} from "@stella/desktop/electron/ipc/mobile-hello-handlers.js";

describe("mobile:hello cloud authority", () => {
  it("waits boundedly for the renderer-selected cloud conversation", async () => {
    let reads = 0;
    const conversationId = await waitForSelectedCloudConversation(
      () => (++reads >= 2 ? " cloud-selected " : null),
      {
        timeoutMs: 100,
        sleep: async () => undefined,
      },
    );

    expect(conversationId).toBe("cloud-selected");
    expect(reads).toBe(2);
  });

  it("returns cloud authority without reading or creating SQLite history", async () => {
    const result = await runMobileHello(
      {
        getActiveConversationId: () => "cloud-selected",
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      },
      {
        expectedConversationId: "cloud-selected",
        sinceCursor: "cloud:17",
        negotiateOnly: true,
      },
    );

    expect(result).toMatchObject({
      conversationId: "cloud-selected",
      conversationChanged: false,
      historyAuthority: "cloud",
      historyAvailableFromDesktopBridge: false,
      messages: [],
      cursor: "cloud:17",
    });
  });

  it("fails closed when cloud selection has not arrived", async () => {
    await expect(
      runMobileHello({
        getActiveConversationId: () => null,
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      }),
    ).rejects.toThrow("cloud conversation is still loading");
  });

  it("refuses to serve transcript history through the desktop bridge", async () => {
    await expect(
      runMobileHello({
        getActiveConversationId: () => "cloud-selected",
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      }),
    ).rejects.toThrow("history is cloud-owned");
  });
});
