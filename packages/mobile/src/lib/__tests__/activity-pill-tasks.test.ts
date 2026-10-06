import { beforeEach, describe, expect, test } from "bun:test";

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
    get length() {
      return memoryStore.size;
    },
    key: (index: number) => [...memoryStore.keys()][index] ?? null,
    clear: () => memoryStore.clear(),
  },
};

import type { ChatMessage, MobileTask } from "../../types";
import { collectConversationTasks } from "../mobile-task-merge";
import {
  __setTranscriptDatabaseForTests,
  loadChatMessages,
  saveChatMessages,
} from "../offline-chat-storage";

/**
 * The floating activity pill shows its running tally iff the conversation's
 * collected tasks include a `running` one (idle it reads "Search"). These tests
 * pin the task-state derivation under the build-94 push regime: the transcript
 * is already cursor-synced, the 5s poll is relaxed/suspended, and task
 * snapshots arrive only through push-triggered cursor deltas — which re-emit
 * the task's spawning row (desktop `withTaskAnchorMessages`) with a `tasks`
 * snapshot attached.
 */

const task = (overrides: Partial<MobileTask> = {}): MobileTask => ({
  id: "agent-1",
  title: "Do X in the background",
  status: "running",
  statusText: "Starting",
  createdAt: 1_000,
  ...overrides,
});

const runningCount = (messages: ChatMessage[]) =>
  collectConversationTasks(messages).filter((t) => t.status === "running")
    .length;

describe("activity pill task derivation under push-connected sync", () => {
  beforeEach(async () => {
    memoryStore.clear();
    await __setTranscriptDatabaseForTests(null);
  });

  test("tasks survive the storage round-trip (pill persists across app relaunch)", async () => {
    const fresh = task({
      agentType: "general",
      parentAgentId: "orchestrator",
      createdAt: Date.now(),
    });
    await saveChatMessages("carplay", [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: fresh.createdAt,
        tasks: [fresh],
      },
    ]);
    const loaded = await loadChatMessages("carplay");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.tasks).toHaveLength(1);
    expect(loaded[0]?.tasks?.[0]?.status).toBe("running");
    expect(loaded[0]?.tasks?.[0]?.agentType).toBe("general");
    expect(loaded[0]?.tasks?.[0]?.parentAgentId).toBe("orchestrator");
    expect(runningCount(loaded)).toBe(1);
  });

  test("a stale persisted running task loads as settled (no forever-shimmer)", async () => {
    const stale = task({ createdAt: Date.now() - 10 * 60_000 });
    await saveChatMessages("carplay", [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: stale.createdAt,
        tasks: [stale],
      },
    ]);
    const loaded = await loadChatMessages("carplay");
    expect(loaded[0]?.tasks?.[0]?.status).toBe("completed");
    expect(runningCount(loaded)).toBe(0);
  });

  test("hydration is corruption-tolerant: garbage rows drop, good rows load", async () => {
    // Simulate a store written by a different (older/newer) code version:
    // valid rows interleaved with shapes parseRow was never taught about.
    memoryStore.set(
      "stella-mobile-carplay-chat-v1",
      JSON.stringify([
        null,
        42,
        "not-a-row",
        { id: 7, role: "assistant", text: 1 },
        { id: "bad-tasks", role: "assistant", text: "hi", tasks: { not: "an array" } },
        {
          id: "good",
          role: "assistant",
          text: "Still here.",
          createdAt: 1_000,
          tasks: [task({ status: "completed", completedAt: 2_000 })],
        },
      ]),
    );
    const loaded = await loadChatMessages("carplay");
    expect(loaded.map((m) => m.id)).toEqual(["bad-tasks", "good"]);
    expect(loaded[1]?.tasks).toHaveLength(1);
  });
});
