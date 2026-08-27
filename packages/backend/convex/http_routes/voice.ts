import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction } from "../auth";
import { runManagedGate } from "../lib/gate_and_meter";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { buildXaiRealtimeClientSecretRequest } from "../http_shared/xai_realtime";

const VOICE_SESSION_RATE_LIMIT = 10;
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;

const normalizeConversationId = async (
  ctx: ActionCtx,
  value: unknown,
): Promise<Id<"conversations"> | null> => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return await ctx.runQuery(internal.conversations.normalizeId, {
    id: normalized,
  });
};

type VoiceUsageBody = {
  responseId?: string;
  model?: string;
  stellaSessionId?: string;
  conversationId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_token_details?: {
      text_tokens?: number;
      audio_tokens?: number;
      image_tokens?: number;
      cached_tokens?: number;
      cached_text_tokens?: number;
      cached_audio_tokens?: number;
      cached_image_tokens?: number;
    };
    output_token_details?: {
      text_tokens?: number;
      audio_tokens?: number;
    };
    cost_in_usd_ticks?: number;
    llm?: {
      model?: string;
    };
    stt?: {
      model?: string;
      audio_seconds?: number;
    };
    xai?: {
      audio_seconds?: number;
      audio_input_seconds?: number;
      audio_output_seconds?: number;
      text_input_messages?: number;
    };
  };
};

type ProviderClientSecretPayload = {
  value?: unknown;
  id?: unknown;
  session?: unknown;
  client_secret?: { value?: unknown; expires_at?: unknown } | unknown;
  expires_at?: unknown;
};

type VoiceRealtimeProvider = "openai" | "xai" | "inworld";

type PreparedVoiceLease =
  | {
      allowed: false;
      message?: string;
      blockedSessionId?: string;
    }
  | {
      allowed: true;
      stellaSessionId: string;
      leaseExpiresAt: number;
      leaseDurationMs: number;
    };

const fingerprintString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const createVoiceSessionId = (provider: string): string => {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `voice_${provider}_${Date.now()}_${random}`;
};

const readProviderClientSecret = (
  value: ProviderClientSecretPayload,
): string | null => {
  if (typeof value.value === "string") return value.value;
  if (
    typeof value.client_secret === "object" &&
    value.client_secret !== null &&
    "value" in value.client_secret &&
    typeof value.client_secret.value === "string"
  ) {
    return value.client_secret.value;
  }
  return null;
};

const readProviderClientSecretExpiry = (
  value: ProviderClientSecretPayload,
): number | undefined => {
  if (typeof value.expires_at === "number") return value.expires_at;
  if (
    typeof value.client_secret === "object" &&
    value.client_secret !== null &&
    "expires_at" in value.client_secret &&
    typeof value.client_secret.expires_at === "number"
  ) {
    return value.client_secret.expires_at;
  }
  return undefined;
};

const readProviderSessionId = (
  value: ProviderClientSecretPayload,
): string | undefined => {
  if (typeof value.id === "string") return value.id;
  if (
    value.session &&
    typeof value.session === "object" &&
    "id" in value.session &&
    typeof value.session.id === "string"
  ) {
    return value.session.id;
  }
  return undefined;
};

const toNonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;

const toNonNegativeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const readOptionalModel = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const parseVoiceUsageBody = (body: VoiceUsageBody | null) => {
  const responseId = body?.responseId?.trim();
  const requestedModel = body?.model?.trim();
  if (!responseId || !requestedModel) {
    return null;
  }

  const inputDetails = body?.usage?.input_token_details ?? {};
  const outputDetails = body?.usage?.output_token_details ?? {};
  const usage = body?.usage ?? {};
  const exactCostMicroCents =
    typeof usage.cost_in_usd_ticks === "number" &&
    Number.isFinite(usage.cost_in_usd_ticks)
      ? Math.max(0, Math.round(usage.cost_in_usd_ticks / 100))
      : undefined;
  const model = readOptionalModel(usage.llm?.model) ?? requestedModel;
  const sttModel = readOptionalModel(usage.stt?.model);
  const sttAudioSeconds = toNonNegativeNumber(usage.stt?.audio_seconds);
  const realtimeAudioSeconds = Math.max(
    toNonNegativeNumber(usage.xai?.audio_seconds),
    toNonNegativeNumber(usage.xai?.audio_input_seconds) +
      toNonNegativeNumber(usage.xai?.audio_output_seconds),
  );
  const realtimeTextInputMessages = toNonNegativeInt(
    usage.xai?.text_input_messages,
  );
  const textInputTokens = toNonNegativeInt(inputDetails.text_tokens);
  const audioInputTokens = toNonNegativeInt(inputDetails.audio_tokens);
  const imageInputTokens = toNonNegativeInt(inputDetails.image_tokens);
  const textCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_text_tokens ?? inputDetails.cached_tokens,
  );
  const audioCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_audio_tokens,
  );
  const imageCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_image_tokens,
  );
  const textOutputTokens = toNonNegativeInt(outputDetails.text_tokens);
  const audioOutputTokens = toNonNegativeInt(outputDetails.audio_tokens);
  const inputTokens =
    toNonNegativeInt(body?.usage?.input_tokens) ||
    textInputTokens + audioInputTokens + imageInputTokens;
  const outputTokens =
    toNonNegativeInt(body?.usage?.output_tokens) ||
    textOutputTokens + audioOutputTokens;
  const totalTokens =
    toNonNegativeInt(body?.usage?.total_tokens) || inputTokens + outputTokens;

  return {
    responseId,
    model,
    stellaSessionId:
      typeof body?.stellaSessionId === "string" &&
      body.stellaSessionId.trim().length > 0
        ? body.stellaSessionId.trim()
        : undefined,
    conversationId:
      typeof body?.conversationId === "string" &&
      body.conversationId.trim().length > 0
        ? body.conversationId.trim()
        : undefined,
    inputTokens,
    outputTokens,
    totalTokens,
    textInputTokens,
    textCachedInputTokens,
    textOutputTokens,
    audioInputTokens,
    audioCachedInputTokens,
    audioOutputTokens,
    imageInputTokens,
    imageCachedInputTokens,
    ...(exactCostMicroCents !== undefined ? { exactCostMicroCents } : {}),
    realtimeAudioSeconds,
    realtimeTextInputMessages,
    ...(sttModel ? { sttModel } : {}),
    sttAudioSeconds,
  };
};

const estimateTextTokensFromChars = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const estimateTtsAudioOutputTokens = (
  text: string,
  speed: number | undefined,
): number => {
  const normalizedSpeed =
    typeof speed === "number" &&
    Number.isFinite(speed) &&
    speed >= 0.25 &&
    speed <= 4
      ? speed
      : 1;

  const estimatedSeconds = text.length / 13 / normalizedSpeed;
  return Math.max(1, Math.ceil(estimatedSeconds * 20));
};

const INWORLD_TTS_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";
const DEFAULT_INWORLD_TTS_MODEL = "inworld-tts-2-flash";
const DEFAULT_INWORLD_TTS_VOICE = "Brooke";
const TTS_MAX_INPUT_CHARS = 8000;

const TTS_RATE_LIMIT = 120;

type TtsSynthesisParams = {
  text: string;
  voice: string;
  model: string;
  speed?: number;
};

type ParsedTtsRequest =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      params: TtsSynthesisParams;
      conversationId?: Id<"conversations">;
    };

const consumeTtsRateLimit = (ctx: ActionCtx, key: string) =>
  ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
    scope: "voice_tts",
    key,
    limit: TTS_RATE_LIMIT,
    windowMs: VOICE_SESSION_RATE_WINDOW_MS,
    blockMs: VOICE_SESSION_RATE_WINDOW_MS,
  });

const normalizeTtsSpeed = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0.25 &&
  value <= 4
    ? value
    : undefined;

const resolveTtsRequest = async (
  ctx: ActionCtx,
  raw: {
    text?: unknown;
    voice?: unknown;
    model?: unknown;
    speed?: unknown;
    conversationId?: unknown;
  },
): Promise<ParsedTtsRequest> => {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) {
    return { ok: false, status: 400, message: "text is required" };
  }

  const truncated =
    text.length > TTS_MAX_INPUT_CHARS
      ? text.slice(0, TTS_MAX_INPUT_CHARS)
      : text;
  const voice =
    typeof raw.voice === "string" && raw.voice.trim().length > 0
      ? raw.voice.trim()
      : DEFAULT_INWORLD_TTS_VOICE;
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_INWORLD_TTS_MODEL;
  const speed = normalizeTtsSpeed(raw.speed);

  let conversationId: Id<"conversations"> | undefined;
  const parsedConversationId = await normalizeConversationId(
    ctx,
    raw.conversationId,
  );
  if (parsedConversationId) {
    try {
      await requireConversationOwnerAction(ctx, parsedConversationId);
      conversationId = parsedConversationId;
    } catch {
      conversationId = undefined;
    }
  }

  return {
    ok: true,
    params: { text: truncated, voice, model, ...(speed ? { speed } : {}) },
    ...(conversationId ? { conversationId } : {}),
  };
};

const decodeBase64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const extractInworldAudioChunk = (line: string): Uint8Array | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    audioContent?: unknown;
    result?: { audioContent?: unknown } | null;
  };
  const b64 =
    obj.result &&
    typeof obj.result === "object" &&
    typeof obj.result.audioContent === "string"
      ? obj.result.audioContent
      : typeof obj.audioContent === "string"
        ? obj.audioContent
        : null;
  if (!b64) return null;
  try {
    return decodeBase64ToBytes(b64);
  } catch {
    return null;
  }
};

const buildInworldTtsStreamBody = (params: TtsSynthesisParams): string =>
  JSON.stringify({
    text: params.text,
    voiceId: params.voice,
    modelId: params.model,
    audioConfig: {
      audioEncoding: "MP3",
      ...(params.speed !== undefined ? { speakingRate: params.speed } : {}),
    },
  });

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

const MAX_TICKET_AUDIO_CACHE_BYTES = 700_000;

type BufferedTtsResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; message: string };

const synthesizeInworldTtsBuffered = async (
  ctx: ActionCtx,
  params: TtsSynthesisParams,
  meta: { ownerId: string; conversationId?: Id<"conversations"> },
): Promise<BufferedTtsResult> => {
  const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
  if (!inworldApiKey) {
    return {
      ok: false,
      status: 503,
      message: "Stella Inworld voice is not configured yet.",
    };
  }
  const requestChars = params.text.length;
  const startedAt = Date.now();
  const record = (
    status: "completed" | "failed" | "partial",
    synthesizedChars: number,
    audioBytes: number,
  ) =>
    ctx
      .runMutation(internal.billing.recordInternalTtsUsage, {
        ownerId: meta.ownerId,
        provider: "inworld" as const,
        model: params.model,
        voice: params.voice,
        ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
        streaming: false,
        status,
        requestChars,
        synthesizedChars,
        audioBytes,
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);

  let upstream: Response;
  try {
    upstream = await fetch(INWORLD_TTS_STREAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inworldApiKey}`,
        "Content-Type": "application/json",
      },
      body: buildInworldTtsStreamBody(params),
    });
  } catch (error) {
    console.error(
      "[voice/tts/stream] Failed to contact Inworld:",
      (error as Error).message,
    );
    await record("failed", 0, 0);
    return { ok: false, status: 502, message: "Failed to reach Inworld TTS" };
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.text().catch(() => undefined);
    console.error("[voice/tts/stream] Inworld TTS failed:", upstream.status);
    await record("failed", 0, 0);
    const status =
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return { ok: false, status, message: "Inworld TTS failed" };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parts: Uint8Array[] = [];
  let total = 0;
  let errored = false;
  const takeLine = (line: string) => {
    const chunk = extractInworldAudioChunk(line);
    if (chunk && chunk.length > 0) {
      parts.push(chunk);
      total += chunk.length;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) takeLine(line);
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) takeLine(rest);
  } catch (error) {
    errored = true;
    console.error(
      "[voice/tts/stream] Buffered relay failed:",
      (error as Error).message,
    );
  }

  if (total === 0) {
    await record("failed", 0, 0);
    return { ok: false, status: 502, message: "Inworld returned no audio" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  await record(errored ? "partial" : "completed", requestChars, total);
  return { ok: true, bytes };
};

const AUDIO_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

const HLS_TARGET_DURATION = 3;
const buildHlsPlaylist = (
  segments: ReadonlyArray<{ seq: number; durationSec: number }>,
  done: boolean,
): string => {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${HLS_TARGET_DURATION}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  const ordered = [...segments].sort((a, b) => a.seq - b.seq);
  for (const seg of ordered) {
    const dur = Number.isFinite(seg.durationSec) ? seg.durationSec : 0;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`${seg.seq}.mp3`);
  }
  if (done) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
};

const serveAudioWithRange = (
  bytes: Uint8Array,
  rangeHeader: string | null,
  origin: string | null,
): Response => {
  const total = bytes.byteLength;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const match = rangeHeader ? AUDIO_RANGE_RE.exec(rangeHeader.trim()) : null;
  if (match) {
    let start = match[1] ? Number.parseInt(match[1], 10) : 0;
    let end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return withCors(
        new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
        }),
        origin,
      );
    }
    const slice = bytes.slice(start, end + 1);
    return withCors(
      new Response(slice as BodyInit, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(slice.byteLength),
        },
      }),
      origin,
    );
  }
  return withCors(
    new Response(bytes as BodyInit, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    }),
    origin,
  );
};

const streamInworldTts = async (
  ctx: ActionCtx,
  origin: string | null,
  params: TtsSynthesisParams,
  meta: { ownerId: string; conversationId?: Id<"conversations"> },
): Promise<Response> => {
  const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
  if (!inworldApiKey) {
    return errorResponse(
      503,
      "Stella Inworld voice is not configured yet.",
      origin,
    );
  }

  const requestChars = params.text.length;
  const startedAt = Date.now();

  const recordFailure = (): Promise<unknown> =>
    ctx
      .runMutation(internal.billing.recordInternalTtsUsage, {
        ownerId: meta.ownerId,
        provider: "inworld" as const,
        model: params.model,
        voice: params.voice,
        ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
        streaming: true,
        status: "failed" as const,
        requestChars,
        synthesizedChars: 0,
        audioBytes: 0,
        durationMs: Date.now() - startedAt,
      })
      .catch((error) => {
        console.error(
          "[voice/tts/stream] usage record failed:",
          (error as Error).message,
        );
      });

  let upstream: Response;
  try {
    upstream = await fetch(INWORLD_TTS_STREAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inworldApiKey}`,
        "Content-Type": "application/json",
      },
      body: buildInworldTtsStreamBody(params),
    });
  } catch (error) {
    console.error(
      "[voice/tts/stream] Failed to contact Inworld:",
      (error as Error).message,
    );
    await recordFailure();
    return errorResponse(502, "Failed to reach Inworld TTS", origin);
  }

  if (!upstream.ok || !upstream.body) {

    await upstream.text().catch(() => undefined);
    console.error("[voice/tts/stream] Inworld TTS failed:", upstream.status);
    await recordFailure();
    const status =
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return errorResponse(status, "Inworld TTS failed", origin);
  }

  const usage = await ctx
    .runMutation(internal.billing.recordInternalTtsUsage, {
      ownerId: meta.ownerId,
      provider: "inworld" as const,
      model: params.model,
      voice: params.voice,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
      streaming: true,
      status: "interrupted" as const,
      requestChars,
      synthesizedChars: requestChars,
      audioBytes: 0,
      durationMs: 0,
    })
    .catch((error) => {
      console.error(
        "[voice/tts/stream] usage record failed:",
        (error as Error).message,
      );
      return null;
    });
  const usageId = usage?.usageId;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let audioBytes = 0;
  let sawAudio = false;
  let upstreamDone = false;
  let recorded = false;

  const finalizeUsage = async (
    status: "completed" | "failed" | "interrupted" | "partial",
  ) => {
    if (recorded || !usageId) return;
    recorded = true;

    const synthesizedChars = status === "failed" ? 0 : requestChars;
    await ctx
      .runMutation(internal.billing.finalizeInternalTtsUsage, {
        usageId,
        status,
        synthesizedChars,
        audioBytes,
        durationMs: Date.now() - startedAt,
      })
      .catch((error) => {
        console.error(
          "[voice/tts/stream] usage finalize failed:",
          (error as Error).message,
        );
      });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const chunk = extractInworldAudioChunk(line);
            if (chunk && chunk.length > 0) {
              audioBytes += chunk.length;
              sawAudio = true;
              controller.enqueue(chunk);
              return;
            }
          }
          if (upstreamDone) {
            const rest = buffer.trim();
            buffer = "";
            if (rest) {
              const chunk = extractInworldAudioChunk(rest);
              if (chunk && chunk.length > 0) {
                audioBytes += chunk.length;
                sawAudio = true;
                controller.enqueue(chunk);
                return;
              }
            }
            await finalizeUsage("completed");
            controller.close();
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            upstreamDone = true;
            buffer += decoder.decode();
            continue;
          }
          if (value) buffer += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        console.error(
          "[voice/tts/stream] Relay stream failed:",
          (error as Error).message,
        );
        await finalizeUsage(sawAudio ? "partial" : "failed");
        try {
          controller.error(error);
        } catch {

        }
      }
    },
    async cancel(reason) {

      await reader.cancel(reason).catch(() => undefined);
      await finalizeUsage("interrupted");
    },
  });

  return withCors(
    new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    }),
    origin,
  );
};

export const registerVoiceRoutes = (http: HttpRouter) => {

  registerCorsOptions(http, [
    "/api/voice/session",
    "/api/voice/usage",
    "/api/voice/lease",
    "/api/voice/inworld/sdp",
    "/api/voice/tts",
    "/api/voice/tts/stream",
    "/api/voice/tts/stream/prepare",
    "/api/voice/tts/stream/cancel",
  ]);

  http.route({
    path: "/api/voice/session",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use realtime voice.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;
        const ownerId = auth.ownerId;

        const gate = await runManagedGate(ctx, origin, {
          ownerId,
          order: ["rate", "capability", "usage"],
          rateLimit: {
            scope: "voice_session",
            key: ownerId,
            limit: VOICE_SESSION_RATE_LIMIT,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
          capability: "audio_generation",
          usage: {},
        });
        if (!gate.ok) return gate.response;

        type VoiceSessionBody = {
          conversationId?: string;
          voice?: string;
          model?: string;

          ttsModel?: string;
          tools?: unknown;
          turnDetection?: "semantic_vad" | "server_vad";
          turnEagerness?: "low" | "medium" | "high";
          instructions?: string;

          voiceProvider?: "openai" | "xai" | "inworld";
        };
        let body: VoiceSessionBody | null = null;
        try {
          body = (await request.json()) as VoiceSessionBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const instructions = body?.instructions?.trim();
        if (!instructions) {
          return errorResponse(400, "instructions is required", origin);
        }

        const voiceProvider: "openai" | "xai" | "inworld" =
          body?.voiceProvider === "xai"
            ? "xai"
            : body?.voiceProvider === "inworld"
              ? "inworld"
              : "openai";
        const stellaSessionId = createVoiceSessionId(voiceProvider);
        const conversationId = await normalizeConversationId(
          ctx,
          body?.conversationId,
        );

        if (voiceProvider === "xai") {

          const xaiApiKey = process.env.XAI_API_KEY ?? null;
          if (!xaiApiKey) {
            return errorResponse(
              503,
              "Stella xAI voice is not configured yet.",
              origin,
            );
          }
          const xaiModel = body.model ?? "grok-voice-think-fast-1.0";
          const xaiVoice = body.voice ?? "eve";
          const lease = (await ctx.runMutation(
            internal.billing.prepareVoiceRealtimeLease,
            {
              ownerId,
              provider: "xai" as const,
              model: xaiModel,
              voice: xaiVoice,
              stellaSessionId,
              ...(conversationId ? { conversationId } : {}),
            },
          )) as PreparedVoiceLease;
          if (!lease.allowed) {
            return errorResponse(
              429,
              lease.message ??
                "Realtime voice is waiting for the previous session to report usage.",
              origin,
            );
          }
          try {
            const xaiResponse = await fetch(
              "https://api.x.ai/v1/realtime/client_secrets",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${xaiApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(
                  buildXaiRealtimeClientSecretRequest(
                    lease.leaseDurationMs / 1000,
                  ),
                ),
              },
            );
            const xaiText = await xaiResponse.text();
            if (!xaiResponse.ok) {
              console.error(
                "[voice/client_secrets] xAI client secret creation failed:",
                xaiResponse.status,
                xaiText,
              );
              await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId,
                stellaSessionId: lease.stellaSessionId,
                reason: `xai_client_secret_${xaiResponse.status}`,
              });
              return errorResponse(
                xaiResponse.status,
                "Failed to create xAI voice session",
                origin,
              );
            }
            const xaiData = JSON.parse(xaiText) as ProviderClientSecretPayload;
            const xaiClientSecret = readProviderClientSecret(xaiData);
            if (!xaiClientSecret) {
              await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId,
                stellaSessionId: lease.stellaSessionId,
                reason: "xai_missing_client_secret",
              });
              return errorResponse(
                502,
                "xAI did not return a client secret",
                origin,
              );
            }
            await ctx.runMutation(internal.billing.activateVoiceRealtimeLease, {
              ownerId,
              stellaSessionId: lease.stellaSessionId,
              clientSecretFingerprint: fingerprintString(xaiClientSecret),
              providerExpiresAt: readProviderClientSecretExpiry(xaiData),
            });
            return jsonResponse(
              {
                voiceProvider: "xai" as const,
                transport: "xai-websocket" as const,
                clientSecret: xaiClientSecret,
                model: xaiModel,
                voice: xaiVoice,
                expiresAt: readProviderClientSecretExpiry(xaiData),
                stellaSessionId: lease.stellaSessionId,
                leaseExpiresAt: lease.leaseExpiresAt,
              },
              200,
              origin,
            );
          } catch (error) {
            await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId,
              stellaSessionId: lease.stellaSessionId,
              reason: "xai_exception",
            });
            console.error(
              "[voice/session] Failed to contact xAI:",
              (error as Error).message,
            );
            return errorResponse(
              502,
              "Failed to create xAI voice session",
              origin,
            );
          }
        }

        if (voiceProvider === "inworld") {

          const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
          if (!inworldApiKey) {
            return errorResponse(
              503,
              "Stella Inworld voice is not configured yet.",
              origin,
            );
          }
          const inworldModel = body.model ?? "openai/gpt-4o-mini";
          const inworldVoice = body.voice ?? "Brooke";

          const inworldTtsModel =
            typeof body.ttsModel === "string" && body.ttsModel.trim().length > 0
              ? body.ttsModel.trim()
              : DEFAULT_INWORLD_TTS_MODEL;
          const lease = (await ctx.runMutation(
            internal.billing.prepareVoiceRealtimeLease,
            {
              ownerId,
              provider: "inworld" as const,
              model: inworldModel,
              voice: inworldVoice,
              stellaSessionId,
              ...(conversationId ? { conversationId } : {}),
            },
          )) as PreparedVoiceLease;
          if (!lease.allowed) {
            return errorResponse(
              429,
              lease.message ??
                "Realtime voice is waiting for the previous session to report usage.",
              origin,
            );
          }

          let iceServers: unknown[] = [];
          try {
            const iceResponse = await fetch(
              "https://api.inworld.ai/v1/realtime/ice-servers",
              {
                headers: { Authorization: `Bearer ${inworldApiKey}` },
              },
            );
            if (iceResponse.ok) {
              const data = (await iceResponse.json()) as {
                ice_servers?: unknown[];
              };
              if (Array.isArray(data.ice_servers)) {
                iceServers = data.ice_servers;
              }
            } else {
              const detail = await iceResponse.text();
              console.warn(
                "[voice/session] Inworld ice-servers fetch failed:",
                iceResponse.status,
                detail,
              );
            }
          } catch (err) {
            console.warn(
              "[voice/session] Inworld ice-servers fetch error:",
              (err as Error).message,
            );
          }

          await ctx.runMutation(internal.billing.activateVoiceRealtimeLease, {
            ownerId,
            stellaSessionId: lease.stellaSessionId,
          });
          return jsonResponse(
            {
              voiceProvider: "inworld" as const,
              transport: "inworld-webrtc" as const,

              clientSecret: "",
              model: inworldModel,
              voice: inworldVoice,
              ttsModel: inworldTtsModel,
              iceServers,
              stellaSessionId: lease.stellaSessionId,
              leaseExpiresAt: lease.leaseExpiresAt,
            },
            200,
            origin,
          );
        }

        const resolveOpenAiApiKey = async (): Promise<string | null> =>
          process.env.OPENAI_API_KEY ?? null;

        const [openaiApiKey] = await Promise.all([resolveOpenAiApiKey()]);
        if (!openaiApiKey) {
          return errorResponse(
            503,
            "Voice sessions are not configured yet.",
            origin,
          );
        }

        const [{ getVoiceToolSchemas, normalizeVoiceToolSchemas }] =
          await Promise.all([import("../tools/voice_schemas")]);

        const tools =
          body.tools === undefined
            ? getVoiceToolSchemas()
            : normalizeVoiceToolSchemas(body.tools);
        if (!tools) {
          return errorResponse(
            400,
            "tools must be a valid voice tool catalog",
            origin,
          );
        }
        const model = body.model ?? "gpt-realtime-2.1";
        const voice = body.voice ?? "marin";
        const lease = (await ctx.runMutation(
          internal.billing.prepareVoiceRealtimeLease,
          {
            ownerId,
            provider: "openai" as const,
            model,
            voice,
            stellaSessionId,
            ...(conversationId ? { conversationId } : {}),
          },
        )) as PreparedVoiceLease;
        if (!lease.allowed) {
          return errorResponse(
            429,
            lease.message ??
              "Realtime voice is waiting for the previous session to report usage.",
            origin,
          );
        }

        const turnDetection =
          body?.turnDetection === "semantic_vad"
            ? {
                type: "semantic_vad",
                eagerness: body.turnEagerness ?? "medium",
                create_response: true,
                interrupt_response: true,
              }
            : {
                type: "server_vad",

                threshold: 0.5,
                prefix_padding_ms: 120,
                silence_duration_ms: 220,
                create_response: true,
                interrupt_response: true,
              };

        const sessionConfig = {
          session: {
            type: "realtime",
            model,
            instructions,
            reasoning: {
              effort: "minimal",
            },
            tools,
            audio: {
              output: {
                voice,
              },
              input: {
                transcription: {
                  model: "gpt-4o-transcribe",
                },
                turn_detection: turnDetection,
              },
            },
          },
        };

        try {
          const openaiResponse = await fetch(
            "https://api.openai.com/v1/realtime/client_secrets",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(sessionConfig),
            },
          );

          const responseText = await openaiResponse.text();
          if (!openaiResponse.ok) {
            console.error(
              "[voice/client_secrets] OpenAI client secret creation failed:",
              openaiResponse.status,
              responseText,
            );
            await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId,
              stellaSessionId: lease.stellaSessionId,
              reason: `openai_client_secret_${openaiResponse.status}`,
            });
            return errorResponse(
              openaiResponse.status,
              "Failed to create voice session",
              origin,
            );
          }

          const openaiData = JSON.parse(
            responseText,
          ) as ProviderClientSecretPayload;
          const openaiClientSecret = readProviderClientSecret(openaiData);
          if (!openaiClientSecret) {
            await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId,
              stellaSessionId: lease.stellaSessionId,
              reason: "openai_missing_client_secret",
            });
            return errorResponse(
              502,
              "OpenAI did not return a client secret",
              origin,
            );
          }
          const openaiSessionId = readProviderSessionId(openaiData);
          await ctx.runMutation(internal.billing.activateVoiceRealtimeLease, {
            ownerId,
            stellaSessionId: lease.stellaSessionId,
            clientSecretFingerprint: fingerprintString(openaiClientSecret),
            ...(openaiSessionId ? { providerSessionId: openaiSessionId } : {}),
            providerExpiresAt: readProviderClientSecretExpiry(openaiData),
          });
          return jsonResponse(
            {
              voiceProvider: "openai" as const,
              transport: "openai-webrtc" as const,
              clientSecret: openaiClientSecret,
              expiresAt: readProviderClientSecretExpiry(openaiData),
              sessionId: openaiSessionId,
              model,
              voice,
              stellaSessionId: lease.stellaSessionId,
              leaseExpiresAt: lease.leaseExpiresAt,
            },
            200,
            origin,
          );
        } catch (error) {
          await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
            ownerId,
            stellaSessionId: lease.stellaSessionId,
            reason: "openai_exception",
          });
          console.error(
            "[voice/session] Failed to contact OpenAI:",
            (error as Error).message,
          );
          return errorResponse(502, "Failed to create voice session", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/voice/inworld/sdp",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use realtime voice.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        const gate = await runManagedGate(ctx, origin, {
          ownerId: auth.ownerId,
          order: ["rate", "capability", "usage"],
          rateLimit: {
            scope: "voice_inworld_sdp",
            key: auth.ownerId,
            limit: VOICE_SESSION_RATE_LIMIT,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
          capability: "audio_generation",
          usage: {},
        });
        if (!gate.ok) return gate.response;

        const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
        if (!inworldApiKey) {
          return errorResponse(
            503,
            "Stella Inworld voice is not configured yet.",
            origin,
          );
        }

        const sdpOffer = await request.text();
        if (!sdpOffer || sdpOffer.length < 10) {
          return errorResponse(400, "Missing SDP offer", origin);
        }
        const stellaSessionId =
          request.headers.get("x-stella-voice-session-id")?.trim() || null;

        try {
          const inworldResponse = await fetch(
            "https://api.inworld.ai/v1/realtime/calls",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${inworldApiKey}`,
                "Content-Type": "application/sdp",
              },
              body: sdpOffer,
            },
          );
          const sdpAnswer = await inworldResponse.text();
          if (!inworldResponse.ok) {
            if (stellaSessionId) {
              await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId: auth.ownerId,
                stellaSessionId,
                reason: `inworld_sdp_${inworldResponse.status}`,
              });
            }
            console.error(
              "[voice/inworld/sdp] Inworld SDP exchange failed:",
              inworldResponse.status,
              sdpAnswer,
            );
            return errorResponse(
              inworldResponse.status,
              "Inworld SDP exchange failed",
              origin,
            );
          }
          return withCors(
            new Response(sdpAnswer, {
              status: 200,
              headers: { "Content-Type": "application/sdp" },
            }),
            origin,
          );
        } catch (error) {
          if (stellaSessionId) {
            await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId: auth.ownerId,
              stellaSessionId,
              reason: "inworld_sdp_exception",
            });
          }
          console.error(
            "[voice/inworld/sdp] Failed to contact Inworld:",
            (error as Error).message,
          );
          return errorResponse(
            502,
            "Failed to reach Inworld for SDP exchange",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/voice/tts/stream",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        const rateLimit = await consumeTtsRateLimit(
          ctx,
          auth.identity.tokenIdentifier,
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: Record<string, unknown> | null = null;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const parsed = await resolveTtsRequest(ctx, body ?? {});
        if (!parsed.ok) {
          return errorResponse(parsed.status, parsed.message, origin);
        }
        return streamInworldTts(ctx, origin, parsed.params, {
          ownerId: auth.ownerId,
          ...(parsed.conversationId
            ? { conversationId: parsed.conversationId }
            : {}),
        });
      }),
    ),
  });

  http.route({
    path: "/api/voice/tts/stream/prepare",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        const rateLimit = await consumeTtsRateLimit(
          ctx,
          auth.identity.tokenIdentifier,
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: Record<string, unknown> | null = null;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const parsed = await resolveTtsRequest(ctx, body ?? {});
        if (!parsed.ok) {
          return errorResponse(parsed.status, parsed.message, origin);
        }

        const ticket = `${Date.now().toString(36)}_${
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID().replace(/-/g, "")
            : Math.random().toString(36).slice(2)
        }`;
        await ctx.runMutation(internal.tts_hls.startHlsSession, {
          ticket,
          ownerId: auth.ownerId,
          text: parsed.params.text,
          voice: parsed.params.voice,
          model: parsed.params.model,
          ...(parsed.params.speed !== undefined
            ? { speed: parsed.params.speed }
            : {}),
          ...(parsed.conversationId
            ? { conversationId: parsed.conversationId }
            : {}),
        });
        return jsonResponse({ ticket }, 200, origin);
      }),
    ),
  });

  http.route({
    pathPrefix: "/api/voice/tts/stream/audio/",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        const ticket = new URL(request.url).searchParams.get("ticket")?.trim();
        if (!ticket) {
          return errorResponse(400, "ticket is required", origin);
        }

        const consumed = await ctx.runMutation(internal.tts_stream.readTicket, {
          ticket,
          ownerId: auth.ownerId,
          nowMs: Date.now(),
        });
        if (!consumed) {
          return errorResponse(
            404,
            "Stream ticket is invalid or expired",
            origin,
          );
        }

        const rangeHeader = request.headers.get("range");

        if (consumed.audio) {
          try {
            return serveAudioWithRange(
              decodeBase64ToBytes(consumed.audio),
              rangeHeader,
              origin,
            );
          } catch {

          }
        }

        const result = await synthesizeInworldTtsBuffered(
          ctx,
          {
            text: consumed.text,
            voice: consumed.voice,
            model: consumed.model,
            ...(typeof consumed.speed === "number"
              ? { speed: consumed.speed }
              : {}),
          },
          {
            ownerId: auth.ownerId,
            ...(consumed.conversationId
              ? { conversationId: consumed.conversationId }
              : {}),
          },
        );
        if (!result.ok) {
          return errorResponse(result.status, result.message, origin);
        }
        if (result.bytes.byteLength <= MAX_TICKET_AUDIO_CACHE_BYTES) {
          await ctx
            .runMutation(internal.tts_stream.cacheTicketAudio, {
              ticket,
              ownerId: auth.ownerId,
              audio: bytesToBase64(result.bytes),
            })
            .catch(() => undefined);
        }
        return serveAudioWithRange(result.bytes, rangeHeader, origin);
      }),
    ),
  });

  http.route({
    pathPrefix: "/api/voice/tts/stream/hls/",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const prefix = "/api/voice/tts/stream/hls/";
        const idx = url.pathname.indexOf(prefix);
        const rest = idx >= 0 ? url.pathname.slice(idx + prefix.length) : "";
        const slash = rest.indexOf("/");
        if (slash <= 0) {
          return errorResponse(404, "Not found", origin);
        }
        const ticket = decodeURIComponent(rest.slice(0, slash));
        const file = rest.slice(slash + 1);
        if (!ticket) {
          return errorResponse(404, "Not found", origin);
        }

        if (file === "playlist.m3u8") {
          const playlist = await ctx.runQuery(
            internal.tts_hls.readHlsPlaylist,
            { ticket, ownerId: auth.ownerId, nowMs: Date.now() },
          );
          if (!playlist) {
            return errorResponse(404, "Stream is invalid or expired", origin);
          }
          const body = buildHlsPlaylist(playlist.segments, playlist.done);
          return withCors(
            new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "application/vnd.apple.mpegurl",
                "Cache-Control": "no-store",
              },
            }),
            origin,
          );
        }

        const segMatch = /^(\d+)\.mp3$/.exec(file);
        if (segMatch) {
          const seq = Number.parseInt(segMatch[1], 10);
          const segment = await ctx.runQuery(internal.tts_hls.readHlsSegment, {
            ticket,
            ownerId: auth.ownerId,
            seq,
          });
          if (!segment) {
            return errorResponse(404, "Segment not found", origin);
          }
          try {
            return serveAudioWithRange(
              decodeBase64ToBytes(segment.audio),
              request.headers.get("range"),
              origin,
            );
          } catch {
            return errorResponse(500, "Segment decode failed", origin);
          }
        }

        return errorResponse(404, "Not found", origin);
      }),
    ),
  });

  http.route({
    path: "/api/voice/tts/stream/cancel",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        let body: Record<string, unknown> | null = null;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const ticket =
          typeof body?.ticket === "string" ? body.ticket.trim() : "";
        if (!ticket) {
          return errorResponse(400, "ticket is required", origin);
        }
        await ctx.runMutation(internal.tts_hls.cancelHlsSession, {
          ticket,
          ownerId: auth.ownerId,
          nowMs: Date.now(),
        });
        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/voice/tts",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use text to speech.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;
        const identity = auth.identity;

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "voice_tts",

            key: identity.tokenIdentifier,
            limit: 120,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        type TtsBody = {
          text?: string;
          voice?: string;
          model?: string;
          conversationId?: string;
          voiceProvider?: "openai" | "inworld";
          speed?: number;
        };
        let body: TtsBody | null = null;
        try {
          body = (await request.json()) as TtsBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const text = body?.text?.trim();
        if (!text) {
          return errorResponse(400, "text is required", origin);
        }

        const truncated = text.length > 8000 ? text.slice(0, 8000) : text;

        const voiceProvider: "openai" | "inworld" =
          body?.voiceProvider === "inworld" ? "inworld" : "openai";

        let conversationId: Id<"conversations"> | undefined;
        const parsedConversationId = await normalizeConversationId(
          ctx,
          body?.conversationId,
        );
        if (parsedConversationId) {
          try {
            await requireConversationOwnerAction(ctx, parsedConversationId);
            conversationId = parsedConversationId;
          } catch {
            conversationId = undefined;
          }
        }

        if (voiceProvider === "inworld") {
          const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
          if (!inworldApiKey) {
            return errorResponse(
              503,
              "Stella Inworld voice is not configured yet.",
              origin,
            );
          }
          const voiceId = body?.voice?.trim() || "Brooke";
          const modelId = body?.model?.trim() || "inworld-tts-2-flash";
          try {
            const inworldResponse = await fetch(
              "https://api.inworld.ai/tts/v1/voice",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${inworldApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  text: truncated,
                  voiceId,
                  modelId,
                  ...(typeof body?.speed === "number" &&
                  Number.isFinite(body.speed)
                    ? { audioConfig: { speakingRate: body.speed } }
                    : {}),
                }),
              },
            );
            const raw = await inworldResponse.text();
            if (!inworldResponse.ok) {
              console.error(
                "[voice/tts] Inworld TTS failed:",
                inworldResponse.status,
                raw,
              );
              return errorResponse(
                inworldResponse.status,
                "Inworld TTS failed",
                origin,
              );
            }

            let audioBase64: string | null = null;
            try {
              const parsed = JSON.parse(raw) as { audioContent?: string };
              if (typeof parsed.audioContent === "string") {
                audioBase64 = parsed.audioContent;
              }
            } catch {
              audioBase64 = null;
            }
            if (!audioBase64) {
              return errorResponse(502, "Inworld returned no audio", origin);
            }

            const bytes = Uint8Array.from(atob(audioBase64), (c) =>
              c.charCodeAt(0),
            );
            try {

              await ctx.runMutation(internal.billing.recordInternalTtsUsage, {
                ownerId: identity.tokenIdentifier,
                provider: "inworld" as const,
                model: modelId,
                voice: voiceId,
                ...(conversationId ? { conversationId } : {}),
                streaming: false,
                status: "completed" as const,
                requestChars: truncated.length,
                synthesizedChars: truncated.length,
                audioBytes: bytes.byteLength,
              });
            } catch {

            }
            return withCors(
              new Response(bytes, {
                status: 200,
                headers: { "Content-Type": "audio/wav" },
              }),
              origin,
            );
          } catch (error) {
            console.error(
              "[voice/tts] Failed to contact Inworld:",
              (error as Error).message,
            );
            return errorResponse(502, "Failed to reach Inworld TTS", origin);
          }
        }

        const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
        if (!openaiApiKey) {
          return errorResponse(503, "Voice TTS is not configured yet.", origin);
        }
        const ttsVoice = body?.voice?.trim() || "marin";
        const ttsModel = body?.model?.trim() || "gpt-4o-mini-tts";
        try {
          const openaiResponse = await fetch(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: ttsModel,
                voice: ttsVoice,
                input: truncated,
                response_format: "mp3",
                ...(typeof body?.speed === "number" &&
                Number.isFinite(body.speed) &&
                body.speed >= 0.25 &&
                body.speed <= 4
                  ? { speed: body.speed }
                  : {}),
              }),
            },
          );
          if (!openaiResponse.ok) {
            const detail = await openaiResponse.text();
            console.error(
              "[voice/tts] OpenAI TTS failed:",
              openaiResponse.status,
              detail,
            );
            return errorResponse(
              openaiResponse.status,
              "OpenAI TTS failed",
              origin,
            );
          }
          const audio = await openaiResponse.arrayBuffer();
          try {

            await ctx.runMutation(internal.billing.recordInternalTtsUsage, {
              ownerId: identity.tokenIdentifier,
              provider: "openai" as const,
              model: ttsModel,
              voice: ttsVoice,
              ...(conversationId ? { conversationId } : {}),
              streaming: false,
              status: "completed" as const,
              requestChars: truncated.length,
              synthesizedChars: truncated.length,
              audioBytes: audio.byteLength,
              textInputTokens: estimateTextTokensFromChars(truncated),
              audioOutputTokens: estimateTtsAudioOutputTokens(
                truncated,
                body?.speed,
              ),
            });
          } catch {

          }
          return withCors(
            new Response(audio, {
              status: 200,
              headers: { "Content-Type": "audio/mpeg" },
            }),
            origin,
          );
        } catch (error) {
          console.error(
            "[voice/tts] Failed to contact OpenAI:",
            (error as Error).message,
          );
          return errorResponse(502, "Failed to reach OpenAI TTS", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/voice/lease",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use realtime voice.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;

        type VoiceLeaseBody = {
          stellaSessionId?: string;
          event?: "heartbeat" | "ended" | "expired" | "lost";
        };
        let body: VoiceLeaseBody | null = null;
        try {
          body = (await request.json()) as VoiceLeaseBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const stellaSessionId = body?.stellaSessionId?.trim();
        const event = body?.event;
        if (
          !stellaSessionId ||
          (event !== "heartbeat" &&
            event !== "ended" &&
            event !== "expired" &&
            event !== "lost")
        ) {
          return errorResponse(
            400,
            "stellaSessionId and event are required",
            origin,
          );
        }

        const result = await ctx.runMutation(
          internal.billing.recordVoiceRealtimeLeaseEvent,
          {
            ownerId: auth.ownerId,
            stellaSessionId,
            event,
          },
        );

        return jsonResponse(result, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/voice/usage",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use realtime voice.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;
        const identity = auth.identity;

        let body: VoiceUsageBody | null = null;
        try {
          body = (await request.json()) as VoiceUsageBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const parsed = parseVoiceUsageBody(body);
        if (!parsed) {
          return errorResponse(
            400,
            "responseId, model, and usage are required",
            origin,
          );
        }
        let conversationId: Id<"conversations"> | undefined;
        const parsedConversationId = await normalizeConversationId(
          ctx,
          parsed.conversationId,
        );
        if (parsedConversationId) {
          try {
            await requireConversationOwnerAction(ctx, parsedConversationId);
            conversationId = parsedConversationId;
          } catch {
            conversationId = undefined;
          }
        }

        const result = await ctx.runMutation(
          internal.billing.recordVoiceRealtimeUsage,
          {
            ownerId: identity.tokenIdentifier,
            responseId: parsed.responseId,
            model: parsed.model,
            ...(parsed.stellaSessionId
              ? { stellaSessionId: parsed.stellaSessionId }
              : {}),
            ...(conversationId ? { conversationId } : {}),
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            totalTokens: parsed.totalTokens,
            textInputTokens: parsed.textInputTokens,
            textCachedInputTokens: parsed.textCachedInputTokens,
            textOutputTokens: parsed.textOutputTokens,
            audioInputTokens: parsed.audioInputTokens,
            audioCachedInputTokens: parsed.audioCachedInputTokens,
            audioOutputTokens: parsed.audioOutputTokens,
            imageInputTokens: parsed.imageInputTokens,
            imageCachedInputTokens: parsed.imageCachedInputTokens,
            ...(parsed.exactCostMicroCents !== undefined
              ? { exactCostMicroCents: parsed.exactCostMicroCents }
              : {}),
            realtimeAudioSeconds: parsed.realtimeAudioSeconds,
            realtimeTextInputMessages: parsed.realtimeTextInputMessages,
            ...(parsed.sttModel ? { sttModel: parsed.sttModel } : {}),
            sttAudioSeconds: parsed.sttAudioSeconds,
          },
        );

        return jsonResponse(
          {
            recorded: result.recorded,
            duplicate: result.duplicate,
            costMicroCents: result.costMicroCents,
          },
          200,
          origin,
        );
      }),
    ),
  });
};
