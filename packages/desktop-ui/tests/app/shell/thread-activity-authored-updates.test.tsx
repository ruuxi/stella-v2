// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";
import { useActivityTasks } from "@/features/chat/hooks/use-thread-activity";
import { __privateThreadActivityStore } from "@/features/chat/services/thread-activity-store";
import { getTaskAgentUpdates } from "@/features/chat/lib/event-transforms";
import { AgentAssistantUpdates } from "@/shell/AgentAssistantUpdates";

const runningRecord = (
  assistantMessages: string[],
  overrides: Partial<ThreadActivityRecord> = {},
): ThreadActivityRecord => ({
  threadId: "agent-1",
  conversationId: "conv-1",
  agentType: "general",
  description: "Inspect the live route",
  status: "running",
  attemptGeneration: 2,
  rootRunId: "run-2",
  startedAt: 2_000,
  assistantMessages,
  assistantMessagesUpdatedAt: 2_000 + (assistantMessages.length - 1) * 100,
  assistantMessagesEntrySequence: assistantMessages.length,
  updatedAt: 2_000,
  ...overrides,
});

const assistantUpdate = (
  assistantMessages: string[],
  overrides: Partial<
    NonNullable<ThreadActivityUpdatedPayload["assistantUpdate"]>
  > = {},
): ThreadActivityUpdatedPayload => ({
  conversationId: "conv-1",
  assistantUpdate: {
    threadId: "agent-1",
    assistantMessages,
    reasoningSummaries: assistantMessages,
    latestMessage: assistantMessages.at(-1) ?? "",
    atMs: 2_000 + (assistantMessages.length - 1) * 100,
    entrySequence: assistantMessages.length,
    attemptGeneration: 2,
    rootRunId: "run-2",
    ...overrides,
  },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

function MountedActivity({
  conversationId = "conv-1",
}: {
  conversationId?: string;
}) {
  const tasks = useActivityTasks(conversationId);
  const messages = tasks.flatMap((task) => [...getTaskAgentUpdates(task)]);
  return (
    <section>
      <output data-testid="updates">{messages.join("|") || "empty"}</output>
      <AgentAssistantUpdates messages={messages} />
    </section>
  );
}

describe("mounted Activity authored-message refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootMounted: boolean;
  let updateListener:
    | ((payload: ThreadActivityUpdatedPayload) => void)
    | undefined;
  let records: ThreadActivityRecord[];
  const oneShotCompletion = vi.fn();
  const listThreadActivity = vi.fn(async () => records);

  beforeEach(() => {
    vi.useFakeTimers();
    records = [runningRecord(["First persisted update"])];
    updateListener = undefined;
    listThreadActivity.mockClear();
    listThreadActivity.mockImplementation(async () => records);
    oneShotCompletion.mockClear();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: (
            listener: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            updateListener = listener;
            return () => {
              updateListener = undefined;
            };
          },
        },
        agent: { oneShotCompletion },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
  });

  afterEach(async () => {
    if (rootMounted) await act(async () => root.unmount());
    __privateThreadActivityStore.resetForTests();
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("updates a running mounted row immediately and never invokes one-shot/relay work", async () => {
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update",
    );

    records = [
      runningRecord(["First persisted update", "Second persisted update"]),
    ];
    await act(async () => {
      updateListener?.(
        assistantUpdate(["First persisted update", "Second persisted update"]),
      );
    });

    // Optimistic payload application is synchronous with the persisted-write
    // notification; the debounced authoritative refetch is only a backstop.
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update",
    );
    expect(oneShotCompletion).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(listThreadActivity).toHaveBeenCalledTimes(2);
    expect(oneShotCompletion).not.toHaveBeenCalled();

    // The old feature scheduled its first summary request at 10 seconds and
    // repeated every 30 seconds. Keep the actual mounted Activity projection
    // alive well beyond that window and prove no timer/request path exists.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listThreadActivity).toHaveBeenCalledTimes(2);
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("keeps persisted final prose across a terminal-row refetch", async () => {
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });

    records = [
      runningRecord([], {
        status: "completed",
        completedAt: 2_200,
        updatedAt: 2_200,
      }),
    ];
    await act(async () => {
      updateListener?.(
        assistantUpdate(["First persisted update", "Final persisted answer"], {
          atMs: 2_200,
          entrySequence: 22,
        }),
      );
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Final persisted answer",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Final persisted answer",
    );
  });

  it("never lets a stale in-flight refetch roll back rapid live updates", async () => {
    const slowFetch = deferred<ThreadActivityRecord[]>();
    const latest = [
      runningRecord([
        "First persisted update",
        "Second persisted update",
        "Third persisted update",
      ]),
    ];
    listThreadActivity
      .mockReset()
      .mockResolvedValueOnce([runningRecord(["First persisted update"])])
      .mockReturnValueOnce(slowFetch.promise)
      .mockResolvedValueOnce(latest);

    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      updateListener?.({ conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(listThreadActivity).toHaveBeenCalledTimes(2);

    await act(async () => {
      updateListener?.(
        assistantUpdate(["First persisted update", "Second persisted update"]),
      );
      updateListener?.(
        assistantUpdate([
          "First persisted update",
          "Second persisted update",
          "Third persisted update",
        ]),
      );
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update|Third persisted update",
    );

    await act(async () => {
      slowFetch.resolve([runningRecord(["First persisted update"])]);
      await slowFetch.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update|Third persisted update",
    );
    expect(listThreadActivity).toHaveBeenCalledTimes(3);
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("uses entry sequence to reject a stale same-millisecond list response", async () => {
    const staleFetch = deferred<ThreadActivityRecord[]>();
    listThreadActivity
      .mockReset()
      .mockResolvedValueOnce([
        runningRecord(["First update"], {
          assistantMessagesUpdatedAt: 2_100,
          assistantMessagesEntrySequence: 10,
        }),
      ])
      .mockReturnValueOnce(staleFetch.promise)
      .mockResolvedValueOnce([
        runningRecord(["First update", "Second update"], {
          assistantMessagesUpdatedAt: 2_100,
          assistantMessagesEntrySequence: 11,
        }),
      ]);

    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
      updateListener?.({ conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      updateListener?.(
        assistantUpdate(["First update", "Second update"], {
          atMs: 2_100,
          entrySequence: 11,
        }),
      );
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First update|Second update",
    );

    await act(async () => {
      staleFetch.resolve([
        runningRecord(["First update"], {
          assistantMessagesUpdatedAt: 2_100,
          assistantMessagesEntrySequence: 10,
        }),
      ]);
      await staleFetch.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First update|Second update",
    );
  });

  it("keeps a live snapshot through a failed request and ignores torn-down work", async () => {
    const failingFetch = deferred<ThreadActivityRecord[]>();
    const switchedAwayFetch = deferred<ThreadActivityRecord[]>();
    const teardownFetch = deferred<ThreadActivityRecord[]>();
    listThreadActivity
      .mockReset()
      .mockResolvedValueOnce([runningRecord(["First persisted update"])])
      .mockReturnValueOnce(failingFetch.promise)
      .mockResolvedValueOnce([
        runningRecord(["First persisted update", "Second persisted update"]),
      ])
      .mockReturnValueOnce(switchedAwayFetch.promise)
      .mockResolvedValueOnce([
        runningRecord(["Conversation two update"], {
          threadId: "agent-2",
          conversationId: "conv-2",
          rootRunId: "run-conv-2",
        }),
      ]);
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      updateListener?.({ conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      updateListener?.(
        assistantUpdate(["First persisted update", "Second persisted update"]),
      );
      failingFetch.reject(new Error("worker restarted"));
      await failingFetch.promise.catch(() => undefined);
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update",
    );

    await act(async () => {
      // The live update's trailing refresh catches up successfully.
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
      // Start another conv-1 request and switch conversations while it hangs.
      updateListener?.({ conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      root.render(<MountedActivity conversationId="conv-2" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "Conversation two update",
    );
    await act(async () => {
      switchedAwayFetch.resolve([runningRecord(["obsolete conv-1 result"])]);
      await switchedAwayFetch.promise;
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "Conversation two update",
    );

    listThreadActivity.mockReturnValueOnce(teardownFetch.promise);
    await act(async () => {
      updateListener?.({ conversationId: "conv-2" });
      await vi.advanceTimersByTimeAsync(120);
      root.unmount();
      rootMounted = false;
      teardownFetch.resolve([runningRecord(["obsolete teardown result"])]);
      await teardownFetch.promise;
      await Promise.resolve();
    });
    expect(updateListener).toBeUndefined();
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("uses a text-safe, collision-free signature for rendered activity fields", () => {
    const embeddedSeparator = runningRecord([], {
      description: "left\0right",
      rootRunId: "tail",
    });
    const shiftedSeparator = runningRecord([], {
      description: "left",
      rootRunId: "right\0tail",
    });

    const embeddedSignature = __privateThreadActivityStore.recordsSignature([
      embeddedSeparator,
    ]);
    const shiftedSignature = __privateThreadActivityStore.recordsSignature([
      shiftedSeparator,
    ]);

    expect(embeddedSignature).not.toBe(shiftedSignature);
    expect(embeddedSignature).not.toContain("\0");
    expect(shiftedSignature).not.toContain("\0");
  });
});
