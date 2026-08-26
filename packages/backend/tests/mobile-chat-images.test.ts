import { describe, expect, it } from "bun:test";

import {
  buildOfflineChatContext,
  MAX_IMAGE_BASE64_CHARS,
  MAX_OFFLINE_IMAGES,
  offlineImageCapabilityError,
  parseOfflineImages,
} from "../convex/mobile_chat_images";
import {
  assistantMessageHasMobileOutput,
  MOBILE_CHAT_TOOLS,
  parseMobileChatToolMessages,
} from "../convex/mobile_chat_tools";
import { buildOpenAICompletionsParams } from "../convex/runtime_ai/openai_completions";
import type { AssistantMessage, Model } from "../convex/runtime_ai/types";

const PNG_BASE64 = "iVBORw0KGgo=";

describe("mobile normal-chat image schema", () => {
  it("accepts provider-safe image payloads without dropping bytes", () => {
    expect(
      parseOfflineImages([
        { base64: PNG_BASE64, mimeType: "image/png" },
        { base64: "/9j/2Q==", mimeType: "IMAGE/JPEG" },
      ]),
    ).toEqual({
      ok: true,
      images: [
        { base64: PNG_BASE64, mimeType: "image/png" },
        { base64: "/9j/2Q==", mimeType: "image/jpeg" },
      ],
    });
  });

  it("rejects malformed, unsupported, oversized, excessive, and over-total images", () => {
    expect(
      parseOfflineImages([{ base64: "not base64!", mimeType: "image/png" }]),
    ).toMatchObject({
      ok: false,
    });
    expect(
      parseOfflineImages([{ base64: PNG_BASE64, mimeType: "image/heic" }]),
    ).toMatchObject({
      ok: false,
    });
    expect(
      parseOfflineImages([
        {
          base64: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4),
          mimeType: "image/png",
        },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      parseOfflineImages(
        Array.from({ length: MAX_OFFLINE_IMAGES + 1 }, () => ({
          base64: PNG_BASE64,
          mimeType: "image/png",
        })),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseOfflineImages(
        Array.from({ length: 3 }, () => ({
          base64: "A".repeat(4_000_004),
          mimeType: "image/png",
        })),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("mobile normal-chat model capability", () => {
  it("rejects image turns for text-only or unknown models", () => {
    const images = [{ base64: PNG_BASE64, mimeType: "image/png" }];
    expect(
      offlineImageCapabilityError({ modalitiesInput: ["text"] }, images),
    ).toContain("does not support images");
    expect(offlineImageCapabilityError({}, images)).toContain(
      "does not support images",
    );
  });

  it("allows image turns only when the resolved model advertises image input", () => {
    expect(
      offlineImageCapabilityError({ modalitiesInput: ["text", "image"] }, [
        { base64: PNG_BASE64, mimeType: "image/png" },
      ]),
    ).toBeNull();
  });
});

describe("mobile normal-chat multimodal forwarding", () => {
  it("builds an OpenAI image_url part with the original base64 payload", () => {
    const context = buildOfflineChatContext({
      systemPrompt: "system",
      history: [{ role: "assistant", text: "Earlier answer" }],
      message: "What is this?",
      images: [{ base64: PNG_BASE64, mimeType: "image/png" }],
    });
    const model: Model<"openai-completions"> = {
      id: "vision-model",
      name: "Vision model",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    };

    const params = buildOpenAICompletionsParams(
      model,
      context,
      undefined,
      false,
    );
    expect(params.messages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
        },
      ],
    });
  });
});

describe("mobile native tool forwarding", () => {
  const model: Model<"openai-completions"> = {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };

  it("sends real tool schemas instead of embedding tool instructions in text", () => {
    const context = buildOfflineChatContext({
      systemPrompt: "Use tools when needed.",
      history: [],
      message: "Search the web for today's news",
      images: [],
      tools: MOBILE_CHAT_TOOLS,
      assistantModel: model.id,
    });
    const params = buildOpenAICompletionsParams(
      model,
      context,
      undefined,
      true,
    );

    expect(Array.isArray(params.tools)).toBe(true);
    expect(
      (params.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
    ).toContain("web");
    expect(
      (params.messages as Array<{ role: string }>).map(
        (message) => message.role,
      ),
    ).toEqual(["system", "user"]);
  });

  it("reconstructs assistant tool calls followed by structured tool results", () => {
    const toolMessages = parseMobileChatToolMessages([
      {
        role: "assistant",
        text: "",
        toolCalls: [
          {
            id: "call_web",
            name: "web",
            arguments: { query: "latest news" },
            thoughtSignature:
              '{"type":"reasoning.encrypted","data":"signature"}',
          },
        ],
        source: {
          api: "openai-completions",
          provider: "openrouter",
          model: "google/gemini-3.7-flash",
        },
      },
      {
        role: "toolResult",
        toolCallId: "call_web",
        toolName: "web",
        text: "Search result text",
        isError: false,
      },
    ]);
    const context = buildOfflineChatContext({
      systemPrompt: "Use tools when needed.",
      history: [],
      message: "Search the web for today's news",
      images: [],
      tools: MOBILE_CHAT_TOOLS,
      toolMessages,
      assistantModel: model.id,
    });
    const params = buildOpenAICompletionsParams(
      model,
      context,
      undefined,
      true,
    );
    const messages = params.messages as Array<Record<string, unknown>>;

    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          {
            id: "call_web",
            type: "function",
            function: { name: "web", arguments: '{"query":"latest news"}' },
          },
        ],
        reasoning_details: [{ type: "reasoning.encrypted", data: "signature" }],
      }),
    );
    expect(messages).toContainEqual({
      role: "tool",
      content: "Search result text",
      tool_call_id: "call_web",
    });
  });

  it("accepts tool-only output but rejects an actually empty model reply", () => {
    const base: Omit<AssistantMessage, "content"> = {
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    expect(
      assistantMessageHasMobileOutput({
        ...base,
        content: [{ type: "text", text: "   " }],
      }),
    ).toBe(false);
    expect(
      assistantMessageHasMobileOutput({
        ...base,
        content: [
          {
            type: "toolCall",
            id: "call_web",
            name: "web",
            arguments: { query: "latest news" },
          },
        ],
      }),
    ).toBe(true);
  });
});
