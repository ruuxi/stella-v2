import { describe, expect, it } from "bun:test";

import { meterCompletedMediaJob } from "../../convex/media_billing";
import { getMediaCapability } from "../../convex/media_catalog";
import { resolveOpenRouterAudioInput } from "../../convex/media_openrouter_stt";

describe("speech_to_text catalog", () => {
  it("defaults to OpenRouter Nemotron 3.5 ASR", () => {
    const capability = getMediaCapability("speech_to_text");
    expect(capability?.provider).toBe("openrouter");
    expect(capability?.endpointId).toBe(
      "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    );
  });
});

describe("speech_to_text billing", () => {
  it("meters Nemotron from OpenRouter usage.seconds at $0.000003/second", () => {
    const billing = meterCompletedMediaJob({
      endpointId: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
      request: { input: { audio_url: "https://example.test/clip.mp3" } },
      output: {
        text: "hello",
        usage: { seconds: 60, cost: 0.00018 },
      },
    });

    expect(billing).toMatchObject({
      endpointId: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
      billingUnit: "second",
      quantity: 60,
      unitPriceUsd: 0.000003,
      costMicroCents: 18_000,
      meteredFrom: "output",
    });
  });

  it("keeps Parakeet TDT v3 metering for leftover jobs", () => {
    const billing = meterCompletedMediaJob({
      endpointId: "nvidia/parakeet-tdt-0.6b-v3",
      request: { input: { audio_url: "https://example.test/clip.mp3" } },
      output: {
        text: "hello",
        usage: { seconds: 60, cost: 0.0015 },
      },
    });

    expect(billing).toMatchObject({
      endpointId: "nvidia/parakeet-tdt-0.6b-v3",
      billingUnit: "minute",
      quantity: 1,
      unitPriceUsd: 0.0015,
      costMicroCents: 150_000,
      meteredFrom: "output",
    });
  });

  it("keeps ElevenLabs Scribe v2 metering for leftover jobs", () => {
    const billing = meterCompletedMediaJob({
      endpointId: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
      request: { input: { audio_url: "https://example.test/clip.mp3" } },
      output: {
        text: "hello",
        words: [{ end: 120 }],
      },
    });

    expect(billing).toMatchObject({
      billingUnit: "minute",
      quantity: 2,
      unitPriceUsd: 0.008,
    });
  });
});

describe("OpenRouter audio input", () => {
  it("accepts a WAV data URI without downloading", async () => {
    const wav = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
    const audio = await resolveOpenRouterAudioInput(
      `data:audio/wav;base64,${wav}`,
    );
    expect(audio.format).toBe("wav");
    expect(audio.data).toBe(wav);
  });
});
