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
