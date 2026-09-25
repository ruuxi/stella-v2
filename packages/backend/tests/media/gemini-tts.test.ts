import { describe, expect, it } from "bun:test";

import {
  buildGeminiTtsRequest,
  createGeminiTtsStreamPipeline,
  parseGeminiTtsUnaryResponse,
  resolveGeminiTtsUsage,
  resolveGeminiTtsVoice,
} from "../../convex/lib/gemini_tts";

const sseEvent = (payload: unknown) =>
  `event: x\ndata: ${JSON.stringify(payload)}\n\n`;

const pcmDelta = (bytes: Uint8Array) =>
  sseEvent({
    event_type: "step.delta",
    delta: {
      mime_type: "audio/l16",
      data: Buffer.from(bytes).toString("base64"),
    },
  });

// Walk MPEG-2 Layer III frame headers; returns frame count or -1 when a
// header does not line up.
const countMp3Frames = (bytes: Uint8Array): number => {
  const bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let offset = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return -1;
    const bitrate = bitrates[(bytes[offset + 2] >> 4) & 0x0f] ?? 0;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    const frameLen = Math.floor((72 * bitrate * 1000) / 24_000) + padding;
    if (frameLen < 4) return -1;
    offset += frameLen;
    frames += 1;
  }
  return offset === bytes.length ? frames : -1;
};

describe("Gemini TTS", () => {
  it("falls back to the default voice for unknown ids", () => {
    expect(resolveGeminiTtsVoice("Puck")).toBe("Puck");
    expect(resolveGeminiTtsVoice(" Sulafat ")).toBe("Sulafat");
    expect(resolveGeminiTtsVoice("Brooke")).toBe("Kore");
    expect(resolveGeminiTtsVoice(undefined)).toBe("Kore");
  });

  it("builds streaming and unary requests", () => {
    const [streamUrl, streamInit] = buildGeminiTtsRequest({
      apiKey: "k",
      text: "hi",
      voice: "Kore",
      stream: true,
    });
    expect(streamUrl).toEndWith("/v1beta/interactions?alt=sse");
    expect(JSON.parse(String(streamInit.body))).toMatchObject({
      model: "gemini-3.8-flash-lite-tts",
      response_format: { mime_type: "audio/l16", sample_rate: 24_000 },
      generation_config: { speech_config: [{ voice: "Kore" }] },
      stream: true,
    });
    const [unaryUrl, unaryInit] = buildGeminiTtsRequest({
      apiKey: "k",
      text: "hi",
      voice: "Kore",
      stream: false,
    });
    expect(unaryUrl).toEndWith("/v1beta/interactions");
    expect(JSON.parse(String(unaryInit.body)).stream).toBeUndefined();
  });

  it("encodes split SSE PCM into whole CBR MP3 frames and captures usage", () => {
    const pipeline = createGeminiTtsStreamPipeline();
    // Two deltas, the first with an odd byte count, then the usage event;
    // fed to the pipeline in awkward 7-byte network chunks.
    const pcm = new Uint8Array(48_000);
    for (let i = 0; i < pcm.length; i += 2) pcm[i] = i % 256;
    const wire = new TextEncoder().encode(
      pcmDelta(pcm.subarray(0, 24_001)) +
        pcmDelta(pcm.subarray(24_001)) +
        sseEvent({
          event_type: "interaction.complete",
          interaction: {
            status: "completed",
            usage: {
              total_input_tokens: 3,
              output_tokens_by_modality: [{ modality: "audio", tokens: 39 }],
            },
          },
        }) +
        "data: [DONE]\n\n",
    );
    const parts: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i += 7) {
      parts.push(pipeline.push(wire.subarray(i, i + 7)));
    }
    parts.push(pipeline.finish());
    const mp3 = Buffer.concat(parts);

    expect(pipeline.pcmBytes).toBe(48_000);
    expect(pipeline.usage).toEqual({ textInputTokens: 3, audioOutputTokens: 39 });
    expect(pipeline.error).toBeNull();
    // One second of 24 kHz audio is ~42 frames of 576 samples.
    expect(countMp3Frames(mp3)).toBeGreaterThanOrEqual(41);
  });

  it("surfaces stream errors", () => {
    const pipeline = createGeminiTtsStreamPipeline();
    pipeline.push(
      new TextEncoder().encode(sseEvent({ error: { message: "quota" } })),
    );
    pipeline.finish();
    expect(pipeline.error).toBe("quota");
  });

  it("estimates usage from PCM duration when none is reported", () => {
    expect(
      resolveGeminiTtsUsage({ reported: null, requestChars: 40, pcmBytes: 96_000 }),
    ).toEqual({ textInputTokens: 10, audioOutputTokens: 80 });
  });

  it("parses unary WAV responses", () => {
    const parsed = parseGeminiTtsUnaryResponse(
      JSON.stringify({
        steps: [
          { content: [{ type: "audio", data: Buffer.from([1, 2]).toString("base64") }] },
        ],
        usage: { total_input_tokens: 1, total_output_tokens: 9 },
      }),
    );
    expect(parsed?.audio).toEqual(new Uint8Array([1, 2]));
    expect(parsed?.usage).toEqual({ textInputTokens: 1, audioOutputTokens: 9 });
    expect(parseGeminiTtsUnaryResponse("{}")).toBeNull();
  });
});
