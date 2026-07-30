import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  ipcMain: {
    handle: () => undefined,
  },
}));

const { runMobileHello, waitForSelectedCloudConversation } =
  await import("./mobile-hello-handlers.js");
const { MOBILE_BRIDGE_CAPABILITIES } =
  await import("../services/mobile-bridge/capabilities.js");

describe("desktop mobile hello cloud selection", () => {
  test("waits for the renderer-selected cloud conversation", async () => {
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

  test("never returns SQLite rows as cloud conversation history", async () => {
    const result = await runMobileHello(
      {
        getActiveConversationId: () => "cloud-selected",
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      },
      { negotiateOnly: true },
    );

    expect(result.conversationId).toBe("cloud-selected");
    expect(result).toMatchObject({
      historyAuthority: "cloud",
      historyAvailableFromDesktopBridge: false,
      messages: [],
    });
  });

  test("does not expose local transcript sync capabilities to mobile", () => {
    const names = new Set(
      MOBILE_BRIDGE_CAPABILITIES.map((capability) => capability.path),
    );
    expect(names.has("localChat.getOrCreateDefaultConversationId")).toBe(false);
    expect(names.has("localChat.listMessages")).toBe(false);
    expect(names.has("localChat.listSyncMessages")).toBe(false);
    expect(names.has("localChat.syncMessages")).toBe(false);
    expect(names.has("localChat.onUpdated")).toBe(false);
  });

  test("fails closed when a caller asks the desktop bridge for transcript history", async () => {
    await expect(
      runMobileHello({
        getActiveConversationId: () => "cloud-selected",
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      }),
    ).rejects.toThrow("history is cloud-owned");
  });

  test("fails closed while cloud selection is unavailable", async () => {
    await expect(
      runMobileHello({
        getActiveConversationId: () => null,
        getUiStateSnapshot: () => ({}),
        conversationWait: { timeoutMs: 0 },
      }),
    ).rejects.toThrow("cloud conversation is still loading");
  });
});
