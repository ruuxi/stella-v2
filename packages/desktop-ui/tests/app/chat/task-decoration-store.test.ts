import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __privateTaskDecorationStore,
  appendTaskReasoning,
  clearTaskDecoration,
  clearConversationTaskDecorations,
  decorateTask,
  getTaskDecoration,
  getConversationTaskDecorationsSnapshot,
  subscribeConversationTaskDecorations,
  subscribeTaskActivityDecorations,
  settleTaskDecoration,
  getTaskDecorationsSnapshot,
  MAX_TASK_DECORATIONS,
  subscribeTaskDecoration,
  subscribeTaskDecorations,
} from "@/features/chat/streaming/task-decoration-store";

afterEach(() => {
  __privateTaskDecorationStore.resetForTests();
});

describe("task-decoration-store", () => {
  it("merges decorate + reasoning per thread and keeps a stable snapshot between writes", () => {
    decorateTask({
      agentId: "t1",
      conversationId: "c1",
      runId: "r1",
      statusText: "Reading guides",
    });
    appendTaskReasoning({ agentId: "t1", conversationId: "c1", chunk: "ab" });
    appendTaskReasoning({ agentId: "t1", conversationId: "c1", chunk: "cd" });
    expect(getTaskDecoration("t1")).toMatchObject({
      runId: "r1",
      statusText: "Reading guides",
      reasoningText: "abcd",
    });
    const first = getTaskDecorationsSnapshot();
    expect(getTaskDecorationsSnapshot()).toBe(first);
    decorateTask({ agentId: "t1", conversationId: "c1", statusText: "Next" });
    expect(getTaskDecorationsSnapshot()).not.toBe(first);
  });

  it("notifies per-agent subscribers only for their own thread", () => {
    const mine = vi.fn();
    const global = vi.fn();
    subscribeTaskDecoration("t1", mine);
    subscribeTaskDecorations(global);
    decorateTask({ agentId: "t2", conversationId: "c1", statusText: "x" });
    expect(mine).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledTimes(1);
    decorateTask({ agentId: "t1", conversationId: "c1", statusText: "y" });
    expect(mine).toHaveBeenCalledTimes(1);
    clearTaskDecoration("t1");
    expect(mine).toHaveBeenCalledTimes(2);
  });

  it("caps the map by evicting the least-recently-updated entry, only on genuinely new keys", () => {
    for (let index = 0; index < MAX_TASK_DECORATIONS; index += 1) {
      decorateTask({
        agentId: `t${index}`,
        conversationId: "c1",
        statusText: `s${index}`,
      });
    }
    // Updating an existing key at the cap must not evict anything.
    decorateTask({ agentId: "t5", conversationId: "c1", statusText: "fresh" });
    expect(Object.keys(getTaskDecorationsSnapshot())).toHaveLength(
      MAX_TASK_DECORATIONS,
    );
    expect(getTaskDecoration("t0")).toBeDefined();
    // A new key past the cap evicts the oldest entry.
    decorateTask({ agentId: "overflow", conversationId: "c1", statusText: "z" });
    expect(Object.keys(getTaskDecorationsSnapshot())).toHaveLength(
      MAX_TASK_DECORATIONS,
    );
    expect(getTaskDecoration("overflow")).toBeDefined();
  });
});


describe("activity subscriptions", () => {
  it("keeps shell snapshots stable while delivering every reasoning update to the owning agent", () => {
    decorateTask({ agentId: "a", conversationId: "c", runId: "r", attemptGeneration: 1, statusText: "Reading" });
    const snapshot = getConversationTaskDecorationsSnapshot("c");
    const activity = vi.fn();
    const agent = vi.fn();
    subscribeConversationTaskDecorations("c", activity);
    subscribeTaskDecoration("a", agent);
    for (let i = 0; i < 100; i++) {
      appendTaskReasoning({ agentId: "a", conversationId: "c", runId: "r", attemptGeneration: 1, lifecycleSequence: i, chunk: "x" });
    }
    expect(activity).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledTimes(100);
    expect(getTaskDecoration("a")?.reasoningText).toBe("x".repeat(100));
    expect(getTaskDecoration("a")?.lifecycleSequence).toBe(99);
    expect(getConversationTaskDecorationsSnapshot("c")).toBe(snapshot);
    expect(snapshot.a).not.toHaveProperty("reasoningText");
    decorateTask({ agentId: "a", conversationId: "c", runId: "r", attemptGeneration: 1, lifecycleSequence: 100, statusText: "Writing" });
    expect(activity).toHaveBeenCalledTimes(1);
    expect(getConversationTaskDecorationsSnapshot("c").a.statusText).toBe("Writing");
    expect(snapshot.a.statusText).toBe("Reading");
  });

  it("does not notify or replace another conversation's snapshot", () => {
    const empty = getConversationTaskDecorationsSnapshot("other");
    const listener = vi.fn();
    const unsubscribe = subscribeConversationTaskDecorations("other", listener);
    decorateTask({ agentId: "a", conversationId: "c", statusText: "Reading" });
    appendTaskReasoning({ agentId: "a", conversationId: "c", chunk: "x" });
    expect(listener).not.toHaveBeenCalled();
    expect(getConversationTaskDecorationsSnapshot("other")).toBe(empty);
    unsubscribe();
  });

  it("publishes first/new-attempt reasoning, terminal lifecycle, and removal without resurrecting stale reasoning", () => {
    const listener = vi.fn();
    subscribeTaskActivityDecorations(listener);
    appendTaskReasoning({ agentId: "a", conversationId: "c", runId: "r1", attemptGeneration: 1, chunk: "x" });
    expect(listener).toHaveBeenCalledTimes(1);
    settleTaskDecoration({ agentId: "a", conversationId: "c", runId: "r1", attemptGeneration: 1, status: "completed" });
    expect(getConversationTaskDecorationsSnapshot("c").a.status).toBe("completed");
    appendTaskReasoning({ agentId: "a", conversationId: "c", runId: "r1", attemptGeneration: 1, chunk: "stale" });
    expect(listener).toHaveBeenCalledTimes(2);
    appendTaskReasoning({ agentId: "a", conversationId: "c", runId: "r2", attemptGeneration: 2, chunk: "new" });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getConversationTaskDecorationsSnapshot("c").a).toMatchObject({ status: "running", runId: "r2", attemptGeneration: 2 });
    const prior = getConversationTaskDecorationsSnapshot("c");
    clearTaskDecoration("a");
    expect(listener).toHaveBeenCalledTimes(4);
    expect(getConversationTaskDecorationsSnapshot("c")).toEqual({});
    expect(prior.a.runId).toBe("r2");
  });
});


it("clears a whole conversation and evicts activity snapshots with the live store", () => {
  decorateTask({ agentId: "old", conversationId: "old-conversation", statusText: "old" });
  const old = getConversationTaskDecorationsSnapshot("old-conversation");
  const removed = vi.fn();
  subscribeConversationTaskDecorations("old-conversation", removed);
  for (let i = 0; i < MAX_TASK_DECORATIONS; i++) {
    decorateTask({ agentId: `new-${i}`, conversationId: "new-conversation", statusText: "new" });
  }
  expect(getConversationTaskDecorationsSnapshot("old-conversation")).toEqual({});
  expect(removed).toHaveBeenCalledTimes(1);
  expect(old.old.statusText).toBe("old");
  const prior = getConversationTaskDecorationsSnapshot("new-conversation");
  clearConversationTaskDecorations("new-conversation");
  expect(getConversationTaskDecorationsSnapshot("new-conversation")).toEqual({});
  expect(Object.keys(prior)).toHaveLength(MAX_TASK_DECORATIONS);
});
