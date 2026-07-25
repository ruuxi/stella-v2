import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import { errorResponse } from "../http_shared/cors";
import { getClientAddressKey } from "../lib/http_utils";
import {
  resolveManagedGatewayApiKey,
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import { resolveManagedModelAccess } from "../lib/managed_billing";
import { resolveEngineAccess } from "../cloud_engines";
import { computeUsageCostMicroCents } from "../lib/billing_money";
import {
  consumeAnonymousIpAllowance,
  consumeAnonymousRequestAllowance,
  DEFAULT_RETRY_AFTER_MS,
} from "./billing";
import {
  estimateRequestTokens,
  requestedModelFromGooglePath,
  resolveRequestedStellaModel,
} from "./request";
import {
  parseRequestJson,
  type AuthorizedStellaRequest,
  type StellaRequestBody,
} from "./shared";

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
}

const providerModelPrefix: Partial<Record<ManagedGatewayProvider, string>> = {
  anthropic: "anthropic/",
  google: "google/",
  openai: "openai/",
  meta: "meta/",
};

const STELLA_RELAY_PROBE_SECRET_ENV = "STELLA_RELAY_PROBE_SECRET";
const STELLA_RELAY_PROBE_SECRET_HEADER = "x-stella-relay-probe-secret";
const STELLA_RELAY_PROBE_OWNER_ID = "probe:stella-relay";
const FIREWORKS_KIMI_K2P6_SERVICE_TIERS = new Set([
  "standard",
  "priority",
  "fast",
]);

export function toProviderNativeModel(
  model: string,
  provider: ManagedGatewayProvider,
): string {
  const prefix = providerModelPrefix[provider];
  const stripped = prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (provider === "anthropic") return stripped.replace(/\./g, "-");
  return stripped;
}
const sha256Hex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const estimatedCostMicroCents = async (
  ctx: ActionCtx,
  model: string,
  tokenEstimate: { inputTokens: number; outputTokens: number },
): Promise<number> => {
  const row = await ctx.runQuery(internal.billing.getManagedModelPrice, {
    model,
  });
  return computeUsageCostMicroCents({
    model,
    inputTokens: tokenEstimate.inputTokens,
    outputTokens: tokenEstimate.outputTokens,
    price: row
      ? {
          inputPerMillionUsd: row.inputPerMillionUsd,
          outputPerMillionUsd: row.outputPerMillionUsd,
          cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
          cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
          reasoningPerMillionUsd: row.reasoningPerMillionUsd,
        }
      : undefined,
  });
};

export async function authorizeStellaRelayRequest(args: {
  ctx: ActionCtx;
  request: Request;
  relayProvider?: ManagedGatewayProvider;
}): Promise<AuthorizedStellaRequest | Response> {
  const { ctx, request, relayProvider } = args;
  const probeSecret = process.env[STELLA_RELAY_PROBE_SECRET_ENV]?.trim();
  const probeHeader = request.headers
    .get(STELLA_RELAY_PROBE_SECRET_HEADER)
    ?.trim();
  if (probeSecret && probeHeader === probeSecret) {
    const requestJson = await parseRequestJson(request);
    if (!requestJson) {
      return stellaProviderErrorResponse(
        400,
        "Stella request body must be valid JSON",
        request,
      );
    }

    const agentType =
      request.headers.get("X-Stella-Agent-Type")?.trim() ||
      (typeof requestJson.agentType === "string" &&
      requestJson.agentType.trim().length > 0
        ? requestJson.agentType.trim()
        : undefined) ||
      "general";

    let selection: ReturnType<typeof resolveRequestedStellaModel>;
    try {
      selection = resolveRequestedStellaModel(agentType, requestJson, "ultra");
    } catch (error) {
      return stellaProviderErrorResponse(
        400,
        error instanceof Error
          ? error.message
          : "Invalid Stella model selection",
        request,
      );
    }

    const { requestedModel, resolvedModel, config } = selection;
    const resolvedProvider = resolveManagedGatewayProvider({
      model: resolvedModel,
      configuredProvider: config.managedGatewayProvider,
    });
    if (relayProvider !== undefined && resolvedProvider !== relayProvider) {
      return stellaProviderErrorResponse(
        400,
        `Stella model ${requestedModel} must use the ${resolvedProvider} relay`,
        request,
      );
    }

    const managedGateway = resolveManagedGatewayConfig({
      model: resolvedModel,
      configuredProvider: config.managedGatewayProvider,
    });
    const apiKey = resolveManagedGatewayApiKey(managedGateway);
    if (!apiKey) {
      return stellaProviderErrorResponse(
        503,
        "Stella upstream gateway is not configured",
        request,
      );
    }

    const requestedServiceTier =
      typeof requestJson.service_tier === "string"
        ? requestJson.service_tier.trim()
        : undefined;
    const serviceTier =
      resolvedProvider === "fireworks" &&
      requestedServiceTier &&
      FIREWORKS_KIMI_K2P6_SERVICE_TIERS.has(requestedServiceTier)
        ? requestedServiceTier
        : config.serviceTier;

    console.log(
      `[stella-provider:probe] agent=${agentType} | requestedModel=${requestedModel} | resolvedModel=${resolvedModel} | gateway=${resolvedProvider} | serviceTier=${serviceTier ?? "default"}`,
    );

    return {
      ownerId: STELLA_RELAY_PROBE_OWNER_ID,
      agentType,
      relayProvider: resolvedProvider,
      requestJson: requestJson as StellaRequestBody,
      requestedModel,
      resolvedModel,
      upstreamModel: toProviderNativeModel(resolvedModel, resolvedProvider),
      serviceTier,
      apiKey,
      tokenEstimate: estimateRequestTokens(requestJson),
    };
  }

  // A non-JWT bearer (a cloud turn token) makes Convex's JWT parse throw;
  // treat that as "no identity" so the turn-token branch below can run.
  let identity: Awaited<ReturnType<typeof ctx.auth.getUserIdentity>> = null;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    identity = null;
  }
  let ownerId: string;
  let isAnonymous = false;
  let viaTurnToken = false;
  if (identity) {
    ownerId = identity.tokenIdentifier;
    isAnonymous = (identity as Record<string, unknown>).isAnonymous === true;
  } else {
    // Cloud executors (the orchestrator DO and sandbox agents) hold no user
    // JWT — only an opaque per-turn token whose hash Convex stored at
    // dispatch. Resolving it to its owner reuses every downstream gate
    // unchanged: plan access, usage limits, and metering all bill the owner.
    const turnToken = request.headers.get("x-stella-turn-token")?.trim();
    const tokenRow = turnToken
      ? ((await ctx.runQuery(
          internal.cloud_apps.getTurnTokenByHashInternal,
          { tokenHash: await sha256Hex(turnToken) },
        )) as { ownerId: string; turnId: string } | null)
      : null;
    if (!tokenRow) {
      return stellaProviderErrorResponse(401, "Unauthorized", request);
    }
    ownerId = tokenRow.ownerId;
    viaTurnToken = true;
  }

  // Cloud turns can run on the owner's own connected engine subscription
  // (Claude Pro/Max). This is a turn-token-only mode: the header names the
  // provider, the relay resolves the owner's stored OAuth token server-side
  // (refreshing if needed), and no managed gating/metering applies — the
  // spend is the user's subscription. Sandboxes never see the token; they
  // only carry this flag.
  const credentialHeader = request.headers
    .get("x-stella-llm-credential")
    ?.trim();
  if (credentialHeader) {
    if (!viaTurnToken) {
      return stellaProviderErrorResponse(
        403,
        "Engine credentials are only available to cloud turns",
        request,
      );
    }
    if (credentialHeader !== "anthropic") {
      return stellaProviderErrorResponse(
        403,
        `Engine "${credentialHeader}" can't run cloud turns yet`,
        request,
      );
    }
    const engineAccess = await resolveEngineAccess(
      ctx,
      ownerId,
      credentialHeader,
    );
    if (!engineAccess) {
      return stellaProviderErrorResponse(
        403,
        "No connected Claude subscription for this account. Connect it in Settings, then try again.",
        request,
      );
    }
    const credentialRequestJson = await parseRequestJson(request);
    if (!credentialRequestJson) {
      return stellaProviderErrorResponse(
        400,
        "Stella request body must be valid JSON",
        request,
      );
    }
    const credentialAgentType =
      request.headers.get("X-Stella-Agent-Type")?.trim() || "general";
    const requestedModel =
      typeof credentialRequestJson.model === "string"
        ? credentialRequestJson.model.trim()
        : "";
    // Model ids arrive as stella/anthropic/<model>; the subscription decides
    // entitlement upstream, so no audience gate applies here.
    const modelMatch = /^stella\/(anthropic\/[A-Za-z0-9._-]+)$/.exec(
      requestedModel,
    );
    if (!modelMatch) {
      return stellaProviderErrorResponse(
        400,
        "Engine-credential turns must pin a stella/anthropic/<model> id",
        request,
      );
    }
    const resolvedModel = modelMatch[1]!;
    console.log(
      `[stella-provider] agent=${credentialAgentType} | engine-credential=anthropic | resolvedModel=${resolvedModel}`,
    );
    return {
      ownerId,
      agentType: credentialAgentType,
      relayProvider: "anthropic",
      requestJson: credentialRequestJson as StellaRequestBody,
      requestedModel,
      resolvedModel,
      upstreamModel: toProviderNativeModel(resolvedModel, "anthropic"),
      apiKey: "",
      tokenEstimate: estimateRequestTokens(credentialRequestJson),
      userCredential: {
        provider: "anthropic",
        accessToken: engineAccess.accessToken,
      },
    };
  }
  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";

  if (isAnonymous) {
    const deviceId = `anon-jwt:${ownerId}`;
    const clientAddressKey = getClientAddressKey(request);
    // The per-IP counter is the durable backstop: deleting Stella data mints
    // a new anonymous identity (fresh `deviceId`), but the IP bucket persists,
    // so spam-resets from one network still hit a ceiling. Check it first so a
    // request blocked by the IP cap doesn't also burn the (fresh) per-device
    // counter. The per-device counter is the smaller per-person trial.
    const ipAllowed = await consumeAnonymousIpAllowance(ctx, clientAddressKey);
    const deviceAllowed = ipAllowed
      ? await consumeAnonymousRequestAllowance(ctx, deviceId, clientAddressKey)
      : false;
    if (!ipAllowed || !deviceAllowed) {
      return stellaProviderErrorResponse(
        429,
        "Sign in required: You've used your free Stella previews. Sign in to keep going.",
        request,
      );
    }
  } else {
    const subscriptionCheck = await resolveManagedModelAccess(ctx, ownerId);
    modelAudience = subscriptionCheck.modelAudience;

    if (!subscriptionCheck.allowed) {
      const response = stellaProviderErrorResponse(
        429,
        subscriptionCheck.message,
        request,
      );
      response.headers.set(
        "Retry-After",
        String(
          Math.ceil(
            (subscriptionCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000,
          ),
        ),
      );
      return response;
    }
  }

  const requestJson = await parseRequestJson(request);
  if (!requestJson) {
    return stellaProviderErrorResponse(
      400,
      "Stella request body must be valid JSON",
      request,
    );
  }

  const url = new URL(request.url);
  if (typeof requestJson.model !== "string") {
    const pathModel = requestedModelFromGooglePath(url.pathname);
    if (pathModel) {
      requestJson.model = pathModel;
    }
  }

  const headerAgentType = request.headers.get("X-Stella-Agent-Type")?.trim();
  const bodyAgentType =
    typeof requestJson.agentType === "string" &&
    requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : undefined;
  const agentType = headerAgentType || bodyAgentType || "general";

  let selection: ReturnType<typeof resolveRequestedStellaModel>;
  try {
    // Turn-token requests come from Stella's own cloud executors, whose
    // pinned model must be honored even for restricted audiences (free/go)
    // — the executor's adapter cannot follow an audience coercion to a
    // different provider. Scoped to CLOUD_EXECUTOR_PINNED_MODEL_IDS.
    selection = resolveRequestedStellaModel(
      agentType,
      requestJson,
      modelAudience,
      { trustedExecutorPin: viaTurnToken },
    );
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      request,
    );
  }

  const { requestedModel, resolvedModel, config } = selection;
  const resolvedProvider = resolveManagedGatewayProvider({
    model: resolvedModel,
    configuredProvider: config.managedGatewayProvider,
  });
  if (relayProvider !== undefined && resolvedProvider !== relayProvider) {
    return stellaProviderErrorResponse(
      400,
      `Stella model ${requestedModel} must use the ${resolvedProvider} relay`,
      request,
    );
  }

  const managedGateway = resolveManagedGatewayConfig({
    model: resolvedModel,
    configuredProvider: config.managedGatewayProvider,
  });
  const apiKey = resolveManagedGatewayApiKey(managedGateway);
  if (!apiKey) {
    return stellaProviderErrorResponse(
      503,
      "Stella upstream gateway is not configured",
      request,
    );
  }

  const tokenEstimate = estimateRequestTokens(requestJson);
  if (!isAnonymous) {
    const estimatedCost = await estimatedCostMicroCents(
      ctx,
      resolvedModel,
      tokenEstimate,
    );
    const limit = await ctx.runMutation(
      internal.billing.enforceManagedUsageLimit,
      {
        ownerId,
        minimumRemainingMicroCents: estimatedCost,
      },
    );
    if (!limit.allowed) {
      const response = stellaProviderErrorResponse(
        429,
        limit.message,
        request,
      );
      response.headers.set(
        "Retry-After",
        String(Math.ceil((limit.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000)),
      );
      return response;
    }
  }

  console.log(
    `[stella-provider] agent=${agentType} | requestedModel=${requestedModel} | resolvedModel=${resolvedModel} | gateway=${resolvedProvider}`,
  );

  return {
    ownerId,
    agentType,
    relayProvider: resolvedProvider,
    requestJson: requestJson as StellaRequestBody,
    requestedModel,
    resolvedModel,
    upstreamModel: toProviderNativeModel(resolvedModel, resolvedProvider),
    serviceTier: config.serviceTier,
    apiKey,
    tokenEstimate,
  };
}
