import { describe, expect, it } from "vitest";
import type {
  EventRecord,
  MessageRecord,
} from "@stella/contracts/local-chat";
import {
  createLifecycleRoutingState,
  routeLifecycleEvents,
} from "@/features/chat/lib/route-lifecycle-events";

const event = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "agent-started",
  ...overrides,
});

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  _id: overrides._id ?? "",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "user_message",
  toolEvents: [],
  ...overrides,
});

const completedBeforeStream = event({
  _id: "c1",
  type: "agent-completed",
  timestamp: 200,
  payload: { agentId: "agent-a" },
});

const followUpMidStream = event({
  _id: "s1",
  type: "agent-started",
  timestamp: 400,
  payload: { agentId: "agent-a", isFollowUp: true },
});

describe("routeLifecycleEvents", () => {
  it("keeps completion at its arrival-order anchor when a later terminal-notice response appears", () => {
    const state = createLifecycleRoutingState();
    const completion = event({
      _id: "completed-writer",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "writer", rootRunId: "run-writer" },
    });
    const user = message({
      _id: "u-terminal",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completion],
    });
    const priorResponse = message({
      _id: "stream-overlay:u-terminal:1",
      timestamp: 300,
      type: "assistant_message",
      payload: {
        text: "I asked the agent to handle it.",
        userMessageId: "u-terminal",
        metadata: {
          runtime: {
            isStreaming: true,
            responseTarget: { type: "user_turn" },
          },
        },
      },
      toolEvents: [],
    });

    const beforeNotice = routeLifecycleEvents([user, priorResponse], state);
    expect(beforeNotice[1]!.toolEvents.map((item) => item._id)).toEqual([
      "completed-writer",
    ]);

    const persistedPrior = message({
      _id: "assistant-prior",
      timestamp: 400,
      type: "assistant_message",
      payload: {
        text: "I asked the agent to handle it.",
        userMessageId: "u-terminal",
        metadata: { runtime: { streamStartedAtMs: 300 } },
      },
      toolEvents: [completion],
    });
    const terminalResponse = message({
      _id: "stream-overlay:u-terminal:2",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "The workflow design update is complete.",
        userMessageId: "u-terminal",
        metadata: {
          runtime: {
            isStreaming: true,
            responseTarget: {
              type: "agent_terminal_notice",
              agentId: "writer",
              terminalState: "completed",
            },
          },
        },
      },
      toolEvents: [],
    });
    const hiddenTerminalPrompt = message({
      _id: "hidden-terminal-prompt",
      timestamp: 450,
      type: "user_message",
      payload: {
        text: "[Agent completed]",
        metadata: { ui: { visibility: "hidden" } },
      },
      toolEvents: [],
    });

    const withNotice = routeLifecycleEvents(
      [
        message({
          _id: "u-terminal",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        persistedPrior,
        hiddenTerminalPrompt,
        terminalResponse,
      ],
      state,
    );

    expect(withNotice[1]!.toolEvents.map((item) => item._id)).toEqual([
      "completed-writer",
    ]);
    expect(withNotice[3]!.toolEvents).toEqual([]);
  });

  it("routes a mid-stream lifecycle event below the streaming text and keeps pre-stream events above it", () => {

    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = message({
      _id: "stream-overlay:u1:1",
      timestamp: 300,
      type: "assistant_message",
      payload: {
        text: "streaming…",
        userMessageId: "u1",
        metadata: { runtime: { isStreaming: true } },
      },
      toolEvents: [],
    });

    const state = createLifecycleRoutingState();
    const routed = routeLifecycleEvents([user, overlay], state);

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("keeps the same layout across the overlay -> persisted handoff (completed card / streamed text / follow-up card)", () => {
    const state = createLifecycleRoutingState();

    const liveUser = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = message({
      _id: "stream-overlay:u1:1",
      timestamp: 300,
      type: "assistant_message",
      payload: {
        text: "streaming…",
        userMessageId: "u1",
        metadata: { runtime: { isStreaming: true } },
      },
      toolEvents: [],
    });
    routeLifecycleEvents([liveUser, overlay], state);

    const persistedUser = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const persistedAssistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final text",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 300 } },
      },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });

    const routed = routeLifecycleEvents(
      [persistedUser, persistedAssistant],
      state,
    );

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("re-anchors chronologically on a cold load (no sticky state) using streamStartedAtMs", () => {

    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const assistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final text",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 300 } },
      },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });

    const routed = routeLifecycleEvents(
      [user, assistant],
      createLifecycleRoutingState(),
    );

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("pins a routed event to its first anchor even if timestamps would later disagree", () => {
    const state = createLifecycleRoutingState();
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream],
    });

    routeLifecycleEvents([user], state);

    const assistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 150 } },
      },
      toolEvents: [completedBeforeStream],
    });
    const routed = routeLifecycleEvents(
      [message({ ...user, toolEvents: [] }), assistant],
      state,
    );

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents).toEqual([]);
  });

  it("leaves legacy assistants (no streamStartedAtMs) untouched and preserves identity", () => {
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const legacyAssistant = message({
      _id: "a1",
      timestamp: 500,
      type: "assistant_message",
      payload: { text: "old transcript", userMessageId: "u1" },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const input = [user, legacyAssistant];

    const routed = routeLifecycleEvents(input, createLifecycleRoutingState());

    expect(routed).toBe(input);
  });

  it("releases a card born mid-stream the moment the stream ends (persisted twin, no further events)", () => {

    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });

    const liveFrame = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );
    expect(liveFrame[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    const settled = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 300 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );

    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("releases a card immediately when the overlay vanishes WITHOUT a persisted twin (aborted segment)", () => {

    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const userWithEvent = () =>
      message({
        _id: "u1",
        timestamp: 100,
        type: "user_message",
        toolEvents: [midStreamCompleted],
      });

    const liveFrame = routeLifecycleEvents(
      [
        userWithEvent(),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );
    expect(liveFrame[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    const released = routeLifecycleEvents([userWithEvent()], state);
    expect(released[0]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
  });

  it("keeps a mid-stream card on the twin's row across a gap frame (overlay cleared before the twin loads)", () => {

    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const userRow = (toolEvents: EventRecord[]) =>
      message({
        _id: "u1",
        timestamp: 100,
        type: "user_message",
        toolEvents,
      });

    const liveFrame = routeLifecycleEvents(
      [
        userRow([midStreamCompleted]),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );
    expect(liveFrame[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    const gapFrame = routeLifecycleEvents(
      [userRow([midStreamCompleted])],
      state,
    );
    expect(gapFrame[0]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    const settled = routeLifecycleEvents(
      [
        userRow([]),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 300 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );
    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("keeps a mid-stream card on the twin's row when the worker-stamped stream start postdates the event (clock skew)", () => {

    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });

    routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 349,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );

    const settled = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 352 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );
    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("does not let a stale pin capture a NEW stream that reuses an aborted segment's slot", () => {

    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const userRow = () =>
      message({
        _id: "u1",
        timestamp: 100,
        type: "user_message",
        toolEvents: [midStreamCompleted],
      });
    const overlayRow = (timestamp: number) =>
      message({
        _id: "stream-overlay:u1:1",
        timestamp,
        type: "assistant_message",
        payload: {
          text: "streaming…",
          userMessageId: "u1",
          metadata: { runtime: { isStreaming: true } },
        },
        toolEvents: [],
      });

    routeLifecycleEvents([userRow(), overlayRow(300)], state);

    routeLifecycleEvents([userRow()], state);

    const retryFrame = routeLifecycleEvents(
      [userRow(), overlayRow(600)],
      state,
    );

    expect(retryFrame[0]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(retryFrame[1]!.toolEvents).toEqual([]);
  });

  it("keeps a mid-stream card on the twin's row when the twin lacks streamStartedAtMs (legacy worker)", () => {
    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });

    routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );

    const settled = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: { text: "final text", userMessageId: "u1" },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );
    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("collapses a tail-refresh duplicate (stale user copy + assistant copy) onto one anchor", () => {

    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const routed = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 300 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      createLifecycleRoutingState(),
    );
    expect(routed[0]!.toolEvents).toEqual([]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
  });

  it("reuses routed message identity across repeated calls (structural sharing)", () => {
    const state = createLifecycleRoutingState();
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = () =>
      message({
        _id: "stream-overlay:u1:1",
        timestamp: 300,
        type: "assistant_message",
        payload: {
          text: "streaming…",
          userMessageId: "u1",
          metadata: { runtime: { isStreaming: true } },
        },
        toolEvents: [],
      });

    const first = routeLifecycleEvents([user, overlay()], state);
    const second = routeLifecycleEvents([user, overlay()], state);

    expect(second[0]).toBe(first[0]);
  });
});
