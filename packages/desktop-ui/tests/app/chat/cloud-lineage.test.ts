// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { MessageRecord } from "@stella/contracts/local-chat";
import {
  __testing,
  provideLineageSource,
  subscribeToLineageMessages,
} from "@/features/chat/services/lineage-messages-store";

afterEach(() => __testing.reset());

test("cloud focus includes each activation and its prompt by thread identity", () => {
  const prompt = (id: string, timestamp: number): MessageRecord => ({
    _id: id,
    timestamp,
    type: "user_message",
    payload: { text: id },
    toolEvents: [],
  });
  const start = (
    id: string,
    userMessageId: string,
    agentId: string,
    timestamp: number,
  ): MessageRecord => ({
    _id: id,
    timestamp,
    type: "assistant_message",
    payload: { text: "On it", userMessageId },
    toolEvents: [
      {
        _id: `start-${id}`,
        timestamp,
        type: "agent-started",
        payload: {
          agentId,
          description: "Same task name",
          attemptGeneration: timestamp,
        },
      },
    ],
  });
  provideLineageSource("conversation", {
    hasOlder: false,
    loadOlder: () => {},
    messages: [
      prompt("u1", 1),
      start("a1", "u1", "thread-1", 2),
      prompt("u2", 3),
      start("a2", "u2", "thread-2", 4),
      prompt("u3", 5),
      start("a3", "u3", "thread-1", 6),
    ],
  });
  const listener = vi.fn();
  const unsubscribe = subscribeToLineageMessages(
    "conversation",
    { kind: "agent", threadId: "thread-1" },
    listener,
  );
  expect(
    listener.mock.lastCall?.[0].messages.map(
      (message: MessageRecord) => message._id,
    ),
  ).toEqual(["u1", "a1", "u3", "a3"]);
  unsubscribe();
});

test("cloud focus on a message carries its turn's reply and updates on the tasks it spawned", () => {
  const messages: MessageRecord[] = [
    { _id: "u1", timestamp: 1, type: "user_message", payload: { text: "Compare vendor pricing" }, toolEvents: [] },
    {
      _id: "spawn", timestamp: 2, type: "assistant_message",
      payload: { text: "On it", userMessageId: "u1" },
      toolEvents: [{ _id: "start", timestamp: 2, type: "agent-started", payload: { agentId: "pricing", description: "Pricing research", attemptGeneration: 1 } }],
    },
    { _id: "u2", timestamp: 3, type: "user_message", payload: { text: "Something else" }, toolEvents: [] },
    { _id: "a2", timestamp: 4, type: "assistant_message", payload: { text: "Sure", userMessageId: "u2" }, toolEvents: [] },
    {
      _id: "done", timestamp: 5, type: "assistant_message",
      payload: { text: "Pricing research is done", metadata: { runtime: { replyRefs: [{ kind: "agent", threadId: "pricing", title: "Pricing research" }] } } },
      toolEvents: [],
    },
  ];
  provideLineageSource("conversation", { hasOlder: false, loadOlder: () => {}, messages });
  const listener = vi.fn();
  const unsubscribe = subscribeToLineageMessages("conversation", { kind: "message", id: "u1" }, listener);
  const snapshot = listener.mock.calls.at(-1)?.[0];
  expect(snapshot.messages.map((message: MessageRecord) => message._id)).toEqual(["u1", "spawn", "done"]);
  unsubscribe();
});

test("cloud focus on a message finds a task known only by its spawn description", () => {
  const messages: MessageRecord[] = [
    { _id: "u1", timestamp: 1, type: "user_message", payload: { text: "Wait then report" }, toolEvents: [] },
    {
      _id: "spawn", timestamp: 2, type: "assistant_message",
      payload: { text: "started", userMessageId: "u1" },
      toolEvents: [
        { _id: "req", timestamp: 2, type: "tool_request", requestId: "call-1", payload: { toolName: "spawn_agent", args: { description: "15s finisher" } } },
        { _id: "res", timestamp: 3, type: "tool_result", requestId: "call-1", payload: { toolName: "spawn_agent", resultPreview: "started" } },
      ],
    },
    { _id: "u2", timestamp: 4, type: "user_message", payload: { text: "Different topic" }, toolEvents: [] },
    { _id: "a2", timestamp: 5, type: "assistant_message", payload: { text: "eight", userMessageId: "u2" }, toolEvents: [] },
    { _id: "wake", timestamp: 6, type: "user_message", payload: { text: "" }, toolEvents: [] },
    {
      _id: "done", timestamp: 7, type: "assistant_message",
      payload: { text: "finished", userMessageId: "wake", metadata: { runtime: { replyRefs: [{ kind: "agent", threadId: "15s-finisher", title: "" }] } } },
      toolEvents: [],
    },
  ];
  provideLineageSource("conversation", { hasOlder: false, loadOlder: () => {}, messages });
  const listener = vi.fn();
  const unsubscribe = subscribeToLineageMessages("conversation", { kind: "message", id: "u1" }, listener);
  const snapshot = listener.mock.calls.at(-1)?.[0];
  expect(snapshot.messages.map((message: MessageRecord) => message._id)).toEqual(["u1", "spawn", "done"]);
  unsubscribe();
});
