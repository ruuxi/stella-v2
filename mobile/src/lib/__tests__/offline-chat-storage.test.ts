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
});
