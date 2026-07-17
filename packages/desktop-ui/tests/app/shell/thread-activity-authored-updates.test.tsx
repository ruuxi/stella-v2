// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import { __privateThreadActivityStore } from "@/features/chat/services/thread-activity-store";

const runningRecord = (assistantMessages: string[]): ThreadActivityRecord => ({
  threadId: "agent-1",
  conversationId: "conv-1",
  agentType: "general",
  description: "Inspect the live route",
  status: "running",
  attemptGeneration: 2,
  rootRunId: "run-2",
  startedAt: 2_000,
  assistantMessages,
  updatedAt: 2_000,
});

function MountedActivity() {
  const { records } = useThreadActivity("conv-1");
  return (
    <div data-testid="updates">
      {records[0]?.assistantMessages?.join("|") ?? "empty"}
    </div>
  );
}

describe("mounted Activity authored-message refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
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
    expect(container.textContent).toBe("First persisted update");

    records = [
      runningRecord(["First persisted update", "Second persisted update"]),
    ];
    await act(async () => {
      updateListener?.({
        conversationId: "conv-1",
        assistantUpdate: {
          threadId: "agent-1",
          assistantMessages: [
            "First persisted update",
            "Second persisted update",
          ],
          reasoningSummaries: [
            "First persisted update",
            "Second persisted update",
          ],
          latestMessage: "Second persisted update",
          atMs: 2_100,
          attemptGeneration: 2,
          rootRunId: "run-2",
        },
      });
    });

    // Optimistic payload application is synchronous with the persisted-write
    // notification; the debounced authoritative refetch is only a backstop.
    expect(container.textContent).toBe(
      "First persisted update|Second persisted update",
    );
    expect(oneShotCompletion).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(listThreadActivity).toHaveBeenCalledTimes(2);
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });
});
