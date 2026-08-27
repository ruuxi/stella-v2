import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import {
  errorResponse,
  jsonResponse,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { meterManagedUsage, runManagedGate } from "../lib/gate_and_meter";
import { dollarsToMicroCents } from "../lib/billing_money";
import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKey,
} from "../lib/managed_gateway";
import {
  XAI_STT_MODEL_LABEL,
  XAI_STT_USD_PER_SECOND,
  XaiSttError,
  resolveXaiSttApiKey,
  transcribeWithXaiRest,
} from "../lib/xai_stt";

const DICTATION_RATE_LIMIT = 30;
const DICTATION_RATE_WINDOW_MS = 60_000;

const INWORLD_TRANSCRIBE_URL = "https://api.inworld.ai/stt/v1/transcribe";
const INWORLD_DEFAULT_MODEL = "inworld/inworld-stt-1";
const INWORLD_DEFAULT_LANGUAGE = "en-US";

const INWORLD_USD_PER_HOUR = 0.28;
const INWORLD_USD_PER_MS = INWORLD_USD_PER_HOUR / (60 * 60 * 1000);

const OPENROUTER_TRANSCRIPTIONS_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENROUTER_DICTATION_MODEL =
  "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b";
const OPENROUTER_USD_PER_SECOND = 0.000003;

export const XAI_DICTATION_MODEL = XAI_STT_MODEL_LABEL;

const MAX_AUDIO_BASE64_BYTES = 14 * 1024 * 1024;

type TranscribeRequestBody = {
  audioBase64?: string;

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

export const registerDictationRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/dictation/transcribe"]);

  http.route({
    path: "/api/dictation/transcribe",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {

        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use dictation.",
          realm: "stella-dictation",
        });
        if (!auth.ok) return auth.response;
        const ownerId = auth.ownerId;

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

        const provider = resolveDictationProvider();

        const xaiKey = provider === "xai" ? resolveXaiSttApiKey() : null;
        const openRouterKey =
          provider === "openrouter"
            ? (resolveManagedGatewayApiKey(
                getManagedGatewayConfig("openrouter"),
              ) ?? null)
            : null;
        const inworldKey =
          provider === "inworld"
            ? (process.env.INWORLD_API_KEY?.trim() || null)
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
            inworldKey: inworldKey!,
            body,
            audioBase64,
          });
        }

        if (provider === "openrouter") {
          return transcribeWithOpenRouter({
            ctx,
            origin,
            ownerId,
            openRouterKey: openRouterKey!,
            body,
            audioBase64,
          });
        }

        return transcribeWithXai({
          ctx,
          origin,
          ownerId,
          xaiKey: xaiKey!,
          body,
          audioBase64,
        });
      }),
    ),
  });
};

const transcribeWithXai = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  xaiKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
}) => {
  const modelId = resolveDictationModel("xai", args.body.modelId);
  const language = args.body.language?.trim();
  const format = formatFromAudioEncoding(args.body.audioEncoding);
  const startedAt = Date.now();

  try {
    const result = await transcribeWithXaiRest({
      apiKey: args.xaiKey,
      audioBase64: args.audioBase64,
      audioFormat: format,
      ...(language ? { language } : {}),
    });
    const transcript = result.text;
    const durationSeconds = result.durationSeconds;
    const transcribedAudioMs =
      durationSeconds !== undefined ? Math.round(durationSeconds * 1000) : null;
    const costUsd =
      durationSeconds !== undefined
        ? Math.max(0, durationSeconds) * XAI_STT_USD_PER_SECOND
        : 0;
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: modelId,
      durationMs: Date.now() - startedAt,
      success: true,
      costMicroCents: dollarsToMicroCents(costUsd),
    });

    return jsonResponse(
      {
        transcript,
        isFinal: true,
        transcribedAudioMs,
        modelId,
      },
      200,
      args.origin,
    );
  } catch (error) {
    if (error instanceof XaiSttError && error.kind === "invalid_base64") {
      return errorResponse(400, "audioBase64 is not valid base64", args.origin);
    }
    if (error instanceof XaiSttError && error.kind === "upstream") {
      console.error(
        "[dictation/transcribe] xAI STT returned",
        error.upstreamStatus,
        error.upstreamBody?.slice(0, 400) ?? "",
      );
    } else {
      console.error(
        "[dictation/transcribe] Failed to contact xAI:",
        error instanceof Error ? error.message : String(error),
      );
    }
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: modelId,
      durationMs: Date.now() - startedAt,
      success: false,
    });
    if (error instanceof XaiSttError && error.kind === "invalid_response") {
      return errorResponse(
        502,
        "xAI returned a non-JSON transcription response",
        args.origin,
      );
    }
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};

const transcribeWithOpenRouter = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  openRouterKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
}) => {
  const modelId = resolveDictationModel("openrouter", args.body.modelId);
  const language = args.body.language?.trim();
  const format = formatFromAudioEncoding(args.body.audioEncoding);
  const startedAt = Date.now();
  try {
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
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(
        "[dictation/transcribe] OpenRouter STT returned",
        upstream.status,
        text.slice(0, 400),
      );
      await meterManagedUsage(args.ctx, {
        ownerId: args.ownerId,
        agentType: "service:dictation",
        model: modelId,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      return errorResponse(502, "Failed to transcribe audio", args.origin);
    }
    let parsed: {
      text?: unknown;
      usage?: {
        seconds?: unknown;
        cost?: unknown;
      };
    };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      await meterManagedUsage(args.ctx, {
        ownerId: args.ownerId,
        agentType: "service:dictation",
        model: modelId,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      return errorResponse(
        502,
        "OpenRouter returned a non-JSON transcription response",
        args.origin,
      );
    }

    const transcript = typeof parsed.text === "string" ? parsed.text : "";
    const usageSeconds = asFiniteNumber(parsed.usage?.seconds);
    const usageCost = asFiniteNumber(parsed.usage?.cost);
    const transcribedAudioMs =
      usageSeconds !== undefined ? Math.round(usageSeconds * 1000) : null;
    const costUsd =
      usageCost !== undefined
        ? Math.max(0, usageCost)
        : usageSeconds !== undefined
          ? Math.max(0, usageSeconds) * OPENROUTER_USD_PER_SECOND
          : 0;
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: modelId,
      durationMs: Date.now() - startedAt,
      success: true,
      costMicroCents: dollarsToMicroCents(costUsd),
    });

    return jsonResponse(
      {
        transcript,
        isFinal: true,
        transcribedAudioMs,
        modelId,
      },
      200,
      args.origin,
    );
  } catch (error) {
    console.error(
      "[dictation/transcribe] Failed to contact OpenRouter:",
      (error as Error).message,
    );
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: modelId,
      durationMs: Date.now() - startedAt,
      success: false,
    });
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};

const transcribeWithInworld = async (args: {
  ctx: ActionCtx;
  origin: string | null;
  ownerId: string;
  inworldKey: string;
  body: TranscribeRequestBody;
  audioBase64: string;
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
  try {
    const inworldResponse = await fetch(INWORLD_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${args.inworldKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(inworldBody),
    });
    const text = await inworldResponse.text();
    if (!inworldResponse.ok) {
      console.error(
        "[dictation/transcribe] Inworld STT returned",
        inworldResponse.status,
        text,
      );
      await meterManagedUsage(args.ctx, {
        ownerId: args.ownerId,
        agentType: "service:dictation",
        model: modelId,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      return errorResponse(502, "Failed to transcribe audio", args.origin);
    }
    let parsed: {
      transcription?: {
        transcript?: string;
        isFinal?: boolean;
      };
      usage?: { transcribedAudioMs?: number; modelId?: string };
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      await meterManagedUsage(args.ctx, {
        ownerId: args.ownerId,
        agentType: "service:dictation",
        model: modelId,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      return errorResponse(
        502,
        "Inworld returned a non-JSON transcription response",
        args.origin,
      );
    }

    const transcribedAudioMs = parsed.usage?.transcribedAudioMs ?? 0;
    const costMicroCents = dollarsToMicroCents(
      Math.max(0, transcribedAudioMs) * INWORLD_USD_PER_MS,
    );
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: parsed.usage?.modelId ?? modelId,
      durationMs: Date.now() - startedAt,
      success: true,
      costMicroCents,
    });

    return jsonResponse(
      {
        transcript: parsed.transcription?.transcript ?? "",
        isFinal: parsed.transcription?.isFinal ?? true,
        transcribedAudioMs: parsed.usage?.transcribedAudioMs ?? null,
        modelId: parsed.usage?.modelId ?? null,
      },
      200,
      args.origin,
    );
  } catch (error) {
    console.error(
      "[dictation/transcribe] Failed to contact Inworld:",
      (error as Error).message,
    );
    await meterManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: "service:dictation",
      model: modelId,
      durationMs: Date.now() - startedAt,
      success: false,
    });
    return errorResponse(502, "Failed to transcribe audio", args.origin);
  }
};
