import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
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
import { acquireTtsProviderDispatchGuard } from "../lib/tts_dispatch_guard";
import { acquireVoiceProviderDispatchGuard } from "../lib/voice_dispatch_guard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOICE_SESSION_RATE_LIMIT = 10; // per minute
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  ownerGeneration?: string;
  providerDispatchId?: string;
  providerAttemptId?: string;
  authorityLeaseId?: string;
  authorityEpoch?: number;
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

const managedRealtimeProviderUnavailable = (
  provider: VoiceRealtimeProvider,
): boolean => provider !== "openai";

type PreparedVoiceLease =
  | {
      allowed: false;
      message?: string;
      blockedSessionId?: string;
    }
  | {
      allowed: true;
      ownerGeneration: string;
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

const readOpenAiRealtimeCallId = (location: string | null): string | null => {
  if (!location) return null;
  try {
    const parsed = new URL(location, "https://api.openai.com");
    if (parsed.origin !== "https://api.openai.com") return null;
    const pathname = parsed.pathname;
    const parts = pathname.split("/").filter(Boolean);
    if (
      parts.length !== 4 ||
      parts[0] !== "v1" ||
      parts[1] !== "realtime" ||
      parts[2] !== "calls"
    ) {
      return null;
    }
    const callId = parts[3]?.trim();
    return callId && /^[A-Za-z0-9._:-]{1,200}$/u.test(callId)
      ? callId
      : null;
  } catch {
    return null;
  }
};

const cancelUnsettledProviderResponseBody = async (
  response: Response | null,
  settled: boolean,
): Promise<void> => {
  if (settled || !response?.body) return;
  await response.body.cancel().catch(() => undefined);
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
  const ownerGeneration = body?.ownerGeneration?.trim();
  const providerDispatchId = body?.providerDispatchId?.trim();
  const providerAttemptId = body?.providerAttemptId?.trim();
  const authorityLeaseId = body?.authorityLeaseId?.trim();
  const authorityEpoch = body?.authorityEpoch;
  const responseId = body?.responseId?.trim();
  const requestedModel = body?.model?.trim();
  if (
    !ownerGeneration ||
    !providerDispatchId ||
    !providerAttemptId ||
    !authorityLeaseId ||
    !Number.isSafeInteger(authorityEpoch) ||
    (authorityEpoch ?? 0) < 1 ||
    !responseId ||
    !requestedModel
  ) {
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
    ownerGeneration,
    providerDispatchId,
    providerAttemptId,
    authorityLeaseId,
    authorityEpoch: authorityEpoch as number,
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
  // OpenAI does not return usage for /audio/speech. Estimate spoken duration
  // from text length, then use the Realtime audio-output rate of 1 token / 50ms.
  const estimatedSeconds = text.length / 13 / normalizedSpeed;
  return Math.max(1, Math.ceil(estimatedSeconds * 20));
};

// ---------------------------------------------------------------------------
// Read-aloud streaming TTS
// ---------------------------------------------------------------------------

const INWORLD_TTS_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";
const DEFAULT_INWORLD_TTS_MODEL = "inworld-tts-2-flash";
const DEFAULT_INWORLD_TTS_VOICE = "Brooke";
const TTS_MAX_INPUT_CHARS = 8000;
// Read-aloud fires per assistant message; give it more headroom than session
// mints but still cap to prevent accidental loops.
const TTS_RATE_LIMIT = 120;
const TTS_OPERATION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

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
      operationId?: string;
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
    operationId?: unknown;
  },
): Promise<ParsedTtsRequest> => {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) {
    return { ok: false, status: 400, message: "text is required" };
  }
  // Bound the input so a runaway prompt can't blow the provider budget.
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
  const rawOperationId =
    typeof raw.operationId === "string" ? raw.operationId.trim() : "";
  if (
    raw.operationId !== undefined &&
    !TTS_OPERATION_ID_RE.test(rawOperationId)
  ) {
    return { ok: false, status: 400, message: "operationId is invalid" };
  }

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
    ...(rawOperationId ? { operationId: rawOperationId } : {}),
  };
};

const ttsOperationDispatchId = (
  operationId: string | undefined,
  fallbackKind: string,
): string =>
  operationId
    ? `tts-operation:${operationId}`
    : `${fallbackKind}:${crypto.randomUUID()}`;

const decodeBase64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// Inworld's streaming TTS returns newline-delimited JSON: one object per line,
// each carrying a base64 audio chunk under `result.audioContent` (the
// non-streaming endpoint uses a bare `audioContent`). Return the decoded audio
// bytes for a line, or null when the line has no audio.
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

// Cap the per-ticket audio cache so a doc stays well under Convex's 1 MiB
// limit; longer clips simply re-synthesize on a range request (rare for
// read-aloud).
const MAX_TICKET_AUDIO_CACHE_BYTES = 700_000;

type BufferedTtsResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; message: string };

/**
 * Synthesize a full Inworld MP3 into a single buffer.
 *
 * Used for the mobile GET transport: native players (AVPlayer/ExoPlayer)
 * fetch a seekable resource and issue several ranged requests, which a
 * chunked, length-less stream cannot satisfy — so the GET serves a complete,
 * range-capable body instead. Internally this still consumes Inworld's fast
 * streaming endpoint (so the buffer fills quickly); the org key never leaves
 * the action, and spend is metered once to the internal ledger.
 */
const synthesizeInworldTtsBuffered = async (
  ctx: ActionCtx,
  params: TtsSynthesisParams,
  meta: {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    conversationId?: Id<"conversations">;
  },
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
  const dispatch = await acquireTtsProviderDispatchGuard(ctx, {
    ownerId: meta.ownerId,
    ownerGeneration: meta.ownerGeneration,
    dispatchId: meta.dispatchId,
    kind: "buffered",
    usage: {
      provider: "inworld",
      model: params.model,
      voice: params.voice,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
      streaming: false,
      requestChars,
    },
  });
  if (!dispatch) {
    return {
      ok: false,
      status: 409,
      message: "TTS synthesis is already in progress.",
    };
  }

  type CloseOptions = Parameters<typeof dispatch.release>[0];
  let marked = false;
  let closed = false;
  let terminal: CloseOptions | undefined;
  let closePromise: Promise<void> | undefined;
  let observedAudioBytes = 0;
  const close = async (options: CloseOptions): Promise<void> => {
    terminal ??= options;
    if (closed) return;
    if (closePromise) return await closePromise;
    const pending = dispatch.release(terminal);
    closePromise = pending;
    try {
      await pending;
      closed = true;
    } finally {
      if (closePromise === pending) closePromise = undefined;
    }
  };

  try {
    let upstream: Response;
    try {
      await dispatch.markMayHaveDispatched();
      marked = true;
      upstream = await dispatch.race(
        fetch(INWORLD_TTS_STREAM_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${inworldApiKey}`,
            "Content-Type": "application/json",
          },
          body: buildInworldTtsStreamBody(params),
          signal: dispatch.signal,
        }),
      );
    } catch (error) {
      await close({
        outcome: marked ? "may_have_dispatched" : "not_dispatched",
        ...(marked
          ? {
              settlement: {
                status: "interrupted",
                synthesizedChars: 0,
                audioBytes: observedAudioBytes,
                durationMs: Date.now() - startedAt,
              },
              abort: true,
            }
          : {}),
      });
      console.error(
        "[voice/tts/stream] Failed to contact Inworld:",
        (error as Error).message,
      );
      return {
        ok: false,
        status: 502,
        message: "Failed to reach Inworld TTS",
      };
    }
    if (!upstream.ok || !upstream.body) {
      try {
        await dispatch.race(
          upstream.text(),
          async (reason) => await upstream.body?.cancel(reason),
        );
      } catch (error) {
        await close({
          outcome: "may_have_dispatched",
          settlement: {
            status: "interrupted",
            synthesizedChars: 0,
            audioBytes: 0,
            durationMs: Date.now() - startedAt,
          },
          abort: true,
        });
        console.error(
          "[voice/tts/stream] Failed to drain Inworld response:",
          (error as Error).message,
        );
        return {
          ok: false,
          status: 502,
          message: "Inworld TTS response was interrupted",
        };
      }
      console.error("[voice/tts/stream] Inworld TTS failed:", upstream.status);
      await close({
        outcome: "settled",
        settlement: {
          status: "failed",
          synthesizedChars: requestChars,
          audioBytes: 0,
          durationMs: Date.now() - startedAt,
        },
      });
      const status =
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      return { ok: false, status, message: "Inworld TTS failed" };
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parts: Uint8Array[] = [];
    let total = 0;
    const takeLine = (line: string) => {
      const chunk = extractInworldAudioChunk(line);
      if (chunk && chunk.length > 0) {
        parts.push(chunk);
        total += chunk.length;
      }
    };
    try {
      while (true) {
        const { done, value } = await dispatch.race(
          reader.read(),
          async (reason) => await reader.cancel(reason),
        );
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
      await reader.cancel().catch(() => undefined);
      observedAudioBytes = total;
      await close({
        outcome: "may_have_dispatched",
        settlement: {
          status: total > 0 ? "partial" : "interrupted",
          synthesizedChars: total > 0 ? requestChars : 0,
          audioBytes: total,
          durationMs: Date.now() - startedAt,
        },
        abort: true,
      });
      console.error(
        "[voice/tts/stream] Buffered relay failed:",
        (error as Error).message,
      );
      return {
        ok: false,
        status: 502,
        message: "Inworld TTS response was interrupted",
      };
    }

    observedAudioBytes = total;
    const deliveryAllowed = await dispatch.checkAllowed();
    await close({
      outcome: "settled",
      settlement: {
        status: total > 0 ? "completed" : "failed",
        synthesizedChars: requestChars,
        audioBytes: total,
        durationMs: Date.now() - startedAt,
      },
    });
    if (total === 0) {
      return { ok: false, status: 502, message: "Inworld returned no audio" };
    }
    if (!deliveryAllowed) {
      return { ok: false, status: 409, message: "TTS synthesis was canceled" };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { ok: true, bytes };
  } finally {
    if (!closed) {
      await close(
        terminal ?? {
          outcome: marked ? "may_have_dispatched" : "not_dispatched",
          ...(marked
            ? {
                settlement: {
                  status: observedAudioBytes > 0 ? "partial" : "interrupted",
                  synthesizedChars: observedAudioBytes > 0 ? requestChars : 0,
                  audioBytes: observedAudioBytes,
                  durationMs: Date.now() - startedAt,
                },
                abort: true,
              }
            : {}),
        },
      );
    }
  }
};

const AUDIO_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

// Build a live HLS media playlist for a mobile read-aloud session. Uses an
// EVENT playlist (segments are only ever appended) so the player keeps
// re-fetching and playing new segments as the background synthesis produces
// them; `#EXT-X-ENDLIST` is added once synthesis is done. Segment URIs are
// relative, so the player resolves them against this playlist's own path and
// carries the same `Authorization` header to each segment request.
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

// Serve a complete MP3 buffer with byte-range support so native players can
// probe and seek. Answers `Range` with 206 + `Content-Range`; otherwise 200 +
// `Content-Length`. Always advertises `Accept-Ranges: bytes`.
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

/**
 * Proxy Inworld's streaming TTS back to the caller as a single progressive
 * `audio/mpeg` stream. The org Inworld key never leaves this action — the
 * client only ever sees decoded MP3 bytes. Provider spend (including
 * cancellations and partial synthesis) is finalized in the same durable
 * receipt transaction that releases the exact provider lease. This never
 * charges the user or grants plan entitlement. Downstream cancellation
 * promptly cancels the upstream read.
 */
const streamInworldTts = async (
  ctx: ActionCtx,
  origin: string | null,
  params: TtsSynthesisParams,
  meta: {
    ownerId: string;
    ownerGeneration: string;
    conversationId?: Id<"conversations">;
    operationId?: string;
  },
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
  const dispatch = await acquireTtsProviderDispatchGuard(ctx, {
    ownerId: meta.ownerId,
    ownerGeneration: meta.ownerGeneration,
    dispatchId: ttsOperationDispatchId(meta.operationId, "desktop-stream"),
    kind: "desktop_stream",
    usage: {
      provider: "inworld",
      model: params.model,
      voice: params.voice,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
      streaming: true,
      requestChars,
    },
  });
  if (!dispatch) {
    return errorResponse(409, "TTS synthesis is already in progress.", origin);
  }

  type CloseOptions = Parameters<typeof dispatch.release>[0];
  let marked = false;
  let providerEof = false;
  let closed = false;
  let terminal: CloseOptions | undefined;
  let closePromise: Promise<void> | undefined;
  let audioBytes = 0;
  const close = async (options: CloseOptions): Promise<void> => {
    terminal ??= options;
    if (closed) return;
    if (closePromise) return await closePromise;
    const pending = dispatch.release(terminal);
    closePromise = pending;
    try {
      await pending;
      closed = true;
    } finally {
      if (closePromise === pending) closePromise = undefined;
    }
  };
  const closeWithRetry = async (options: CloseOptions): Promise<void> => {
    try {
      await close(options);
    } catch {
      await close(options);
    }
  };
  let upstream: Response;
  try {
    await dispatch.markMayHaveDispatched();
    marked = true;
    upstream = await dispatch.race(
      fetch(INWORLD_TTS_STREAM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${inworldApiKey}`,
          "Content-Type": "application/json",
        },
        body: buildInworldTtsStreamBody(params),
        signal: dispatch.signal,
      }),
    );
  } catch (error) {
    await close({
      outcome: marked ? "may_have_dispatched" : "not_dispatched",
      ...(marked
        ? {
            settlement: {
              status: "interrupted",
              synthesizedChars: 0,
              audioBytes: 0,
              durationMs: Date.now() - startedAt,
            },
            abort: true,
          }
        : {}),
    });
    console.error(
      "[voice/tts/stream] Failed to contact Inworld:",
      (error as Error).message,
    );
    return errorResponse(502, "Failed to reach Inworld TTS", origin);
  }

  if (!upstream.ok || !upstream.body) {
    // Drain + discard the error body so the socket frees; never forward a
    // provider error body to the client.
    try {
      await dispatch.race(
        upstream.text(),
        async (reason) => await upstream.body?.cancel(reason),
      );
    } catch (error) {
      await close({
        outcome: "may_have_dispatched",
        settlement: {
          status: "interrupted",
          synthesizedChars: 0,
          audioBytes: 0,
          durationMs: Date.now() - startedAt,
        },
        abort: true,
      });
      console.error(
        "[voice/tts/stream] Failed to drain Inworld response:",
        (error as Error).message,
      );
      return errorResponse(502, "Inworld TTS response was interrupted", origin);
    }
    console.error("[voice/tts/stream] Inworld TTS failed:", upstream.status);
    await close({
      outcome: "settled",
      settlement: {
        status: "failed",
        synthesizedChars: requestChars,
        audioBytes: 0,
        durationMs: Date.now() - startedAt,
      },
    });
    const status =
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return errorResponse(status, "Inworld TTS failed", origin);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawAudio = false;
  let upstreamDone = false;

  // Pull the next decoded audio chunk out of the NDJSON buffer, reading more
  // from Inworld only as the downstream consumer asks for it (backpressure →
  // bounded buffering).
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
              if (!(await dispatch.checkAllowed())) {
                throw new Error("TTS provider dispatch was canceled.");
              }
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
                if (!(await dispatch.checkAllowed())) {
                  throw new Error("TTS provider dispatch was canceled.");
                }
                audioBytes += chunk.length;
                sawAudio = true;
                controller.enqueue(chunk);
                return;
              }
            }
            const deliveryAllowed = await dispatch.checkAllowed();
            await closeWithRetry({
              outcome: "settled",
              settlement: {
                status: sawAudio ? "completed" : "failed",
                synthesizedChars: requestChars,
                audioBytes,
                durationMs: Date.now() - startedAt,
              },
            });
            if (deliveryAllowed) {
              controller.close();
            } else {
              controller.error(
                new Error("TTS provider dispatch was canceled."),
              );
            }
            return;
          }
          const { done, value } = await dispatch.race(
            reader.read(),
            async (reason) => await reader.cancel(reason),
          );
          if (done) {
            providerEof = true;
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
        await reader.cancel(error).catch(() => undefined);
        await closeWithRetry(
          providerEof
            ? {
                outcome: "settled",
                settlement: {
                  status: sawAudio ? "completed" : "failed",
                  synthesizedChars: requestChars,
                  audioBytes,
                  durationMs: Date.now() - startedAt,
                },
              }
            : {
                outcome: "may_have_dispatched",
                settlement: {
                  status: sawAudio ? "partial" : "interrupted",
                  synthesizedChars: sawAudio ? requestChars : 0,
                  audioBytes,
                  durationMs: Date.now() - startedAt,
                },
                abort: true,
              },
        );
        try {
          controller.error(error);
        } catch {
          // Ignore downstream error races.
        }
      }
    },
    async cancel(reason) {
      // Client went away — stop pulling from Inworld and record the
      // interrupted outcome. (On platforms that drain the response server-side
      // this may resolve as "completed", which is the correct spend since the
      // provider meters the full submitted text.)
      await reader.cancel(reason).catch(() => undefined);
      await closeWithRetry(
        providerEof
          ? {
              outcome: "settled",
              settlement: {
                status: sawAudio ? "completed" : "failed",
                synthesizedChars: requestChars,
                audioBytes,
                durationMs: Date.now() - startedAt,
              },
            }
          : {
              outcome: "may_have_dispatched",
              settlement: {
                status: sawAudio ? "partial" : "interrupted",
                synthesizedChars: sawAudio ? requestChars : 0,
                audioBytes,
                durationMs: Date.now() - startedAt,
              },
              abort: true,
            },
      );
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

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerVoiceRoutes = (http: HttpRouter) => {
  // --- Voice Session ---

  registerCorsOptions(http, [
    "/api/voice/session",
    "/api/voice/usage",
    "/api/voice/lease",
    "/api/voice/openai/sdp",
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
        if (managedRealtimeProviderUnavailable(voiceProvider)) {
          return errorResponse(
            503,
            `Managed ${voiceProvider} realtime voice is unavailable because the provider does not expose a Stella-verifiable call revocation boundary.`,
            origin,
          );
        }

        // Realtime voice synthesizes Stella's replies, so it is a
        // generative-audio surface even though the user also speaks into it:
        // it needs the rate-limit, capability, and managed-usage gates. These
        // used to be three serial mutations (three commits) before the session
        // could be minted; the combined gate runs them in one transaction, in
        // the same precedence (rate -> capability -> usage), so the 429/402 a
        // client sees is unchanged. Every gate is still enforced pre-spend.
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

        const stellaSessionId = createVoiceSessionId(voiceProvider);
        const conversationId = await normalizeConversationId(
          ctx,
          body?.conversationId,
        );

        if (voiceProvider === "xai") {
          // ── xAI Grok Voice Agent path ────────────────────────────────
          // Stella mints an ephemeral token against api.x.ai using the
          // Stella org's XAI_API_KEY. We never return the org key to the
          // client; if the ephemeral endpoint is unavailable we fail
          // closed rather than leaking the key.
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
              ownerGeneration: gate.ownerGeneration,
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
          const dispatch = await acquireVoiceProviderDispatchGuard(ctx, {
            ownerId,
            ownerGeneration: lease.ownerGeneration,
            stellaSessionId: lease.stellaSessionId,
            kind: "xai_client_secret",
          }).catch(() => null);
          if (!dispatch) {
            await ctx
              .runMutation(
                internal.billing.releaseUndispatchedVoiceRealtimeLeaseInternal,
                {
                  ownerId,
                  ownerGeneration: lease.ownerGeneration,
                  stellaSessionId: lease.stellaSessionId,
                  reason: "provider_dispatch_not_acquired",
                },
              )
              .catch(() => false);
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
          let providerTransportSettled = false;
          let providerResponse: Response | null = null;
          try {
            const xaiResponse = (providerResponse = await fetch(
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
                signal: dispatch.signal,
              },
            ));
            const xaiText = await xaiResponse.text();
            providerTransportSettled = true;
            if (!xaiResponse.ok) {
              console.error(
                "[voice/client_secrets] xAI client secret creation failed:",
                xaiResponse.status,
                xaiText,
              );
              await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId,
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
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
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
                reason: "xai_missing_client_secret",
              });
              return errorResponse(
                502,
                "xAI did not return a client secret",
                origin,
              );
            }
            if (!(await dispatch.checkAllowed())) {
              return errorResponse(
                409,
                "The realtime voice session is no longer available.",
                origin,
              );
            }
            const activation = await ctx.runMutation(
              internal.billing.activateVoiceRealtimeLease,
              {
                ownerId,
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
                clientSecretFingerprint: fingerprintString(xaiClientSecret),
                providerExpiresAt: readProviderClientSecretExpiry(xaiData),
              },
            );
            if (!activation.activated) {
              return errorResponse(
                409,
                "The realtime voice session is no longer available.",
                origin,
              );
            }
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
                ownerGeneration: activation.ownerGeneration,
                providerDispatchId: activation.providerDispatchId,
                providerAttemptId: activation.providerAttemptId,
                authorityLeaseId: activation.authorityLeaseId,
                authorityEpoch: activation.authorityEpoch,
                authorityExpiresAt: activation.authorityExpiresAt,
                authorityLeaseDurationMs: activation.authorityLeaseDurationMs,
                authorityPollIntervalMs: activation.authorityPollIntervalMs,
              },
              200,
              origin,
            );
          } catch (error) {
            await ctx
              .runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId,
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
                reason: "xai_exception",
              })
              .catch(() => undefined);
            console.error(
              "[voice/session] Failed to contact xAI:",
              (error as Error).message,
            );
            return errorResponse(
              502,
              "Failed to create xAI voice session",
              origin,
            );
          } finally {
            await cancelUnsettledProviderResponseBody(
              providerResponse,
              providerTransportSettled,
            );
            await dispatch.release({
              outcome: providerTransportSettled ? "settled" : "ambiguous",
              abort: true,
            });
          }
        }

        if (voiceProvider === "inworld") {
          // ── Inworld Realtime path ─────────────────────────────────
          // Inworld doesn't have an ephemeral-token concept — the org
          // API key is the Bearer for the SDP exchange. To avoid
          // leaking it to the renderer, the Stella path returns no
          // client secret; the renderer instead routes the SDP offer
          // through /api/voice/inworld/sdp, which is auth-gated by the
          // user's Convex session.
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
          // TTS model is server-authoritative: honor an explicit override
          // (backward compat) but default here so the renderer's session.update
          // uses the backend's default without needing a client release.
          const inworldTtsModel =
            typeof body.ttsModel === "string" && body.ttsModel.trim().length > 0
              ? body.ttsModel.trim()
              : DEFAULT_INWORLD_TTS_MODEL;
          const lease = (await ctx.runMutation(
            internal.billing.prepareVoiceRealtimeLease,
            {
              ownerId,
              ownerGeneration: gate.ownerGeneration,
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
          // Inworld's WebRTC SDP endpoint expects a complete offer
          // (ICE candidates baked in), so the renderer needs Inworld's
          // STUN/TURN config to gather candidates correctly. Fetch
          // server-side so the org API key never leaves the backend.
          const dispatch = await acquireVoiceProviderDispatchGuard(ctx, {
            ownerId,
            ownerGeneration: lease.ownerGeneration,
            stellaSessionId: lease.stellaSessionId,
            kind: "inworld_ice_servers",
          }).catch(() => null);
          if (!dispatch) {
            await ctx
              .runMutation(
                internal.billing.releaseUndispatchedVoiceRealtimeLeaseInternal,
                {
                  ownerId,
                  ownerGeneration: lease.ownerGeneration,
                  stellaSessionId: lease.stellaSessionId,
                  reason: "provider_dispatch_not_acquired",
                },
              )
              .catch(() => false);
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
          let providerTransportSettled = false;
          let providerResponse: Response | null = null;
          try {
            let iceServers: unknown[] = [];
            try {
              const iceResponse = (providerResponse = await fetch(
                "https://api.inworld.ai/v1/realtime/ice-servers",
                {
                  headers: { Authorization: `Bearer ${inworldApiKey}` },
                  signal: dispatch.signal,
                },
              ));
              const detail = await iceResponse.text();
              providerTransportSettled = true;
              if (iceResponse.ok) {
                const data = JSON.parse(detail) as {
                  ice_servers?: unknown[];
                };
                if (Array.isArray(data.ice_servers)) {
                  iceServers = data.ice_servers;
                }
              } else {
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

            if (!(await dispatch.checkAllowed())) {
              return errorResponse(
                409,
                "The realtime voice session is no longer available.",
                origin,
              );
            }
            const activation = await ctx
              .runMutation(internal.billing.activateVoiceRealtimeLease, {
                ownerId,
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
              })
              .catch(() => ({ activated: false as const }));
            if (!activation.activated) {
              return errorResponse(
                409,
                "The realtime voice session is no longer available.",
                origin,
              );
            }
            return jsonResponse(
              {
                voiceProvider: "inworld" as const,
                transport: "inworld-webrtc" as const,
                // No clientSecret: SDP is proxied through the backend
                // route so the org key never reaches the renderer.
                clientSecret: "",
                model: inworldModel,
                voice: inworldVoice,
                ttsModel: inworldTtsModel,
                iceServers,
                stellaSessionId: lease.stellaSessionId,
                leaseExpiresAt: lease.leaseExpiresAt,
                ownerGeneration: activation.ownerGeneration,
                providerDispatchId: activation.providerDispatchId,
                providerAttemptId: activation.providerAttemptId,
                authorityLeaseId: activation.authorityLeaseId,
                authorityEpoch: activation.authorityEpoch,
                authorityExpiresAt: activation.authorityExpiresAt,
                authorityLeaseDurationMs: activation.authorityLeaseDurationMs,
                authorityPollIntervalMs: activation.authorityPollIntervalMs,
              },
              200,
              origin,
            );
          } finally {
            await cancelUnsettledProviderResponseBody(
              providerResponse,
              providerTransportSettled,
            );
            await dispatch.release({
              outcome: providerTransportSettled ? "settled" : "ambiguous",
              abort: true,
            });
          }
        }

        // ── OpenAI Realtime path (default) ───────────────────────────
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
        if (!managedRealtimeProviderUnavailable("openai")) {
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
          const providerSessionConfigJson = JSON.stringify({
            type: "realtime",
            model,
            instructions,
            reasoning: { effort: "minimal" },
            tools,
            audio: {
              output: { voice },
              input: {
                transcription: { model: "gpt-4o-transcribe" },
                turn_detection: turnDetection,
              },
            },
          });
          const lease = (await ctx.runMutation(
            internal.billing.prepareVoiceRealtimeLease,
            {
              ownerId,
              ownerGeneration: gate.ownerGeneration,
              provider: "openai" as const,
              model,
              voice,
              stellaSessionId,
              providerSessionConfigJson,
              ...(conversationId ? { conversationId } : {}),
            },
          )) as PreparedVoiceLease;
          if (!lease.allowed) {
            return errorResponse(
              429,
              lease.message ??
                "Realtime voice is waiting for the previous session to settle.",
              origin,
            );
          }
          const providerDispatchId = `voice:openai_call:${lease.stellaSessionId}`;
          const providerAttemptId = crypto.randomUUID();
          const activation = await ctx.runMutation(
            internal.billing.issueOpenAiVoiceRealtimeAuthority,
            {
              ownerId,
              ownerGeneration: lease.ownerGeneration,
              stellaSessionId: lease.stellaSessionId,
              providerDispatchId,
              providerAttemptId,
            },
          );
          if (!activation.activated) {
            await ctx
              .runMutation(
                internal.billing.releaseUndispatchedVoiceRealtimeLeaseInternal,
                {
                  ownerId,
                  ownerGeneration: lease.ownerGeneration,
                  stellaSessionId: lease.stellaSessionId,
                  reason: "openai_authority_not_issued",
                },
              )
              .catch(() => false);
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
          return jsonResponse(
            {
              voiceProvider: "openai" as const,
              transport: "openai-webrtc" as const,
              // Compatibility sentinel only. Managed clients must route SDP
              // through Stella and never send this value to OpenAI.
              clientSecret: "stella-server-created-call",
              sdpEndpoint: "/api/voice/openai/sdp",
              model,
              voice,
              stellaSessionId: lease.stellaSessionId,
              leaseExpiresAt: lease.leaseExpiresAt,
              ownerGeneration: activation.ownerGeneration,
              providerDispatchId: activation.providerDispatchId,
              providerAttemptId: activation.providerAttemptId,
              authorityLeaseId: activation.authorityLeaseId,
              authorityEpoch: activation.authorityEpoch,
              authorityExpiresAt: activation.authorityExpiresAt,
              authorityLeaseDurationMs: activation.authorityLeaseDurationMs,
              authorityPollIntervalMs: activation.authorityPollIntervalMs,
            },
            200,
            origin,
          );
        }
        const lease = (await ctx.runMutation(
          internal.billing.prepareVoiceRealtimeLease,
          {
            ownerId,
            ownerGeneration: gate.ownerGeneration,
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

        const dispatch = await acquireVoiceProviderDispatchGuard(ctx, {
          ownerId,
          ownerGeneration: lease.ownerGeneration,
          stellaSessionId: lease.stellaSessionId,
          kind: "openai_client_secret",
        }).catch(() => null);
        if (!dispatch) {
          await ctx
            .runMutation(
              internal.billing.releaseUndispatchedVoiceRealtimeLeaseInternal,
              {
                ownerId,
                ownerGeneration: lease.ownerGeneration,
                stellaSessionId: lease.stellaSessionId,
                reason: "provider_dispatch_not_acquired",
              },
            )
            .catch(() => false);
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }

        // Request ephemeral client secret from OpenAI
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
                // Faster end-of-turn detection profile.
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

        let providerTransportSettled = false;
        let providerResponse: Response | null = null;
        try {
          const openaiResponse = (providerResponse = await fetch(
            "https://api.openai.com/v1/realtime/client_secrets",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(sessionConfig),
              signal: dispatch.signal,
            },
          ));

          const responseText = await openaiResponse.text();
          providerTransportSettled = true;
          if (!openaiResponse.ok) {
            console.error(
              "[voice/client_secrets] OpenAI client secret creation failed:",
              openaiResponse.status,
              responseText,
            );
            await ctx.runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId,
              ownerGeneration: lease.ownerGeneration,
              stellaSessionId: lease.stellaSessionId,
              dispatchId: dispatch.dispatchId,
              attemptId: dispatch.attemptId,
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
              ownerGeneration: lease.ownerGeneration,
              stellaSessionId: lease.stellaSessionId,
              dispatchId: dispatch.dispatchId,
              attemptId: dispatch.attemptId,
              reason: "openai_missing_client_secret",
            });
            return errorResponse(
              502,
              "OpenAI did not return a client secret",
              origin,
            );
          }
          if (!(await dispatch.checkAllowed())) {
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
          const openaiSessionId = readProviderSessionId(openaiData);
          const activation = await ctx.runMutation(
            internal.billing.activateVoiceRealtimeLease,
            {
              ownerId,
              ownerGeneration: lease.ownerGeneration,
              stellaSessionId: lease.stellaSessionId,
              dispatchId: dispatch.dispatchId,
              attemptId: dispatch.attemptId,
              clientSecretFingerprint: fingerprintString(openaiClientSecret),
              ...(openaiSessionId
                ? { providerSessionId: openaiSessionId }
                : {}),
              providerExpiresAt: readProviderClientSecretExpiry(openaiData),
            },
          );
          if (!activation.activated) {
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
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
              ownerGeneration: activation.ownerGeneration,
              providerDispatchId: activation.providerDispatchId,
              providerAttemptId: activation.providerAttemptId,
              authorityLeaseId: activation.authorityLeaseId,
              authorityEpoch: activation.authorityEpoch,
              authorityExpiresAt: activation.authorityExpiresAt,
              authorityLeaseDurationMs: activation.authorityLeaseDurationMs,
              authorityPollIntervalMs: activation.authorityPollIntervalMs,
            },
            200,
            origin,
          );
        } catch (error) {
          await ctx
            .runMutation(internal.billing.failVoiceRealtimeLease, {
              ownerId,
              ownerGeneration: lease.ownerGeneration,
              stellaSessionId: lease.stellaSessionId,
              dispatchId: dispatch.dispatchId,
              attemptId: dispatch.attemptId,
              reason: "openai_exception",
            })
            .catch(() => undefined);
          console.error(
            "[voice/session] Failed to contact OpenAI:",
            (error as Error).message,
          );
          return errorResponse(502, "Failed to create voice session", origin);
        } finally {
          await cancelUnsettledProviderResponseBody(
            providerResponse,
            providerTransportSettled,
          );
          await dispatch.release({
            outcome: providerTransportSettled ? "settled" : "ambiguous",
            abort: true,
          });
        }
      }),
    ),
  });

  // ── Managed OpenAI server-created WebRTC call ───────────────────
  http.route({
    path: "/api/voice/openai/sdp",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use realtime voice.",
          realm: "stella-voice",
        });
        if (!auth.ok) return auth.response;
        const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
        if (!openaiApiKey) {
          return errorResponse(503, "Voice sessions are not configured yet.", origin);
        }
        const stellaSessionId =
          request.headers.get("x-stella-voice-session-id")?.trim() ?? "";
        const ownerGeneration =
          request.headers.get("x-stella-owner-generation")?.trim() ?? "";
        const providerDispatchId =
          request.headers.get("x-stella-provider-dispatch-id")?.trim() ?? "";
        const providerAttemptId =
          request.headers.get("x-stella-provider-attempt-id")?.trim() ?? "";
        if (
          !stellaSessionId ||
          !ownerGeneration ||
          !providerDispatchId ||
          !providerAttemptId
        ) {
          return errorResponse(400, "The exact voice authority tuple is required.", origin);
        }
        const sdpOffer = await request.text();
        if (sdpOffer.length < 10 || sdpOffer.length > 1_000_000) {
          return errorResponse(400, "Missing or invalid SDP offer.", origin);
        }
        const fence = await ctx.runQuery(
          internal.billing.getOpenAiVoiceCallFence,
          { ownerId: auth.ownerId, stellaSessionId },
        );
        if (
          !fence ||
          fence.ownerGeneration !== ownerGeneration ||
          fence.providerDispatchId !== providerDispatchId ||
          fence.providerAttemptId !== providerAttemptId ||
          fence.status !== "active" ||
          fence.authorityState !== "active" ||
          fence.usageDisposition !== "pending" ||
          fence.providerCallId !== null
        ) {
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }
        const dispatch = await acquireVoiceProviderDispatchGuard(ctx, {
          ownerId: auth.ownerId,
          ownerGeneration,
          stellaSessionId,
          kind: "openai_call",
          attemptId: providerAttemptId,
        }).catch(() => null);
        if (!dispatch || dispatch.dispatchId !== providerDispatchId) {
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }

        let providerOutcomeKnown = false;
        let providerResponse: Response | null = null;
        let boundCallId: string | null = null;
        try {
          const started = await ctx.runMutation(
            internal.billing.markOpenAiVoiceProviderCallStarted,
            {
              ownerId: auth.ownerId,
              ownerGeneration,
              stellaSessionId,
              providerDispatchId,
              providerAttemptId,
            },
          );
          if (!started) {
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
              origin,
            );
          }
          const form = new FormData();
          form.set("sdp", sdpOffer);
          form.set("session", fence.providerSessionConfigJson);
          const openaiResponse = (providerResponse = await fetch(
            "https://api.openai.com/v1/realtime/calls",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "X-Client-Request-Id": providerAttemptId,
              },
              body: form,
              signal: dispatch.signal,
            },
          ));
          const providerCallId = readOpenAiRealtimeCallId(
            openaiResponse.headers.get("location"),
          );
          providerOutcomeKnown = !openaiResponse.ok || providerCallId !== null;
          if (!openaiResponse.ok) {
            await ctx.runMutation(
              internal.billing.markOpenAiVoiceProviderCallNotCreated,
              {
                ownerId: auth.ownerId,
                ownerGeneration,
                stellaSessionId,
                providerDispatchId,
                providerAttemptId,
                providerStatus: openaiResponse.status,
              },
            );
            const detail = await openaiResponse.text().catch(() => "");
            console.error(
              "[voice/openai/sdp] OpenAI call creation failed:",
              openaiResponse.status,
              detail,
            );
            return errorResponse(
              openaiResponse.status,
              "Failed to create the OpenAI voice call.",
              origin,
            );
          }
          if (!providerCallId) {
            await openaiResponse.body?.cancel().catch(() => undefined);
            return errorResponse(
              502,
              "OpenAI did not return a revocable call locator.",
              origin,
            );
          }
          boundCallId = providerCallId;
          const binding = await ctx.runMutation(
            internal.billing.bindOpenAiVoiceProviderCall,
            {
              ownerId: auth.ownerId,
              ownerGeneration,
              stellaSessionId,
              providerDispatchId,
              providerAttemptId,
              providerCallId,
            },
          );
          if (!binding.bound || !binding.deliveryAllowed) {
            await openaiResponse.body?.cancel().catch(() => undefined);
            return errorResponse(
              409,
              "The realtime voice session was revoked before delivery.",
              origin,
            );
          }
          const sdpAnswer = await openaiResponse.text();
          if (!(await dispatch.checkAllowed())) {
            await ctx.runMutation(
              internal.billing.requestOpenAiVoiceHangupInternal,
              {
                ownerId: auth.ownerId,
                ownerGeneration,
                stellaSessionId,
                providerCallId,
                reason: "provider_response_fenced_after_bind",
              },
            );
            return errorResponse(
              409,
              "The realtime voice session was revoked before delivery.",
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
          if (boundCallId) {
            await ctx
              .runMutation(internal.billing.requestOpenAiVoiceHangupInternal, {
                ownerId: auth.ownerId,
                ownerGeneration,
                stellaSessionId,
                providerCallId: boundCallId,
                reason: "openai_sdp_response_failure",
              })
              .catch(() => false);
          }
          console.error(
            "[voice/openai/sdp] Failed to create OpenAI call:",
            error instanceof Error ? error.message : String(error),
          );
          return errorResponse(502, "Failed to create the OpenAI voice call.", origin);
        } finally {
          await cancelUnsettledProviderResponseBody(
            providerResponse,
            providerOutcomeKnown,
          );
          await dispatch.release({
            outcome: providerOutcomeKnown ? "settled" : "ambiguous",
            abort: true,
          });
        }
      }),
    ),
  });

  // ── Inworld SDP proxy ────────────────────────────────────────────
  // The renderer POSTs its WebRTC SDP offer here (Content-Type:
  // application/sdp). We forward to Inworld using the org API key and
  // return the SDP answer text. This keeps the org Inworld key
  // server-side — the renderer never receives it.
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

        if (managedRealtimeProviderUnavailable("inworld")) {
          return errorResponse(
            503,
            "Managed Inworld realtime voice is unavailable because Inworld does not expose a Stella-verifiable call revocation boundary.",
            origin,
          );
        }

        // Same generative-audio gauntlet as /api/voice/session (rate ->
        // capability -> usage), collapsed into one transaction/commit while
        // keeping identical enforcement and response precedence.
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
        if (!stellaSessionId) {
          return errorResponse(
            400,
            "x-stella-voice-session-id is required",
            origin,
          );
        }

        const leaseFence = await ctx.runQuery(
          internal.billing.getVoiceRealtimeLeaseFence,
          { ownerId: auth.ownerId, stellaSessionId },
        );
        if (
          !leaseFence ||
          leaseFence.provider !== "inworld" ||
          leaseFence.ownerGeneration !== gate.ownerGeneration
        ) {
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }
        const dispatch = await acquireVoiceProviderDispatchGuard(ctx, {
          ownerId: auth.ownerId,
          ownerGeneration: leaseFence.ownerGeneration,
          stellaSessionId,
          kind: "inworld_sdp",
        }).catch(() => null);
        if (!dispatch) {
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }

        let providerTransportSettled = false;
        let providerResponse: Response | null = null;
        try {
          const inworldResponse = (providerResponse = await fetch(
            "https://api.inworld.ai/v1/realtime/calls",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${inworldApiKey}`,
                "Content-Type": "application/sdp",
              },
              body: sdpOffer,
              signal: dispatch.signal,
            },
          ));
          const sdpAnswer = await inworldResponse.text();
          providerTransportSettled = true;
          if (!inworldResponse.ok) {
            if (stellaSessionId) {
              await ctx
                .runMutation(internal.billing.failVoiceRealtimeLease, {
                  ownerId: auth.ownerId,
                  ownerGeneration: leaseFence.ownerGeneration,
                  stellaSessionId,
                  dispatchId: dispatch.dispatchId,
                  attemptId: dispatch.attemptId,
                  reason: `inworld_sdp_${inworldResponse.status}`,
                })
                .catch(() => undefined);
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
          // The provider call may outlive a reset, migration fence, or newer
          // lease. Never publish the SDP answer unless the exact admitted
          // generation and active lease still own the response.
          const publishAllowed = await dispatch.checkAllowed();
          if (!publishAllowed) {
            return errorResponse(
              409,
              "The realtime voice session is no longer available.",
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
            await ctx
              .runMutation(internal.billing.failVoiceRealtimeLease, {
                ownerId: auth.ownerId,
                ownerGeneration: leaseFence.ownerGeneration,
                stellaSessionId,
                dispatchId: dispatch.dispatchId,
                attemptId: dispatch.attemptId,
                reason: "inworld_sdp_exception",
              })
              .catch(() => undefined);
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
        } finally {
          await cancelUnsettledProviderResponseBody(
            providerResponse,
            providerTransportSettled,
          );
          await dispatch.release({
            outcome: providerTransportSettled ? "settled" : "ambiguous",
            abort: true,
          });
        }
      }),
    ),
  });

  // ── Read-aloud streaming TTS (desktop) ───────────────────────────
  // Progressive text-to-speech: proxies Inworld's streaming synthesis back
  // as a single `audio/mpeg` stream so playback can begin before the whole
  // reply is synthesized. Read-aloud is FREE on every plan, so — unlike
  // realtime voice — there is deliberately no capability or managed-usage
  // gate here; auth, rate limiting, bounded input, and safe provider-error
  // handling remain. Provider spend is tracked internally only.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

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
          ownerGeneration,
          ...(parsed.conversationId
            ? { conversationId: parsed.conversationId }
            : {}),
          ...(parsed.operationId ? { operationId: parsed.operationId } : {}),
        });
      }),
    ),
  });

  // ── Read-aloud streaming TTS: prepare a mobile HLS session ────────
  // Mobile's native player can only progressively stream from a GET URL, but
  // the assistant text is too long for a query string. The client POSTs the
  // text here and gets back a short-lived opaque ticket; it then plays the live
  // HLS playlist at `/api/voice/tts/stream/hls/<ticket>/playlist.m3u8`. This
  // schedules ONE background synthesis that streams Inworld and appends MP3
  // segments as they are produced, so audio begins while Inworld is still
  // generating. The text never appears in a URL, log, or client-visible store.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

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
          ownerGeneration,
          providerDispatchId: ttsOperationDispatchId(parsed.operationId, "hls"),
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

  // ── Read-aloud streaming TTS: serve a ticketed clip (mobile GET) ──
  // Registered as a prefix so the request URL can carry a `.mp3` suffix (which
  // nudges native players to treat the response as an MP3) without a dot in the
  // registered route path. Native players (AVPlayer/ExoPlayer) fetch a seekable
  // resource and issue several ranged requests per playback, so — unlike the
  // desktop POST stream — this serves a complete, `Range`-capable MP3 from a
  // reusable, owner-bound ticket. The first request synthesizes and caches the
  // audio; the player's follow-up range requests are served from that cache.
  // Auth is still enforced (Bearer header). GET has no side effects the browser
  // needs to preflight, so there is no CORS OPTIONS route for this path.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

        const ticket = new URL(request.url).searchParams.get("ticket")?.trim();
        if (!ticket) {
          return errorResponse(400, "ticket is required", origin);
        }

        const attemptId = crypto.randomUUID();
        const consumed = await ctx.runMutation(internal.tts_stream.readTicket, {
          ticket,
          ownerId: auth.ownerId,
          ownerGeneration,
          attemptId,
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

        // Serve the cached clip if a prior request already synthesized it.
        if (consumed.state === "cached" && consumed.audio) {
          try {
            return serveAudioWithRange(
              decodeBase64ToBytes(consumed.audio),
              rangeHeader,
              origin,
            );
          } catch {
            // A cached row has no live claim. Never fall through to a second
            // provider dispatch; leave the terminal ticket for bounded TTL
            // cleanup and make the client prepare a fresh one.
            return errorResponse(500, "Cached audio is invalid", origin);
          }
        }
        if (consumed.state === "busy") {
          return errorResponse(
            409,
            "Audio synthesis is already in progress",
            origin,
          );
        }
        if (consumed.state === "unavailable") {
          return errorResponse(
            410,
            "Use the HLS stream for this ticket",
            origin,
          );
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
            ownerGeneration: consumed.ownerGeneration,
            dispatchId: `buffered:${ticket}`,
            ...(consumed.conversationId
              ? { conversationId: consumed.conversationId }
              : {}),
          },
        );
        if (!result.ok) {
          await ctx
            .runMutation(internal.tts_stream.failTicketAudio, {
              ticket,
              ownerId: auth.ownerId,
              ownerGeneration: consumed.ownerGeneration,
              attemptId,
            })
            .catch(() => undefined);
          return errorResponse(result.status, result.message, origin);
        }
        const cacheable =
          result.bytes.byteLength <= MAX_TICKET_AUDIO_CACHE_BYTES;
        await ctx.runMutation(internal.tts_stream.finishTicketAudio, {
          ticket,
          ownerId: auth.ownerId,
          ownerGeneration: consumed.ownerGeneration,
          attemptId,
          ...(cacheable ? { audio: bytesToBase64(result.bytes) } : {}),
          tooLarge: !cacheable,
        });
        return serveAudioWithRange(result.bytes, rangeHeader, origin);
      }),
    ),
  });

  // ── Read-aloud streaming TTS: mobile HLS transport (playlist + segments) ──
  // The mobile player streams a live HLS playlist so audio begins while Inworld
  // is still generating. One prefix serves both the growing `playlist.m3u8`
  // (built from the ticket's manifest — no audio loaded) and each `<seq>.mp3`
  // packed-audio segment. Auth is enforced per request (Bearer header, which
  // native players attach to every playlist + segment fetch); segments are
  // owner-bound to the ticket. Registered as a prefix so the `.m3u8`/`.mp3`
  // suffixes reach native players without a dot in the route path.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

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
            {
              ticket,
              ownerId: auth.ownerId,
              ownerGeneration,
              nowMs: Date.now(),
            },
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
            ownerGeneration,
            seq,
            nowMs: Date.now(),
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

  // ── Read-aloud streaming TTS: stop beacon (mobile) ────────────────
  // Posted when the user stops read-aloud. Sets a cooperative cancel flag the
  // background synthesis polls so provider spend ends early and is metered as
  // interrupted. Best-effort: a missing/expired ticket is a no-op.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

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
          ownerGeneration,
          nowMs: Date.now(),
        });
        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  // ── Read-aloud TTS (non-streamed fallback) ───────────────────────
  // One-shot text-to-speech for the renderer's "read assistant replies
  // aloud" toggle. Returns binary audio (mp3 for OpenAI, wav for
  // Inworld) so the renderer can decode + play through Web Audio API
  // without an extra JSON unwrap. Kept as the graceful fallback for when
  // true streaming is unavailable (e.g. the OpenAI voice family, or a
  // client that cannot consume a progressive stream). Free on every plan.
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
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, identity.tokenIdentifier);

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "voice_tts",
            // Read-aloud fires per assistant message; give it more
            // headroom than session mints but still cap to prevent
            // accidental loops.
            key: identity.tokenIdentifier,
            limit: 120,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        // Read-aloud is free on every plan: no capability or managed-usage
        // gate here (that would restrict it to paid plans). Auth + rate
        // limiting above remain; provider spend is tracked internally below.

        type TtsBody = {
          text?: string;
          voice?: string;
          model?: string;
          conversationId?: string;
          voiceProvider?: "openai" | "inworld";
          speed?: number;
          operationId?: string;
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
        const rawOperationId = body?.operationId?.trim();
        if (
          body?.operationId !== undefined &&
          (!rawOperationId || !TTS_OPERATION_ID_RE.test(rawOperationId))
        ) {
          return errorResponse(400, "operationId is invalid", origin);
        }
        // Cap at ~8k chars so a runaway prompt can't blow the budget.
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
          const startedAt = Date.now();
          const dispatch = await acquireTtsProviderDispatchGuard(ctx, {
            ownerId: identity.tokenIdentifier,
            ownerGeneration,
            dispatchId: ttsOperationDispatchId(
              rawOperationId,
              "oneshot-inworld",
            ),
            kind: "oneshot_inworld",
            usage: {
              provider: "inworld",
              model: modelId,
              voice: voiceId,
              ...(conversationId ? { conversationId } : {}),
              streaming: false,
              requestChars: truncated.length,
            },
          });
          if (!dispatch) {
            return errorResponse(
              409,
              "TTS synthesis is already in progress.",
              origin,
            );
          }
          type CloseOptions = Parameters<typeof dispatch.release>[0];
          let marked = false;
          let bodyConsumed = false;
          let closed = false;
          let terminal: CloseOptions | undefined;
          let closePromise: Promise<void> | undefined;
          const close = async (options: CloseOptions): Promise<void> => {
            terminal ??= options;
            if (closed) return;
            if (closePromise) return await closePromise;
            const pending = dispatch.release(terminal);
            closePromise = pending;
            try {
              await pending;
              closed = true;
            } finally {
              if (closePromise === pending) closePromise = undefined;
            }
          };
          try {
            let inworldResponse: Response;
            try {
              await dispatch.markMayHaveDispatched();
              marked = true;
              inworldResponse = await dispatch.race(
                fetch("https://api.inworld.ai/tts/v1/voice", {
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
                  signal: dispatch.signal,
                }),
              );
            } catch (error) {
              await close({
                outcome: marked ? "may_have_dispatched" : "not_dispatched",
                ...(marked
                  ? {
                      settlement: {
                        status: "interrupted",
                        synthesizedChars: 0,
                        audioBytes: 0,
                        durationMs: Date.now() - startedAt,
                      },
                      abort: true,
                    }
                  : {}),
              });
              console.error(
                "[voice/tts] Failed to contact Inworld:",
                (error as Error).message,
              );
              return errorResponse(502, "Failed to reach Inworld TTS", origin);
            }
            let raw: string;
            try {
              raw = await dispatch.race(
                inworldResponse.text(),
                async (reason) => await inworldResponse.body?.cancel(reason),
              );
              bodyConsumed = true;
            } catch (error) {
              await close({
                outcome: "may_have_dispatched",
                settlement: {
                  status: "interrupted",
                  synthesizedChars: 0,
                  audioBytes: 0,
                  durationMs: Date.now() - startedAt,
                },
                abort: true,
              });
              console.error(
                "[voice/tts] Inworld response read failed:",
                (error as Error).message,
              );
              return errorResponse(
                502,
                "Inworld TTS response was interrupted",
                origin,
              );
            }
            if (!inworldResponse.ok) {
              console.error(
                "[voice/tts] Inworld TTS failed:",
                inworldResponse.status,
                raw,
              );
              await close({
                outcome: "settled",
                settlement: {
                  status: "failed",
                  synthesizedChars: truncated.length,
                  audioBytes: 0,
                  durationMs: Date.now() - startedAt,
                },
              });
              return errorResponse(
                inworldResponse.status,
                "Inworld TTS failed",
                origin,
              );
            }
            // Inworld returns JSON { audioContent: <base64 wav> }.
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
              await close({
                outcome: "settled",
                settlement: {
                  status: "failed",
                  synthesizedChars: truncated.length,
                  audioBytes: 0,
                  durationMs: Date.now() - startedAt,
                },
              });
              return errorResponse(502, "Inworld returned no audio", origin);
            }
            // Decode base64 → bytes for the response body.
            try {
              const bytes = Uint8Array.from(atob(audioBase64), (c) =>
                c.charCodeAt(0),
              );
              const deliveryAllowed = await dispatch.checkAllowed();
              await close({
                outcome: "settled",
                settlement: {
                  status: "completed",
                  synthesizedChars: truncated.length,
                  audioBytes: bytes.byteLength,
                  durationMs: Date.now() - startedAt,
                },
              });
              if (!deliveryAllowed) {
                return errorResponse(409, "TTS synthesis was canceled", origin);
              }
              return withCors(
                new Response(bytes, {
                  status: 200,
                  headers: { "Content-Type": "audio/wav" },
                }),
                origin,
              );
            } catch (error) {
              if (terminal) throw error;
              await close({
                outcome: "settled",
                settlement: {
                  status: "failed",
                  synthesizedChars: truncated.length,
                  audioBytes: 0,
                  durationMs: Date.now() - startedAt,
                },
              });
              return errorResponse(
                502,
                "Inworld returned invalid audio",
                origin,
              );
            }
          } finally {
            if (!closed) {
              await close(
                terminal ??
                  (bodyConsumed
                    ? {
                        outcome: "settled",
                        settlement: {
                          status: "failed",
                          synthesizedChars: truncated.length,
                          audioBytes: 0,
                          durationMs: Date.now() - startedAt,
                        },
                      }
                    : {
                        outcome: marked
                          ? "may_have_dispatched"
                          : "not_dispatched",
                        ...(marked
                          ? {
                              settlement: {
                                status: "interrupted",
                                synthesizedChars: 0,
                                audioBytes: 0,
                                durationMs: Date.now() - startedAt,
                              },
                              abort: true,
                            }
                          : {}),
                      }),
              );
            }
          }
        }

        // ── OpenAI TTS (default) ─────────────────────────────────────
        const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
        if (!openaiApiKey) {
          return errorResponse(503, "Voice TTS is not configured yet.", origin);
        }
        const ttsVoice = body?.voice?.trim() || "marin";
        const ttsModel = body?.model?.trim() || "gpt-4o-mini-tts";
        const textInputTokens = estimateTextTokensFromChars(truncated);
        const audioOutputTokens = estimateTtsAudioOutputTokens(
          truncated,
          body?.speed,
        );
        const startedAt = Date.now();
        const dispatch = await acquireTtsProviderDispatchGuard(ctx, {
          ownerId: identity.tokenIdentifier,
          ownerGeneration,
          dispatchId: ttsOperationDispatchId(rawOperationId, "oneshot-openai"),
          kind: "oneshot_openai",
          usage: {
            provider: "openai",
            model: ttsModel,
            voice: ttsVoice,
            ...(conversationId ? { conversationId } : {}),
            streaming: false,
            requestChars: truncated.length,
            textInputTokens,
            audioOutputTokens,
          },
        });
        if (!dispatch) {
          return errorResponse(
            409,
            "TTS synthesis is already in progress.",
            origin,
          );
        }
        type CloseOptions = Parameters<typeof dispatch.release>[0];
        let marked = false;
        let bodyConsumed = false;
        let closed = false;
        let terminal: CloseOptions | undefined;
        let closePromise: Promise<void> | undefined;
        const close = async (options: CloseOptions): Promise<void> => {
          terminal ??= options;
          if (closed) return;
          if (closePromise) return await closePromise;
          const pending = dispatch.release(terminal);
          closePromise = pending;
          try {
            await pending;
            closed = true;
          } finally {
            if (closePromise === pending) closePromise = undefined;
          }
        };
        try {
          let openaiResponse: Response;
          try {
            await dispatch.markMayHaveDispatched();
            marked = true;
            openaiResponse = await dispatch.race(
              fetch("https://api.openai.com/v1/audio/speech", {
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
                signal: dispatch.signal,
              }),
            );
          } catch (error) {
            await close({
              outcome: marked ? "may_have_dispatched" : "not_dispatched",
              ...(marked
                ? {
                    settlement: {
                      status: "interrupted",
                      synthesizedChars: 0,
                      audioBytes: 0,
                      textInputTokens,
                      audioOutputTokens,
                      durationMs: Date.now() - startedAt,
                    },
                    abort: true,
                  }
                : {}),
            });
            console.error(
              "[voice/tts] Failed to contact OpenAI:",
              (error as Error).message,
            );
            return errorResponse(502, "Failed to reach OpenAI TTS", origin);
          }
          if (!openaiResponse.ok) {
            let detail: string;
            try {
              detail = await dispatch.race(
                openaiResponse.text(),
                async (reason) => await openaiResponse.body?.cancel(reason),
              );
              bodyConsumed = true;
            } catch (error) {
              await close({
                outcome: "may_have_dispatched",
                settlement: {
                  status: "interrupted",
                  synthesizedChars: 0,
                  audioBytes: 0,
                  textInputTokens,
                  audioOutputTokens,
                  durationMs: Date.now() - startedAt,
                },
                abort: true,
              });
              console.error(
                "[voice/tts] OpenAI response read failed:",
                (error as Error).message,
              );
              return errorResponse(
                502,
                "OpenAI TTS response was interrupted",
                origin,
              );
            }
            console.error(
              "[voice/tts] OpenAI TTS failed:",
              openaiResponse.status,
              detail,
            );
            await close({
              outcome: "settled",
              settlement: {
                status: "failed",
                synthesizedChars: truncated.length,
                audioBytes: 0,
                textInputTokens,
                audioOutputTokens,
                durationMs: Date.now() - startedAt,
              },
            });
            return errorResponse(
              openaiResponse.status,
              "OpenAI TTS failed",
              origin,
            );
          }
          try {
            const audio = await dispatch.race(
              openaiResponse.arrayBuffer(),
              async (reason) => await openaiResponse.body?.cancel(reason),
            );
            bodyConsumed = true;
            const deliveryAllowed = await dispatch.checkAllowed();
            await close({
              outcome: "settled",
              settlement: {
                status: "completed",
                synthesizedChars: truncated.length,
                audioBytes: audio.byteLength,
                textInputTokens,
                audioOutputTokens,
                durationMs: Date.now() - startedAt,
              },
            });
            if (!deliveryAllowed) {
              return errorResponse(409, "TTS synthesis was canceled", origin);
            }
            return withCors(
              new Response(audio, {
                status: 200,
                headers: { "Content-Type": "audio/mpeg" },
              }),
              origin,
            );
          } catch (error) {
            if (terminal) throw error;
            await close({
              outcome: "may_have_dispatched",
              settlement: {
                status: "interrupted",
                synthesizedChars: 0,
                audioBytes: 0,
                textInputTokens,
                audioOutputTokens,
                durationMs: Date.now() - startedAt,
              },
              abort: true,
            });
            console.error(
              "[voice/tts] OpenAI response read failed:",
              (error as Error).message,
            );
            return errorResponse(
              502,
              "OpenAI TTS response was interrupted",
              origin,
            );
          }
        } finally {
          if (!closed) {
            await close(
              terminal ??
                (bodyConsumed
                  ? {
                      outcome: "settled",
                      settlement: {
                        status: "failed",
                        synthesizedChars: truncated.length,
                        audioBytes: 0,
                        textInputTokens,
                        audioOutputTokens,
                        durationMs: Date.now() - startedAt,
                      },
                    }
                  : {
                      outcome: marked
                        ? "may_have_dispatched"
                        : "not_dispatched",
                      ...(marked
                        ? {
                            settlement: {
                              status: "interrupted",
                              synthesizedChars: 0,
                              audioBytes: 0,
                              textInputTokens,
                              audioOutputTokens,
                              durationMs: Date.now() - startedAt,
                            },
                            abort: true,
                          }
                        : {}),
                    }),
            );
          }
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
          authorityLeaseId?: string;
          authorityEpoch?: number;
          event?: "heartbeat" | "ended" | "expired" | "lost" | "cancel_ack";
          usageDisposition?: "drained" | "unresolved";
          transportClosedAt?: number;
        };
        let body: VoiceLeaseBody | null = null;
        try {
          body = (await request.json()) as VoiceLeaseBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const stellaSessionId = body?.stellaSessionId?.trim();
        const authorityLeaseId = body?.authorityLeaseId?.trim();
        const authorityEpoch = body?.authorityEpoch;
        const event = body?.event;
        const usageDisposition = body?.usageDisposition;
        const transportClosedAt = body?.transportClosedAt;
        if (
          !stellaSessionId ||
          !authorityLeaseId ||
          !Number.isSafeInteger(authorityEpoch) ||
          (authorityEpoch ?? 0) < 1 ||
          (event !== "heartbeat" &&
            event !== "ended" &&
            event !== "expired" &&
            event !== "lost" &&
            event !== "cancel_ack") ||
          (usageDisposition !== undefined &&
            usageDisposition !== "drained" &&
            usageDisposition !== "unresolved") ||
          (transportClosedAt !== undefined &&
            !Number.isFinite(transportClosedAt)) ||
          (event === "heartbeat" &&
            (usageDisposition !== undefined || transportClosedAt !== undefined))
        ) {
          return errorResponse(
            400,
            "stellaSessionId, authorityLeaseId, authorityEpoch, and event are required",
            origin,
          );
        }

        const leaseFence = await ctx.runQuery(
          internal.billing.getVoiceRealtimeLeaseFence,
          { ownerId: auth.ownerId, stellaSessionId },
        );
        if (
          !leaseFence ||
          !leaseFence.providerDispatchId ||
          !leaseFence.providerAttemptId ||
          !leaseFence.authorityLeaseId ||
          leaseFence.authorityEpoch === null
        ) {
          return errorResponse(
            409,
            "The realtime voice session is no longer available.",
            origin,
          );
        }

        const result = await ctx.runMutation(
          internal.billing.recordVoiceRealtimeLeaseEvent,
          {
            ownerId: auth.ownerId,
            ownerGeneration: leaseFence.ownerGeneration,
            stellaSessionId,
            authorityLeaseId,
            authorityEpoch: authorityEpoch as number,
            event,
            ...(usageDisposition ? { usageDisposition } : {}),
            ...(transportClosedAt !== undefined ? { transportClosedAt } : {}),
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
        if (!parsed || !parsed.stellaSessionId) {
          return errorResponse(
            400,
            "the exact voice authority tuple, responseId, model, stellaSessionId, and usage are required",
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
            ownerGeneration: parsed.ownerGeneration,
            providerDispatchId: parsed.providerDispatchId,
            providerAttemptId: parsed.providerAttemptId,
            authorityLeaseId: parsed.authorityLeaseId,
            authorityEpoch: parsed.authorityEpoch,
            responseId: parsed.responseId,
            model: parsed.model,
            stellaSessionId: parsed.stellaSessionId,
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
