import { describe, expect, it } from "vitest";

import { buildOpenAIRealtimeSessionConfig } from "@/features/voice/services/realtime/providers/openai-provider";
import { buildStellaVoiceSessionRequest } from "@/features/voice/services/realtime/providers/stella-provider";
import { toRealtimeProviderTool } from "@/features/voice/services/realtime/providers/tool-schema";
import type { RealtimeSessionTool } from "@/features/voice/services/realtime/providers/types";

const tools: RealtimeSessionTool[] = [
  {
    type: "function",
    name: "Read",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

describe("realtime provider tool contract", () => {
  it("sends the resolved orchestrator tools when Stella mints the session", () => {
    expect(
      buildStellaVoiceSessionRequest(
        {
          conversationId: "conversation123",
          instructions: "Help the user.",
          tools,
        },
        { voiceProvider: "openai", voice: "marin" },
      ),
    ).toEqual({
      conversationId: "conversation123",
      instructions: "Help the user.",
      tools,
      voiceProvider: "openai",
      voice: "marin",
    });
  });

  it("does not try to update immutable OpenAI model or voice fields", () => {
    expect(
      buildOpenAIRealtimeSessionConfig({
        instructions: "Help the user.",
        tools,
      }),
    ).toEqual({
      type: "realtime",
      instructions: "Help the user.",
      tools,
      tool_choice: "auto",
    });
  });

  it("removes root unions that OpenAI Realtime rejects", () => {
    expect(
      toRealtimeProviderTool({
        ...tools[0],
        name: "image_gen",
        parameters: {
          ...tools[0].parameters,
          allOf: [{ not: { required: ["tooManyReferences"] } }],
        },
      }),
    ).toEqual({
      ...tools[0],
      name: "image_gen",
    });
  });
});
