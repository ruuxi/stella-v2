import { describe, expect, test } from "bun:test";
import { parseVoiceJournalRecords } from "../src/journal-append-protocol.js";

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  api: "openai-completions",
  provider: "stella",
  model: "voice",
  usage: {},
  stopReason: "stop",
  timestamp: 1,
};

describe("voice journal append protocol", () => {
  test("accepts the exact voice message envelope", () => {
    expect(
      parseVoiceJournalRecords([
        {
          kind: "message",
          role: "assistant",
          payloadJson: JSON.stringify(assistant),
          hidden: true,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        hidden: true,
      }),
    ]);
  });

  test("rejects lifecycle rows, unknown fields, and declared role mismatches", () => {
    expect(
      parseVoiceJournalRecords([
        {
          kind: "turn",
          role: "assistant",
          phase: "completed",
          payloadJson: JSON.stringify(assistant),
        },
      ]),
    ).toBeNull();
    expect(
      parseVoiceJournalRecords([
        {
          kind: "message",
          role: "assistant",
          notice: "not allowed",
          payloadJson: JSON.stringify(assistant),
        },
      ]),
    ).toBeNull();
    expect(
      parseVoiceJournalRecords([
        {
          kind: "message",
          role: "user",
          payloadJson: JSON.stringify(assistant),
        },
      ]),
    ).toBeNull();
  });
});
