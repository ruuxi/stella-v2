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
});
