// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __privateThreadActivityStore,
  subscribeToThreadActivity,
  subscribeToThreadActivityRecord,
} from "@/features/chat/services/thread-activity-store";
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";

const record = (conversationId: string): ThreadActivityRecord => ({
  source: "stella",
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
  it("patches one keyed record without refetching or notifying unrelated cards", async () => {
    let updateListener:
      | ((payload: ThreadActivityUpdatedPayload) => void)
      | null = null;
    const initial = [
      { ...record("a"), threadId: "thread-1", status: "running" as const },
      { ...record("a"), threadId: "thread-2", status: "running" as const },
    ];
    const listThreadActivity = vi.fn(async () => initial);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: vi.fn(
            (listener: (payload: ThreadActivityUpdatedPayload) => void) => {
              updateListener = listener;
              return () => {
                updateListener = null;
              };
            },
          ),
        },
      },
    });

    const first: Array<ThreadActivityRecord | null> = [];
    const second: Array<ThreadActivityRecord | null> = [];
    const unsubscribeFirst = subscribeToThreadActivityRecord(
      "a",
      "thread-1",
      (value) => first.push(value),
    );
    const unsubscribeSecond = subscribeToThreadActivityRecord(
      "a",
      "thread-2",
      (value) => second.push(value),
    );
    await vi.waitFor(() => expect(first.at(-1)?.status).toBe("running"));
    const firstCount = first.length;
    const secondCount = second.length;

    updateListener?.({
      conversationId: "a",
      record: {
        ...initial[0]!,
        status: "completed",
        completedAt: 3_000,
        updatedAt: 3_000,
      },
    });

    expect(first.at(-1)?.status).toBe("completed");
    expect(first).toHaveLength(firstCount + 1);
    expect(second).toHaveLength(secondCount);
    expect(listThreadActivity).toHaveBeenCalledTimes(1);

    // Cards mount and unmount as the transcript window moves. Once this live
    // conversation entry is hydrated, a later card must reuse the index rather
    // than rereading all thread rows.
    unsubscribeSecond();
    const unsubscribeRemounted = subscribeToThreadActivityRecord(
      "a",
      "thread-2",
      () => {},
    );
    await Promise.resolve();
    expect(listThreadActivity).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeRemounted();
  });

  it("does not let stale hydration roll back a keyed lifecycle push", async () => {
    let updateListener:
      | ((payload: ThreadActivityUpdatedPayload) => void)
      | null = null;
    let resolveHydration: ((records: ThreadActivityRecord[]) => void) | null =
      null;
    const stale = {
      ...record("race"),
      status: "running" as const,
      // Millisecond timestamps can collide across a fast lifecycle. A stale
      // running hydration must not outrank a terminal push in the same tick.
      updatedAt: 3_000,
    };
    const listThreadActivity = vi.fn(
      () =>
        new Promise<ThreadActivityRecord[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: vi.fn(
            (listener: (payload: ThreadActivityUpdatedPayload) => void) => {
              updateListener = listener;
              return () => {
                updateListener = null;
              };
            },
          ),
        },
      },
    });

    const seen: Array<ThreadActivityRecord | null> = [];
    const unsubscribe = subscribeToThreadActivityRecord(
      "race",
      stale.threadId,
      (value) => seen.push(value),
    );
    const completed = {
      ...stale,
      status: "completed" as const,
      completedAt: 3_000,
      updatedAt: 3_000,
    };
    updateListener?.({ conversationId: "race", record: completed });
    expect(seen.at(-1)?.status).toBe("completed");

    resolveHydration?.([stale]);
    await vi.waitFor(() => expect(listThreadActivity).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(seen.at(-1)?.status).toBe("completed");
    unsubscribe();
  });

  it("ignores an out-of-order push from an older attempt", async () => {
    let updateListener:
      | ((payload: ThreadActivityUpdatedPayload) => void)
      | null = null;
    const newest = {
      ...record("attempts"),
      status: "running" as const,
      attemptGeneration: 2,
      rootRunId: "run-2",
      updatedAt: 4_000,
      groupKey: "research",
      groupLabel: "Research",
    };
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity: vi.fn(async () => [newest]),
          onThreadActivityUpdated: vi.fn(
            (listener: (payload: ThreadActivityUpdatedPayload) => void) => {
              updateListener = listener;
              return () => {
                updateListener = null;
              };
            },
          ),
        },
      },
    });

    const seen: Array<ThreadActivityRecord | null> = [];
    const unsubscribe = subscribeToThreadActivityRecord(
      "attempts",
      newest.threadId,
      (value) => seen.push(value),
    );
    await vi.waitFor(() => expect(seen.at(-1)?.attemptGeneration).toBe(2));
    updateListener?.({
      conversationId: "attempts",
      record: {
        ...record("attempts"),
        status: "running",
        attemptGeneration: 3,
        rootRunId: "run-3",
        updatedAt: 5_000,
      },
    });
    expect(seen.at(-1)?.attemptGeneration).toBe(3);
    expect(seen.at(-1)?.groupKey).toBe("research");
    expect(seen.at(-1)?.groupLabel).toBe("Research");
    const countBeforeStalePush = seen.length;
    updateListener?.({
      conversationId: "attempts",
      record: {
        ...newest,
        status: "failed",
        attemptGeneration: 1,
        rootRunId: "run-1",
        updatedAt: 6_000,
      },
    });

    expect(seen).toHaveLength(countBeforeStalePush);
    expect(seen.at(-1)?.attemptGeneration).toBe(3);
    expect(seen.at(-1)?.status).toBe("running");
    unsubscribe();
  });

  it("patches assistant prose for only the owning card and mounted aggregate view", async () => {
    let updateListener:
      | ((payload: ThreadActivityUpdatedPayload) => void)
      | null = null;
    const initial = [
      { ...record("prose"), threadId: "thread-1", status: "running" as const },
      { ...record("prose"), threadId: "thread-2", status: "running" as const },
    ];
    const listThreadActivity = vi.fn(async () => initial);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: vi.fn(
            (listener: (payload: ThreadActivityUpdatedPayload) => void) => {
              updateListener = listener;
              return () => {
                updateListener = null;
              };
            },
          ),
        },
      },
    });

    const first: Array<ThreadActivityRecord | null> = [];
    const second: Array<ThreadActivityRecord | null> = [];
    const aggregates: Array<{ records: ThreadActivityRecord[] }> = [];
    const unsubscribeFirst = subscribeToThreadActivityRecord(
      "prose",
      "thread-1",
      (value) => first.push(value),
    );
    const unsubscribeSecond = subscribeToThreadActivityRecord(
      "prose",
      "thread-2",
      (value) => second.push(value),
    );
    const unsubscribeAggregate = subscribeToThreadActivity(
      "prose",
      (snapshot) => aggregates.push(snapshot),
    );
    await vi.waitFor(() => expect(first.at(-1)?.status).toBe("running"));
    const firstCount = first.length;
    const secondCount = second.length;
    const aggregateCount = aggregates.length;

    updateListener?.({
      conversationId: "prose",
      assistantUpdate: {
        threadId: "thread-1",
        assistantMessages: ["Working", "Finished"],
        reasoningSummaries: ["Working", "Finished"],
        latestMessage: "Finished",
        atMs: 2_500,
        atSequence: 42,
        attemptGeneration: 0,
      },
    });

    expect(first).toHaveLength(firstCount + 1);
    expect(first.at(-1)?.assistantMessages).toEqual(["Working", "Finished"]);
    expect(second).toHaveLength(secondCount);
    expect(aggregates).toHaveLength(aggregateCount + 1);
    expect(
      aggregates.at(-1)?.records.find((item) => item.threadId === "thread-1")
        ?.assistantMessages,
    ).toEqual(["Working", "Finished"]);
    expect(listThreadActivity).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeAggregate();
  });

  it("retries a failed keyed hydration and disposes the shared push subscription", async () => {
    vi.useFakeTimers();
    const unsubscribeUpdates = vi.fn();
    let updateListener:
      | ((payload: ThreadActivityUpdatedPayload) => void)
      | null = null;
    const listThreadActivity = vi
      .fn<() => Promise<ThreadActivityRecord[]>>()
      .mockRejectedValueOnce(new Error("worker restarting"))
      .mockResolvedValueOnce([record("retry")]);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: vi.fn(
            (listener: (payload: ThreadActivityUpdatedPayload) => void) => {
              updateListener = listener;
              return unsubscribeUpdates;
            },
          ),
        },
      },
    });

    const seen: Array<ThreadActivityRecord | null> = [];
    const unsubscribe = subscribeToThreadActivityRecord(
      "retry",
      "thread-retry",
      (value) => seen.push(value),
    );
    updateListener?.({
      conversationId: "retry",
      record: { ...record("retry"), status: "running", updatedAt: 1_000 },
    });
    await vi.waitFor(() => expect(listThreadActivity).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(seen.at(-1)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(seen.at(-1)?.status).toBe("completed"));
    expect(listThreadActivity).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(unsubscribeUpdates).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("seeds a returning tab while keeping inactive conversations unsubscribed", async () => {
    let holdReturningA = false;
    const listThreadActivity = vi.fn(
      async ({ conversationId }: { conversationId: string }) => {
        if (conversationId === "a" && holdReturningA) {
          return await new Promise<ThreadActivityRecord[]>(() => {});
        }
        return [record(conversationId)];
      },
    );
    const unsubscribeUpdates = vi.fn();
    const onThreadActivityUpdated = vi.fn(() => unsubscribeUpdates);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { localChat: { listThreadActivity, onThreadActivityUpdated } },
    });

    const aSnapshots: Array<{
      records: ThreadActivityRecord[];
      hasLoaded: boolean;
    }> = [];
    const unsubscribeA = subscribeToThreadActivity("a", (snapshot) =>
      aSnapshots.push(snapshot),
    );
    await waitForLoaded(aSnapshots);
    unsubscribeA();
    expect(unsubscribeUpdates).toHaveBeenCalledTimes(1);

    const bSnapshots: Array<{
      records: ThreadActivityRecord[];
      hasLoaded: boolean;
    }> = [];
    const unsubscribeB = subscribeToThreadActivity("b", (snapshot) =>
      bSnapshots.push(snapshot),
    );
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
    expect(
      returningSnapshots[0]?.records.map((item) => item.description),
    ).toEqual(["Work in a"]);
    expect(listThreadActivity).toHaveBeenCalledTimes(3);

    unsubscribeReturning();
    expect(unsubscribeUpdates).toHaveBeenCalledTimes(3);
  });
});
