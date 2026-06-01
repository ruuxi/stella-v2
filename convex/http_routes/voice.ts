import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction } from "../auth";
import { checkManagedUsageLimit } from "../lib/managed_billing";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { rateLimitResponse } from "../http_shared/webhook_controls";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOICE_SESSION_RATE_LIMIT = 10; // per minute
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const asConvexConversationId = (value: unknown): Id<"conversations"> | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized as Id<"conversations">;
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
    conversationId: asConvexConversationId(body?.conversationId),
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
// Route Registration
// ---------------------------------------------------------------------------

export const registerVoiceRoutes = (http: HttpRouter) => {
  // --- Voice Session ---

  registerCorsOptions(http, [
    "/api/voice/session",
    "/api/voice/usage",
    "/api/voice/lease",
    "/api/voice/inworld/sdp",
    "/api/voice/tts",
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
        const identity = auth.identity;

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "voice_session",
            key: identity.tokenIdentifier,
            limit: VOICE_SESSION_RATE_LIMIT,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        type VoiceSessionBody = {
          conversationId?: string;
          voice?: string;
          model?: string;
          turnDetection?: "semantic_vad" | "server_vad";
          turnEagerness?: "low" | "medium" | "high";
          instructions?: string;
          /**
           * Which voice family the renderer wants Stella to mint for.
           * Defaults to "openai" so older clients keep working.
           */
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

        // Resolve owner ID from identity
        const ownerId = auth.ownerId;
        const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId);
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
        }

        const voiceProvider: "openai" | "xai" | "inworld" =
          body?.voiceProvider === "xai"
            ? "xai"
            : body?.voiceProvider === "inworld"
              ? "inworld"
              : "openai";
        const stellaSessionId = createVoiceSessionId(voiceProvider);

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
              provider: "xai" as const,
              model: xaiModel,
              voice: xaiVoice,
              stellaSessionId,
              ...(asConvexConversationId(body?.conversationId)
                ? {
                    conversationId: asConvexConversationId(
                      body?.conversationId,
                    )!,
                  }
                : {}),
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
                body: JSON.stringify({
                  expires_after: {
                    seconds: Math.max(
                      60,
                      Math.floor(lease.leaseDurationMs / 1000),
                    ),
                  },
                  session: {
                    type: "realtime",
                    model: xaiModel,
                    instructions,
                    voice: xaiVoice,
                  },
                }),
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
          const inworldVoice = body.voice ?? "Evelyn";
          const lease = (await ctx.runMutation(
            internal.billing.prepareVoiceRealtimeLease,
            {
              ownerId,
              provider: "inworld" as const,
              model: inworldModel,
              voice: inworldVoice,
              stellaSessionId,
              ...(asConvexConversationId(body?.conversationId)
                ? {
                    conversationId: asConvexConversationId(
                      body?.conversationId,
                    )!,
                  }
                : {}),
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
              // No clientSecret: SDP is proxied through the backend
              // route so the org key never reaches the renderer.
              clientSecret: "",
              model: inworldModel,
              voice: inworldVoice,
              iceServers,
              stellaSessionId: lease.stellaSessionId,
              leaseExpiresAt: lease.leaseExpiresAt,
            },
            200,
            origin,
          );
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

        const [{ getVoiceToolSchemas }] = await Promise.all([
          import("../tools/voice_schemas"),
        ]);

        const tools = getVoiceToolSchemas();
        const model = body.model ?? "gpt-realtime-2";
        const voice = body.voice ?? "marin";
        const lease = (await ctx.runMutation(
          internal.billing.prepareVoiceRealtimeLease,
          {
            ownerId,
            provider: "openai" as const,
            model,
            voice,
            stellaSessionId,
            ...(asConvexConversationId(body?.conversationId)
              ? {
                  conversationId: asConvexConversationId(body?.conversationId)!,
                }
              : {}),
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
        const identity = auth.identity;
        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "voice_inworld_sdp",
            key: identity.tokenIdentifier,
            limit: VOICE_SESSION_RATE_LIMIT,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const subscriptionCheck = await checkManagedUsageLimit(
          ctx,
          auth.ownerId,
        );
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
        }

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

  // ── Read-aloud TTS ───────────────────────────────────────────────
  // One-shot text-to-speech for the renderer's "read assistant replies
  // aloud" toggle. Returns binary audio (mp3 for OpenAI, wav for
  // Inworld) so the renderer can decode + play through Web Audio API
  // without an extra JSON unwrap.
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

        const subscriptionCheck = await checkManagedUsageLimit(
          ctx,
          auth.ownerId,
        );
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
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
        // Cap at ~8k chars so a runaway prompt can't blow the budget.
        const truncated = text.length > 8000 ? text.slice(0, 8000) : text;

        const voiceProvider: "openai" | "inworld" =
          body?.voiceProvider === "inworld" ? "inworld" : "openai";

        let conversationId: Id<"conversations"> | undefined;
        const parsedConversationId = asConvexConversationId(
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
          const voiceId = body?.voice?.trim() || "Evelyn";
          const modelId = body?.model?.trim() || "inworld-tts-2";
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
              return errorResponse(502, "Inworld returned no audio", origin);
            }
            // Decode base64 → bytes for the response body.
            const bytes = Uint8Array.from(atob(audioBase64), (c) =>
              c.charCodeAt(0),
            );
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

        // ── OpenAI TTS (default) ─────────────────────────────────────
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
            await ctx.runMutation(internal.billing.recordVoiceTtsUsage, {
              ownerId: identity.tokenIdentifier,
              model: ttsModel,
              ...(conversationId ? { conversationId } : {}),
              textInputTokens: estimateTextTokensFromChars(truncated),
              audioOutputTokens: estimateTtsAudioOutputTokens(
                truncated,
                body?.speed,
              ),
            });
          } catch {
            // Best-effort metering should not block audio playback.
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
        if (parsed.conversationId) {
          try {
            await requireConversationOwnerAction(ctx, parsed.conversationId);
            conversationId = parsed.conversationId;
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
