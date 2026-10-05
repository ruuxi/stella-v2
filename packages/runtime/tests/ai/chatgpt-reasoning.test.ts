import { describe, expect, it } from "vitest";

import { getModels } from "@stella/runtime/ai/models";
import {
  buildChatGptRequestBody,
  resolveChatGptReasoningEffort,
} from "@stella/runtime/ai/providers/chatgpt-responses";
import type { Model } from "@stella/runtime/ai/types";

const luna = (): Model<"chatgpt-responses"> => {
  const model = getModels("chatgpt").find(
    (candidate) => candidate.id === "gpt-5.6-luna",
  );
  if (!model || model.api !== "chatgpt-responses") {
    throw new Error("Missing GPT-5.6-Luna ChatGPT model metadata.");
  }
  return model;
};

describe("ChatGPT reasoning effort", () => {
  it("sends explicit none for Luna when no reasoning is requested", () => {
    expect(resolveChatGptReasoningEffort(luna(), "off")).toBe("none");
  });

  it("falls back to low when model metadata disables no reasoning", () => {
    expect(
      resolveChatGptReasoningEffort(
        { ...luna(), thinkingLevelMap: { off: null } },
        "off",
      ),
    ).toBe("low");
  });

  it("serializes reasoning none without a reusable session key", () => {
    const body = buildChatGptRequestBody(
      luna(),
      {
        systemPrompt: "narrate",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "summarize" }],
            timestamp: 1,
          },
        ],
      },
      { reasoningEffort: "none" },
    );

    expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.store).toBe(false);
  });
});
