import { describe, expect, it } from "bun:test";

import {
  computeRealtimeUsageCostMicroCents,
  computeTtsUsageCostMicroCents,
} from "../convex/lib/billing_money";

describe("billing money", () => {
  it("prices gpt-realtime-2 text, audio, and image modalities", () => {
    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: "gpt-realtime-2",
      textInputTokens: 1_000_000,
      textCachedInputTokens: 1_000_000,
      textOutputTokens: 1_000_000,
      audioInputTokens: 1_000_000,
      audioCachedInputTokens: 1_000_000,
      audioOutputTokens: 1_000_000,
      imageInputTokens: 1_000_000,
      imageCachedInputTokens: 1_000_000,
    });

    expect(costMicroCents).toBe(13_030_000_000);
  });

  it("prices gpt-realtime-2.1 identically to gpt-realtime-2", () => {
    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: "gpt-realtime-2.1",
      textInputTokens: 1_000_000,
      textCachedInputTokens: 1_000_000,
      textOutputTokens: 1_000_000,
      audioInputTokens: 1_000_000,
      audioCachedInputTokens: 1_000_000,
      audioOutputTokens: 1_000_000,
      imageInputTokens: 1_000_000,
      imageCachedInputTokens: 1_000_000,
    });

    expect(costMicroCents).toBe(13_030_000_000);

    // Future dated snapshots of 2.1 must price through the base 2.1 rates.
    expect(
      computeRealtimeUsageCostMicroCents({
        model: "gpt-realtime-2.1-2026-08-01",
        audioOutputTokens: 1_000_000,
      }),
    ).toBe(6_400_000_000);
  });

  it("prices gpt-4o-mini-tts text input and audio output", () => {
    const costMicroCents = computeTtsUsageCostMicroCents({
      model: "gpt-4o-mini-tts",
      textInputTokens: 1_000_000,
      audioOutputTokens: 1_000_000,
    });

    expect(costMicroCents).toBe(1_260_000_000);
  });

  it("prices dated OpenAI voice snapshots through their base model rates", () => {
    expect(
      computeRealtimeUsageCostMicroCents({
        model: "gpt-realtime-2-2026-05-13",
        audioOutputTokens: 1_000_000,
      }),
    ).toBe(6_400_000_000);

    expect(
      computeTtsUsageCostMicroCents({
        model: "gpt-4o-mini-tts-2025-12-15",
        textInputTokens: 0,
        audioOutputTokens: 1_000_000,
      }),
    ).toBe(1_200_000_000);
  });

  it("prices xAI realtime audio duration", () => {
    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: "grok-voice-think-fast-1.0",
      realtimeAudioSeconds: 60,
      realtimeTextInputMessages: 2,
    });

    expect(costMicroCents).toBe(5_000_000);
  });

  it("uses exact provider costs when xAI returns cost ticks", () => {
    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: "grok-voice-think-fast-1.0",
      exactCostMicroCents: 123_456,
      realtimeAudioSeconds: 3600,
      realtimeTextInputMessages: 10,
    });

    expect(costMicroCents).toBe(123_456);
  });

  it("prices Inworld realtime LLM and STT without TTS", () => {
    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: "openai/gpt-4o-mini",
      textInputTokens: 2_000_000,
      textCachedInputTokens: 1_000_000,
      textOutputTokens: 1_000_000,
      sttModel: "assemblyai/u3-rt-pro",
      sttAudioSeconds: 3600,
    });

    expect(costMicroCents).toBe(117_500_000);
  });
});
