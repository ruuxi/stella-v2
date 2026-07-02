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

import type { ChatMessage, MobileTask } from "../../types";
import { mergeMessagesById } from "../chat-merge";
import { collectConversationTasks } from "../mobile-task-merge";
import { loadChatMessages, saveChatMessages } from "../offline-chat-storage";

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
  test("a push-delta anchor row re-delivers the running task to an already-synced transcript", () => {
    // Phone state: rows already synced (e.g. reloaded from storage that
    // predates the tasks fix), no task snapshots anywhere.
    const current: ChatMessage[] = [
      { id: "u1", role: "user", text: "do X in the background", createdAt: 900 },
      { id: "a1", role: "assistant", text: "Working on it.", createdAt: 1_100 },
    ];
    expect(runningCount(current)).toBe(0);

    // Push fires (agent-progress persisted on the desktop) → cursor delta
    // re-emits the spawning assistant row, now carrying the task snapshot.
    const delta: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: 1_100,
        tasks: [task({ statusText: "Halfway" })],
      },
    ];
    const merged = mergeMessagesById(current, delta);
    const tasks = collectConversationTasks(merged);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("running");
    expect(tasks[0]?.statusText).toBe("Halfway");
  });

  test("a later terminal snapshot beats the running one; the pill goes away", () => {
    const withRunning: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: 1_100,
        tasks: [task()],
      },
    ];
    expect(runningCount(withRunning)).toBe(1);

    const merged = mergeMessagesById(withRunning, [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: 1_100,
        tasks: [task({ status: "completed", completedAt: 2_000 })],
      },
    ]);
    expect(runningCount(merged)).toBe(0);
    expect(collectConversationTasks(merged)[0]?.status).toBe("completed");
  });

  test("tasks survive the storage round-trip (pill persists across app relaunch)", async () => {
    const fresh = task({ createdAt: Date.now() });
    await saveChatMessages("computer", [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: fresh.createdAt,
        tasks: [fresh],
      },
    ]);
    const loaded = await loadChatMessages("computer");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.tasks).toHaveLength(1);
    expect(loaded[0]?.tasks?.[0]?.status).toBe("running");
    expect(runningCount(loaded)).toBe(1);
  });

  test("a stale persisted running task loads as settled (no forever-shimmer)", async () => {
    const stale = task({ createdAt: Date.now() - 10 * 60_000 });
    await saveChatMessages("computer", [
      {
        id: "a1",
        role: "assistant",
        text: "Working on it.",
        createdAt: stale.createdAt,
        tasks: [stale],
      },
    ]);
    const loaded = await loadChatMessages("computer");
    expect(loaded[0]?.tasks?.[0]?.status).toBe("completed");
    expect(runningCount(loaded)).toBe(0);
  });
});
