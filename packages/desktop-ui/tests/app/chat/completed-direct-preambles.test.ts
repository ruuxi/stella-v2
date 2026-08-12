import { describe, expect, it } from "vitest";

import { suppressCompletedDirectPreambleText } from "@/features/chat/lib/completed-direct-preambles";
import type { MessageRecord } from "@stella/contracts/local-chat";

const assistant = (
  id: string,
  text: string,
  runtime: Record<string, unknown>,
  toolEvents: MessageRecord["toolEvents"] = [],
): MessageRecord => ({
  _id: id,
  timestamp: Number(id.replace(/\D/g, "")) || 1,
  type: "assistant_message",
  payload: {
    text,
    userMessageId: "user-1",
    metadata: { runtime },
  },
  toolEvents,
});

describe("suppressCompletedDirectPreambleText", () => {
  it("removes direct-mode preamble text only after the final response completes", () => {
    const toolEvents = [
      { _id: "tool-1", timestamp: 2, type: "tool_result", payload: {} },
    ];
    const preamble = assistant(
      "assistant-1",
      "Let me check that.",
      { workingMode: "direct", followedByToolCall: true },
      toolEvents,
    );
    const secondPreamble = assistant("assistant-2", "Now I’ll finish it.", {
      workingMode: "direct",
      followedByToolCall: true,
    });
    const final = assistant("assistant-3", "Done.", {
      workingMode: "direct",
      turnComplete: true,
    });

    const result = suppressCompletedDirectPreambleText([
      preamble,
      secondPreamble,
      final,
    ]);

    expect(result[0]?.payload?.text).toBe("");
    expect(result[0]?.toolEvents).toBe(toolEvents);
    expect(result[1]?.payload?.text).toBe("");
    expect(result[2]?.payload?.text).toBe("Done.");
  });

  it("keeps preambles while a direct turn is still active", () => {
    const messages = [
      assistant("assistant-1", "Let me check that.", {
        workingMode: "direct",
        followedByToolCall: true,
      }),
    ];

    expect(suppressCompletedDirectPreambleText(messages)).toBe(messages);
  });

  it("does not cut off a live overlay when the durable final row lands", () => {
    const livePreamble = assistant(
      "stream-overlay:user-1:1",
      "Let me check that.",
      {
        workingMode: "direct",
        followedByToolCall: true,
        assistantTextTransition: "holding",
      },
    );
    const final = assistant("assistant-2", "Done.", {
      workingMode: "direct",
      turnComplete: true,
    });

    const result = suppressCompletedDirectPreambleText([livePreamble, final]);

    expect(result[0]).toBe(livePreamble);
    expect(result[0]?.payload?.text).toBe("Let me check that.");
  });

  it("does not change completed orchestrated turns", () => {
    const messages = [
      assistant("assistant-1", "Let me check that.", {
        workingMode: "orchestrated",
        followedByToolCall: true,
      }),
      assistant("assistant-2", "Done.", {
        workingMode: "orchestrated",
        turnComplete: true,
      }),
    ];

    expect(suppressCompletedDirectPreambleText(messages)).toBe(messages);
  });

  it("keeps the only completed segment even if it ended with a tool call", () => {
    const message = assistant("assistant-1", "I started it.", {
      workingMode: "direct",
      followedByToolCall: true,
      turnComplete: true,
    });

    expect(suppressCompletedDirectPreambleText([message])[0]).toBe(message);
  });
});
