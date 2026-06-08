import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  assertSensitiveSessionPolicyAction,
  createAuth,
  getAuthBaseUrl,
  isAnonymousIdentity,
} from "../auth";
import { getAppReviewEmail } from "../lib/app_review_auth";
import { AGENT_IDS } from "../lib/agent_constants";
import { MANAGED_GATEWAY } from "../agent/model";
import {
  resolveFallbackConfig,
  resolveModelConfig,
} from "../agent/model_resolver";
import { OFFLINE_RESPONDER_SYSTEM_PROMPT } from "../prompts/offline_responder";
import { getResponseLanguageSystemPrompt } from "../prompts/system_assembly";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import {
  consumeWebhookRateLimit,
  enforceHttpRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
import { readJsonBody } from "../http_shared/request";
import { encodeSseData, sseResponse } from "../http_shared/sse";
import { getClientAddressKey } from "../lib/http_utils";
import {
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "../lib/managed_billing";
import {
  assistantText,
  completeManagedChat,
  streamManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";
import { processIncomingMessage } from "../channels/message_pipeline";
import { MOBILE_BRIDGE_LEASE_MS } from "../mobile_bridge";
import {
  verifyPairedMobileProof,
  verifyPairedMobileSecret,
} from "../mobile_access";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Usage,
  UserMessage,
} from "../runtime_ai/types";

const OFFLINE_CHAT_RATE_LIMIT = 12;
const OFFLINE_CHAT_RATE_WINDOW_MS = 60_000;
/** Per-owner cap on the Voxtral transcription endpoint. */
const TRANSCRIBE_RATE_LIMIT = 30;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;
/** ~10 MB of base64 ≈ ~7.5 MB raw audio. Roughly 2 min of m4a. */
const MAX_TRANSCRIBE_AUDIO_BASE64_CHARS = 10_000_000;
const TRANSCRIBE_MODEL = "mistralai/voxtral-mini-transcribe";
const TRANSCRIBE_AUDIO_FORMATS = new Set([
  "wav",
  "mp3",
  "flac",
  "m4a",
  "ogg",
  "webm",
  "aac",
  "mp4",
]);
const MAX_BASE_URLS = 8;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_BRIDGE_CHALLENGE_LENGTH = 512;
const MAX_BRIDGE_PUBLIC_KEY_LENGTH = 128;
const MOBILE_BRIDGE_PAIR_PROOF_MAX_SKEW_MS = 5 * 60_000;
const MAX_OFFLINE_HISTORY_ITEMS = 40;
const MAX_OFFLINE_MESSAGE_CHARS = 12_000;
const MAX_OFFLINE_IMAGES = 5;
/** ~6M chars base64 ≈ ~4.5MB decoded — guardrail per image */
const MAX_IMAGE_BASE64_CHARS = 6_000_000;

/** Per-owner cap for the desktop bridge endpoints (cheap reads/writes). */
const MOBILE_BRIDGE_RATE_LIMIT = 60;
const MOBILE_BRIDGE_RATE_WINDOW_MS = 60_000;
/** Tighter cap for the Cloudflare-Tunnel-provisioning endpoint. */
const MOBILE_TUNNEL_TOKEN_RATE_LIMIT = 12;
const MOBILE_TUNNEL_TOKEN_RATE_WINDOW_MS = 60_000;
/** Per-request-id cap for the magic-link status poll. */
const MAGIC_LINK_STATUS_RATE_LIMIT = 60;
const MAGIC_LINK_STATUS_RATE_WINDOW_MS = 60_000;
/** Per-IP cap on `/api/mobile/pairing/complete` so brute-force is bounded. */
const MOBILE_PAIRING_COMPLETE_RATE_LIMIT = 30;
const MOBILE_PAIRING_COMPLETE_RATE_WINDOW_MS = 60_000;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantHistoryMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "managed",
  model: "offline-history",
  usage: EMPTY_USAGE,
  stopReason: "stop",
  timestamp: Date.now(),
});

const parseOfflineHistory = (
  raw: unknown,
): Array<{ role: "user" | "assistant"; text: string }> => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { role?: unknown; text?: unknown };
    const role = record.role;
    const text =
      typeof record.text === "string"
        ? record.text.slice(0, MAX_OFFLINE_MESSAGE_CHARS)
        : "";
    const trimmed = text.trim();
    if (!trimmed || (role !== "user" && role !== "assistant")) {
      continue;
    }
    out.push({ role, text: trimmed });
  }
  return out.slice(-MAX_OFFLINE_HISTORY_ITEMS);
};

const parseOfflineImages = (
  raw: unknown,
): Array<{ base64: string; mimeType: string }> => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ base64: string; mimeType: string }> = [];
  for (const item of raw) {
    if (out.length >= MAX_OFFLINE_IMAGES) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { base64?: unknown; mimeType?: unknown };
    const base64 = typeof record.base64 === "string" ? record.base64 : "";
    if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS) {
      continue;
    }
    const mimeType =
      typeof record.mimeType === "string" && record.mimeType.trim().length > 0
        ? record.mimeType.trim()
        : "image/jpeg";
    out.push({ base64, mimeType });
  }
  return out;
};

const buildOfflineChatContext = (args: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  message: string;
  images: Array<{ base64: string; mimeType: string }>;
}): Context => {
  const messages: Message[] = [];
  for (const turn of args.history) {
    if (turn.role === "user") {
      messages.push({
        role: "user",
        content: turn.text,
        timestamp: Date.now(),
      });
    } else {
      messages.push(assistantHistoryMessage(turn.text));
    }
  }

  const parts: Array<TextContent | ImageContent> = [];
  const msg = args.message.trim();
  if (msg) {
    parts.push({ type: "text", text: msg });
  }
  for (const img of args.images) {
    parts.push({
      type: "image",
      data: img.base64,
      mimeType: img.mimeType,
    });
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "(Image)" });
  }

  let userContent: UserMessage["content"];
  if (parts.length === 1 && parts[0].type === "text") {
    userContent = parts[0].text;
  } else {
    userContent = parts;
  }

  messages.push({
    role: "user",
    content: userContent,
    timestamp: Date.now(),
  });

  return {
    systemPrompt: args.systemPrompt,
    messages,
  };
};

const MAGIC_LINK_RATE_LIMIT = 3;
const MAGIC_LINK_RATE_WINDOW_MS = 60_000;
const MAGIC_LINK_EXPIRY_MS = 10 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthenticatedOwnerResult =
  | { ownerId: string; name?: string; isAnonymous: boolean }
  | { response: Response };

const readConvexErrorCode = (error: unknown) => {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data = error.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { code?: unknown }).code === "string"
  ) {
    return (data as { code: string }).code;
  }
  return null;
};

const readConvexErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const requireMobileAccountOwner = async (
  ctx: ActionCtx,
  origin: string | null,
): Promise<AuthenticatedOwnerResult> => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return { response: errorResponse(401, "Unauthorized", origin) };
  }
  if (isAnonymousIdentity(identity)) {
    return {
      response: errorResponse(
        403,
        "Sign in with an account to use Stella mobile.",
        origin,
      ),
    };
  }

  try {
    await assertSensitiveSessionPolicyAction(ctx, identity);
  } catch (error) {
    return {
      response: errorResponse(
        401,
        readConvexErrorMessage(error, "Unauthorized"),
        origin,
      ),
    };
  }

  return {
    ownerId: identity.tokenIdentifier,
    name:
      typeof identity.name === "string" && identity.name.trim().length > 0
        ? identity.name.trim()
        : undefined,
    isAnonymous: false,
  };
};

const ANONYMOUS_OWNER_PREFIX = "anon:mobile:";

/**
 * For offline-chat endpoints: authenticate if possible, fall back to
 * anonymous guest access keyed by a stable mobile device id when available,
 * with IP fallback for older clients.
 */
const resolveMobileOwnerOrGuest = async (
  ctx: ActionCtx,
  request: Request,
  origin: string | null,
): Promise<AuthenticatedOwnerResult> => {
  const anonymousMobileDeviceId = normalizeDeviceId(
    request.headers.get("X-Stella-Mobile-Device-Id"),
  );
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  const anonymousOwner = {
    ownerId: anonymousMobileDeviceId
      ? `${ANONYMOUS_OWNER_PREFIX}device:${anonymousMobileDeviceId}`
      : `${ANONYMOUS_OWNER_PREFIX}ip:${ip}`,
    isAnonymous: true,
  } as const;

  const identity = await ctx.auth.getUserIdentity();
  if (identity && !isAnonymousIdentity(identity)) {
    try {
      await assertSensitiveSessionPolicyAction(ctx, identity);
    } catch (error) {
      // Offline mobile chat is available without an account, so stale or revoked
      // auth should not block guest access for these endpoints.
      console.warn(
        "[mobile/offline-chat] Falling back to anonymous access after auth check failed:",
        readConvexErrorMessage(error, "Unauthorized"),
      );
      return anonymousOwner;
    }
    return {
      ownerId: identity.tokenIdentifier,
      name:
        typeof identity.name === "string" && identity.name.trim().length > 0
          ? identity.name.trim()
          : undefined,
      isAnonymous: false,
    };
  }

  return anonymousOwner;
};

const normalizeDeviceId = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_DEVICE_ID_LENGTH);
};

const normalizePlatform = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : undefined;
};

const normalizeBaseUrls = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      unique.add(url.toString().replace(/\/+$/, ""));
    } catch {
      continue;
    }
    if (unique.size >= MAX_BASE_URLS) {
      break;
    }
  }

  return Array.from(unique);
};

const normalizeBridgeChallenge = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_BRIDGE_CHALLENGE_LENGTH);
};

const normalizeBridgePublicKey = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_BRIDGE_PUBLIC_KEY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(trimmed)
  ) {
    return "";
  }
  return trimmed;
};

const normalizeBridgeSessionTokenPart = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return "";
  }
  return trimmed;
};

const normalizeProofIssuedAt = (value: unknown) => {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const requirePairedMobileCredentials = async (
  ctx: ActionCtx,
  request: Request,
  args: {
    ownerId: string;
    desktopDeviceId: string;
    origin: string | null;
    proofChallenge?: string;
    proofMobilePublicKey?: string;
  },
): Promise<{ mobileDeviceId: string } | { response: Response }> => {
  const mobileDeviceId = normalizeDeviceId(
    request.headers.get("X-Stella-Mobile-Device-Id"),
  );
  if (!mobileDeviceId) {
    return {
      response: errorResponse(
        403,
        "A paired phone credential is required",
        args.origin,
      ),
    };
  }

  const proof = request.headers.get("X-Stella-Mobile-Pair-Proof")?.trim() ?? "";
  const issuedAt = normalizeProofIssuedAt(
    request.headers.get("X-Stella-Mobile-Pair-Proof-Issued-At"),
  );
  const proofChallenge = normalizeBridgeChallenge(
    args.proofChallenge ??
      request.headers.get("X-Stella-Mobile-Pair-Proof-Challenge"),
  );
  const proofMobilePublicKey =
    args.proofMobilePublicKey ??
    normalizeBridgePublicKey(request.headers.get("X-Stella-Mobile-Public-Key"));
  const pairSecret =
    request.headers.get("X-Stella-Mobile-Pair-Secret")?.trim() ?? "";
  if (!proof && !pairSecret) {
    return {
      response: errorResponse(
        403,
        "A paired phone credential is required",
        args.origin,
      ),
    };
  }

  const pairedDevice = await ctx.runQuery(
    internal.mobile_access.getPairedMobileDevice,
    {
      ownerId: args.ownerId,
      desktopDeviceId: args.desktopDeviceId,
      mobileDeviceId,
    },
  );
  if (!pairedDevice) {
    return {
      response: errorResponse(403, "This phone is not paired", args.origin),
    };
  }

  let secretOk = false;
  if (proof) {
    const now = Date.now();
    if (
      issuedAt > 0 &&
      Math.abs(now - issuedAt) <= MOBILE_BRIDGE_PAIR_PROOF_MAX_SKEW_MS &&
      proofChallenge
    ) {
      secretOk = await verifyPairedMobileProof({
        pairSecretHash: pairedDevice.pairSecretHash,
        proof,
        desktopDeviceId: args.desktopDeviceId,
        mobileDeviceId,
        challenge: proofChallenge,
        mobilePublicKey: proofMobilePublicKey,
        issuedAt,
      });
    }
  } else if (pairSecret) {
    secretOk = await verifyPairedMobileSecret({
      pairSecret,
      pairSecretHash: pairedDevice.pairSecretHash,
    });
  }

  if (!secretOk) {
    return {
      response: errorResponse(
        403,
        "This phone credential is invalid",
        args.origin,
      ),
    };
  }

  return { mobileDeviceId };
};

const generateOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: Array<{ base64: string; mimeType: string }>;
  model?: string | null;
}) => {
  const modelAccess = await resolveManagedModelAccess(args.ctx, args.ownerId, {
    isAnonymous: args.isAnonymous,
  });
  if (!modelAccess.allowed) {
    throw new ConvexError({
      code: "USAGE_LIMIT_REACHED",
      message: modelAccess.message,
    });
  }

  const primaryConfig = await resolveModelConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess, modelOverride: args.model },
  );
  const fallbackConfig = await resolveFallbackConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess },
  );

  const responderLocaleDirective = getResponseLanguageSystemPrompt(
    await args.ctx.runQuery(internal.data.preferences.getLocaleForOwner, {
      ownerId: args.ownerId,
    }),
  );

  const systemPrompt = [
    OFFLINE_RESPONDER_SYSTEM_PROMPT,
    "You are replying inside Stella's mobile offline chat.",
    "Answer in plain text and keep the response practical and concise.",
    "Use prior messages in this conversation for context when relevant.",
    responderLocaleDirective || null,
    args.userName ? `The user's name is ${args.userName}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const context = buildOfflineChatContext({
    systemPrompt,
    history: args.history,
    message: args.message,
    images: args.images,
  });

  const execute = async (config: typeof primaryConfig) =>
    await completeManagedChat({
      config,
      context,
    });

  const startedAt = Date.now();
  let activeModel = primaryConfig.model;
  let result;
  try {
    result = await execute(primaryConfig);
  } catch (error) {
    if (!fallbackConfig) {
      throw error;
    }
    activeModel = fallbackConfig.model;
    result = await execute(fallbackConfig);
  }

  await scheduleManagedUsage(args.ctx, {
    ownerId: args.ownerId,
    agentType: "service:offline_chat",
    model: activeModel,
    durationMs: Date.now() - startedAt,
    success: true,
    usage: usageSummaryFromAssistant(result),
  });

  const text = assistantText(result);
  return text || "I'm here, but I couldn't generate a reply right now.";
};

const streamOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: Array<{ base64: string; mimeType: string }>;
  model?: string | null;
  origin: string | null;
}): Promise<Response> => {
  const modelAccess = await resolveManagedModelAccess(args.ctx, args.ownerId, {
    isAnonymous: args.isAnonymous,
  });

  if (!modelAccess.allowed) {
    return errorResponse(429, modelAccess.message, args.origin);
  }

  const config = await resolveModelConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess, modelOverride: args.model },
  );

  const responderLocaleDirective = getResponseLanguageSystemPrompt(
    await args.ctx.runQuery(internal.data.preferences.getLocaleForOwner, {
      ownerId: args.ownerId,
    }),
  );

  const systemPrompt = [
    OFFLINE_RESPONDER_SYSTEM_PROMPT,
    "You are replying inside Stella's mobile offline chat.",
    "Answer in plain text and keep the response practical and concise.",
    "Use prior messages in this conversation for context when relevant.",
    responderLocaleDirective || null,
    args.userName ? `The user's name is ${args.userName}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const context = buildOfflineChatContext({
    systemPrompt,
    history: args.history,
    message: args.message,
    images: args.images,
  });

  const startedAt = Date.now();
  const eventStream = streamManagedChat({ config, context });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        let finalMessage: AssistantMessage | null = null;
        for await (const event of eventStream) {
          if (event.type === "text_delta") {
            controller.enqueue(encodeSseData({ t: event.delta }));
          } else if (event.type === "done") {
            finalMessage = event.message;
          } else if (event.type === "error") {
            finalMessage = event.error;
          }
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();

        void scheduleManagedUsage(args.ctx, {
          ownerId: args.ownerId,
          agentType: "service:offline_chat",
          model: config.model,
          durationMs: Date.now() - startedAt,
          success: true,
          usage: usageSummaryFromAssistant(finalMessage),
        });
      } catch (error) {
        console.error("[mobile/offline-chat-stream] Error:", error);
        controller.enqueue(encodeSseData({ error: "Stream failed" }));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return sseResponse(readable, args.origin);
};

export const registerMobileRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/mobile/offline-chat",
    "/api/mobile/offline-chat/stream",
    "/api/mobile/transcribe",
    "/api/mobile/chat",
    "/api/mobile/pairing/complete",
    "/api/mobile/push-token",
    "/api/mobile/push-token/unregister",
    "/api/mobile/desktop-bridge/register",
    "/api/mobile/desktop-bridge/clear",
    "/api/mobile/desktop-bridge/request",
    "/api/mobile/desktop-bridge/authorize",
    "/api/mobile/desktop-bridge/session",
    "/api/mobile/desktop-bridge/session/consume",
    "/api/mobile/desktop-bridge/tunnel-token",
  ]);

  http.route({
    path: "/api/mobile/offline-chat",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await resolveMobileOwnerOrGuest(ctx, request, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(
            `[mobile/offline-chat] Missing ${MANAGED_GATEWAY.apiKeyEnvVar}`,
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const rateLimitResponse = await enforceHttpRateLimit(ctx, origin, {
          scope: "mobile_offline_chat",
          key: owner.ownerId,
          limit: OFFLINE_CHAT_RATE_LIMIT,
          windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
          blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
        });
        if (rateLimitResponse) return rateLimitResponse;

        const bodyResult = await readJsonBody<{
          message?: unknown;
          history?: unknown;
          images?: unknown;
          model?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;

        const message =
          typeof body?.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body?.history);
        const images = parseOfflineImages(body?.images);
        const model = typeof body?.model === "string" ? body.model : null;

        if (!message && images.length === 0) {
          return errorResponse(400, "Message or image required", origin);
        }

        try {
          const text = await generateOfflineReply({
            ctx,
            ownerId: owner.ownerId,
            userName: owner.name,
            message,
            isAnonymous: owner.isAnonymous,
            history,
            images,
            model,
          });
          return jsonResponse({ text }, 200, origin);
        } catch (error) {
          console.error("[mobile/offline-chat] Error:", error);
          const status =
            readConvexErrorCode(error) === "USAGE_LIMIT_REACHED" ? 429 : 500;
          return errorResponse(
            status,
            readConvexErrorMessage(error, "Could not send your message"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/offline-chat/stream",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await resolveMobileOwnerOrGuest(ctx, request, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          return errorResponse(500, "Server configuration error", origin);
        }

        const rateLimitResponse = await enforceHttpRateLimit(ctx, origin, {
          scope: "mobile_offline_chat",
          key: owner.ownerId,
          limit: OFFLINE_CHAT_RATE_LIMIT,
          windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
          blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
        });
        if (rateLimitResponse) return rateLimitResponse;

        const bodyResult = await readJsonBody<{
          message?: unknown;
          history?: unknown;
          images?: unknown;
          model?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;

        const message =
          typeof body.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body.history);
        const images = parseOfflineImages(body.images);
        const model = typeof body.model === "string" ? body.model : null;

        if (!message && images.length === 0) {
          return errorResponse(400, "Message or image required", origin);
        }

        return streamOfflineReply({
          ctx,
          ownerId: owner.ownerId,
          userName: owner.name,
          message,
          isAnonymous: owner.isAnonymous,
          history,
          images,
          model,
          origin,
        });
      }),
    ),
  });

  http.route({
    path: "/api/mobile/transcribe",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await resolveMobileOwnerOrGuest(ctx, request, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(
            `[mobile/transcribe] Missing ${MANAGED_GATEWAY.apiKeyEnvVar}`,
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const rateLimitResp = await enforceHttpRateLimit(ctx, origin, {
          scope: "mobile_transcribe",
          key: owner.ownerId,
          limit: TRANSCRIBE_RATE_LIMIT,
          windowMs: TRANSCRIBE_RATE_WINDOW_MS,
          blockMs: TRANSCRIBE_RATE_WINDOW_MS,
        });
        if (rateLimitResp) return rateLimitResp;

        const bodyResult = await readJsonBody<{
          audio?: unknown;
          format?: unknown;
          language?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;

        const audio = typeof body.audio === "string" ? body.audio : "";
        const format =
          typeof body.format === "string"
            ? body.format.trim().toLowerCase()
            : "";
        const language =
          typeof body.language === "string"
            ? body.language.trim().slice(0, 16)
            : "";

        if (!audio) {
          return errorResponse(400, "audio is required", origin);
        }
        if (audio.length > MAX_TRANSCRIBE_AUDIO_BASE64_CHARS) {
          return errorResponse(413, "Audio clip is too long", origin);
        }
        if (!format || !TRANSCRIBE_AUDIO_FORMATS.has(format)) {
          return errorResponse(
            400,
            "format must be one of wav, mp3, flac, m4a, ogg, webm, aac, mp4",
            origin,
          );
        }

        try {
          const upstream = await fetch(
            `${MANAGED_GATEWAY.baseURL}/audio/transcriptions`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://stella.sh",
                "X-OpenRouter-Title": "Stella",
              },
              body: JSON.stringify({
                input_audio: {
                  data: audio,
                  format,
                },
                model: TRANSCRIBE_MODEL,
                ...(language ? { language } : {}),
              }),
            },
          );

          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => "");
            console.error(
              "[mobile/transcribe] Upstream error",
              upstream.status,
              errText.slice(0, 500),
            );
            return errorResponse(
              upstream.status >= 400 && upstream.status < 500
                ? upstream.status
                : 502,
              "Could not transcribe that audio. Try again.",
              origin,
            );
          }

          const parsed = (await upstream.json()) as { text?: unknown };
          const text =
            typeof parsed.text === "string" ? parsed.text.trim() : "";
          return jsonResponse({ text }, 200, origin);
        } catch (error) {
          console.error("[mobile/transcribe] Error:", error);
          return errorResponse(
            500,
            readConvexErrorMessage(error, "Could not transcribe that audio."),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/chat",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const rateLimitResponse = await enforceHttpRateLimit(ctx, origin, {
          scope: "mobile_offline_chat",
          key: owner.ownerId,
          limit: OFFLINE_CHAT_RATE_LIMIT,
          windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
          blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
        });
        if (rateLimitResponse) return rateLimitResponse;

        return errorResponse(
          410,
          "Update Stella mobile to message your paired desktop.",
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_get",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const url = new URL(request.url);
        const requestedDesktopDeviceId = normalizeDeviceId(
          url.searchParams.get("desktopDeviceId"),
        );
        const nowMs = Date.now();
        const registration = requestedDesktopDeviceId
          ? await ctx.runQuery(
              internal.mobile_bridge.getRegistrationForOwnerDevice,
              {
                ownerId: owner.ownerId,
                deviceId: requestedDesktopDeviceId,
                nowMs,
              },
            )
          : await ctx.runQuery(
              internal.mobile_bridge.getLatestRegistrationForOwner,
              { ownerId: owner.ownerId, nowMs },
            );
        if (!registration) {
          return jsonResponse(
            {
              available: false,
              baseUrls: [],
              platform: null,
              updatedAt: null,
            },
            200,
            origin,
          );
        }

        return jsonResponse(
          {
            available: registration.available,
            baseUrls: registration.available ? registration.baseUrls : [],
            platform: registration.platform ?? null,
            updatedAt: registration.updatedAt,
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/push-token",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_push_token",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const bodyResult = await readJsonBody<{
          token?: unknown;
          platform?: unknown;
          mobileDeviceId?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;

        const expoPushToken =
          typeof body.token === "string" ? body.token.trim() : "";
        if (!expoPushToken) {
          return errorResponse(400, "Push token required", origin);
        }

        // Prefer the explicit mobileDeviceId from the body; fall back to the
        // device-id header so older clients still register.
        const mobileDeviceIdFromBody = normalizeDeviceId(body.mobileDeviceId);
        const mobileDeviceIdFromHeader = normalizeDeviceId(
          request.headers.get("X-Stella-Mobile-Device-Id"),
        );
        const mobileDeviceId =
          mobileDeviceIdFromBody || mobileDeviceIdFromHeader;
        if (!mobileDeviceId) {
          return errorResponse(400, "mobileDeviceId required", origin);
        }

        const platform = normalizePlatform(body.platform);

        await ctx.runMutation(internal.mobile_push.upsertToken, {
          ownerId: owner.ownerId,
          mobileDeviceId,
          expoPushToken,
          ...(platform ? { platform } : {}),
          nowMs: Date.now(),
        });

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/push-token/unregister",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_push_token_unregister",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const bodyResult = await readJsonBody<{
          mobileDeviceId?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;

        const mobileDeviceIdFromBody = normalizeDeviceId(
          bodyResult.body.mobileDeviceId,
        );
        const mobileDeviceIdFromHeader = normalizeDeviceId(
          request.headers.get("X-Stella-Mobile-Device-Id"),
        );
        const mobileDeviceId =
          mobileDeviceIdFromBody || mobileDeviceIdFromHeader;
        if (!mobileDeviceId) {
          return errorResponse(400, "mobileDeviceId required", origin);
        }

        await ctx.runMutation(internal.mobile_push.deleteTokensForOwnerDevice, {
          ownerId: owner.ownerId,
          mobileDeviceId,
        });

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/pairing/complete",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        // Pairing-code brute-force protection: also gate per-IP so an
        // attacker can't drive code guesses from many fake owner ids.
        const clientAddress = getClientAddressKey(request);
        const ownerLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_pairing_complete_owner",
          key: owner.ownerId,
          limit: MOBILE_PAIRING_COMPLETE_RATE_LIMIT,
          windowMs: MOBILE_PAIRING_COMPLETE_RATE_WINDOW_MS,
          blockMs: MOBILE_PAIRING_COMPLETE_RATE_WINDOW_MS,
        });
        if (!ownerLimit.allowed) {
          return withCors(rateLimitResponse(ownerLimit.retryAfterMs), origin);
        }
        if (clientAddress) {
          const ipLimit = await consumeWebhookRateLimit(ctx, {
            scope: "mobile_pairing_complete_ip",
            key: clientAddress,
            limit: MOBILE_PAIRING_COMPLETE_RATE_LIMIT,
            windowMs: MOBILE_PAIRING_COMPLETE_RATE_WINDOW_MS,
            blockMs: MOBILE_PAIRING_COMPLETE_RATE_WINDOW_MS,
          });
          if (!ipLimit.allowed) {
            return withCors(rateLimitResponse(ipLimit.retryAfterMs), origin);
          }
        }

        let body: {
          pairingCode?: unknown;
          mobileDeviceId?: unknown;
          displayName?: unknown;
          platform?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            pairingCode?: unknown;
            mobileDeviceId?: unknown;
            displayName?: unknown;
            platform?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const pairingCode =
          typeof body?.pairingCode === "string"
            ? body.pairingCode.trim().toUpperCase().slice(0, 12)
            : "";
        const mobileDeviceId = normalizeDeviceId(body?.mobileDeviceId);
        const displayName =
          typeof body?.displayName === "string"
            ? body.displayName.trim().slice(0, 64)
            : undefined;
        const platform = normalizePlatform(body?.platform);

        if (!pairingCode || !mobileDeviceId) {
          return errorResponse(
            400,
            "pairingCode and mobileDeviceId are required",
            origin,
          );
        }

        try {
          const result = await ctx.runMutation(
            internal.mobile_access.completePairingSession,
            {
              ownerId: owner.ownerId,
              pairingCode,
              mobileDeviceId,
              ...(displayName ? { displayName } : {}),
              ...(platform ? { platform } : {}),
            },
          );
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return errorResponse(
            400,
            readConvexErrorMessage(error, "Unable to pair this phone"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/register",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_register",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: {
          deviceId?: unknown;
          baseUrls?: unknown;
          platform?: unknown;
          desktopPublicKey?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            deviceId?: unknown;
            baseUrls?: unknown;
            platform?: unknown;
            desktopPublicKey?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        const baseUrls = normalizeBaseUrls(body?.baseUrls);
        const platform = normalizePlatform(body?.platform);
        const desktopPublicKey = normalizeBridgePublicKey(
          body?.desktopPublicKey,
        );
        if (!deviceId || baseUrls.length === 0) {
          return errorResponse(
            400,
            "deviceId and baseUrls are required",
            origin,
          );
        }

        const updatedAt = Date.now();
        await ctx.runMutation(internal.mobile_bridge.upsertRegistration, {
          ownerId: owner.ownerId,
          deviceId,
          baseUrls,
          updatedAt,
          ...(platform ? { platform } : {}),
          ...(desktopPublicKey ? { desktopPublicKey } : {}),
        });

        return jsonResponse(
          {
            ok: true,
            leaseDurationMs: MOBILE_BRIDGE_LEASE_MS,
            leaseExpiresAt: updatedAt + MOBILE_BRIDGE_LEASE_MS,
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/clear",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_clear",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        await ctx.runMutation(internal.mobile_bridge.clearRegistration, {
          ownerId: owner.ownerId,
          deviceId,
        });
        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/request",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_request",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: {
          desktopDeviceId?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            desktopDeviceId?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const desktopDeviceId = normalizeDeviceId(body?.desktopDeviceId);
        if (!desktopDeviceId) {
          return errorResponse(400, "desktopDeviceId is required", origin);
        }

        const paired = await requirePairedMobileCredentials(ctx, request, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          origin,
        });
        if ("response" in paired) {
          return paired.response;
        }

        await ctx.runMutation(internal.mobile_access.upsertConnectIntent, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          mobileDeviceId: paired.mobileDeviceId,
          createdAt: Date.now(),
        });

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/authorize",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_authorize",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        const registration = await ctx.runQuery(
          internal.mobile_bridge.getRegistrationForOwnerDevice,
          {
            ownerId: owner.ownerId,
            deviceId,
            nowMs: Date.now(),
          },
        );
        if (!registration?.available) {
          return errorResponse(403, "Desktop bridge is unavailable", origin);
        }

        const paired = await requirePairedMobileCredentials(ctx, request, {
          ownerId: owner.ownerId,
          desktopDeviceId: deviceId,
          origin,
        });
        if ("response" in paired) {
          return paired.response;
        }

        await ctx.runMutation(internal.mobile_access.markPairedMobileSeen, {
          ownerId: owner.ownerId,
          desktopDeviceId: deviceId,
          mobileDeviceId: paired.mobileDeviceId,
          seenAt: Date.now(),
        });

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/session",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_session",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: {
          desktopDeviceId?: unknown;
          desktopChallenge?: unknown;
          mobilePublicKey?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            desktopDeviceId?: unknown;
            desktopChallenge?: unknown;
            mobilePublicKey?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const desktopDeviceId = normalizeDeviceId(body?.desktopDeviceId);
        const desktopChallenge = normalizeBridgeChallenge(
          body?.desktopChallenge,
        );
        const mobilePublicKey = normalizeBridgePublicKey(body?.mobilePublicKey);
        if (!desktopDeviceId || !desktopChallenge || !mobilePublicKey) {
          return errorResponse(
            400,
            "desktopDeviceId, desktopChallenge and mobilePublicKey are required",
            origin,
          );
        }

        const registration = await ctx.runQuery(
          internal.mobile_bridge.getRegistrationForOwnerDevice,
          {
            ownerId: owner.ownerId,
            deviceId: desktopDeviceId,
            nowMs: Date.now(),
          },
        );
        if (!registration?.available) {
          return errorResponse(403, "Desktop bridge is unavailable", origin);
        }
        if (!registration.desktopPublicKey) {
          return errorResponse(
            409,
            "Update Stella desktop to use the secure mobile bridge.",
            origin,
          );
        }

        const paired = await requirePairedMobileCredentials(ctx, request, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          origin,
          proofChallenge: desktopChallenge,
          proofMobilePublicKey: mobilePublicKey,
        });
        if ("response" in paired) {
          return paired.response;
        }

        const now = Date.now();
        await ctx.runMutation(internal.mobile_access.markPairedMobileSeen, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          mobileDeviceId: paired.mobileDeviceId,
          seenAt: now,
        });

        const session = await ctx.runMutation(
          internal.mobile_bridge.createSession,
          {
            ownerId: owner.ownerId,
            desktopDeviceId,
            mobileDeviceId: paired.mobileDeviceId,
            desktopChallenge,
            desktopPublicKey: registration.desktopPublicKey,
            mobilePublicKey,
            createdAt: now,
          },
        );

        return jsonResponse(
          {
            ok: true,
            protocol: "x25519-hkdf-sha256-aes-256-gcm-v1",
            ...session,
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/session/consume",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_session_consume",
          key: owner.ownerId,
          limit: MOBILE_BRIDGE_RATE_LIMIT,
          windowMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
          blockMs: MOBILE_BRIDGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: {
          deviceId?: unknown;
          sessionId?: unknown;
          sessionSecret?: unknown;
          desktopChallenge?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            deviceId?: unknown;
            sessionId?: unknown;
            sessionSecret?: unknown;
            desktopChallenge?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        const sessionId = normalizeBridgeSessionTokenPart(body?.sessionId);
        const sessionSecret = normalizeBridgeSessionTokenPart(
          body?.sessionSecret,
        );
        const desktopChallenge = normalizeBridgeChallenge(
          body?.desktopChallenge,
        );
        if (!deviceId || !sessionId || !sessionSecret || !desktopChallenge) {
          return errorResponse(
            400,
            "deviceId, sessionId, sessionSecret and desktopChallenge are required",
            origin,
          );
        }

        const consumed = await ctx.runMutation(
          internal.mobile_bridge.consumeSession,
          {
            ownerId: owner.ownerId,
            desktopDeviceId: deviceId,
            sessionId,
            sessionSecret,
            desktopChallenge,
            nowMs: Date.now(),
          },
        );
        if (!consumed) {
          return errorResponse(403, "Invalid bridge session", origin);
        }

        return jsonResponse(
          {
            ok: true,
            protocol: "x25519-hkdf-sha256-aes-256-gcm-v1",
            ...consumed,
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/tunnel-token",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }
        // Tunnel-token provisioning hits the Cloudflare API; tighter cap
        // than the rest of the bridge surface.
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_desktop_bridge_tunnel_token",
          key: owner.ownerId,
          limit: MOBILE_TUNNEL_TOKEN_RATE_LIMIT,
          windowMs: MOBILE_TUNNEL_TOKEN_RATE_WINDOW_MS,
          blockMs: MOBILE_TUNNEL_TOKEN_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const deviceId =
          typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        try {
          const result = await ctx.runAction(
            internal.cloudflare_tunnels.getOrProvisionTunnel,
            { ownerId: owner.ownerId, deviceId },
          );
          return jsonResponse(result, 200, origin);
        } catch (error) {
          console.error("[mobile/tunnel-token] Error:", error);
          return errorResponse(
            500,
            readConvexErrorMessage(error, "Failed to provision tunnel"),
            origin,
          );
        }
      }),
    ),
  });

  // ── Mobile magic link (no-redirect) ────────────────────────────────

  registerCorsOptions(http, [
    "/api/auth/link/send",
    "/api/auth/link/status",
    "/api/auth/desktop-social/start",
  ]);

  // Start a desktop social sign-in and return a requestId for polling. The
  // OAuth callback lands on `/api/auth/desktop-social/verify`, where the OTT is
  // exchanged server-side for the raw Better Auth session cookie.
  http.route({
    path: "/api/auth/desktop-social/start",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "desktop_social_auth_start",
          key: getClientAddressKey(request) ?? "unknown",
          limit: MAGIC_LINK_RATE_LIMIT,
          windowMs: MAGIC_LINK_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const authBaseUrl = getAuthBaseUrl();
        if (!authBaseUrl) {
          console.error("[desktop/auth] Missing auth base URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();
        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email: "desktop-social:google",
          requestId,
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
        });

        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        return jsonResponse(
          {
            requestId,
            callbackURL: `${authBaseUrl}/api/auth/desktop-social/verify?requestId=${encodeURIComponent(requestId)}`,
          },
          200,
          origin,
        );
      }),
    ),
  });

  // Send a magic link and return a requestId for polling.
  http.route({
    path: "/api/auth/link/send",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        let body: { email?: unknown } | null = null;
        try {
          body = (await request.json()) as { email?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const email =
          typeof body?.email === "string"
            ? body.email.trim().toLowerCase()
            : "";
        if (!email || !EMAIL_PATTERN.test(email)) {
          return errorResponse(400, "A valid email is required.", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "mobile_magic_link",
            key: email,
            limit: MAGIC_LINK_RATE_LIMIT,
            windowMs: MAGIC_LINK_RATE_WINDOW_MS,
            blockMs: MAGIC_LINK_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const authBaseUrl = getAuthBaseUrl();
        if (!authBaseUrl) {
          console.error("[mobile/auth] Missing auth base URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();
        const appReviewEmail = getAppReviewEmail();

        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email,
          requestId,
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
        });

        try {
          const auth = createAuth(ctx);
          if (appReviewEmail && email === appReviewEmail) {
            const signInAppReview = (
              auth.api as unknown as {
                signInAppReview(args: {
                  body: { email: string };
                  headers: Headers;
                  returnHeaders: true;
                }): Promise<unknown>;
              }
            ).signInAppReview;
            const signInResult = await signInAppReview({
              body: { email },
              headers: new Headers({ origin: authBaseUrl }),
              returnHeaders: true,
            });

            let sessionCookie = "";
            const headersList = (signInResult as Record<string, unknown>)
              ?.headers as { _headersList?: [string, string][] } | undefined;
            if (Array.isArray(headersList?._headersList)) {
              for (const [name, value] of headersList._headersList) {
                if (
                  name === "set-better-auth-cookie" ||
                  name === "set-cookie"
                ) {
                  sessionCookie = value;
                  break;
                }
              }
            }

            if (!sessionCookie) {
              throw new Error("Missing session cookie");
            }

            await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
              requestId,
              ott: "app-review",
              sessionCookie,
            });
          } else {
            const callbackURL = `${authBaseUrl}/api/auth/link/verify?requestId=${encodeURIComponent(requestId)}`;
            await auth.api.signInMagicLink({
              body: { email, callbackURL },
              headers: new Headers({ origin: authBaseUrl }),
            });
          }
        } catch (error) {
          console.error("[mobile/auth] Failed to send magic link:", error);
          return errorResponse(500, "Failed to send sign-in email.", origin);
        }

        // Clean up after expiry.
        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        return jsonResponse({ requestId }, 200, origin);
      }),
    ),
  });

  // Poll for magic link verification status.
  http.route({
    path: "/api/auth/link/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const url = new URL(request.url);
        const requestId = url.searchParams.get("requestId") ?? "";
        if (!requestId) {
          return errorResponse(400, "requestId is required", origin);
        }
        // Cap polls per requestId so a misbehaving client can't spin a
        // tight poll loop. The mobile client polls every ~1 s, so 60/min
        // is comfortably above legitimate usage.
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_auth_link_status",
          key: requestId,
          limit: MAGIC_LINK_STATUS_RATE_LIMIT,
          windowMs: MAGIC_LINK_STATUS_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_STATUS_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const result = await ctx.runQuery(
          internal.mobile_auth.getLinkRequestStatus,
          { requestId, nowMs: Date.now() },
        );
        if (!result) {
          return errorResponse(404, "Request not found", origin);
        }

        return jsonResponse(result, 200, origin);
      }),
    ),
  });

  // Browser landing after desktop social auth. The cross-domain plugin appends
  // ?ott=... to this URL after the provider flow completes.
  http.route({
    path: "/api/auth/desktop-social/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionCookie = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          const headersList = (verifyRes as Record<string, unknown>)
            ?.headers as { _headersList?: [string, string][] } | undefined;
          if (Array.isArray(headersList?._headersList)) {
            for (const [name, value] of headersList._headersList) {
              if (name === "set-better-auth-cookie" || name === "set-cookie") {
                sessionCookie = value;
                break;
              }
            }
          }
        } catch (err) {
          console.error("[desktop/auth] Server-side OTT verify failed:", err);
        }
        await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
          requestId,
          ott,
          ...(sessionCookie ? { sessionCookie } : {}),
        });
      }

      const websiteUrl =
        process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });

  // Browser landing after magic link verification.
  // The cross-domain plugin appends ?ott=... to this URL after verifying the token.
  // Exchanges the OTT for a session cookie server-side and stores the raw
  // Set-Cookie value so polling clients can apply it directly.
  http.route({
    path: "/api/auth/link/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionCookie = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          const headersList = (verifyRes as Record<string, unknown>)
            ?.headers as { _headersList?: [string, string][] } | undefined;
          if (Array.isArray(headersList?._headersList)) {
            for (const [name, value] of headersList._headersList) {
              if (name === "set-better-auth-cookie" || name === "set-cookie") {
                sessionCookie = value;
                break;
              }
            }
          }
        } catch (err) {
          console.error("[mobile/auth] Server-side OTT verify failed:", err);
        }
        await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
          requestId,
          ott,
          ...(sessionCookie ? { sessionCookie } : {}),
        });
      }

      const websiteUrl =
        process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });
};
