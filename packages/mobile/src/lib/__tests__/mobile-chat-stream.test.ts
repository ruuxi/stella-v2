import { describe, expect, test } from "bun:test";

import { parseMobileChatStreamPayload } from "../mobile-chat-stream";

describe("mobile chat structured stream frames", () => {
  test("parses text and native tool-call frames", () => {
    expect(parseMobileChatStreamPayload('{"t":"hello"}')).toEqual({
      type: "text",
      text: "hello",
    });
    expect(
      parseMobileChatStreamPayload(
        JSON.stringify({
          toolCall: {
            id: "call_web",
            name: "web",
            arguments: { query: "latest news" },
            thoughtSignature: '{"type":"reasoning.encrypted"}',
            source: {
              api: "openai-completions",
              provider: "openrouter",
              model: "google/gemini-3.7-flash",
            },
          },
        }),
      ),
    ).toEqual({
      type: "toolCall",
      toolCall: {
        id: "call_web",
        name: "web",
        arguments: { query: "latest news" },
        thoughtSignature: '{"type":"reasoning.encrypted"}',
        source: {
          api: "openai-completions",
          provider: "openrouter",
          model: "google/gemini-3.7-flash",
        },
      },
    });
  });

  test("surfaces errors and ignores malformed frames", () => {
    expect(parseMobileChatStreamPayload('{"error":"failed"}')).toEqual({
      type: "error",
      error: "failed",
    });
    expect(parseMobileChatStreamPayload("not-json")).toEqual({
      type: "ignore",
    });
    expect(parseMobileChatStreamPayload("[DONE]")).toEqual({ type: "done" });
  });
});
