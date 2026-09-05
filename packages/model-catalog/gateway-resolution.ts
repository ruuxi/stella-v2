import type { GatewayModelResolution } from "@stella/contracts/gateway/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import { resolveManagedGatewayProvider } from "./managed-gateway";
import {
  managedModelSupportsImageInput,
  resolveRequestedStellaModel,
} from "./request-estimate";
import { resolveCloudManagedProtocol } from "./request-shaping";

/** Local prediction only. The gateway validates this entire descriptor on inference. */
export const resolveManagedModelDescriptor = (args: {
  agentType: string;
  requestedModel: string;
  audience: ManagedModelAudience;
}): GatewayModelResolution => {
  const selection = resolveRequestedStellaModel(
    args.agentType,
    { model: args.requestedModel },
    args.audience,
  );
  const provider = resolveManagedGatewayProvider({
    model: selection.resolvedModel,
    configuredProvider: selection.config.managedGatewayProvider,
  });
  return managedModelDescriptor({
    requestedModel: selection.requestedModel,
    resolvedModel: selection.resolvedModel,
    provider,
    protocol: resolveCloudManagedProtocol({
      relayProvider: provider,
      configuredApi: selection.config.api,
    }),
    config: selection.config,
  });
};

/** Shared wire metadata construction, used by prediction and authoritative routing. */
export const managedModelDescriptor = (
  route: Pick<
    GatewayModelResolution,
    "requestedModel" | "resolvedModel" | "provider" | "protocol"
  > & {
    config: { maxOutputTokens?: number };
  },
): GatewayModelResolution => ({
  requestedModel: route.requestedModel,
  resolvedModel: route.resolvedModel,
  provider: route.provider,
  protocol: route.protocol,
  reasoning: true,
  supportsImages: managedModelSupportsImageInput(route.resolvedModel),
  ...(route.config.maxOutputTokens !== undefined
    ? { maxOutputTokens: route.config.maxOutputTokens }
    : {}),
});
