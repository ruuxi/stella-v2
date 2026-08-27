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
  MAX_RETAINED_TOOL_DETAIL_EVENTS,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
      api.emit("conversation-b", appended);
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot("conversation-b").messages.at(-1)
            ?._id,
        ).toBe(appended._id),
      );

      const streamed = makeMessage(500, "stream completed");
      api.timeline[api.timeline.length - 1] = streamed;
      api.emit("conversation-b", streamed);
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
      const unpinnedAppend = makeMessage(501, "arrived while reading");
      api.timeline.push(unpinnedAppend);
      api.emit("conversation-b", unpinnedAppend);
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

  it("patches tool pushes directly without advancing the durable tail cursor", async () => {
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
        expect.objectContaining({ afterSequence: 2 }),
      );
      expect(
        getLocalMessageTimelineSnapshot("event-cursor").messages.at(-1)?._id,
      ).toBe(nextUser._id);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("recovers an older authored push that arrives while a newer tail read is pending", async () => {
    const initial = [makeMessage(0), makeMessage(1)];
    const olderAuthored = makeMessage(2, "older authored");
    const newerAuthored = makeMessage(3, "newer authored");
    const api = installTimelineApi(initial);
    const pending = deferred<MessageWindow>();
    api.listMessagesAfter.mockImplementationOnce(() => pending.promise);

    try {
      const { unsubscribe } = await subscribeAndWait("out-of-order-authored");
      api.timeline.push(olderAuthored, newerAuthored);
      api.emit("out-of-order-authored", newerAuthored);
      api.emit("out-of-order-authored", olderAuthored);
      pending.resolve({
        messages: [newerAuthored],
        visibleMessageCount: 1,
        nextCursor: {
          timestamp: newerAuthored.timestamp,
          id: newerAuthored._id,
          sequence: newerAuthored.sequence,
        },
      });

      await waitForIdle("out-of-order-authored");
      await waitFor(() =>
        expect(
          getLocalMessageTimelineSnapshot("out-of-order-authored")
            .messages.slice(-2)
            .map((message) => message._id),
        ).toEqual([olderAuthored._id, newerAuthored._id]),
      );
      expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("replays a live tool patch after a stale tail response completes", async () => {
    const initial = [makeMessage(0), makeMessage(1)];
    const nextUser = makeMessage(2, "next turn");
    const liveTool = {
      _id: "live-tool-during-tail",
      timestamp: initial[1]!.timestamp + 1,
      sequence: 3,
      type: "tool_result" as const,
      payload: { output: "must survive" },
    };
    const api = installTimelineApi(initial);
    api.timeline.push(nextUser);
    const pending = deferred<MessageWindow>();
    api.listMessagesAfter.mockImplementationOnce(() => pending.promise);

    try {
      const { unsubscribe } = await subscribeAndWait("stale-tail-race");
      api.emit("stale-tail-race", nextUser);
      api.emit("stale-tail-race", liveTool);
      pending.resolve(asWindow([nextUser]));
      await waitForIdle("stale-tail-race");

      const assistant = getLocalMessageTimelineSnapshot(
        "stale-tail-race",
      ).messages.find((message) => message._id === initial[1]!._id);
      expect(assistant?.toolEvents).toContainEqual(liveTool);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reconciles a rewind queued during initial hydration", async () => {
    const original = Array.from({ length: 500 }, (_, index) =>
      makeMessage(index),
    );
    const api = installTimelineApi(original);
    const pending = deferred<MessageWindow>();
    api.listMessages.mockImplementationOnce(() => pending.promise);

    try {
      const unsubscribe = subscribeToLocalMessageTimeline(
        "rewind-during-initial",
        () => {},
      );
      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(1));
      api.timeline.splice(450);
      api.emit("rewind-during-initial");
      pending.resolve(asWindow(original.slice(-81)));

      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
      await waitForIdle("rewind-during-initial");
      expect(
        getLocalMessageTimelineSnapshot("rewind-during-initial").messages.at(-1)
          ?._id,
      ).toBe("message-0000449");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reconciles a rewind queued during older-page hydration", async () => {
    const original = Array.from({ length: 500 }, (_, index) =>
      makeMessage(index),
    );
    const api = installTimelineApi(original);
    const pending = deferred<MessageWindow>();

    try {
      const { unsubscribe } = await subscribeAndWait("rewind-during-older");
      api.listMessagesBefore.mockImplementationOnce(() => pending.promise);
      const olderRead = loadOlderLocalMessages("rewind-during-older");
      expectStarted(olderRead);
      api.timeline.splice(490);
      api.emit("rewind-during-older");
      pending.resolve(asWindow(original.slice(339, 420)));
      await olderRead;

      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
      await waitForIdle("rewind-during-older");
      expect(
        getLocalMessageTimelineSnapshot("rewind-during-older").messages.at(-1)
          ?._id,
      ).toBe("message-0000489");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reconciles a rewind queued during newer-page hydration", async () => {
    const original = Array.from({ length: 500 }, (_, index) =>
      makeMessage(index),
    );
    const api = installTimelineApi(original);
    const pending = deferred<MessageWindow>();

    try {
      const { unsubscribe } = await subscribeAndWait("rewind-during-newer");
      for (let page = 0; page < 4; page += 1) {
        expectStarted(loadOlderLocalMessages("rewind-during-newer"));
        await waitForIdle("rewind-during-newer");
      }
      expect(
        getLocalMessageTimelineSnapshot("rewind-during-newer").hasNewer,
      ).toBe(true);

      api.listMessagesAfter.mockImplementationOnce(() => pending.promise);
      const newerRead = loadNewerLocalMessages("rewind-during-newer");
      expectStarted(newerRead);
      api.timeline.splice(400);
      api.emit("rewind-during-newer");
      pending.resolve(asWindow(original.slice(418)));
      await newerRead;

      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
      await waitForIdle("rewind-during-newer");
      expect(
        getLocalMessageTimelineSnapshot("rewind-during-newer").messages.at(-1)
          ?._id,
      ).toBe("message-0000399");
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reconciles a rewind queued during a live tail read", async () => {
    const original = Array.from({ length: 500 }, (_, index) =>
      makeMessage(index),
    );
    const api = installTimelineApi(original);
    const pending = deferred<MessageWindow>();

    try {
      const { unsubscribe } = await subscribeAndWait("rewind-during-tail");
      api.listMessagesAfter.mockImplementationOnce(() => pending.promise);
      const appended = makeMessage(500);
      api.timeline.push(appended);
      api.emit("rewind-during-tail", appended);
      await waitFor(() =>
        expect(api.listMessagesAfter).toHaveBeenCalledTimes(1),
      );

      api.timeline.splice(490);
      api.emit("rewind-during-tail");
      pending.resolve(asWindow([appended]));

      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
      await waitForIdle("rewind-during-tail");
      const snapshot = getLocalMessageTimelineSnapshot("rewind-during-tail");
      expect(snapshot.messages.at(-1)?._id).toBe("message-0000489");
      expect(
        snapshot.messages.some((message) => message._id === appended._id),
      ).toBe(false);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reconciles a rewind while a historical window has newer rows", async () => {
    const api = installTimelineApi(
      Array.from({ length: 500 }, (_, index) => makeMessage(index)),
    );
    try {
      const { unsubscribe } = await subscribeAndWait("rewind-with-newer");
      for (let page = 0; page < 4; page += 1) {
        expectStarted(loadOlderLocalMessages("rewind-with-newer"));
        await waitForIdle("rewind-with-newer");
      }
      expect(
        getLocalMessageTimelineSnapshot("rewind-with-newer").hasNewer,
      ).toBe(true);

      api.timeline.splice(400);
      api.emit("rewind-with-newer");
      await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
      await waitForIdle("rewind-with-newer");
      const snapshot = getLocalMessageTimelineSnapshot("rewind-with-newer");
      expect(snapshot.messages.at(-1)?._id).toBe("message-0000399");
      expect(snapshot.hasNewer).toBe(false);
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

      const summary =
        getLocalMessageTimelineSnapshot("detail-cursor").messages.at(
          -1,
        )?.toolEventSummary;
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

  it("prunes live tool-event pins when their message is removed", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEventSummary: {
        totalCount: 1,
        loadedCount: 1,
        truncated: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    api.listMessageToolEvents.mockResolvedValueOnce({
      events: [],
      hasMore: false,
    });

    try {
      const { unsubscribe } = await subscribeAndWait("removed-detail-pins");
      expect(
        await loadLocalMessageToolEventPage(
          "removed-detail-pins",
          assistant._id,
        ),
      ).toBe(true);
      api.emit("removed-detail-pins", {
        _id: "live-after-detail",
        timestamp: 150,
        sequence: 150,
        type: "tool_result",
        payload: { output: "live" },
      });
      expect(
        __testing.getLiveToolEventPinIds(
          "removed-detail-pins",
          assistant._id,
        ),
      ).toEqual(["live-after-detail"]);

      api.timeline.splice(0, api.timeline.length);
      api.emit("removed-detail-pins");
      await waitForIdle("removed-detail-pins");

      expect(
        getLocalMessageTimelineSnapshot("removed-detail-pins").messages,
      ).toEqual([]);
      expect(
        __testing.getLiveToolEventPinIds(
          "removed-detail-pins",
          assistant._id,
        ),
      ).toEqual([]);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("offers lazy detail when a live tool payload is projected", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const toolEvent = {
      _id: "projected-live-tool",
      timestamp: 150,
      sequence: 150,
      type: "tool_result" as const,
      payload: { output: "short" },
    };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEvents: [toolEvent],
      toolEventSummary: {
        totalCount: 1,
        loadedCount: 1,
        truncated: false,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    api.listMessageToolEvents.mockResolvedValueOnce({
      events: [
        {
          ...toolEvent,
          payload: { output: "x".repeat(10_000) },
        },
      ],
      hasMore: false,
      nextCursor: {
        timestamp: toolEvent.timestamp,
        id: toolEvent._id,
        sequence: toolEvent.sequence,
      },
    });

    try {
      const { unsubscribe } = await subscribeAndWait("live-payload-detail");
      api.emit("live-payload-detail", {
        ...toolEvent,
        payload: {
          output: "projected",
          __stellaEagerProjection: {
            truncated: true,
            fullDetailAvailable: true,
          },
        },
      });

      const summary = getLocalMessageTimelineSnapshot(
        "live-payload-detail",
      ).messages.at(-1)?.toolEventSummary;
      expect(summary).toMatchObject({
        totalCount: 1,
        loadedCount: 1,
        truncated: true,
      });
      expect(summary).not.toHaveProperty("totalCountIsLowerBound");

      expect(
        await loadLocalMessageToolEventPage(
          "live-payload-detail",
          assistant._id,
        ),
      ).toBe(true);
      expect(api.listMessageToolEvents).toHaveBeenCalledWith(
        expect.not.objectContaining({ afterEventId: expect.anything() }),
      );
      const loaded = getLocalMessageTimelineSnapshot(
        "live-payload-detail",
      ).messages.at(-1);
      expect(loaded?.toolEvents[0]?.payload).toEqual({
        output: "x".repeat(10_000),
      });
      expect(loaded?.toolEventSummary?.truncated).toBe(false);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("reopens detail when a durable read replaces loaded payload with a projection", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const projectedEvent = {
      _id: "durable-projected-tool",
      timestamp: 150,
      sequence: 150,
      type: "tool_result" as const,
      payload: {
        output: "projected-v1",
        __stellaEagerProjection: {
          truncated: true,
          fullDetailAvailable: true,
        },
      },
    };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEvents: [projectedEvent],
      toolEventSummary: {
        totalCount: 1,
        loadedCount: 1,
        truncated: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    api.listMessageToolEvents
      .mockResolvedValueOnce({
        events: [
          {
            ...projectedEvent,
            payload: { output: "full-v1" },
          },
        ],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [
          {
            ...projectedEvent,
            payload: { output: "full-v2" },
          },
        ],
        hasMore: false,
      });

    try {
      const { unsubscribe } = await subscribeAndWait("durable-payload-detail");
      expect(
        await loadLocalMessageToolEventPage(
          "durable-payload-detail",
          assistant._id,
        ),
      ).toBe(true);

      api.timeline[1] = {
        ...assistant,
        toolEvents: [
          {
            ...projectedEvent,
            payload: {
              ...projectedEvent.payload,
              output: "projected-v2",
            },
          },
        ],
      };
      api.emit("durable-payload-detail");
      await waitForIdle("durable-payload-detail");

      let current = getLocalMessageTimelineSnapshot(
        "durable-payload-detail",
      ).messages.at(-1);
      expect(current?.toolEvents[0]?.payload?.output).toBe("projected-v2");
      expect(current?.toolEventSummary).toMatchObject({
        truncated: true,
        loadedCount: 1,
      });
      expect(current?.toolEventSummary?.detailLoaded).not.toBe(true);

      expect(
        await loadLocalMessageToolEventPage(
          "durable-payload-detail",
          assistant._id,
        ),
      ).toBe(true);
      expect(api.listMessageToolEvents.mock.calls[1]?.[0]).not.toHaveProperty(
        "afterEventId",
      );
      current = getLocalMessageTimelineSnapshot(
        "durable-payload-detail",
      ).messages.at(-1);
      expect(current?.toolEvents[0]?.payload?.output).toBe("full-v2");
      expect(current?.toolEventSummary?.truncated).toBe(false);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("does not advance detail past a live pin omitted by an in-flight page", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const assistant = {
      ...makeMessage(1),
      sequence: 300,
      timestamp: 300,
      toolEventSummary: {
        totalCount: 101,
        loadedCount: 32,
        truncated: true,
        totalCountIsLowerBound: true,
      },
    } satisfies MessageRecord;
    const live = {
      _id: "live-inside-stale-page",
      timestamp: 150,
      sequence: 150,
      type: "tool_result" as const,
      payload: { output: "live" },
    };
    const staleEvents = Array.from({ length: 100 }, (_, index) => ({
      _id: `stale-page-${index}`,
      timestamp: 101 + index,
      sequence: 101 + index,
      type: "tool_result" as const,
      payload: { output: `${index}` },
    }));
    const api = installTimelineApi([user, assistant]);
    const pending = deferred<LocalChatToolEventPage>();
    let detailReadCount = 0;
    api.listMessageToolEvents.mockImplementation(() => {
      detailReadCount += 1;
      if (detailReadCount === 1) return pending.promise;
      return Promise.resolve({
        events: [...staleEvents, live],
        hasMore: false,
        nextCursor: { timestamp: 200, id: "stale-page-99", sequence: 200 },
      });
    });

    try {
      const { unsubscribe } = await subscribeAndWait("detail-race");
      const firstRead = loadLocalMessageToolEventPage(
        "detail-race",
        assistant._id,
      );
      api.emit("detail-race", live);
      pending.resolve({
        events: staleEvents,
        hasMore: true,
        nextCursor: { timestamp: 200, id: "stale-page-99", sequence: 200 },
      });
      expect(await firstRead).toBe(true);

      let summary =
        getLocalMessageTimelineSnapshot("detail-race").messages.at(
          -1,
        )?.toolEventSummary;
      expect(summary).toEqual(
        expect.objectContaining({
          truncated: true,
          livePinsPending: true,
        }),
      );
      expect(summary?.detailCursor).toBeUndefined();
      expect(
        __testing.getLiveToolEventPinIds("detail-race", assistant._id),
      ).toEqual([live._id]);
      expect(
        getLocalMessageTimelineSnapshot("detail-race").messages.at(-1)
          ?.toolEvents,
      ).toContainEqual(live);

      expect(
        await loadLocalMessageToolEventPage("detail-race", assistant._id),
      ).toBe(true);
      expect(detailReadCount).toBe(2);
      expect(
        __testing.getLiveToolEventPinIds("detail-race", assistant._id),
      ).toEqual([]);
      expect(api.listMessageToolEvents.mock.calls[1]?.[0]).not.toHaveProperty(
        "afterId",
      );
      summary =
        getLocalMessageTimelineSnapshot("detail-race").messages.at(
          -1,
        )?.toolEventSummary;
      expect(summary).toEqual(
        expect.objectContaining({
          truncated: false,
          detailHasMore: false,
          livePinsPending: false,
        }),
      );
      expect(
        getLocalMessageTimelineSnapshot("detail-race").messages.at(-1)
          ?.toolEvents,
      ).toContainEqual(live);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("accepts a fresh payload when a tool event id is updated", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const staleEvent = {
      _id: "mutable-tool-event",
      timestamp: 150,
      sequence: 150,
      type: "tool_result" as const,
      payload: { output: "stale" },
    };
    const assistant = {
      ...makeMessage(1),
      sequence: 200,
      timestamp: 200,
      toolEvents: [staleEvent],
      toolEventSummary: {
        totalCount: 1,
        loadedCount: 1,
        truncated: false,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);

    try {
      const { unsubscribe } = await subscribeAndWait("same-id-update");
      api.emit("same-id-update", {
        ...staleEvent,
        payload: { output: "fresh" },
      });

      expect(
        getLocalMessageTimelineSnapshot("same-id-update").messages.at(-1)
          ?.toolEvents[0]?.payload,
      ).toEqual({ output: "fresh" });
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("keeps a same-id push authoritative over a stale in-flight detail page", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const staleEvent = {
      _id: "mutable-detail-event",
      timestamp: 150,
      sequence: 150,
      type: "tool_result" as const,
      payload: { output: "stale" },
    };
    const freshEvent = {
      ...staleEvent,
      payload: { output: "fresh" },
    };
    const assistant = {
      ...makeMessage(1),
      sequence: 300,
      timestamp: 300,
      toolEvents: [staleEvent],
      toolEventSummary: {
        totalCount: 101,
        loadedCount: 1,
        truncated: true,
        totalCountIsLowerBound: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    const pending = deferred<LocalChatToolEventPage>();
    api.listMessageToolEvents.mockImplementationOnce(() => pending.promise);
    api.listMessageToolEvents.mockResolvedValueOnce({
      events: [freshEvent],
      hasMore: false,
      nextCursor: {
        timestamp: freshEvent.timestamp,
        id: freshEvent._id,
        sequence: freshEvent.sequence,
      },
    });

    try {
      const { unsubscribe } = await subscribeAndWait("same-id-detail-race");
      const firstRead = loadLocalMessageToolEventPage(
        "same-id-detail-race",
        assistant._id,
      );
      api.emit("same-id-detail-race", freshEvent);
      pending.resolve({
        events: [staleEvent],
        hasMore: true,
        nextCursor: {
          timestamp: staleEvent.timestamp,
          id: staleEvent._id,
          sequence: staleEvent.sequence,
        },
      });
      expect(await firstRead).toBe(true);

      let loaded = getLocalMessageTimelineSnapshot(
        "same-id-detail-race",
      ).messages.at(-1)!;
      expect(
        loaded.toolEvents.find((event) => event._id === staleEvent._id),
      ).toEqual(freshEvent);
      expect(
        __testing.getLiveToolEventPinIds("same-id-detail-race", assistant._id),
      ).toEqual([freshEvent._id]);
      expect(loaded.toolEventSummary?.detailCursor).toBeUndefined();

      expect(
        await loadLocalMessageToolEventPage(
          "same-id-detail-race",
          assistant._id,
        ),
      ).toBe(true);
      loaded = getLocalMessageTimelineSnapshot(
        "same-id-detail-race",
      ).messages.at(-1)!;
      expect(
        loaded.toolEvents.find((event) => event._id === staleEvent._id),
      ).toEqual(freshEvent);
      expect(
        __testing.getLiveToolEventPinIds("same-id-detail-race", assistant._id),
      ).toEqual([]);
      unsubscribe();
    } finally {
      api.restore();
    }
  });

  it("bounds retained paginated tool detail while advancing the full cursor", async () => {
    const user = { ...makeMessage(0), sequence: 100, timestamp: 100 };
    const eagerToolEvents = [
      ...Array.from({ length: 16 }, (_, index) => index),
      ...Array.from({ length: 16 }, (_, index) => 484 + index),
    ].map((index) => ({
      _id: `detail-${index.toString().padStart(3, "0")}`,
      timestamp: 101 + index,
      sequence: 101 + index,
      type: "tool_result" as const,
      payload: { output: `projected detail ${index}` },
    }));
    const assistant = {
      ...makeMessage(1),
      sequence: 1_000,
      timestamp: 1_000,
      toolEvents: eagerToolEvents,
      toolEventSummary: {
        totalCount: 500,
        loadedCount: 32,
        truncated: true,
      },
    } satisfies MessageRecord;
    const api = installTimelineApi([user, assistant]);
    let nextPageIndex = 0;
    api.listMessageToolEvents.mockImplementation(async () => {
      const pageIndex = nextPageIndex;
      nextPageIndex += 1;
      const start = pageIndex * 100;
      const events = Array.from({ length: 100 }, (_, offset) => {
        const index = start + offset;
        return {
          _id: `detail-${index.toString().padStart(3, "0")}`,
          timestamp: 101 + index,
          sequence: 101 + index,
          type: "tool_result" as const,
          payload: { output: `detail ${index}` },
        };
      });
      const last = events.at(-1)!;
      return {
        events,
        hasMore: pageIndex < 4,
        nextCursor: {
          timestamp: last.timestamp,
          id: last._id,
          sequence: last.sequence,
        },
      };
    });

    try {
      const { unsubscribe } = await subscribeAndWait("bounded-detail");
      for (let page = 0; page < 5; page += 1) {
        expect(
          await loadLocalMessageToolEventPage("bounded-detail", assistant._id),
        ).toBe(true);
      }

      const loaded =
        getLocalMessageTimelineSnapshot("bounded-detail").messages.at(-1)!;
      expect(loaded.toolEvents).toHaveLength(MAX_RETAINED_TOOL_DETAIL_EVENTS);
      expect(loaded.toolEventSummary).toEqual(
        expect.objectContaining({
          loadedCount: 500,
          totalCount: 500,
          truncated: false,
          detailCursor: {
            timestamp: 600,
            id: "detail-499",
            sequence: 600,
          },
        }),
      );
      expect(loaded.toolEvents[0]?._id).toBe("detail-000");
      expect(loaded.toolEvents.at(-1)?._id).toBe("detail-499");
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
