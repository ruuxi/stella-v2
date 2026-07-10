import { describe, expect, test } from "bun:test";

// AsyncStorage's non-native fallback talks to `window.localStorage`; give the
// bun test runtime an in-memory one before the storage module is exercised.
const memoryStore = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  },
};

import type { ChatMessage } from "../../types";
import { loadChatMessages, saveChatMessages } from "../offline-chat-storage";

describe("chat storage round-trip", () => {
  test("preserves the canonical ordering stamp alongside the local anchor", async () => {
    const rows: ChatMessage[] = [
      {
        id: "local-u",
        role: "user",
        text: "question",
        canonicalId: "desk-u",
        createdAt: 911_000,
        canonicalCreatedAt: 1_003_000,
      },
      {
        id: "desk-a",
        role: "assistant",
        text: "answer",
        createdAt: 1_004_000,
        canonicalCreatedAt: 1_004_000,
      },
      // In-flight local row: no canonical identity, no stamp.
      { id: "local-x", role: "user", text: "in flight", createdAt: 911_500 },
    ];
    await saveChatMessages("computer", rows);
    const loaded = await loadChatMessages("computer");
    expect(loaded.map((m) => m.id)).toEqual(["local-u", "desk-a", "local-x"]);
    expect(loaded[0]?.canonicalCreatedAt).toBe(1_003_000);
    expect(loaded[0]?.createdAt).toBe(911_000);
    expect(loaded[1]?.canonicalCreatedAt).toBe(1_004_000);
    expect(loaded[2]?.canonicalCreatedAt === undefined).toBe(true);
  });

  test("round-trips queued / stopped / requestId so a restart is honest and de-dupes", async () => {
    const rows: ChatMessage[] = [
      // A queued-but-unsent bubble must reload as queued, never as delivered.
      { id: "q1", role: "user", text: "send me later", createdAt: 5, queued: true },
      // A reply linked only by requestId (killed before the canonicalId
      // reconcile) must keep it so the restart catch-up sync de-dupes it.
      {
        id: "a1",
        role: "assistant",
        text: "partial",
        createdAt: 6,
        requestId: "desk-user-1",
        stopped: true,
      },
    ];
    await saveChatMessages("cloud", rows);
    const loaded = await loadChatMessages("cloud");
    expect(loaded[0]?.queued).toBe(true);
    expect(loaded[1]?.requestId).toBe("desk-user-1");
    expect(loaded[1]?.stopped).toBe(true);
  });

  test("round-trips normal-chat image metadata for history reload", async () => {
    const rows: ChatMessage[] = [
      {
        id: "image-u",
        role: "user",
        text: "What is this?",
        createdAt: 10,
        hasImage: true,
        thumbnailUris: ["file:///cached/photo.png"],
      },
    ];

    await saveChatMessages("cloud", rows);
    const loaded = await loadChatMessages("cloud");
    expect(loaded).toEqual(rows);
  });
});
