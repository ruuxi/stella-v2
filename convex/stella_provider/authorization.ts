import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import { errorResponse } from "../http_shared/cors";
import { getClientAddressKey } from "../lib/http_utils";
import {
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import { resolveManagedModelAccess } from "../lib/managed_billing";
import { computeUsageCostMicroCents } from "../lib/billing_money";
import {
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
};

export function toProviderNativeModel(
  model: string,
  provider: ManagedGatewayProvider,
): string {
  const prefix = providerModelPrefix[provider];
  const stripped = prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (provider === "anthropic") return stripped.replace(/\./g, "-");
  return stripped;
}
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
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.tokenIdentifier;
  const isAnonymous =
    (identity as Record<string, unknown>).isAnonymous === true;
  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";

  if (isAnonymous) {
    const deviceId = `anon-jwt:${ownerId}`;
    const clientAddressKey = getClientAddressKey(request);
    const allowed = await consumeAnonymousRequestAllowance(
      ctx,
      deviceId,
      clientAddressKey,
    );
    if (!allowed) {
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
  const apiKey = process.env[managedGateway.apiKeyEnvVar]?.trim();
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
    apiKey,
    tokenEstimate,
  };
}
