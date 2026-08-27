/**
 * Dictation transcription proxy.
 *
 * The renderer captures microphone audio locally, WAV-encodes it (LINEAR16
 * PCM, 16 kHz mono), and POSTs the base64'd container here on stop. This
 * route forwards the request to xAI Grok STT (`POST https://api.x.ai/v1/stt`,
 * one-shot multipart upload) so `XAI_API_KEY` never leaves the backend.
 * Direct xAI beat the previous OpenRouter Nemotron path on latency
 * (~245-760ms model time vs ~1.1s median).
 *
 * Provider is env-selectable for fast rollback without a code deploy:
 * `DICTATION_STT_PROVIDER=openrouter` restores the OpenRouter one-shot path
 * (`OPENROUTER_API_KEY`), `DICTATION_STT_PROVIDER=inworld` restores
 * Inworld's sync STT endpoint (`INWORLD_API_KEY`, Basic auth). Default is
 * `xai`. `DICTATION_STT_MODEL` overrides the model id for the active
 * provider (for xAI it only relabels usage metering — the REST STT endpoint
 * has a single model and takes no model parameter).
 *
 * We deliberately stay on sync HTTP: browser WebSockets cannot set the
 * Authorization headers these providers require, and one-shot latency is
 * already low enough for stop-to-text dictation.
 *
 * Billing: Grok STT REST is $0.10/hr ($0.0000278/s). We require sign-in,
 * gate on the user's managed-usage limit, then meter the response's
 * `duration` seconds at the list rate and log it through `logManagedUsage`
 * with `costMicroCents` so it counts against the user's plan windows. The
 * OpenRouter rollback meters `usage.cost`/`usage.seconds` as before, and
 * the Inworld rollback still meters `transcribedAudioMs` at $0.28/hr.
 */
import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import {
  errorResponse,
  jsonResponse,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { runManagedGate } from "../lib/gate_and_meter";
import { createManagedUsageDispatchGuard } from "../lib/managed_billing";
import { runManagedDispatchAttempt } from "../runtime_ai/managed";
import { dollarsToMicroCents } from "../lib/billing_money";
import { MANAGED_USAGE_BILLING_KIND } from "../lib/managed_dispatch";
import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKey,
} from "../lib/managed_gateway";

const DICTATION_RATE_LIMIT = 30; // per minute
const DICTATION_RATE_WINDOW_MS = 60_000;

const INWORLD_TRANSCRIBE_URL = "https://api.inworld.ai/stt/v1/transcribe";
const INWORLD_DEFAULT_MODEL = "inworld/inworld-stt-1";
const INWORLD_DEFAULT_LANGUAGE = "en-US";
// Inworld STT pricing as of 2026-05. Kept for the env rollback path.
const INWORLD_USD_PER_HOUR = 0.28;
const INWORLD_USD_PER_MS = INWORLD_USD_PER_HOUR / (60 * 60 * 1000);

const OPENROUTER_TRANSCRIPTIONS_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENROUTER_DICTATION_MODEL =
  "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b";
const OPENROUTER_USD_PER_SECOND = 0.000003;

const XAI_TRANSCRIBE_URL = "https://api.x.ai/v1/stt";
// xAI's REST STT endpoint has a single model (the OpenRouter alias was
// `x-ai/grok-stt-1.0`); this id is only used to label usage metering.
export const XAI_DICTATION_MODEL = "grok-stt-1.0";
// Grok STT REST list price as of 2026-08 (docs.x.ai): $0.10/hr.
const XAI_USD_PER_HOUR = 0.1;
const XAI_USD_PER_SECOND = XAI_USD_PER_HOUR / 3600;

// Convex HTTP actions cap request bodies at ~20MB; base64 inflates by 33%
// so this keeps a comfortable margin for the JSON envelope.
const MAX_AUDIO_BASE64_BYTES = 14 * 1024 * 1024;

type TranscribeRequestBody = {
  audioBase64?: string;
  /**
   * Container/encoding hint. Desktop WAV uploads send AUTO_DETECT or
   * LINEAR16; OpenRouter needs a concrete format, so AUTO_DETECT maps to wav.
   */
  audioEncoding?: "AUTO_DETECT" | "LINEAR16" | "MP3" | "OGG_OPUS" | "FLAC";
  language?: string;
  modelId?: string;
};

export type DictationProvider = "xai" | "openrouter" | "inworld";

export const resolveDictationProvider = (): DictationProvider => {
  const configured = process.env.DICTATION_STT_PROVIDER?.trim().toLowerCase();
  if (configured === "inworld") return "inworld";
  if (configured === "openrouter") return "openrouter";
  return "xai";
};

const DEFAULT_MODEL_BY_PROVIDER: Record<DictationProvider, string> = {
  xai: XAI_DICTATION_MODEL,
  openrouter: OPENROUTER_DICTATION_MODEL,
  inworld: INWORLD_DEFAULT_MODEL,
};

/**
 * Model precedence: explicit request override, then the `DICTATION_STT_MODEL`
 * env (so future swaps are env-only, no deploy), then the provider default.
 */
export const resolveDictationModel = (
  provider: DictationProvider,
  requested?: string,
): string => {
  const fromRequest = requested?.trim();
  if (fromRequest) return fromRequest;
  const fromEnv = process.env.DICTATION_STT_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_MODEL_BY_PROVIDER[provider];
};

const formatFromAudioEncoding = (
  encoding: TranscribeRequestBody["audioEncoding"],
): string => {
  switch (encoding) {
    case "MP3":
      return "mp3";
    case "OGG_OPUS":
      return "ogg";
    case "FLAC":
      return "flac";
    case "LINEAR16":
    case "AUTO_DETECT":
    default:
      return "wav";
  }
};

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const estimatedAudioSeconds = (audioBase64: string): number =>
  Math.max(1, (audioBase64.length * 0.75) / (16_000 * 2));

const dictationBilling = (args: {
  provider: DictationProvider;
  model: string;
  audioBase64: string;
  usdPerSecond: number;
}) => ({
  kind: MANAGED_USAGE_BILLING_KIND,
  requestFingerprint: `dictation:${args.provider}:${crypto.randomUUID()}`,
  agentType: "service:dictation",
  model: args.model,
  fallbackCostMicroCents: Math.max(
    1,
    dollarsToMicroCents(
      estimatedAudioSeconds(args.audioBase64) * args.usdPerSecond,
    ),
  ),
});

export const registerDictationRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/dictation/transcribe"]);

  http.route({
    path: "/api/dictation/transcribe",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // Cloud STT is paid by the second; require a connected account so every
        // transcription rolls up to a real user's plan window.
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use dictation.",
          realm: "stella-dictation",
        });
        if (!auth.ok) return auth.response;
        const ownerId = auth.ownerId;

        // No capability/subscription gate: composer dictation is a free input
        // path into the text assistant, not audio generation. Signed-in Free,
        // Go, and Pro users all reach the same transcription path. See
        // `capabilityForMediaCapabilityId` in `capability_contract.ts`, which
        // leaves `speech_to_text` ungated for the same reason.
        // Both spend gates in a single transaction/commit, evaluated in the
        // same order as before (usage-limit first, then rate-limit) so the
        // 429 a client sees is unchanged. Both are still enforced pre-spend.
        const gate = await runManagedGate(ctx, origin, {
          ownerId,
          order: ["usage", "rate"],
          usage: {},
          rateLimit: {
            scope: "dictation_transcribe",
            key: ownerId,
            limit: DICTATION_RATE_LIMIT,
            windowMs: DICTATION_RATE_WINDOW_MS,
            blockMs: DICTATION_RATE_WINDOW_MS,
          },
        });
        if (!gate.ok) return gate.response;
        const ownerGeneration = gate.ownerGeneration;

        const provider = resolveDictationProvider();
        // Same org key the realtime Grok Voice path uses (voice.ts); it
        // never leaves the backend.
        const xaiKey =
          provider === "xai" ? process.env.XAI_API_KEY?.trim() || null : null;
        const openRouterKey =
          provider === "openrouter"
            ? (resolveManagedGatewayApiKey(
                getManagedGatewayConfig("openrouter"),
              ) ?? null)
            : null;
        const inworldKey =
          provider === "inworld"
            ? process.env.INWORLD_API_KEY?.trim() || null
            : null;
        if (provider === "xai" && !xaiKey) {
          return errorResponse(
            503,
            "Dictation is not configured (missing XAI_API_KEY).",
            origin,
          );
        }
        if (provider === "openrouter" && !openRouterKey) {
          return errorResponse(
            503,
            "Dictation is not configured (missing OPENROUTER_API_KEY).",
            origin,
          );
        }
        if (provider === "inworld" && !inworldKey) {
          return errorResponse(
            503,
            "Dictation is not configured (missing INWORLD_API_KEY).",
            origin,
          );
        }

        let body: TranscribeRequestBody;
        try {
          body = (await request.json()) as TranscribeRequestBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const audioBase64 = body.audioBase64?.trim();
        if (!audioBase64) {
          return errorResponse(400, "audioBase64 is required", origin);
        }
        if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
          return errorResponse(
            413,
            "Audio clip too large; please dictate a shorter segment.",
            origin,
          );
        }

        if (provider === "inworld") {
          return transcribeWithInworld({
            ctx,
            origin,
            ownerId,
            ownerGeneration,
            inworldKey: inworldKey!,
            body,
            audioBase64,
            signal: request.signal,
          });
        }

        if (provider === "openrouter") {
          return transcribeWithOpenRouter({
            ctx,
            origin,
            ownerId,
            ownerGeneration,
            openRouterKey: openRouterKey!,
            body,
            audioBase64,
            signal: request.signal,
          });
        }

        return transcribeWithXai({
          ctx,
          origin,
          ownerId,
          ownerGeneration,
          xaiKey: xaiKey!,
          body,
          audioBase64,
          signal: request.signal,
        });
      }),
    ),
  });
};

const mimeTypeForFormat = (format: string): string => {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    default:
      return "audio/wav";
  }
};

const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const transcribeWithXai = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  ownerGeneration: string;
  xaiKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
  signal: AbortSignal;
}) => {
  const modelId = resolveDictationModel("xai", args.body.modelId);
  const language = args.body.language?.trim();
  const format = formatFromAudioEncoding(args.body.audioEncoding);
  const startedAt = Date.now();

  let audioBytes: Uint8Array<ArrayBuffer>;
  try {
    audioBytes = base64ToBytes(args.audioBase64);
  } catch {
    return errorResponse(400, "audioBase64 is not valid base64", args.origin);
  }

  // xAI's STT endpoint takes multipart/form-data; container formats (WAV,
  // MP3, ...) are auto-detected, and the file field must come last.
  const form = new FormData();
  if (language) {
    // `format=true` enables inverse text normalization and requires a
    // language code; the model transcribes any language regardless.
    form.append("format", "true");
    form.append("language", language);
  }
  form.append(
    "file",
    new Blob([audioBytes], { type: mimeTypeForFormat(format) }),
    `audio.${format}`,
  );

  const dispatchGuard = createManagedUsageDispatchGuard(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
  });
  const billing = dictationBilling({
    provider: "xai",
    model: modelId,
    audioBase64: args.audioBase64,
    usdPerSecond: XAI_USD_PER_SECOND,
  });

  try {
    const result = await runManagedDispatchAttempt({
      dispatchGuard,
      callerSignal: args.signal,
      billing,
      run: async (signal, receipt) => {
        const upstream = await fetch(XAI_TRANSCRIBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.xaiKey}`,
          },
          body: form,
          signal,
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          console.error(
            "[dictation/transcribe] xAI STT returned",
            upstream.status,
            text.slice(0, 400),
          );
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error(`xAI STT returned ${upstream.status}`);
        }
        let parsed: { text?: unknown; duration?: unknown };
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error("xAI returned a non-JSON transcription response");
        }

        const transcript = typeof parsed.text === "string" ? parsed.text : "";
        const durationSeconds = asFiniteNumber(parsed.duration);
        const transcribedAudioMs =
          durationSeconds !== undefined
            ? Math.round(durationSeconds * 1000)
            : null;
        const costMicroCents =
          durationSeconds !== undefined
            ? dollarsToMicroCents(
                Math.max(0, durationSeconds) * XAI_USD_PER_SECOND,
              )
            : billing.fallbackCostMicroCents;
        await receipt.captureUsage({
          durationMs: Date.now() - startedAt,
          success: true,
          costMicroCents,
        });
        return { transcript, transcribedAudioMs };
      },
    });

    return jsonResponse(
      {
        transcript: result.transcript,
        isFinal: true,
        transcribedAudioMs: result.transcribedAudioMs,
        modelId,
      },
      200,
      args.origin,
    );
  } catch (error) {
    if (dispatchGuard.signal.aborted || args.signal.aborted) {
      return errorResponse(
        409,
        "Your account changed before dictation could start. Please retry.",
        args.origin,
      );
    }
    console.error(
      "[dictation/transcribe] Failed to contact xAI:",
      (error as Error).message,
    );
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};

const transcribeWithOpenRouter = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  ownerGeneration: string;
  openRouterKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
  signal: AbortSignal;
}) => {
  const modelId = resolveDictationModel("openrouter", args.body.modelId);
  const language = args.body.language?.trim();
  const format = formatFromAudioEncoding(args.body.audioEncoding);
  const startedAt = Date.now();
  const dispatchGuard = createManagedUsageDispatchGuard(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
  });
  const billing = dictationBilling({
    provider: "openrouter",
    model: modelId,
    audioBase64: args.audioBase64,
    usdPerSecond: OPENROUTER_USD_PER_SECOND,
  });
  try {
    const result = await runManagedDispatchAttempt({
      dispatchGuard,
      callerSignal: args.signal,
      billing,
      run: async (signal, receipt) => {
        const upstream = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.openRouterKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://stella.sh",
            "X-OpenRouter-Title": "Stella",
          },
          body: JSON.stringify({
            model: modelId,
            input_audio: {
              data: args.audioBase64,
              format,
            },
            ...(language ? { language } : {}),
          }),
          signal,
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          console.error(
            "[dictation/transcribe] OpenRouter STT returned",
            upstream.status,
            text.slice(0, 400),
          );
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error(`OpenRouter STT returned ${upstream.status}`);
        }
        let parsed: {
          text?: unknown;
          usage?: { seconds?: unknown; cost?: unknown };
        };
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error(
            "OpenRouter returned a non-JSON transcription response",
          );
        }

        const transcript = typeof parsed.text === "string" ? parsed.text : "";
        const usageSeconds = asFiniteNumber(parsed.usage?.seconds);
        const usageCost = asFiniteNumber(parsed.usage?.cost);
        const transcribedAudioMs =
          usageSeconds !== undefined
            ? Math.round(usageSeconds * 1000)
            : null;
        const costMicroCents =
          usageCost !== undefined
            ? dollarsToMicroCents(Math.max(0, usageCost))
            : usageSeconds !== undefined
              ? dollarsToMicroCents(
                  Math.max(0, usageSeconds) * OPENROUTER_USD_PER_SECOND,
                )
              : billing.fallbackCostMicroCents;
        await receipt.captureUsage({
          durationMs: Date.now() - startedAt,
          success: true,
          costMicroCents,
        });
        return { transcript, transcribedAudioMs };
      },
    });

    return jsonResponse(
      {
        transcript: result.transcript,
        isFinal: true,
        transcribedAudioMs: result.transcribedAudioMs,
        modelId,
      },
      200,
      args.origin,
    );
  } catch (error) {
    if (dispatchGuard.signal.aborted || args.signal.aborted) {
      return errorResponse(
        409,
        "Your account changed before dictation could start. Please retry.",
        args.origin,
      );
    }
    console.error(
      "[dictation/transcribe] Failed to contact OpenRouter:",
      (error as Error).message,
    );
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};

const transcribeWithInworld = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  ownerGeneration: string;
  inworldKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
  signal: AbortSignal;
}) => {
  const modelId = resolveDictationModel("inworld", args.body.modelId);
  const inworldBody = {
    transcribe_config: {
      model_id: modelId,
      language: args.body.language ?? INWORLD_DEFAULT_LANGUAGE,
      audio_encoding: args.body.audioEncoding ?? "AUTO_DETECT",
    },
    audio_data: { content: args.audioBase64 },
  };

  const startedAt = Date.now();
  const dispatchGuard = createManagedUsageDispatchGuard(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
  });
  const billing = dictationBilling({
    provider: "inworld",
    model: modelId,
    audioBase64: args.audioBase64,
    usdPerSecond: INWORLD_USD_PER_HOUR / 3600,
  });
  try {
    const result = await runManagedDispatchAttempt({
      dispatchGuard,
      callerSignal: args.signal,
      billing,
      run: async (signal, receipt) => {
        const inworldResponse = await fetch(INWORLD_TRANSCRIBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Basic ${args.inworldKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(inworldBody),
          signal,
        });
        const text = await inworldResponse.text();
        if (!inworldResponse.ok) {
          console.error(
            "[dictation/transcribe] Inworld STT returned",
            inworldResponse.status,
            text,
          );
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error(`Inworld STT returned ${inworldResponse.status}`);
        }
        let parsed: {
          transcription?: { transcript?: string; isFinal?: boolean };
          usage?: { transcribedAudioMs?: number; modelId?: string };
        };
        try {
          parsed = JSON.parse(text);
        } catch {
          await receipt.captureUsage({
            durationMs: Date.now() - startedAt,
            success: false,
            costMicroCents: billing.fallbackCostMicroCents,
          });
          throw new Error("Inworld returned a non-JSON transcription response");
        }

        const transcribedAudioMs = parsed.usage?.transcribedAudioMs ?? 0;
        await receipt.captureUsage({
          durationMs: Date.now() - startedAt,
          success: true,
          costMicroCents: dollarsToMicroCents(
            Math.max(0, transcribedAudioMs) * INWORLD_USD_PER_MS,
          ),
        });
        return parsed;
      },
    });

    return jsonResponse(
      {
        transcript: result.transcription?.transcript ?? "",
        isFinal: result.transcription?.isFinal ?? true,
        transcribedAudioMs: result.usage?.transcribedAudioMs ?? null,
        modelId: result.usage?.modelId ?? null,
      },
      200,
      args.origin,
    );
  } catch (error) {
    if (dispatchGuard.signal.aborted || args.signal.aborted) {
      return errorResponse(
        409,
        "Your account changed before dictation could start. Please retry.",
        args.origin,
      );
    }
    console.error(
      "[dictation/transcribe] Failed to contact Inworld:",
      (error as Error).message,
    );
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};
