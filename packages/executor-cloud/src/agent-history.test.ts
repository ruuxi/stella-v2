import { describe, expect, test } from "bun:test";
import {
  AGENT_HISTORY_MAX_ROWS,
  AGENT_HISTORY_ROW_MAX_BYTES,
  parseAuthoritativeAgentHistory,
} from "./agent-history.js";

const user = (text = "hello") =>
  JSON.stringify({ role: "user", content: text, timestamp: 1 });

const assistant = () =>
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "messages",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });

describe("authoritative cloud agent history", () => {
  test("accepts ordered, structurally valid AgentMessage rows", () => {
    expect(
      parseAuthoritativeAgentHistory([
        { seq: 1, role: "user", payloadJson: user(), turnId: "turn-1" },
        {
          seq: 2,
          role: "assistant",
          payloadJson: assistant(),
          turnId: "turn-1",
        },
      ]),
    ).toHaveLength(2);
  });

  test.each([
    ["malformed JSON", "{"],
    [
      "invalid AgentMessage shape",
      JSON.stringify({ role: "assistant", content: "not-an-array" }),
    ],
    ["declared role mismatch", user()],
  ])("rejects %s instead of silently discarding it", (_name, payloadJson) => {
    expect(() =>
      parseAuthoritativeAgentHistory([
        {
          seq: 1,
          role: _name === "declared role mismatch" ? "assistant" : "user",
          payloadJson,
          turnId: "turn-1",
        },
      ]),
    ).toThrow();
  });

  test("rejects duplicate/out-of-order sequence authority", () => {
    expect(() =>
      parseAuthoritativeAgentHistory([
        { seq: 2, role: "user", payloadJson: user(), turnId: "turn-1" },
        { seq: 2, role: "user", payloadJson: user(), turnId: "turn-2" },
      ]),
    ).toThrow(/row 1/);
  });

  test("enforces row and aggregate protocol bounds", () => {
    expect(() =>
      parseAuthoritativeAgentHistory(
        Array.from({ length: AGENT_HISTORY_MAX_ROWS + 1 }, (_, seq) => ({
          seq,
          role: "user",
          payloadJson: user(),
          turnId: "turn-1",
        })),
      ),
    ).toThrow(/bounded/);
    expect(() =>
      parseAuthoritativeAgentHistory([
        {
          seq: 1,
          role: "user",
          payloadJson: user("x".repeat(AGENT_HISTORY_ROW_MAX_BYTES)),
          turnId: "turn-1",
        },
      ]),
    ).toThrow(/byte bound/);
  });
});
