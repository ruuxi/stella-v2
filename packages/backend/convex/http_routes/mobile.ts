import { makeFunctionReference, type HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  assertSensitiveSessionPolicyAction,
  createAuth,
  getAuthBaseUrl,
  getUserIdentityOrNullAction,
  isAnonymousIdentity,
  tokenIdentifierForBetterAuthUserId,
} from "../auth";
import {
  BROWSER_AUTH_HANDOFF_TOKEN_PATTERN,
  buildBrowserAuthFragmentRedirect,
  normalizeBrowserAuthReturnTarget,
} from "../lib/browser_auth_callback";
import { decideAnonymousLinkBinding } from "../lib/mobile_auth_link";
import { encryptHandoffToken } from "../lib/handoff_crypto";
import { AGENT_IDS } from "../lib/agent_constants";
import { MANAGED_GATEWAY } from "../agent/model";
import {
  resolveFallbackConfig,
  resolveModelConfig,
  type ResolvedModelConfig,
} from "../agent/model_resolver";
import {
  buildOfflineChatContext,
  modelSupportsOfflineImages,
  offlineImageCapabilityError,
  parseOfflineImages,
  type OfflineChatImage,
} from "../mobile_chat_images";
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
import { createAssistantTextFramer } from "../http_shared/assistant_text_frames";
import { dollarsToMicroCents } from "../lib/billing_money";
import {
  estimateManagedModelFallbackCostMicroCents,
  MANAGED_USAGE_BILLING_KIND,
} from "../lib/managed_dispatch";
import { getClientAddressKey } from "../lib/http_utils";
import {
  bindManagedProviderRequest,
  createManagedUsageDispatchGuard,
  resolveManagedModelAccess,
} from "../lib/managed_billing";
import {
  assistantText,
  completeManagedChat,
  estimateManagedContextInputTokens,
  runManagedDispatchAttempt,
  streamManagedChat,
  type ManagedDispatchOutcome,
  type ManagedModelBillingContext,
} from "../runtime_ai/managed";
import { isRetryableProviderError } from "../runtime_ai/retry";
import {
  XAI_STT_MODEL_LABEL,
  XAI_STT_USD_PER_SECOND,
  XaiSttError,
  assertXaiSttAudioBase64,
  resolveXaiSttApiKey,
  transcribeWithXaiRest,
} from "../lib/xai_stt";
import { MOBILE_BRIDGE_LEASE_MS } from "../mobile_bridge";
import {
  verifyPairedMobileProof,
  verifyPairedMobileSecret,
} from "../mobile_access";

const OFFLINE_CHAT_RATE_LIMIT = 12;
const OFFLINE_CHAT_RATE_WINDOW_MS = 60_000;
/**
 * Secondary per-IP cap for anonymous guests. The anonymous owner id is
 * derived from the client-supplied device-id header, which an attacker can
 * rotate freely — the IP cap bounds total unauthenticated LLM spend.
 */
const OFFLINE_CHAT_ANON_IP_RATE_LIMIT = 30;
/** Per-owner cap on the mobile and CarPlay transcription endpoint. */
const TRANSCRIBE_RATE_LIMIT = 30;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;
const TRANSCRIBE_ANON_IP_RATE_LIMIT = 60;
/** ~10 MB of base64 ≈ ~7.5 MB raw audio. Roughly 2 min of m4a. */
const MAX_TRANSCRIBE_AUDIO_BASE64_CHARS = 10_000_000;
const MANAGED_PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9:._-]{8,256}$/u;
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
const MOBILE_EXECUTION_SUBMIT_RATE_LIMIT = 30;
const MOBILE_EXECUTION_SUBMIT_RATE_WINDOW_MS = 60_000;

type MobileExecutionDispatchResult = {
  dispatchId: string;
  idempotencyKey: string;
  kind: "chat" | "agent";
  ingress: "mobile";
  subject: "portable" | "computer" | "cloud";
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  state: string;
  placement?: "computer" | "cloud";
  executorDeviceId?: string;
  executorPresenceSessionId?: string;
  revision: number;
  fallbackReason?: string;
  cancelRequestId?: string;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: string;
  cloudTurnId?: string;
  terminalAt?: number;
  createdAt: number;
  updatedAt: number;
};

const submitMobileExecutionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    idempotencyKey: string;
    payloadJson: string;
    payloadHash: string;
    kind: "chat" | "agent";
    ingress: "mobile";
    subject: "portable" | "computer" | "cloud";
    conversationId: string;
    parentTurnId?: string;
    threadId?: string;
    requestingDeviceId?: string;
    pairGrantDeviceId?: string;
    requiredCapabilities: Array<
      "chat" | "agent" | "computer-use" | "local-files" | "local-apps"
    >;
    now: number;
  },
  MobileExecutionDispatchResult
>("execution_placement:submitExecutionDispatchInternal");

const mobileExecutionStatusRef = makeFunctionReference<
  "query",
  { ownerId: string; dispatchId: string },
  MobileExecutionDispatchResult | null
>("execution_placement:getExecutionDispatchStatusForOwnerInternal");

const cancelMobileExecutionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    cancelRequestId: string;
    reason?: string;
  },
  MobileExecutionDispatchResult
>("execution_placement:cancelExecutionDispatchForOwnerInternal");

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

const MAGIC_LINK_RATE_LIMIT = 3;
/** Per-IP cap on magic-link sends so one caller can't spam many addresses. */
const MAGIC_LINK_IP_RATE_LIMIT = 10;
const MAGIC_LINK_RATE_WINDOW_MS = 60_000;
const MAGIC_LINK_EXPIRY_MS = 10 * 60_000;
// Matches the `/api/auth/link/claim` window in `mobile_auth.claimLinkRequest`.
// Do not keep an independently usable callback registration any longer.
const BROWSER_SOCIAL_HANDOFF_EXPIRY_MS = 3 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * base64url(SHA-256(claimSecret)), unpadded: 43 characters. Validated in the
 * route so a malformed hash is rejected before a handoff row is created —
 * a row whose `claimHash` no client can reproduce would be unclaimable.
 */
const CLAIM_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AuthenticatedAccountOwnerResult =
  | {
      ownerId: string;
      ownerGeneration: string;
      name?: string;
      isAnonymous: boolean;
    }
  | { response: Response };

type AuthenticatedOwnerResult =
  | { ownerId: string; name?: string; isAnonymous: boolean }
  | { response: Response };

type AnonymousLinkOwnerBinding =
  | { fromOwnerId?: string; fromAuthUserId?: string }
  | { response: Response };

const BEARER_AUTHORIZATION_PATTERN = /^Bearer\s+\S+$/i;

const resolveAnonymousLinkOwnerBinding = async (
  ctx: ActionCtx,
  request: Request,
  origin: string | null,
  requireAnonymousOwner: boolean,
): Promise<AnonymousLinkOwnerBinding> => {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  let identity: Awaited<ReturnType<typeof getUserIdentityOrNullAction>> = null;
  try {
    identity = await getUserIdentityOrNullAction(ctx);
  } catch {
    // Invalid/expired JWTs are credentials, so never echo or log their value.
    return {
      response: errorResponse(
        401,
        "The anonymous session could not be verified.",
        origin,
      ),
    };
  }
  const decision = decideAnonymousLinkBinding({
    hasAuthorizationHeader: authorization.length > 0,
    hasBearerAuthorization: BEARER_AUTHORIZATION_PATTERN.test(authorization),
    ...(identity ? { identityOwnerId: identity.tokenIdentifier } : {}),
    identityIsAnonymous: identity ? isAnonymousIdentity(identity) : false,
    requireAnonymousOwner,
  });
  if (!decision.ok) {
    return {
      response: errorResponse(
        401,
        decision.reason === "invalid_authorization"
          ? "The anonymous session could not be verified."
          : "An authenticated anonymous session is required to preserve this conversation.",
        origin,
      ),
    };
  }
  return decision.fromOwnerId
    ? {
        fromOwnerId: decision.fromOwnerId,
        ...(identity && typeof identity.subject === "string"
          ? { fromAuthUserId: identity.subject }
          : {}),
      }
    : {};
};

const readBetterAuthResponseHeader = (
  result: unknown,
  wantedName: string,
): string => {
  if (!result || typeof result !== "object") return "";
  const headers = (result as { headers?: unknown }).headers;
  if (headers instanceof Headers) {
    return headers.get(wantedName)?.trim() ?? "";
  }
  const headersList = (
    headers as { _headersList?: Array<[string, string]> } | null | undefined
  )?._headersList;
  if (!Array.isArray(headersList)) return "";
  const normalizedWantedName = wantedName.toLowerCase();
  return (
    headersList
      .find(([name]) => name.toLowerCase() === normalizedWantedName)?.[1]
      ?.trim() ?? ""
  );
};

/**
 * The opaque bearer token the `bearer()` plugin emits for a newly established
 * session. This replaces reading `set-better-auth-cookie` / `set-cookie`:
 * native clients have no cookie jar, and the cookie mirroring that emulated
 * one is gone.
 */
const readBetterAuthSessionToken = (result: unknown): string =>
  readBetterAuthResponseHeader(result, "set-auth-token");

const readBetterAuthResponseUserId = (result: unknown): string => {
  if (!result || typeof result !== "object") return "";
  const response = (result as { response?: unknown }).response;
  if (!response || typeof response !== "object") return "";
  const user = (response as { user?: unknown }).user;
  if (!user || typeof user !== "object") return "";
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id.trim() : "";
};

const browserAuthBridgeResponse = (
  status: number,
  location?: string,
): Response => {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (location) headers.set("Location", location);
  return new Response(null, { status, headers });
};

const authNoStoreJsonResponse = (
  data: unknown,
  status: number,
  origin: string | null,
): Response => {
  const response = jsonResponse(data, status, origin);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

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
): Promise<AuthenticatedAccountOwnerResult> => {
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

  const [lifecycle, migrationFenced] = await Promise.all([
    ctx.runQuery(internal.owner_lifecycle.getOwnerDataAccessStateInternal, {
      ownerId: identity.tokenIdentifier,
    }),
    ctx.runQuery(internal.auth.hasOwnerMigrationWriteFenceInternal, {
      ownerId: identity.tokenIdentifier,
    }),
  ]);
  if (!lifecycle.allowed || migrationFenced) {
    return {
      response: errorResponse(
        409,
        migrationFenced
          ? "This account is being linked. Refresh authentication and retry."
          : "Account data is currently being reset or deleted.",
        origin,
      ),
    };
  }

  return {
    ownerId: identity.tokenIdentifier,
    ownerGeneration: lifecycle.generation,
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

const createOfflineChatBilling = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  ownerGeneration: string;
  requestId: string;
  context: ReturnType<typeof buildOfflineChatContext>;
  configs: readonly ResolvedModelConfig[];
}): Promise<ManagedModelBillingContext> => {
  const inputTokens = estimateManagedContextInputTokens(args.context);
  const fallbackCostMicroCentsByModel = Object.fromEntries(
    args.configs.map((config) => [
      config.model,
      estimateManagedModelFallbackCostMicroCents({
        model: config.model,
        inputTokens,
        maxOutputTokens: config.maxOutputTokens ?? 32_768,
      }),
    ]),
  );
  const binding = await bindManagedProviderRequest(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    route: "mobile_offline_chat",
    requestId: args.requestId,
    canonicalBody: JSON.stringify({
      version: 1,
      context: args.context,
      configs: args.configs,
    }),
  });
  if (binding.replayed) {
    throw new ConvexError({
      code: "REQUEST_ALREADY_ACCEPTED",
      message: "This mobile request was already accepted.",
    });
  }
  return {
    requestFingerprint: binding.requestFingerprint,
    agentType: "service:offline_chat",
    fallbackCostMicroCents: Math.max(
      ...Object.values(fallbackCostMicroCentsByModel),
    ),
    fallbackCostMicroCentsByModel,
  };
};

const generateOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: OfflineChatImage[];
  model?: string | null;
  requestId: string;
  signal?: AbortSignal;
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
  const capabilityError = offlineImageCapabilityError(
    primaryConfig,
    args.images,
  );
  if (capabilityError) {
    throw new ConvexError({
      code: "UNSUPPORTED_INPUT_MODALITY",
      message: capabilityError,
    });
  }

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
  const usableFallback =
    fallbackConfig &&
    (args.images.length === 0 || modelSupportsOfflineImages(fallbackConfig))
      ? fallbackConfig
      : undefined;
  const billing = await createOfflineChatBilling({
    ctx: args.ctx,
    ownerId: args.ownerId,
    ownerGeneration: modelAccess.ownerGeneration,
    requestId: args.requestId,
    context,
    configs: usableFallback
      ? [primaryConfig, usableFallback]
      : [primaryConfig],
  });
  const dispatchGuard = createManagedUsageDispatchGuard(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: modelAccess.ownerGeneration,
    spanExecution: true,
  });
  let outcome: ManagedDispatchOutcome = "failed";
  try {
    const result = await completeManagedChat({
      config: primaryConfig,
      fallbackConfig: usableFallback,
      context,
      request: { signal: args.signal },
      billing,
      dispatchGuard,
    });
    const text = assistantText(result);
    outcome = "succeeded";
    return text || "I'm here, but I couldn't generate a reply right now.";
  } catch (error) {
    outcome = dispatchGuard.signal.aborted ? "aborted" : "failed";
    throw error;
  } finally {
    await dispatchGuard.finishExecution?.(outcome);
  }
};

const streamOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: OfflineChatImage[];
  model?: string | null;
  requestId: string;
  origin: string | null;
  signal?: AbortSignal;
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
  const capabilityError = offlineImageCapabilityError(config, args.images);
  if (capabilityError) {
    return errorResponse(422, capabilityError, args.origin);
  }
  const fallbackConfig = await resolveFallbackConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess },
  );
  const usableFallback =
    fallbackConfig &&
    (args.images.length === 0 || modelSupportsOfflineImages(fallbackConfig))
      ? fallbackConfig
      : undefined;

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
  const billing = await createOfflineChatBilling({
    ctx: args.ctx,
    ownerId: args.ownerId,
    ownerGeneration: modelAccess.ownerGeneration,
    requestId: args.requestId,
    context,
    configs: usableFallback ? [config, usableFallback] : [config],
  });

  const dispatchGuard = createManagedUsageDispatchGuard(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: modelAccess.ownerGeneration,
    spanExecution: true,
  });
  const readable = new ReadableStream({
    async start(controller) {
      let outcome: ManagedDispatchOutcome = "failed";
      let closed = false;
      let sawProviderError = false;
      const enqueue = (value: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(value);
        } catch {
          closed = true;
        }
      };
      try {
        const eventStream = streamManagedChat({
          config,
          fallbackConfig: usableFallback,
          context,
          request: { signal: args.signal },
          billing,
          dispatchGuard,
        });
        // Assistant text is delivered whole: deltas buffer here and leave as
        // one `{ t }` frame per text block once the block closes. `done` needs
        // no branch of its own — exact provider usage is captured by the
        // physical receipt before that event leaves the managed stream.
        const textFramer = createAssistantTextFramer();
        for await (const event of eventStream) {
          for (const segment of textFramer.accept(event)) {
            enqueue(encodeSseData({ t: segment }));
          }
          if (event.type === "error") {
            sawProviderError = true;
            enqueue(encodeSseData({ error: "Stream failed" }));
          }
        }
        outcome = sawProviderError ? "failed" : "succeeded";
        enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } catch (error) {
        outcome = dispatchGuard.signal.aborted ? "aborted" : "failed";
        console.error("[mobile/offline-chat-stream] Error:", error);
        enqueue(encodeSseData({ error: "Stream failed" }));
        enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // Client cancellation already closed the response body.
          }
          closed = true;
        }
        await dispatchGuard.finishExecution?.(outcome);
      }
    },
  });

  return sseResponse(readable, args.origin);
};

export const registerMobileRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/mobile/offline-chat",
    "/api/mobile/offline-chat/stream",
    "/api/mobile/execution/submit",
    "/api/mobile/execution/status",
    "/api/mobile/execution/cancel",
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
    path: "/api/mobile/execution/submit",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) return owner.response;

        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_execution_submit",
          key: owner.ownerId,
          limit: MOBILE_EXECUTION_SUBMIT_RATE_LIMIT,
          windowMs: MOBILE_EXECUTION_SUBMIT_RATE_WINDOW_MS,
          blockMs: MOBILE_EXECUTION_SUBMIT_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: Record<string, unknown>;
        try {
          const parsed = await request.json();
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return errorResponse(400, "Invalid JSON body", origin);
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const desktopDeviceId = normalizeDeviceId(body.desktopDeviceId);
        const desktopGrantWasSupplied =
          body.desktopDeviceId !== undefined &&
          body.desktopDeviceId !== null &&
          body.desktopDeviceId !== "";
        const idempotencyKey =
          typeof body.idempotencyKey === "string"
            ? body.idempotencyKey.trim()
            : "";
        const payloadJson =
          typeof body.payloadJson === "string" ? body.payloadJson : "";
        const payloadHash =
          typeof body.payloadHash === "string"
            ? body.payloadHash.trim().toLowerCase()
            : "";
        const conversationId =
          typeof body.conversationId === "string"
            ? body.conversationId.trim()
            : "";
        const kind = body.kind;
        const subject = body.subject;
        if (
          (desktopGrantWasSupplied && !desktopDeviceId) ||
          !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
          !payloadJson ||
          !/^[a-f0-9]{64}$/.test(payloadHash) ||
          !conversationId ||
          (kind !== "chat" && kind !== "agent") ||
          (subject !== "portable" &&
            subject !== "computer" &&
            subject !== "cloud")
        ) {
          return errorResponse(
            400,
            "A valid optional desktop grant, idempotency key, payload, conversation, kind, and execution subject are required.",
            origin,
          );
        }

        const challenge = [
          "execution-placement-v1",
          idempotencyKey,
          conversationId,
          payloadHash,
          kind,
          subject,
        ].join(":");
        const paired = desktopDeviceId
          ? await requirePairedMobileCredentials(ctx, request, {
              ownerId: owner.ownerId,
              desktopDeviceId,
              origin,
              proofChallenge: challenge,
            })
          : undefined;
        if (paired && "response" in paired) return paired.response;

        const allowedCapabilities = new Set([
          "chat",
          "agent",
          "computer-use",
          "local-files",
          "local-apps",
        ] as const);
        if (
          body.requiredCapabilities !== undefined &&
          (!Array.isArray(body.requiredCapabilities) ||
            body.requiredCapabilities.length > 8 ||
            body.requiredCapabilities.some(
              (capability) =>
                typeof capability !== "string" ||
                !allowedCapabilities.has(
                  capability as
                    | "chat"
                    | "agent"
                    | "computer-use"
                    | "local-files"
                    | "local-apps",
                ),
            ))
        ) {
          return errorResponse(
            400,
            "Execution capabilities contain an unsupported requirement.",
            origin,
          );
        }
        const requiredCapabilities = [
          ...new Set(
            (body.requiredCapabilities ?? []) as Array<
              "chat" | "agent" | "computer-use" | "local-files" | "local-apps"
            >,
          ),
        ];
        const parentTurnId =
          typeof body.parentTurnId === "string" && body.parentTurnId.trim()
            ? body.parentTurnId.trim().slice(0, 256)
            : undefined;
        const threadId =
          typeof body.threadId === "string" && body.threadId.trim()
            ? body.threadId.trim().slice(0, 256)
            : undefined;
        const lifecycle = await ctx.runQuery(
          internal.owner_lifecycle.getOwnerDataAccessStateInternal,
          { ownerId: owner.ownerId },
        );
        if (!lifecycle.allowed) {
          return errorResponse(
            409,
            "Account data is currently being reset or deleted.",
            origin,
          );
        }

        try {
          const result = await ctx.runMutation(submitMobileExecutionRef, {
            ownerId: owner.ownerId,
            ownerGeneration: lifecycle.generation,
            idempotencyKey,
            payloadJson,
            payloadHash,
            kind,
            ingress: "mobile",
            subject,
            conversationId,
            ...(parentTurnId ? { parentTurnId } : {}),
            ...(threadId ? { threadId } : {}),
            ...(paired && desktopDeviceId
              ? {
                  requestingDeviceId: paired.mobileDeviceId,
                  pairGrantDeviceId: desktopDeviceId,
                }
              : {}),
            requiredCapabilities,
            now: Date.now(),
          });
          return jsonResponse(result, 202, origin);
        } catch (error) {
          const data =
            error && typeof error === "object"
              ? (error as { data?: { code?: unknown } }).data
              : undefined;
          const status = data?.code === "CONFLICT" ? 409 : 400;
          return errorResponse(
            status,
            readConvexErrorMessage(error, "Execution admission failed."),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/execution/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) return owner.response;
        const dispatchId = new URL(request.url).searchParams
          .get("dispatchId")
          ?.trim();
        if (!dispatchId || dispatchId.length > 64) {
          return errorResponse(
            400,
            "A valid execution dispatch is required.",
            origin,
          );
        }
        try {
          const result = await ctx.runQuery(mobileExecutionStatusRef, {
            ownerId: owner.ownerId,
            dispatchId,
          });
          return jsonResponse(result, 200, origin);
        } catch (error) {
          const code = readConvexErrorCode(error);
          return errorResponse(
            code === "OWNERSHIP_MIGRATED" ? 409 : 400,
            readConvexErrorMessage(error, "Execution status is unavailable."),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/execution/cancel",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) return owner.response;
        let body: Record<string, unknown>;
        try {
          const parsed = await request.json();
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return errorResponse(400, "Invalid JSON body", origin);
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const dispatchId =
          typeof body.dispatchId === "string" ? body.dispatchId.trim() : "";
        const cancelRequestId =
          typeof body.cancelRequestId === "string"
            ? body.cancelRequestId.trim()
            : "";
        const reason =
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim().slice(0, 512)
            : undefined;
        if (
          !dispatchId ||
          dispatchId.length > 64 ||
          !cancelRequestId ||
          cancelRequestId.length > 128
        ) {
          return errorResponse(
            400,
            "A valid execution dispatch and cancellation identity are required.",
            origin,
          );
        }
        const lifecycle = await ctx.runQuery(
          internal.owner_lifecycle.getOwnerDataAccessStateInternal,
          { ownerId: owner.ownerId },
        );
        if (!lifecycle.allowed) {
          return errorResponse(
            409,
            "Account data is currently being reset or deleted.",
            origin,
          );
        }
        try {
          const result = await ctx.runMutation(cancelMobileExecutionRef, {
            ownerId: owner.ownerId,
            ownerGeneration: lifecycle.generation,
            dispatchId,
            cancelRequestId,
            ...(reason ? { reason } : {}),
          });
          return jsonResponse(result, 200, origin);
        } catch (error) {
          const code = readConvexErrorCode(error);
          return errorResponse(
            code === "CONFLICT" || code === "OWNERSHIP_MIGRATED" ? 409 : 400,
            readConvexErrorMessage(error, "Execution cancellation failed."),
            origin,
          );
        }
      }),
    ),
  });

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

        if (owner.isAnonymous) {
          const ipKey = getClientAddressKey(request);
          if (ipKey) {
            const ipLimitResponse = await enforceHttpRateLimit(ctx, origin, {
              scope: "mobile_offline_chat_ip",
              key: ipKey,
              limit: OFFLINE_CHAT_ANON_IP_RATE_LIMIT,
              windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
              blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
            });
            if (ipLimitResponse) return ipLimitResponse;
          }
        }

        const bodyResult = await readJsonBody<{
          requestId?: unknown;
          message?: unknown;
          history?: unknown;
          images?: unknown;
          model?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;
        const requestId =
          typeof body?.requestId === "string" ? body.requestId.trim() : "";
        if (!MANAGED_PROVIDER_REQUEST_ID_PATTERN.test(requestId)) {
          return errorResponse(400, "A valid requestId is required", origin);
        }

        const message =
          typeof body?.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body?.history);
        const imageResult = parseOfflineImages(body?.images);
        if (!imageResult.ok) {
          return errorResponse(400, imageResult.error, origin);
        }
        const images = imageResult.images;
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
            requestId,
            signal: request.signal,
          });
          return jsonResponse({ text }, 200, origin);
        } catch (error) {
          console.error("[mobile/offline-chat] Error:", error);
          const code = readConvexErrorCode(error);
          const status =
            code === "USAGE_LIMIT_REACHED"
              ? 429
              : code === "IDEMPOTENCY_CONFLICT" ||
                  code === "REQUEST_ALREADY_ACCEPTED"
                ? 409
              : code === "UNSUPPORTED_INPUT_MODALITY"
                ? 422
                : 500;
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

        if (owner.isAnonymous) {
          const ipKey = getClientAddressKey(request);
          if (ipKey) {
            const ipLimitResponse = await enforceHttpRateLimit(ctx, origin, {
              scope: "mobile_offline_chat_ip",
              key: ipKey,
              limit: OFFLINE_CHAT_ANON_IP_RATE_LIMIT,
              windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
              blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
            });
            if (ipLimitResponse) return ipLimitResponse;
          }
        }

        const bodyResult = await readJsonBody<{
          requestId?: unknown;
          message?: unknown;
          history?: unknown;
          images?: unknown;
          model?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;
        const requestId =
          typeof body.requestId === "string" ? body.requestId.trim() : "";
        if (!MANAGED_PROVIDER_REQUEST_ID_PATTERN.test(requestId)) {
          return errorResponse(400, "A valid requestId is required", origin);
        }

        const message =
          typeof body.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body.history);
        const imageResult = parseOfflineImages(body.images);
        if (!imageResult.ok) {
          return errorResponse(400, imageResult.error, origin);
        }
        const images = imageResult.images;
        const model = typeof body.model === "string" ? body.model : null;

        if (!message && images.length === 0) {
          return errorResponse(400, "Message or image required", origin);
        }

        try {
          return await streamOfflineReply({
            ctx,
            ownerId: owner.ownerId,
            userName: owner.name,
            message,
            isAnonymous: owner.isAnonymous,
            history,
            images,
            model,
            requestId,
            origin,
            signal: request.signal,
          });
        } catch (error) {
          const code = readConvexErrorCode(error);
          return errorResponse(
            code === "IDEMPOTENCY_CONFLICT" ||
              code === "REQUEST_ALREADY_ACCEPTED"
              ? 409
              : 500,
            readConvexErrorMessage(error, "Could not send your message"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/transcribe",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // Composer dictation is free on every plan. Identity resolution stays
        // in place for attribution and abuse controls, but there is no paid
        // subscription/capability check on this transcription-only route.
        const owner = await resolveMobileOwnerOrGuest(ctx, request, origin);
        if ("response" in owner) {
          return owner.response;
        }

        // Composer dictation goes straight to xAI Grok STT — the same
        // transport desktop dictation uses (`lib/xai_stt`), not the managed
        // chat gateway.
        const apiKey = resolveXaiSttApiKey();
        if (!apiKey) {
          console.error("[mobile/transcribe] Missing XAI_API_KEY");
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

        if (owner.isAnonymous) {
          const ipKey = getClientAddressKey(request);
          if (ipKey) {
            const ipLimitResp = await enforceHttpRateLimit(ctx, origin, {
              scope: "mobile_transcribe_ip",
              key: ipKey,
              limit: TRANSCRIBE_ANON_IP_RATE_LIMIT,
              windowMs: TRANSCRIBE_RATE_WINDOW_MS,
              blockMs: TRANSCRIBE_RATE_WINDOW_MS,
            });
            if (ipLimitResp) return ipLimitResp;
          }
        }

        const bodyResult = await readJsonBody<{
          requestId?: unknown;
          audio?: unknown;
          format?: unknown;
          language?: unknown;
        }>(request, origin, "Invalid request body");
        if (!bodyResult.ok) return bodyResult.response;
        const body = bodyResult.body;
        const requestId =
          typeof body.requestId === "string" ? body.requestId.trim() : "";
        if (!MANAGED_PROVIDER_REQUEST_ID_PATTERN.test(requestId)) {
          return errorResponse(400, "A valid requestId is required", origin);
        }

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

        const modelAccess = await resolveManagedModelAccess(
          ctx,
          owner.ownerId,
          { isAnonymous: owner.isAnonymous },
        );
        if (!modelAccess.allowed) {
          return errorResponse(429, modelAccess.message, origin);
        }

        // Reject malformed audio before a binding or lease exists: a
        // client-side encoding bug must not burn the request id or cost the
        // user a billed attempt.
        try {
          assertXaiSttAudioBase64(audio);
        } catch {
          return errorResponse(400, "Invalid audio data", origin);
        }

        // xAI's STT endpoint takes multipart/form-data, so there is no JSON
        // wire body to fingerprint. This canonical envelope stands in for it:
        // a retry of the same request id carrying different audio, container,
        // or language still conflicts.
        const canonicalBody = JSON.stringify({
          provider: "xai",
          model: XAI_STT_MODEL_LABEL,
          audio,
          format,
          ...(language ? { language } : {}),
        });
        let binding: Awaited<ReturnType<typeof bindManagedProviderRequest>>;
        try {
          binding = await bindManagedProviderRequest(ctx, {
            ownerId: owner.ownerId,
            ownerGeneration: modelAccess.ownerGeneration,
            route: "mobile_transcription",
            requestId,
            canonicalBody,
          });
          if (binding.replayed) {
            throw new ConvexError({
              code: "REQUEST_ALREADY_ACCEPTED",
              message: "This transcription request was already accepted.",
            });
          }
        } catch (error) {
          const code = readConvexErrorCode(error);
          return errorResponse(
            code === "IDEMPOTENCY_CONFLICT" ||
              code === "REQUEST_ALREADY_ACCEPTED"
              ? 409
              : 400,
            readConvexErrorMessage(error, "Invalid transcription request"),
            origin,
          );
        }
        const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
          ownerId: owner.ownerId,
          ownerGeneration: modelAccess.ownerGeneration,
          spanExecution: true,
        });
        const fallbackCostMicroCents = Math.max(
          1,
          dollarsToMicroCents(
            Math.max(1, (audio.length * 0.75) / (16_000 * 2)) *
              XAI_STT_USD_PER_SECOND,
          ),
        );
        const billing = {
          kind: MANAGED_USAGE_BILLING_KIND,
          requestFingerprint: binding.requestFingerprint,
          agentType: "service:mobile_dictation",
          model: XAI_STT_MODEL_LABEL,
          fallbackCostMicroCents,
        } as const;

        const startedAt = Date.now();
        let executionOutcome: ManagedDispatchOutcome = "failed";
        try {
          const result = await runManagedDispatchAttempt({
            dispatchGuard,
            callerSignal: request.signal,
            billing,
            run: async (signal, receipt) => {
              let transcription;
              try {
                transcription = await transcribeWithXaiRest({
                  apiKey,
                  audioBase64: audio,
                  audioFormat: format,
                  ...(language ? { language } : {}),
                  signal,
                });
              } catch (error) {
                if (error instanceof XaiSttError && error.kind === "upstream") {
                  console.error(
                    "[mobile/transcribe] xAI STT returned",
                    error.upstreamStatus,
                    error.upstreamBody?.slice(0, 500) ?? "",
                  );
                }
                await receipt.captureUsage({
                  durationMs: Date.now() - startedAt,
                  success: false,
                  costMicroCents: fallbackCostMicroCents,
                });
                throw error;
              }
              // Grok STT bills audio seconds, not tokens, so the receipt
              // carries a cost with no token counts to report.
              await receipt.captureUsage({
                durationMs: Date.now() - startedAt,
                success: true,
                costMicroCents:
                  transcription.durationSeconds !== undefined
                    ? dollarsToMicroCents(
                        Math.max(0, transcription.durationSeconds) *
                          XAI_STT_USD_PER_SECOND,
                      )
                    : fallbackCostMicroCents,
              });
              return { text: transcription.text.trim() };
            },
          });
          executionOutcome = "succeeded";
          return jsonResponse(result, 200, origin);
        } catch (error) {
          if (dispatchGuard.signal.aborted || request.signal.aborted) {
            executionOutcome = "aborted";
            return errorResponse(
              409,
              "Your account changed before transcription could start. Please retry.",
              origin,
            );
          }
          if (isRetryableProviderError(error)) {
            executionOutcome = "outcome_unknown";
          }
          // The upstream status/body was already logged inside `run`.
          if (!(error instanceof XaiSttError && error.kind === "upstream")) {
            console.error("[mobile/transcribe] Error:", error);
          }
          if (error instanceof XaiSttError) {
            if (error.kind === "invalid_base64") {
              return errorResponse(400, "Invalid audio data", origin);
            }
            if (error.kind === "upstream") {
              const status = error.upstreamStatus ?? 502;
              return errorResponse(
                status >= 400 && status < 500 ? status : 502,
                "Could not transcribe that audio. Try again.",
                origin,
              );
            }
          }
          return errorResponse(
            500,
            readConvexErrorMessage(error, "Could not transcribe that audio."),
            origin,
          );
        } finally {
          await dispatchGuard.finishExecution?.(executionOutcome);
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
              lastKnownRegistration: null,
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
            lastKnownRegistration: {
              desktopDeviceId: registration.deviceId,
              baseUrls: registration.baseUrls,
              platform: registration.platform ?? null,
              desktopPublicKey: registration.desktopPublicKey ?? null,
              updatedAt: registration.updatedAt,
            },
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
          ownerGeneration: owner.ownerGeneration,
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
              ownerGeneration: owner.ownerGeneration,
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
        const result = await ctx.runMutation(
          internal.mobile_bridge.upsertRegistration,
          {
            ownerId: owner.ownerId,
            ownerGeneration: owner.ownerGeneration,
            deviceId,
            baseUrls,
            updatedAt,
            ...(platform ? { platform } : {}),
            ...(desktopPublicKey ? { desktopPublicKey } : {}),
          },
        );

        return jsonResponse(
          {
            ok: true,
            written: result.written,
            leaseDurationMs: MOBILE_BRIDGE_LEASE_MS,
            leaseExpiresAt: result.updatedAt + MOBILE_BRIDGE_LEASE_MS,
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
          ownerGeneration: owner.ownerGeneration,
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
          ownerGeneration: owner.ownerGeneration,
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
        // A current mobile client may have reached this desktop through the
        // additive last-known descriptor after its Convex availability lease
        // expired. Direct bridge health/challenge validation establishes live
        // reachability; the durable registration remains the authority for the
        // desktop public key. Older mobile clients still receive no expired
        // top-level baseUrls and therefore never enter this path.
        if (!registration) {
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
          ownerGeneration: owner.ownerGeneration,
          desktopDeviceId,
          mobileDeviceId: paired.mobileDeviceId,
          seenAt: now,
        });

        const session = await ctx.runMutation(
          internal.mobile_bridge.createSession,
          {
            ownerId: owner.ownerId,
            ownerGeneration: owner.ownerGeneration,
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
            ownerGeneration: owner.ownerGeneration,
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
    "/api/auth/link/claim",
    "/api/auth/browser-social/start",
    "/api/auth/desktop-social/start",
  ]);

  // Register the exact web-shell return URL server-side before OAuth starts.
  // The provider callback carries only this opaque request id; the target is
  // never accepted from the callback query string.
  http.route({
    path: "/api/auth/browser-social/start",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        let body: { returnTo?: unknown } | null = null;
        try {
          body = (await request.json()) as { returnTo?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const returnTo = normalizeBrowserAuthReturnTarget({
          rawReturnTo:
            typeof body?.returnTo === "string" ? body.returnTo.trim() : "",
          requestOrigin: origin ?? "",
        });
        if (!returnTo || !origin) {
          return errorResponse(
            400,
            "Invalid browser auth return target.",
            origin,
          );
        }

        const ownerBinding = await resolveAnonymousLinkOwnerBinding(
          ctx,
          request,
          origin,
          true,
        );
        if ("response" in ownerBinding || !ownerBinding.fromOwnerId) {
          return "response" in ownerBinding
            ? ownerBinding.response
            : errorResponse(
                401,
                "An authenticated anonymous session is required to preserve this conversation.",
                origin,
              );
        }

        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "browser_social_auth_start",
          key: getClientAddressKey(request) ?? ownerBinding.fromOwnerId,
          limit: MAGIC_LINK_RATE_LIMIT,
          windowMs: MAGIC_LINK_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const authBaseUrl = getAuthBaseUrl().replace(/\/+$/, "");
        const requestId = crypto.randomUUID();
        const now = Date.now();
        const created = await ctx.runMutation(
          internal.mobile_auth.createBrowserSocialHandoff,
          {
            requestId,
            provider: "google",
            fromOwnerId: ownerBinding.fromOwnerId,
            returnOrigin: origin,
            returnTo,
            expiresAt: now + BROWSER_SOCIAL_HANDOFF_EXPIRY_MS,
            createdAt: now,
          },
        );
        if (!created.ok) {
          return errorResponse(
            409,
            "Account connection is unavailable while account data is changing.",
            origin,
          );
        }
        await ctx.scheduler.runAfter(
          BROWSER_SOCIAL_HANDOFF_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupBrowserSocialHandoff,
          { requestId },
        );
        return authNoStoreJsonResponse(
          {
            callbackURL: `${authBaseUrl}/api/auth/browser-social/verify?requestId=${encodeURIComponent(requestId)}`,
          },
          200,
          origin,
        );
      }),
    ),
  });

  // Better Auth's provider hook currently appends its one-time credential as
  // `?ott=`. This no-render route consumes that query before any app shell or
  // third-party asset loads, then redirects to the registered target with the
  // credential in a fragment. The registration is atomically single-use.
  http.route({
    path: "/api/auth/browser-social/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestIds = url.searchParams.getAll("requestId");
      const tokens = url.searchParams.getAll("ott");
      const hasUnexpectedParameter = Array.from(url.searchParams.keys()).some(
        (key) => key !== "requestId" && key !== "ott",
      );
      const requestId = requestIds[0] ?? "";
      const token = tokens[0] ?? "";
      if (
        requestIds.length !== 1 ||
        tokens.length !== 1 ||
        hasUnexpectedParameter ||
        !requestId ||
        !BROWSER_AUTH_HANDOFF_TOKEN_PATTERN.test(token)
      ) {
        return browserAuthBridgeResponse(400);
      }

      const handoff = await ctx.runMutation(
        internal.mobile_auth.consumeBrowserSocialHandoff,
        { requestId, nowMs: Date.now() },
      );
      if (!handoff.ok) {
        return browserAuthBridgeResponse(
          handoff.reason === "not_found" ? 400 : 410,
        );
      }
      const returnTo = normalizeBrowserAuthReturnTarget({
        rawReturnTo: handoff.returnTo,
        requestOrigin: handoff.returnOrigin,
      });
      const redirect = returnTo
        ? buildBrowserAuthFragmentRedirect({ returnTo, token })
        : null;
      return redirect
        ? browserAuthBridgeResponse(302, redirect)
        : browserAuthBridgeResponse(400);
    }),
  });

  // Start a desktop social sign-in and return a requestId for polling. The
  // OAuth callback lands on `/api/auth/desktop-social/verify`, where the OTT is
  // exchanged server-side for a bearer token encrypted into the claim row.
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

        let socialClaimHash = "";
        try {
          const body = (await request.json()) as { claimHash?: unknown };
          if (typeof body?.claimHash === "string") {
            socialClaimHash = body.claimHash.trim();
          }
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        if (!CLAIM_HASH_PATTERN.test(socialClaimHash)) {
          return errorResponse(400, "A valid claimHash is required", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();
        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email: "desktop-social:google",
          requestId,
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
          claimHash: socialClaimHash,
        });

        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        return authNoStoreJsonResponse(
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
        let body: {
          email?: unknown;
          requireAnonymousOwner?: unknown;
          claimHash?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            email?: unknown;
            requireAnonymousOwner?: unknown;
            claimHash?: unknown;
          };
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
        const claimHash =
          typeof body?.claimHash === "string" ? body.claimHash.trim() : "";
        if (!CLAIM_HASH_PATTERN.test(claimHash)) {
          return errorResponse(400, "A valid claimHash is required", origin);
        }
        if (
          body?.requireAnonymousOwner !== undefined &&
          typeof body.requireAnonymousOwner !== "boolean"
        ) {
          return errorResponse(
            400,
            "requireAnonymousOwner must be a boolean.",
            origin,
          );
        }

        const ownerBinding = await resolveAnonymousLinkOwnerBinding(
          ctx,
          request,
          origin,
          body?.requireAnonymousOwner === true,
        );
        if ("response" in ownerBinding) {
          return ownerBinding.response;
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

        const ipKey = getClientAddressKey(request);
        if (ipKey) {
          const ipRateLimit = await consumeWebhookRateLimit(ctx, {
            scope: "mobile_magic_link_ip",
            key: ipKey,
            limit: MAGIC_LINK_IP_RATE_LIMIT,
            windowMs: MAGIC_LINK_RATE_WINDOW_MS,
            blockMs: MAGIC_LINK_RATE_WINDOW_MS,
          });
          if (!ipRateLimit.allowed) {
            return withCors(
              rateLimitResponse(ipRateLimit.retryAfterMs),
              origin,
            );
          }
        }

        const authBaseUrl = getAuthBaseUrl();
        if (!authBaseUrl) {
          console.error("[mobile/auth] Missing auth base URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();

        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email,
          requestId,
          ...(ownerBinding.fromOwnerId
            ? { fromOwnerId: ownerBinding.fromOwnerId }
            : {}),
          ...(ownerBinding.fromAuthUserId
            ? { fromAuthUserId: ownerBinding.fromAuthUserId }
            : {}),
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
          claimHash,
        });

        // Schedule cleanup before attempting the send so a failed send
        // doesn't leak the pending row forever.
        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        try {
          const auth = createAuth(ctx);
          const callbackURL = `${authBaseUrl}/api/auth/link/verify?requestId=${encodeURIComponent(requestId)}`;
          await auth.api.signInMagicLink({
            body: { email, callbackURL },
            headers: new Headers({ origin: authBaseUrl }),
          });
        } catch (error) {
          console.error("[mobile/auth] Failed to send magic link:", error);
          return errorResponse(500, "Failed to send sign-in email.", origin);
        }

        return authNoStoreJsonResponse({ requestId }, 200, origin);
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

        return authNoStoreJsonResponse(result, 200, origin);
      }),
    ),
  });

  // Browser landing after desktop social auth. The one-time-token plugin
  // appends ?ott=... to this URL after the provider flow completes.
  http.route({
    path: "/api/auth/desktop-social/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionToken = "";
        let connectedUserId = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          sessionToken = readBetterAuthSessionToken(verifyRes);
          connectedUserId = readBetterAuthResponseUserId(verifyRes);
        } catch {
          // Never attach the thrown value here: provider errors may echo the
          // one-time credential that arrived in the request query string.
          console.error("[desktop/auth] Server-side OTT verification failed");
        }
        if (sessionToken && connectedUserId) {
          const completion = await ctx.runMutation(
            internal.mobile_auth.completeLinkRequest,
            {
              requestId,
              tokenEnc: await encryptHandoffToken(sessionToken),
              toOwnerId: tokenIdentifierForBetterAuthUserId(connectedUserId),
            },
          );
          if (!completion.ok) {
            console.error(
              `[desktop/auth] Link request completion rejected: ${completion.reason}`,
            );
          }
        }
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
  // The one-time-token plugin appends ?ott=... to this URL after verifying the
  // token. The OTT is exchanged for the opaque bearer server-side and stored
  // encrypted, so the row is claimable only by the holder of the claim secret.
  http.route({
    path: "/api/auth/link/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionToken = "";
        let connectedUserId = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          sessionToken = readBetterAuthSessionToken(verifyRes);
          connectedUserId = readBetterAuthResponseUserId(verifyRes);
        } catch {
          // Keep credentials out of logs even when the auth library includes
          // request input in its thrown error.
          console.error("[mobile/auth] Server-side OTT verification failed");
        }
        if (sessionToken && connectedUserId) {
          const completion = await ctx.runMutation(
            internal.mobile_auth.completeLinkRequest,
            {
              requestId,
              tokenEnc: await encryptHandoffToken(sessionToken),
              toOwnerId: tokenIdentifierForBetterAuthUserId(connectedUserId),
            },
          );
          if (!completion.ok) {
            console.error(
              `[mobile/auth] Link request completion rejected: ${completion.reason}`,
            );
          }
        }
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
