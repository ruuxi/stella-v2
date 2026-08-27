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
import { computeUsageCostMicroCents } from "../lib/billing_money";
import { resolveEngineAccess } from "../cloud_engines";
import type { CloudExecutionSelection } from "../lib/cloud_execution";
import type { ManagedProtocol } from "../runtime_ai/managed";
import { getUserIdentityOrNullAction } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import {
  validateConnectedCloudBinding,
  validateManagedCloudBinding,
  validateManagedReasoningBinding,
} from "./cloud_binding";
import { cloudTurnTokenFromRequest } from "./native_relay";
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
  deepseek: "deepseek/",
  crof: "crof/",
  wafer: "wafer/",
  xai: "x-ai/",
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

/**
 * Wafer lists its models with capitalized slugs (e.g.
 * `DeepSeek-V4-Flash-0731-Fast`) while Stella's managed ids are lowercase.
 * Send the exact upstream casing wafer's catalog advertises.
 */
const WAFER_NATIVE_MODEL_IDS: Record<string, string> = {
  "deepseek-v4-flash-0731-fast": "DeepSeek-V4-Flash-0731-Fast",
};

export function toProviderNativeModel(
  model: string,
  provider: ManagedGatewayProvider,
): string {
  const prefix = providerModelPrefix[provider];
  const stripped =
    prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (provider === "anthropic") return stripped.replace(/\./g, "-");
  if (provider === "wafer") return WAFER_NATIVE_MODEL_IDS[stripped] ?? stripped;
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

type CloudTurnAuthority = {
  kind: "turn";
  tokenHash: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  agentType: string;
  execution?: CloudExecutionSelection;
};

type IdentityAuthority = {
  kind: "identity";
  ownerId: string;
  isAnonymous: boolean;
};

export type StellaRequestAuthority = CloudTurnAuthority | IdentityAuthority;

/**
 * Re-check lifecycle state after capability lookup while retaining the exact
 * generation embedded in a cloud-turn token. A fresh lifecycle read must
 * never silently upgrade a stale token to the post-reset generation.
 */
export const resolveActiveStellaAuthorityGeneration = async (args: {
  ctx: ActionCtx;
  request: Request;
  authority: StellaRequestAuthority;
}): Promise<string | Response> => {
  const active = await assertOwnerDataAccessActive(
    args.ctx,
    args.authority.ownerId,
  );
  if (
    args.authority.kind === "turn" &&
    active.generation !== args.authority.ownerGeneration
  ) {
    return stellaProviderErrorResponse(401, "Unauthorized", args.request);
  }
  return args.authority.kind === "turn"
    ? args.authority.ownerGeneration
    : active.generation;
};

/**
 * Resolve either a normal Convex identity or an active, owner-scoped cloud
 * turn capability. The opaque turn token is looked up only by its SHA-256
 * digest; callers receive ownership/routing metadata, never the token row or
 * any account-level provider credential.
 */
export const resolveStellaRequestAuthority = async (args: {
  ctx: ActionCtx;
  request: Request;
}): Promise<StellaRequestAuthority | Response> => {
  const tokenResult = cloudTurnTokenFromRequest(args.request);
  if (!tokenResult.ok) {
    return stellaProviderErrorResponse(
      401,
      "Conflicting cloud turn credentials",
      args.request,
    );
  }

  // An opaque capability in Authorization is not a JWT. Treat identity parse
  // failure as absence and continue into the hashed capability lookup.
  let identity: Awaited<ReturnType<typeof getUserIdentityOrNullAction>> = null;
  try {
    identity = await getUserIdentityOrNullAction(args.ctx);
  } catch {
    identity = null;
  }
  if (identity) {
    return {
      kind: "identity",
      ownerId: identity.tokenIdentifier,
      isAnonymous: (identity as Record<string, unknown>).isAnonymous === true,
    };
  }

  const token = tokenResult.token;
  const tokenHash = token ? await sha256Hex(token) : undefined;
  const tokenRow = token
    ? ((await args.ctx.runQuery(
        internal.cloud_apps.getTurnTokenByHashInternal,
        {
          tokenHash: tokenHash!,
          now: Date.now(),
          requireActive: true,
        },
      )) as {
        ownerId: string;
        ownerGeneration?: string;
        turnId: string;
        agentType: string;
        execution?: CloudExecutionSelection;
      } | null)
    : null;
  if (!tokenRow?.ownerGeneration) {
    return stellaProviderErrorResponse(401, "Unauthorized", args.request);
  }
  return {
    kind: "turn",
    tokenHash: tokenHash!,
    ownerId: tokenRow.ownerId,
    ownerGeneration: tokenRow.ownerGeneration,
    turnId: tokenRow.turnId,
    agentType: tokenRow.agentType,
    execution: tokenRow.execution,
  };
};

export type CloudManagedModelResolution = {
  requestedModel: string;
  resolvedModel: string;
  relayProvider: ManagedGatewayProvider;
  api: ManagedProtocol;
};

/** Match the backend runtime's managed-protocol selection exactly. */
export const resolveCloudManagedProtocol = (args: {
  relayProvider: ManagedGatewayProvider;
  configuredApi?: ManagedProtocol;
}): ManagedProtocol => {
  if (args.configuredApi) return args.configuredApi;
  switch (args.relayProvider) {
    case "fireworks":
    case "deepseek":
    case "xai":
    case "openai":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "crof":
    case "wafer":
    case "openrouter":
    case "meta":
      return "openai-completions";
  }
};

/**
 * Resolve an executor's managed selection from its scoped turn capability.
 * The response deliberately contains routing metadata only: upstream keys and
 * connected-engine credentials remain inside Convex.
 */
export const resolveCloudManagedModelForTurn = async (args: {
  ctx: ActionCtx;
  request: Request;
  model: string;
}): Promise<CloudManagedModelResolution | Response> => {
  const authority = await resolveStellaRequestAuthority(args);
  if (authority instanceof Response) return authority;
  if (authority.kind !== "turn") {
    return stellaProviderErrorResponse(401, "Unauthorized", args.request);
  }
  const ownerGeneration = await resolveActiveStellaAuthorityGeneration({
    ...args,
    authority,
  });
  if (ownerGeneration instanceof Response) return ownerGeneration;
  const execution = authority.execution;
  if (
    !execution ||
    execution.engine !== "stella" ||
    execution.provider !== "stella" ||
    execution.model !== args.model
  ) {
    return stellaProviderErrorResponse(
      403,
      "This turn token is not authorized for the requested managed model",
      args.request,
    );
  }

  const access = await args.ctx.runMutation(
    internal.billing.resolveManagedModelAccess,
    {
      ownerId: authority.ownerId,
      ownerGeneration,
    },
  );
  if (!access.allowed) {
    const response = stellaProviderErrorResponse(
      429,
      access.message,
      args.request,
    );
    response.headers.set(
      "Retry-After",
      String(Math.ceil((access.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000)),
    );
    return response;
  }

  let selection: ReturnType<typeof resolveRequestedStellaModel>;
  try {
    selection = resolveRequestedStellaModel(
      authority.agentType,
      { model: args.model },
      access.modelAudience,
    );
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      args.request,
    );
  }
  // `resolveRequestedStellaModel` intentionally falls back for disallowed
  // client selections. A turn capability is immutable, so fail closed instead
  // of silently routing it to a different model.
  if (selection.requestedModel !== args.model) {
    return stellaProviderErrorResponse(
      403,
      `Managed model "${args.model}" is not available for this account`,
      args.request,
    );
  }
  const relayProvider = resolveManagedGatewayProvider({
    model: selection.resolvedModel,
    configuredProvider: selection.config.managedGatewayProvider,
  });
  return {
    requestedModel: selection.requestedModel,
    resolvedModel: selection.resolvedModel,
    relayProvider,
    api: resolveCloudManagedProtocol({
      relayProvider,
      configuredApi: selection.config.api,
    }),
  };
};

const estimatedCostMicroCents = async (
  ctx: ActionCtx,
  model: string,
  tokenEstimate: { inputTokens: number; outputTokens: number },
): Promise<number> => {
  const row = await ctx.runQuery(internal.billing.getManagedModelPrice, {
    model,
  });
  const costMicroCents = computeUsageCostMicroCents({
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
  if (costMicroCents <= 0) {
    throw new Error(
      `Managed relay fallback estimate for ${model} must be positive.`,
    );
  }
  return costMicroCents;
};

export async function authorizeStellaRelayRequest(args: {
  ctx: ActionCtx;
  request: Request;
  relayProvider?: ManagedGatewayProvider;
  deferAnonymousAllowance?: boolean;
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
      selection = resolveRequestedStellaModel(agentType, requestJson, "pro");
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

  const authority = await resolveStellaRequestAuthority({ ctx, request });
  if (authority instanceof Response) return authority;
  const ownerId = authority.ownerId;
  const ownerGeneration = await resolveActiveStellaAuthorityGeneration({
    ctx,
    request,
    authority,
  });
  if (ownerGeneration instanceof Response) return ownerGeneration;
  const isAnonymous =
    authority.kind === "identity" ? authority.isAnonymous : false;
  const viaTurnToken = authority.kind === "turn";
  const turnExecution =
    authority.kind === "turn" ? authority.execution : undefined;
  const turnAgentType =
    authority.kind === "turn" ? authority.agentType : undefined;

  // Connected Claude/ChatGPT access is resolved only after the scoped turn
  // capability has identified the account and immutable execution route. The
  // executor never receives the account-level OAuth token or account id.
  const credentialHeader =
    request.headers.get("x-stella-llm-credential")?.trim() ||
    (viaTurnToken && turnExecution?.engine !== "stella"
      ? turnExecution?.engine
      : undefined);
  if (credentialHeader) {
    if (!viaTurnToken) {
      return stellaProviderErrorResponse(
        403,
        "Engine credentials are only available to cloud turns",
        request,
      );
    }
    if (
      credentialHeader !== "anthropic" &&
      credentialHeader !== "openai-codex"
    ) {
      return stellaProviderErrorResponse(
        403,
        `Engine "${credentialHeader}" can't run cloud turns yet`,
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
    const requestedModel =
      typeof credentialRequestJson.model === "string"
        ? credentialRequestJson.model.trim()
        : "";
    const binding = validateConnectedCloudBinding({
      execution: turnExecution,
      credentialProvider: credentialHeader,
      requestedModel,
      requestPathname: new URL(request.url).pathname,
      requestJson: credentialRequestJson,
      anthropicBeta: request.headers.get("anthropic-beta") ?? undefined,
    });
    if (!binding.ok) {
      return stellaProviderErrorResponse(
        binding.error.status,
        binding.error.message,
        request,
      );
    }

    const credentialRelayProvider: ManagedGatewayProvider =
      credentialHeader === "anthropic" ? "anthropic" : "openai";
    if (
      relayProvider !== undefined &&
      relayProvider !== credentialRelayProvider
    ) {
      return stellaProviderErrorResponse(
        400,
        `This connected engine must use the ${credentialRelayProvider} relay`,
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
        credentialHeader === "anthropic"
          ? "No connected Claude subscription for this account. Connect it in Settings, then try again."
          : "No connected ChatGPT subscription for this account. Connect it in Settings, then try again.",
        request,
      );
    }
    if (credentialHeader === "openai-codex" && !engineAccess.accountId) {
      return stellaProviderErrorResponse(
        403,
        "The ChatGPT connection is missing its account identity. Reconnect ChatGPT, then try again.",
        request,
      );
    }

    const nativeModel = binding.nativeModel;
    const agentType = turnAgentType || "general";
    const resolvedModel =
      credentialHeader === "anthropic"
        ? `anthropic/${nativeModel}`
        : nativeModel;
    console.log(
      `[stella-provider] agent=${agentType} | engine-credential=${credentialHeader} | resolvedModel=${resolvedModel}`,
    );
    return {
      ownerId,
      ownerGeneration,
      cloudTurnId: authority.kind === "turn" ? authority.turnId : undefined,
      cloudTurnAuthority:
        authority.kind === "turn"
          ? { tokenHash: authority.tokenHash, turnId: authority.turnId }
          : undefined,
      agentType,
      relayProvider: credentialRelayProvider,
      requestJson: credentialRequestJson as StellaRequestBody,
      requestedModel,
      resolvedModel,
      upstreamModel: nativeModel,
      apiKey: "",
      tokenEstimate: estimateRequestTokens(credentialRequestJson),
      userCredential: {
        provider: credentialHeader,
        accessToken: engineAccess.accessToken,
        ...(credentialHeader === "anthropic" &&
        requestedModel.startsWith("stella/anthropic/")
          ? { injectClaudeCodeIdentity: true }
          : {}),
        ...(credentialHeader === "openai-codex"
          ? { accountId: engineAccess.accountId }
          : {}),
      },
    };
  }
  if (turnExecution && turnExecution.engine !== "stella") {
    return stellaProviderErrorResponse(
      403,
      "This cloud turn requires its connected-engine relay route",
      request,
    );
  }

  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";

  if (isAnonymous && !args.deferAnonymousAllowance) {
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
    const subscriptionCheck = await ctx.runMutation(
      internal.billing.resolveManagedModelAccess,
      { ownerId, ownerGeneration },
    );
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

  const managedBindingError = validateManagedCloudBinding({
    execution: turnExecution,
    viaTurnToken,
    requestedModel: requestJson.model,
  });
  if (managedBindingError) {
    return stellaProviderErrorResponse(
      managedBindingError.status,
      managedBindingError.message,
      request,
    );
  }

  const headerAgentType = request.headers.get("X-Stella-Agent-Type")?.trim();
  const bodyAgentType =
    typeof requestJson.agentType === "string" &&
    requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : undefined;
  const agentType =
    turnAgentType || headerAgentType || bodyAgentType || "general";

  let selection: ReturnType<typeof resolveRequestedStellaModel>;
  try {
    selection = resolveRequestedStellaModel(
      agentType,
      requestJson,
      modelAudience,
    );
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      request,
    );
  }

  if (
    viaTurnToken &&
    turnExecution?.engine === "stella" &&
    selection.requestedModel !== turnExecution.model
  ) {
    return stellaProviderErrorResponse(
      403,
      `Managed model "${turnExecution.model}" is not available for this account`,
      request,
    );
  }

  const { requestedModel, resolvedModel, config } = selection;
  const resolvedProvider = resolveManagedGatewayProvider({
    model: resolvedModel,
    configuredProvider: config.managedGatewayProvider,
  });
  if (viaTurnToken && turnExecution?.engine === "stella") {
    const reasoningError = validateManagedReasoningBinding({
      execution: turnExecution,
      relayProvider: resolvedProvider,
      resolvedModel,
      // The managed runtime's canonical model adapter marks every managed
      // model reasoning-capable and emits an explicit off form when the turn
      // selects none. Mirror that source of truth instead of guessing from a
      // mutable config or model-name heuristic, which can miss raw pins.
      reasoningCapable: true,
      requestJson,
    });
    if (reasoningError) {
      return stellaProviderErrorResponse(
        reasoningError.status,
        reasoningError.message,
        request,
      );
    }
  }
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
  const fallbackCostMicroCents = await estimatedCostMicroCents(
    ctx,
    resolvedModel,
    tokenEstimate,
  );
  if (!isAnonymous) {
    const limit = await ctx.runMutation(
      internal.billing.enforceManagedUsageLimit,
      {
        ownerId,
        ownerGeneration,
        minimumRemainingMicroCents: fallbackCostMicroCents,
      },
    );
    if (!limit.allowed) {
      const response = stellaProviderErrorResponse(429, limit.message, request);
      response.headers.set(
        "Retry-After",
        String(
          Math.ceil((limit.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000),
        ),
      );
      return response;
    }
  }

  console.log(
    `[stella-provider] agent=${agentType} | requestedModel=${requestedModel} | resolvedModel=${resolvedModel} | gateway=${resolvedProvider}`,
  );

  return {
    ownerId,
    ownerGeneration,
    isAnonymous,
    cloudTurnId: authority.kind === "turn" ? authority.turnId : undefined,
    cloudTurnAuthority:
      authority.kind === "turn"
        ? { tokenHash: authority.tokenHash, turnId: authority.turnId }
        : undefined,
    agentType,
    relayProvider: resolvedProvider,
    requestJson: requestJson as StellaRequestBody,
    requestedModel,
    resolvedModel,
    upstreamModel: toProviderNativeModel(resolvedModel, resolvedProvider),
    serviceTier: config.serviceTier,
    apiKey,
    tokenEstimate,
    fallbackCostMicroCents,
  };
}
