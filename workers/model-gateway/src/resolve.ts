import type { GatewayProtocol } from "@stella/contracts/gateway/api";
import type { GatewayCapabilityClaims } from "@stella/contracts/gateway/capability";
import {
  getManagedGatewayConfig,
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
  type ManagedProtocol,
} from "@stella/model-catalog/managed-gateway";
import type { ModelConfig } from "@stella/model-catalog/model";
import { resolveRequestedStellaModel } from "@stella/model-catalog/request-estimate";
import {
  resolveCloudManagedProtocol,
  toProviderNativeModel,
} from "@stella/model-catalog/request-shaping";
import { GatewayError } from "./errors.js";

/**
 * Alias -> route resolution for the managed lane, per capability audience.
 *
 * Audience rules live in `@stella/model-catalog`: a restricted audience's
 * override silently falls back to the agent default there. That is fine for
 * a session capability (the caller asked for something it may not have), but
 * a turn capability was admitted with one exact execution — if the resolved
 * `requestedModel` is not that execution's model the request is refused
 * rather than routed elsewhere.
 */
export type ManagedRoute = {
  requestedModel: string;
  resolvedModel: string;
  upstreamModel: string;
  provider: ManagedGatewayProvider;
  protocol: ManagedProtocol;
  config: ModelConfig;
};

/** Wire protocols each provider's upstream actually serves. */
export const PROTOCOLS_BY_PROVIDER: Record<
  ManagedGatewayProvider,
  readonly GatewayProtocol[]
> = {
  anthropic: ["anthropic-messages"],
  google: ["google-generative-ai"],
  fireworks: ["openai-responses"],
  crof: ["openai-completions"],
  wafer: ["openai-completions"],
  openai: ["openai-responses", "openai-completions"],
  deepseek: ["openai-responses", "openai-completions"],
  xai: ["openai-responses", "openai-completions"],
  openrouter: ["openai-responses", "openai-completions"],
  meta: ["openai-responses", "openai-completions"],
};

export const assertAgentTypeAllowed = (
  claims: GatewayCapabilityClaims,
  agentType: string,
): void => {
  if (claims.agentTypes && !claims.agentTypes.includes(agentType)) {
    throw new GatewayError(
      403,
      "agent_type_forbidden",
      `This capability may not act as agent type "${agentType}".`,
    );
  }
};

export const resolveManagedRoute = (args: {
  claims: GatewayCapabilityClaims;
  agentType: string;
  requestedModel: string | undefined;
}): ManagedRoute => {
  let selection: ReturnType<typeof resolveRequestedStellaModel>;
  try {
    selection = resolveRequestedStellaModel(
      args.agentType,
      { model: args.requestedModel ?? "" },
      args.claims.audience,
    );
  } catch (error) {
    throw new GatewayError(
      400,
      "bad_request",
      error instanceof Error
        ? error.message
        : "Invalid Stella model selection.",
    );
  }
  const turn = args.claims.turn;
  if (turn) {
    if (turn.execution.engine !== "stella") {
      throw new GatewayError(
        403,
        "execution_mismatch",
        "This turn was admitted for a connected engine, not the managed model lane.",
      );
    }
    if (selection.requestedModel !== turn.execution.model) {
      throw new GatewayError(
        403,
        "execution_mismatch",
        `This turn is pinned to "${turn.execution.model}"; "${selection.requestedModel}" is not available.`,
      );
    }
  }
  const provider = resolveManagedGatewayProvider({
    model: selection.resolvedModel,
    configuredProvider: selection.config.managedGatewayProvider,
  });
  const protocol = resolveCloudManagedProtocol({
    relayProvider: provider,
    configuredApi: selection.config.api,
  });
  return {
    requestedModel: selection.requestedModel,
    resolvedModel: selection.resolvedModel,
    upstreamModel: toProviderNativeModel(selection.resolvedModel, provider),
    provider,
    protocol,
    config: selection.config,
  };
};

export const upstreamBaseUrl = (provider: ManagedGatewayProvider): string =>
  getManagedGatewayConfig(provider).baseURL;
