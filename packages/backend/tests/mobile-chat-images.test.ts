import { describe, expect, it } from "bun:test";

import {
  buildOfflineChatContext,
  MAX_IMAGE_BASE64_CHARS,
  MAX_OFFLINE_IMAGES,
  offlineImageCapabilityError,
  parseOfflineImages,
} from "../convex/mobile_chat_images";
import { buildOpenAICompletionsParams } from "../convex/runtime_ai/openai_completions";
import type { Model } from "../convex/runtime_ai/types";

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
    expect(parseOfflineImages([{ base64: "not base64!", mimeType: "image/png" }])).toMatchObject({
      ok: false,
    });
    expect(parseOfflineImages([{ base64: PNG_BASE64, mimeType: "image/heic" }])).toMatchObject({
      ok: false,
    });
    expect(
      parseOfflineImages([
        { base64: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4), mimeType: "image/png" },
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
    expect(offlineImageCapabilityError({ modalitiesInput: ["text"] }, images)).toContain(
      "does not support images",
    );
    expect(offlineImageCapabilityError({}, images)).toContain(
      "does not support images",
    );
  });

  it("allows image turns only when the resolved model advertises image input", () => {
    expect(
      offlineImageCapabilityError(
        { modalitiesInput: ["text", "image"] },
        [{ base64: PNG_BASE64, mimeType: "image/png" }],
      ),
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

    const params = buildOpenAICompletionsParams(model, context, undefined, false);
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
