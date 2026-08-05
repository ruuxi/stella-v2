// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __privateThreadActivityStore,
  subscribeToThreadActivity,
} from "@/features/chat/services/thread-activity-store";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";

const record = (conversationId: string): ThreadActivityRecord => ({
  threadId: `thread-${conversationId}`,
  conversationId,
  agentType: "general",
  description: `Work in ${conversationId}`,
  status: "completed",
  startedAt: 1_000,
  completedAt: 2_000,
  updatedAt: 2_000,
});

const waitForLoaded = async (snapshots: Array<{ hasLoaded: boolean }>) => {
  for (let index = 0; index < 20; index += 1) {
    if (snapshots.at(-1)?.hasLoaded) return;
    await Promise.resolve();
  }
  throw new Error("activity did not load");
};

afterEach(() => {
  __privateThreadActivityStore.resetForTests();
  Reflect.deleteProperty(window, "electronAPI");
  vi.restoreAllMocks();
});

describe("thread activity tab cache", () => {
  it("seeds a returning tab while keeping inactive conversations unsubscribed", async () => {
    let holdReturningA = false;
    const listThreadActivity = vi.fn(async ({ conversationId }: { conversationId: string }) => {
      if (conversationId === "a" && holdReturningA) {
        return await new Promise<ThreadActivityRecord[]>(() => {});
      }
      return [record(conversationId)];
    });
    const unsubscribeUpdates = vi.fn();
    const onThreadActivityUpdated = vi.fn(() => unsubscribeUpdates);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { localChat: { listThreadActivity, onThreadActivityUpdated } },
    });

    const aSnapshots: Array<{ records: ThreadActivityRecord[]; hasLoaded: boolean }> = [];
    const unsubscribeA = subscribeToThreadActivity("a", (snapshot) => aSnapshots.push(snapshot));
    await waitForLoaded(aSnapshots);
    unsubscribeA();
    expect(unsubscribeUpdates).toHaveBeenCalledTimes(1);

    const bSnapshots: Array<{ records: ThreadActivityRecord[]; hasLoaded: boolean }> = [];
    const unsubscribeB = subscribeToThreadActivity("b", (snapshot) => bSnapshots.push(snapshot));
    await waitForLoaded(bSnapshots);
    unsubscribeB();
    expect(unsubscribeUpdates).toHaveBeenCalledTimes(2);

    holdReturningA = true;
    const returningSnapshots: Array<{
      records: ThreadActivityRecord[];
      hasLoaded: boolean;
    }> = [];
    const unsubscribeReturning = subscribeToThreadActivity("a", (snapshot) =>
      returningSnapshots.push(snapshot),
    );
    expect(returningSnapshots[0]?.hasLoaded).toBe(false);
    expect(returningSnapshots[0]?.records.map((item) => item.description)).toEqual([
      "Work in a",
    ]);
    expect(listThreadActivity).toHaveBeenCalledTimes(3);

    unsubscribeReturning();
    expect(unsubscribeUpdates).toHaveBeenCalledTimes(3);
  });
});
