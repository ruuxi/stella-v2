import { describe, expect, it } from "vitest";

import { getModels } from "@stella/runtime/ai/models";
import {
  buildOpenAICodexRequestBody,
  resolveOpenAICodexReasoningEffort,
} from "@stella/runtime/ai/providers/openai-codex-responses";
import type { Model } from "@stella/runtime/ai/types";

const luna = (): Model<"openai-codex-responses"> => {
  const model = getModels("openai-codex").find(
    (candidate) => candidate.id === "gpt-5.6-luna",
  );
  if (!model || model.api !== "openai-codex-responses") {
    throw new Error("Missing GPT-5.6-Luna OpenAI Codex model metadata.");
  }
  return model;
};

describe("OpenAI Codex reasoning effort", () => {
  it("sends explicit none for Luna when no reasoning is requested", () => {
    expect(resolveOpenAICodexReasoningEffort(luna(), "off")).toBe("none");
  });

  it("falls back to low when model metadata disables no reasoning", () => {
    expect(
      resolveOpenAICodexReasoningEffort(
        { ...luna(), thinkingLevelMap: { off: null } },
        "off",
      ),
    ).toBe("low");
  });

  it("serializes reasoning none without a reusable session key", () => {
    const body = buildOpenAICodexRequestBody(
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
