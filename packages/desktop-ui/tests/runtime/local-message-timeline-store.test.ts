import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalChatToolEventPage,
  LocalChatUpdatedPayload,
  MessageRecord,
} from "@stella/contracts/local-chat";
import {
  __testing,
  getLocalMessageTimelineSnapshot,
  loadLocalMessageToolEventPage,
  loadLatestLocalMessages,
  loadNewerLocalMessages,
  loadOlderLocalMessages,
  MAX_RETAINED_TIMELINE_MESSAGES,
  MESSAGE_TIMELINE_PAGE_SIZE,
  retryLocalMessageTimeline,
  subscribeToLocalMessageTimeline,
} from "@/features/chat/services/local-message-timeline-store";

type MessageWindow = {
  messages: MessageRecord[];
  visibleMessageCount: number;
  nextCursor?: { timestamp: number; id: string; sequence?: number };
};

type UpdateListener = (payload: LocalChatUpdatedPayload | null) => void;

const makeMessage = (
  index: number,
  text = `message ${index}`,
): MessageRecord => ({
  _id: `message-${index.toString().padStart(7, "0")}`,
  timestamp: 1_000_000 + index,
  sequence: index + 1,
  type: index % 2 === 0 ? "user_message" : "assistant_message",
  payload: { text },
  toolEvents: [],
});

const asWindow = (messages: MessageRecord[]): MessageWindow => {
  const last = messages.at(-1);
  return {
    messages,
    visibleMessageCount: messages.length,
    ...(last
      ? {
          nextCursor: {
            timestamp: last.timestamp,
            id: last._id,
            sequence: last.sequence,
          },
        }
      : {}),
  };
};

const expectStarted = (result: false | Promise<boolean>) => {
  expect(result).toBeInstanceOf(Promise);
};

const waitFor = async (assertion: () => void, timeoutMs = 1_000) => {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError) throw lastError;
  assertion();
};

function installTimelineApi(initialMessages: MessageRecord[]) {
  const timeline = [...initialMessages];
  const listeners = new Set<UpdateListener>();
  const listMessages = vi.fn(
    async ({
      maxVisibleMessages = MESSAGE_TIMELINE_PAGE_SIZE,
    }: {
      maxVisibleMessages?: number;
    }) => asWindow(timeline.slice(-maxVisibleMessages)),
  );
  const listMessagesBefore = vi.fn(
    async ({
      beforeId,
      maxVisibleMessages = MESSAGE_TIMELINE_PAGE_SIZE,
    }: {
      beforeId: string;
      maxVisibleMessages?: number;
    }) => {
      const index = timeline.findIndex((message) => message._id === beforeId);
      return asWindow(
        index < 0
          ? []
          : timeline.slice(Math.max(0, index - maxVisibleMessages), index),
      );
    },
  );
  const listMessagesAfter = vi.fn(
    async ({
      afterId,
      maxVisibleMessages = MESSAGE_TIMELINE_PAGE_SIZE,
    }: {
      afterId: string;
      maxVisibleMessages?: number;
    }) => {
      const index = timeline.findIndex((message) => message._id === afterId);
      if (index < 0) return asWindow([]);
      return asWindow(
        timeline.slice(index + 1, index + 1 + maxVisibleMessages),
      );
    },
  );
  const listMessageToolEvents = vi.fn(
    async (): Promise<LocalChatToolEventPage> => ({
      events: [],
      hasMore: false,
    }),
  );
  const onUpdated = vi.fn((listener: UpdateListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = {
    electronAPI: {
      localChat: {
        listMessages,
        listMessagesBefore,
        listMessagesAfter,
        listMessageToolEvents,
        onUpdated,
      },
    },
  };

  return {
    timeline,
    listMessages,
    listMessagesBefore,
    listMessagesAfter,
    listMessageToolEvents,
    emit(
      conversationId: string,
      event?: NonNullable<LocalChatUpdatedPayload["event"]>,
    ) {
      for (const listener of listeners) listener({ conversationId, event });
    },
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window: unknown }).window = previousWindow;
      }
    },
  };
}

async function subscribeAndWait(conversationId: string) {
  const snapshots: ReturnType<typeof getLocalMessageTimelineSnapshot>[] = [];
  const unsubscribe = subscribeToLocalMessageTimeline(
    conversationId,
    (snapshot) => {
      snapshots.push(snapshot);
    },
  );
  await waitFor(() =>
    expect(getLocalMessageTimelineSnapshot(conversationId).hasLoaded).toBe(
      true,
    ),
  );
  return { snapshots, unsubscribe };
}

async function waitForIdle(conversationId: string) {
  await waitFor(() => {
    const snapshot = getLocalMessageTimelineSnapshot(conversationId);
    expect(snapshot.isLoadingOlder || snapshot.isLoadingNewer).toBe(false);
    expect(__testing.getDebugStats().pendingReads).toBe(0);
  });
}

afterEach(() => {
  __testing.reset();
  vi.restoreAllMocks();
});

describe("local message timeline production store", () => {
  it("loads cursor pages early and traverses both directions with a bounded window", async () => {
    const api = installTimelineApi(
      Array.from({ length: 1_000 }, (_, index) => makeMessage(index)),
    );
    try {
      const { unsubscribe } = await subscribeAndWait("conversation-a");
      let snapshot = getLocalMessageTimelineSnapshot("conversation-a");
      expect(snapshot.messages).toHaveLength(MESSAGE_TIMELINE_PAGE_SIZE);
      expect(snapshot.messages[0]?._id).toBe("message-0000920");
      expect(snapshot.hasOlder).toBe(true);
      expect(snapshot.hasNewer).toBe(false);

      for (let page = 0; page < 4; page += 1) {
        expectStarted(loadOlderLocalMessages("conversation-a"));
        // Rapid duplicate actions are rejected while the cursor read is live.
        expect(loadOlderLocalMessages("conversation-a")).toBe(false);
        await waitForIdle("conversation-a");
      }

      snapshot = getLocalMessageTimelineSnapshot("conversation-a");
      expect(snapshot.messages).toHaveLength(MAX_RETAINED_TIMELINE_MESSAGES);
      expect(snapshot.messages[0]?._id).toBe("message-0000600");
      expect(snapshot.messages.at(-1)?._id).toBe("message-0000919");
      expect(snapshot.hasNewer).toBe(true);

      expectStarted(loadNewerLocalMessages("conversation-a"));
      await waitForIdle("conversation-a");
      expect(api.listMessagesAfter).toHaveBeenLastCalledWith(
        expect.objectContaining({
          afterId: "message-0000918",
          maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
        }),
      );
      snapshot = getLocalMessageTimelineSnapshot("conversation-a");
      expect(snapshot.messages).toHaveLength(MAX_RETAINED_TIMELINE_MESSAGES);
      expect(snapshot.messages[0]?._id).toBe("message-0000680");
      expect(snapshot.messages.at(-1)?._id).toBe("message-0000999");
      expect(snapshot.hasNewer).toBe(false);
      expect(snapshot.hasOlder).toBe(true);
      expect(__testing.getDebugStats().maxResidentMessages).toBe(
        MAX_RETAINED_TIMELINE_MESSAGES,
      );
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("tail-merges append and stream updates only while following the live end", async () => {
    const api = installTimelineApi(
      Array.from({ length: 500 }, (_, index) => makeMessage(index)),
    );
    try {
      const { unsubscribe } = await subscribeAndWait("conversation-b");
      const appended = makeMessage(500, "stream start");
      api.timeline.push(appended);
      api.emit("conversation-b");
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot("conversation-b").messages.at(-1)
            ?._id,
        ).toBe(appended._id),
      );

      const streamed = makeMessage(500, "stream completed");
      api.timeline[api.timeline.length - 1] = streamed;
      api.emit("conversation-b");
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot("conversation-b").messages.at(-1)
            ?.payload,
        ).toEqual({ text: "stream completed" }),
      );

      for (let page = 0; page < 4; page += 1) {
        expectStarted(loadOlderLocalMessages("conversation-b"));
        await waitForIdle("conversation-b");
      }
      const unpinned = getLocalMessageTimelineSnapshot("conversation-b");
      expect(unpinned.hasNewer).toBe(true);
      const callsBeforeUnpinnedAppend = api.listMessagesAfter.mock.calls.length;
      api.timeline.push(makeMessage(501, "arrived while reading"));
      api.emit("conversation-b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(api.listMessagesAfter).toHaveBeenCalledTimes(
        callsBeforeUnpinnedAppend,
      );
      expect(getLocalMessageTimelineSnapshot("conversation-b").messages).toBe(
        unpinned.messages,
      );

      expectStarted(loadLatestLocalMessages("conversation-b"));
      await waitForIdle("conversation-b");
      expect(
        getLocalMessageTimelineSnapshot("conversation-b").messages.at(-1)?._id,
      ).toBe("message-0000501");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("patches tool pushes directly and tails new messages from their high-water sequence", async () => {
    const user = makeMessage(0);
    const assistant = makeMessage(1);
    const firstTool = {
      _id: "tool-sequence-3",
      timestamp: 1_000_002,
      sequence: 3,
      type: "tool_result",
      payload: { output: "first" },
    };
    const secondTool = {
      _id: "tool-sequence-4",
      timestamp: 1_000_003,
      sequence: 4,
      type: "tool_result",
      payload: { output: "second" },
    };
    const api = installTimelineApi([user, assistant]);
    const nextUser = {
      ...makeMessage(2),
      timestamp: 1_000_004,
      sequence: 5,
      type: "user_message" as const,
    };
    api.listMessagesAfter.mockResolvedValueOnce({
      messages: [nextUser],
      visibleMessageCount: 1,
      nextCursor: {
        timestamp: nextUser.timestamp,
        id: nextUser._id,
        sequence: nextUser.sequence,
      },
    });

    try {
      const { unsubscribe } = await subscribeAndWait("event-cursor");
      api.emit("event-cursor", firstTool);
      api.emit("event-cursor", secondTool);
      expect(api.listMessagesAfter).not.toHaveBeenCalled();
      expect(
        getLocalMessageTimelineSnapshot("event-cursor").messages.at(-1)
          ?.toolEvents,
      ).toEqual([firstTool, secondTool]);
      expect(
        getLocalMessageTimelineSnapshot("event-cursor").messages.at(-1)
          ?.toolEventSummary,
      ).toEqual({ totalCount: 2, loadedCount: 2, truncated: false });

      api.emit("event-cursor", nextUser);
      await waitForIdle("event-cursor");
      expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
      expect(api.listMessagesAfter.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ afterSequence: 4 }),
      );
      expect(
        getLocalMessageTimelineSnapshot("event-cursor").messages.at(-1)?._id,
      ).toBe(nextUser._id);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("patches an omitted historical artifact without reopening or unbounding the tail", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEvents: [
        ...Array.from({ length: 16 }, (_, index) => ({
          _id: `head-${index}`,
          timestamp: 110 + index,
          sequence: 110 + index,
          type: "tool_result" as const,
          payload: { output: "head" },
        })),
        ...Array.from({ length: 16 }, (_, index) => ({
          _id: `tail-${index}`,
          timestamp: 170 + index,
          sequence: 170 + index,
          type: "tool_result" as const,
          payload: { output: "tail" },
        })),
      ],
      toolEventSummary: {
        totalCount: 33,
        loadedCount: 32,
        truncated: true,
        totalCountIsLowerBound: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    try {
      const { unsubscribe } = await subscribeAndWait("artifact-patch");
      const tailReadsBefore = api.listMessagesAfter.mock.calls.length;
      api.emit("artifact-patch", {
        _id: "omitted-artifact",
        timestamp: 150,
        sequence: 150,
        type: "tool_result",
        payload: { fileChanges: [{ path: "/tmp/result.txt" }] },
      });

      const loadedAssistant =
        getLocalMessageTimelineSnapshot("artifact-patch").messages.at(-1)!;
      expect(loadedAssistant.toolEvents).toHaveLength(32);
      expect(
        loadedAssistant.toolEvents.some(
          (event) => event._id === "omitted-artifact",
        ),
      ).toBe(true);
      expect(api.listMessagesAfter).toHaveBeenCalledTimes(tailReadsBefore);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("keeps lazy-detail pagination on its contiguous cursor when live pins arrive", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEventSummary: {
        totalCount: 33,
        loadedCount: 32,
        truncated: true,
        totalCountIsLowerBound: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    const detailEvents = Array.from({ length: 50 }, (_, index) => ({
      _id: `detail-${index}`,
      timestamp: 110 + index,
      sequence: 110 + index,
      type: "tool_result" as const,
      payload: { output: `detail ${index}` },
    }));
    api.listMessageToolEvents.mockResolvedValueOnce({
      events: detailEvents,
      hasMore: true,
      nextCursor: { timestamp: 159, id: "detail-49", sequence: 159 },
    });
    api.listMessageToolEvents.mockResolvedValueOnce({
      events: [],
      hasMore: false,
    });

    try {
      const { unsubscribe } = await subscribeAndWait("detail-cursor");
      expect(
        await loadLocalMessageToolEventPage("detail-cursor", assistant._id),
      ).toBe(true);
      api.emit("detail-cursor", {
        _id: "live-tail",
        timestamp: 1_000,
        sequence: 1_000,
        type: "tool_result",
        payload: { output: "projected tail" },
      });

      const summary = getLocalMessageTimelineSnapshot(
        "detail-cursor",
      ).messages.at(-1)?.toolEventSummary;
      expect(summary).toEqual(
        expect.objectContaining({
          detailLoaded: true,
          truncated: true,
          detailCursor: { timestamp: 159, id: "detail-49", sequence: 159 },
        }),
      );
      expect(
        await loadLocalMessageToolEventPage("detail-cursor", assistant._id),
      ).toBe(true);
      expect(api.listMessageToolEvents.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          afterTimestampMs: 159,
          afterId: "detail-49",
          afterSequence: 159,
        }),
      );
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("merges changed loaded anchors while paging newer without duplicates", async () => {
    const api = installTimelineApi(
      Array.from({ length: 500 }, (_, index) => makeMessage(index)),
    );
    try {
      const { unsubscribe } = await subscribeAndWait("conversation-c");
      for (let page = 0; page < 4; page += 1) {
        loadOlderLocalMessages("conversation-c");
        await waitForIdle("conversation-c");
      }
      const before = getLocalMessageTimelineSnapshot("conversation-c");
      const anchor = before.messages.at(-1)!;
      const changedAnchor = {
        ...anchor,
        payload: { text: "tool card settled" },
      };
      api.listMessagesAfter.mockResolvedValueOnce(
        asWindow([
          changedAnchor,
          ...api.timeline.slice(
            api.timeline.findIndex((message) => message._id === anchor._id) + 1,
          ),
        ]),
      );

      expectStarted(loadNewerLocalMessages("conversation-c"));
      await waitForIdle("conversation-c");
      const after = getLocalMessageTimelineSnapshot("conversation-c");
      expect(
        after.messages.filter((message) => message._id === anchor._id),
      ).toHaveLength(1);
      expect(
        after.messages.find((message) => message._id === anchor._id)?.payload,
      ).toEqual({ text: "tool card settled" });
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("preserves authoritative sequence order across bounded page merges", async () => {
    const timeline = Array.from({ length: 200 }, (_, index) => ({
      ...makeMessage(index),
      _id: `reverse-id-${(200 - index).toString().padStart(4, "0")}`,
      timestamp: 1_000,
      sequence: index + 1,
    }));
    const api = installTimelineApi(timeline);
    try {
      const { unsubscribe } = await subscribeAndWait("sequence-order");
      expectStarted(loadOlderLocalMessages("sequence-order"));
      await waitForIdle("sequence-order");

      const messages =
        getLocalMessageTimelineSnapshot("sequence-order").messages;
      expect(messages.map((message) => message.sequence)).toEqual(
        Array.from({ length: 160 }, (_, index) => index + 41),
      );
      expect(messages[0]?._id).toBe("reverse-id-0160");
      expect(messages.at(-1)?._id).toBe("reverse-id-0001");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("does not let UI-hidden storage rows consume the retained window", async () => {
    const api = installTimelineApi([]);
    const visible = Array.from({ length: 81 }, (_, index) =>
      makeMessage(index),
    );
    const hidden = Array.from({ length: 500 }, (_, index) => ({
      ...makeMessage(10_000 + index),
      payload: {
        text: `hidden ${index}`,
        metadata: { ui: { visibility: "hidden" } },
      },
    }));
    api.listMessages.mockResolvedValueOnce({
      messages: [...hidden, ...visible],
      visibleMessageCount: visible.length,
    });

    try {
      const { unsubscribe } = await subscribeAndWait("hidden-rows");
      const snapshot = getLocalMessageTimelineSnapshot("hidden-rows");
      expect(snapshot.messages).toHaveLength(MESSAGE_TIMELINE_PAGE_SIZE);
      expect(snapshot.messages[0]?._id).toBe("message-0000001");
      expect(snapshot.hasOlder).toBe(true);
      expect(__testing.getDebugStats().maxResidentMessages).toBe(
        MESSAGE_TIMELINE_PAGE_SIZE,
      );
      expect(
        snapshot.messages.some(
          (message) => message.payload?.metadata?.ui?.visibility === "hidden",
        ),
      ).toBe(false);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("cancels stale completions, retries failures, and shares one read across surfaces", async () => {
    let resolveInitial: ((value: MessageWindow) => void) | undefined;
    const api = installTimelineApi([]);
    api.listMessages.mockImplementationOnce(
      () =>
        new Promise<MessageWindow>((resolve) => {
          resolveInitial = resolve;
        }),
    );
    try {
      const unsubscribeFirst = subscribeToLocalMessageTimeline(
        "switch-from",
        () => {},
      );
      const unsubscribeSecond = subscribeToLocalMessageTimeline(
        "switch-from",
        () => {},
      );
      expect(api.listMessages).toHaveBeenCalledTimes(1);
      unsubscribeFirst();
      unsubscribeSecond();
      resolveInitial?.(asWindow([makeMessage(1)]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getLocalMessageTimelineSnapshot("switch-from").hasLoaded).toBe(
        false,
      );

      api.listMessages.mockRejectedValueOnce(
        new Error("temporary read failure"),
      );
      const { unsubscribe } = await subscribeAndWait("retry-target");
      expect(
        getLocalMessageTimelineSnapshot("retry-target").error?.message,
      ).toBe("temporary read failure");
      expectStarted(retryLocalMessageTimeline("retry-target"));
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot("retry-target").error,
        ).toBeNull(),
      );
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("retries the failed cursor direction instead of refreshing a different edge", async () => {
    const api = installTimelineApi(
      Array.from({ length: 300 }, (_, index) => makeMessage(index)),
    );
    try {
      const { unsubscribe } = await subscribeAndWait("retry-older");
      api.listMessagesBefore.mockRejectedValueOnce(
        new Error("temporary older-page failure"),
      );

      const failedRead = loadOlderLocalMessages("retry-older");
      expectStarted(failedRead);
      await failedRead;
      expect(
        getLocalMessageTimelineSnapshot("retry-older").error?.message,
      ).toBe("temporary older-page failure");

      expectStarted(retryLocalMessageTimeline("retry-older"));
      await waitForIdle("retry-older");
      expect(api.listMessagesBefore).toHaveBeenCalledTimes(2);
      expect(api.listMessagesAfter).not.toHaveBeenCalled();
      expect(
        getLocalMessageTimelineSnapshot("retry-older").messages[0]?._id,
      ).toBe("message-0000140");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("restores a settled cursor window after unmount and latches exhaustion", async () => {
    const api = installTimelineApi(
      Array.from({ length: 200 }, (_, index) => makeMessage(index)),
    );
    try {
      const first = await subscribeAndWait("restore-target");
      loadOlderLocalMessages("restore-target");
      await waitForIdle("restore-target");
      const settled = getLocalMessageTimelineSnapshot("restore-target");
      const settledMessages = settled.messages;
      first.unsubscribe();

      const listCallsBeforeRestore = api.listMessages.mock.calls.length;
      const restoredSnapshots: typeof first.snapshots = [];
      const unsubscribe = subscribeToLocalMessageTimeline(
        "restore-target",
        (snapshot) => restoredSnapshots.push(snapshot),
      );
      expect(restoredSnapshots[0]?.messages).toBe(settledMessages);
      expect(api.listMessages).toHaveBeenCalledTimes(listCallsBeforeRestore);
      unsubscribe();

      const exhausted = await subscribeAndWait("short-conversation");
      const shortSnapshot =
        getLocalMessageTimelineSnapshot("short-conversation");
      // The fake API shares its 200-row fixture across conversation IDs, so
      // exhaust this window through cursor pages rather than relying on size.
      while (getLocalMessageTimelineSnapshot("short-conversation").hasOlder) {
        loadOlderLocalMessages("short-conversation");
        await waitForIdle("short-conversation");
      }
      expect(loadOlderLocalMessages("short-conversation")).toBe(false);
      expect(
        getLocalMessageTimelineSnapshot("short-conversation").hasOlder,
      ).toBe(false);
      exhausted.unsubscribe();
      expect(shortSnapshot.hasLoaded).toBe(true);
    } finally {
      api.restore();
    }
  });

  it("keeps retained conversation caches and per-operation work bounded at scale", async () => {
    const run = async (size: number) => {
      __testing.reset();
      const api = installTimelineApi(
        Array.from({ length: size }, (_, index) => makeMessage(index)),
      );
      const { unsubscribe } = await subscribeAndWait(`scale-${size}`);
      for (let page = 0; page < 5; page += 1) {
        loadOlderLocalMessages(`scale-${size}`);
        await waitForIdle(`scale-${size}`);
      }
      const afterPrepends = __testing.getDebugStats();
      expectStarted(loadLatestLocalMessages(`scale-${size}`));
      await waitForIdle(`scale-${size}`);
      const beforeAppend = __testing.getDebugStats();
      const appended = makeMessage(size);
      api.timeline.push(appended);
      api.emit(`scale-${size}`);
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot(`scale-${size}`).messages.at(-1)?._id,
        ).toBe(appended._id),
      );
      const stats = __testing.getDebugStats();
      unsubscribe();
      api.restore();
      return {
        stats,
        prependMergedRows: afterPrepends.mergedRows,
        appendMergedRows: stats.mergedRows - beforeAppend.mergedRows,
      };
    };

    const small = await run(2_000);
    const large = await run(20_000);
    expect(large.stats.olderReads).toBe(small.stats.olderReads);
    expect(large.prependMergedRows).toBe(small.prependMergedRows);
    expect(large.appendMergedRows).toBe(small.appendMergedRows);
    expect(large.stats.maxResidentMessages).toBe(
      MAX_RETAINED_TIMELINE_MESSAGES,
    );

    const api = installTimelineApi(
      Array.from({ length: 100 }, (_, i) => makeMessage(i)),
    );
    try {
      const activeUnsubscribes = Array.from({ length: 10 }, (_, index) =>
        subscribeToLocalMessageTimeline(`active-${index}`, () => {}),
      );
      await waitFor(() =>
        expect(__testing.getDebugStats().activeEntries).toBe(10),
      );
      expect(__testing.getDebugStats().retainedEntries).toBeGreaterThanOrEqual(
        10,
      );
      expect(__testing.getDebugStats().retainedEntries).toBeLessThanOrEqual(18);
      for (const unsubscribe of activeUnsubscribes) unsubscribe();
      expect(__testing.getDebugStats().retainedEntries).toBeLessThanOrEqual(8);

      for (let index = 0; index < 12; index += 1) {
        const { unsubscribe } = await subscribeAndWait(`cache-${index}`);
        unsubscribe();
      }
      expect(__testing.getDebugStats().retainedEntries).toBeLessThanOrEqual(8);
      expect(__testing.getDebugStats().residentMessages).toBeLessThanOrEqual(
        8 * MESSAGE_TIMELINE_PAGE_SIZE,
      );
    } finally {
      api.restore();
    }
  });
});
