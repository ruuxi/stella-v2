/**
 * Model resolver - resolves backend managed model config.
 *
 * Backend execution is Stella-managed. Local/runtime BYOK happens in the
 * desktop runtime, not here.
 */

import type { ActionCtx } from "../_generated/server";
import type { ManagedProtocol } from "../runtime_ai/managed";
import { getModelConfig, type ManagedModelAudience } from "./model";
import { resolveStellaModelConfigForSelection } from "@stella/model-catalog/aliases";
import {
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import {
  assertManagedUsageAllowed,
  type ManagedModelAccess,
} from "../lib/managed_billing";

export type ResolvedModelConfig = {
  model: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  /** Wire-protocol override carried from the mode/pin config (see
   * `ManagedModelConfig.api`). */
  api?: ManagedProtocol;
  temperature?: number;
  maxOutputTokens?: number;
  serviceTier?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Input modalities forwarded to `buildManagedModel` so unsupported parts
   * (image/audio/video/pdf) are dropped at the gateway boundary. Text only
   * since model prices left Convex.
   */
  modalitiesInput?: ("text" | "image" | "audio" | "video" | "pdf")[];
};

const TEXT_ONLY: ("text" | "image" | "audio" | "video" | "pdf")[] = ["text"];

type RunQueryCtx = { runQuery: ActionCtx["runQuery"] };

export const toResolvedModelConfig = (
  config: {
    model: string;
    managedGatewayProvider?: ManagedGatewayProvider;
    api?: ManagedProtocol;
    temperature?: number;
    maxOutputTokens?: number;
    serviceTier?: string;
    providerOptions?: unknown;
  },
  modalitiesInput?: ResolvedModelConfig["modalitiesInput"],
): ResolvedModelConfig => ({
  model: config.model,
  managedGatewayProvider: resolveManagedGatewayProvider({
    model: config.model,
    configuredProvider: config.managedGatewayProvider,
  }),
  api: config.api,
  temperature: config.temperature,
  maxOutputTokens: config.maxOutputTokens,
  serviceTier: config.serviceTier,
  providerOptions: config.providerOptions as
    | Record<string, Record<string, unknown>>
    | undefined,
  modalitiesInput,
});

type ResolveModelConfigOptions = {
  audience?: ManagedModelAudience;
  access?: ManagedModelAccess;
  modelOverride?: string | null;
};

export async function resolveModelConfig(
  ctx: RunQueryCtx,
  agentType: string,
  ownerId?: string,
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig> {
  const audience =
    options?.access?.modelAudience ?? options?.audience ?? "free";
  // Shared with the relay request path so an override resolves to the same
  // model + gateway provider on both (a mode carries its own provider/options;
  // an upstream pick infers its provider; everything else is the agent default).
  const { config } = resolveStellaModelConfigForSelection(
    options?.modelOverride,
    agentType,
    audience,
  );
  void ctx;
  void ownerId;
  return toResolvedModelConfig(config, TEXT_ONLY);
}

export async function resolveFallbackConfig(
  ctx: RunQueryCtx,
  agentType: string,
  ownerId?: string,
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig | null> {
  const audience =
    options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);
  if (!defaults.fallback) return null;
  void ctx;

  const resolvedFallback = toResolvedModelConfig(
    {
      model: defaults.fallback,
      managedGatewayProvider: defaults.fallbackManagedGatewayProvider,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      serviceTier: defaults.fallbackServiceTier,
      providerOptions: defaults.fallbackProviderOptions,
    },
    TEXT_ONLY,
  );

  void ownerId;
  return resolvedFallback;
}

export async function resolveManagedModelConfigs(
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  agentType: string,
  ownerId: string,
  options?: { modelOverride?: string | null },
): Promise<{
  access: ManagedModelAccess;
  config: ResolvedModelConfig;
  fallbackConfig: ResolvedModelConfig | null;
}> {
  const access = await assertManagedUsageAllowed(ctx, ownerId);
  const [config, fallbackConfig] = await Promise.all([
    resolveModelConfig(ctx, agentType, ownerId, {
      access,
      modelOverride: options?.modelOverride,
    }),
    resolveFallbackConfig(ctx, agentType, ownerId, {
      access,
    }),
  ]);
  return { access, config, fallbackConfig };
}
