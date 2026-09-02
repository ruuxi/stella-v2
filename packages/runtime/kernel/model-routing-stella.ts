import { Buffer } from "node:buffer";
import type { Api, Model } from "../ai/types.js";
import {
  findRegistryModel,
  findRegistryModelsById,
  getStellaVerbatimUpstreamModel,
  uniqueModelCandidates,
} from "./model-routing-matching.js";
import {
  STELLA_DEFAULT_MODEL,
  STELLA_DEFAULT_UPSTREAM_MODEL,
  STELLA_RELAY_PROVIDERS,
  STELLA_STANDARD_MODEL,
  isDeepSeekV4FlashModel,
  isMuseSpark12ContributorModel,
  type StellaRelayProvider,
} from "@stella/contracts/stella-api";
import { gatewayRelayBaseUrl } from "@stella/contracts/gateway/api";
import { readConfiguredStellaSiteUrl } from "@stella/contracts/convex-urls";
import {
  createGatewaySessionClient,
  getRememberedStellaGatewayOrigin,
} from "./gateway-session.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

/**
 * Fallback context window for Stella-managed relay routes, used only when the
 * resolved upstream model isn't found in the registry. When the model *is* in
 * the registry, `createRelayModel` carries its real provider-catalog-derived
 * context window instead — which the orchestrator compaction trigger keys off.
 */
export const STELLA_CONTEXT_WINDOW = 80_000;
const STELLA_MAX_TOKENS = 16_384;
const STELLA_AUTH_REFRESH_SKEW_MS = 15_000;
export const STELLA_PROVIDER = "stella";

/**
 * Relay base for a Stella route built before the catalog advertised the
 * gateway origin. A reserved `.invalid` host can never resolve, so a
 * provisional route that slips past catalog enrichment fails closed on DNS
 * instead of sending a capability to some SDK default endpoint; the catalog
 * layer replaces the route (or fails loudly) before any model call.
 */
export const STELLA_GATEWAY_ORIGIN_PENDING =
  "https://model-gateway.unconfigured.invalid";

export type StellaSiteConfig = {
  baseUrl: string | null;
  /** Device identity forwarded on the session capability exchange. */
  deviceId?: string;
  getAuthToken: () => string | null | undefined;
  refreshAuthToken?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  hasConnectedAccount?: () => boolean;
};

type ManagedGatewayProvider = StellaRelayProvider;

const STELLA_REGISTRY_PROVIDERS = new Set<string>(STELLA_RELAY_PROVIDERS);

const FIREWORKS_MODEL_PREFIXES = [
  "accounts/fireworks/models/",
  "accounts/fireworks/routers/",
] as const;

const DIRECT_MODEL_PROVIDER_PREFIXES = [
  ["openai/", "openai"],
  ["anthropic/", "anthropic"],
  ["google/", "google"],
  ["deepseek/", "deepseek"],
  ["crof/", "crof"],
  ["wafer/", "wafer"],
] as const satisfies readonly (readonly [string, ManagedGatewayProvider])[];

export const inferManagedGatewayProviderFromModel = (
  model: string,
): ManagedGatewayProvider => {
  const directProvider = DIRECT_MODEL_PROVIDER_PREFIXES.find(([prefix]) =>
    model.startsWith(prefix),
  )?.[1];
  if (directProvider) return directProvider;
  if (FIREWORKS_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return "fireworks";
  }
  return "openrouter";
};

export const resolveManagedStellaRegistryMatches = (
  matches: ReturnType<typeof findRegistryModelsById>,
): string | null => {
  const eligibleMatches = matches.filter(({ registryProvider }) =>
    STELLA_REGISTRY_PROVIDERS.has(registryProvider),
  );
  if (eligibleMatches.length === 0) return null;

  const candidates = eligibleMatches.flatMap(({ registryProvider, model }) => {
    switch (registryProvider) {
      case "openai":
      case "anthropic":
      case "google":
      case "deepseek":
      case "crof":
      case "wafer":
      case "openrouter":
        return [`${registryProvider}/${model.id}`];
      case "fireworks":
        return model.id.startsWith("accounts/fireworks/") ? [model.id] : [];
      default:
        return [];
    }
  });
  const uniqueCandidates = Array.from(new Set(candidates));
  return candidates.length === eligibleMatches.length &&
    uniqueCandidates.length === 1
    ? uniqueCandidates[0]
    : null;
};

const managedUpstreamForBareStellaModel = (
  bareModelId: string,
): string | null => {
  const matches = findRegistryModelsById(bareModelId);
  // Opaque backend-owned aliases are not in the local registry. Preserve the
  // exact id as a provisional route so catalog enrichment can resolve it; if
  // the catalog is unavailable, the relay sees that exact id and fails loudly
  // upstream instead of silently substituting another model family.
  if (matches.length === 0) return bareModelId;

  return resolveManagedStellaRegistryMatches(matches);
};

export const resolveOfflineStellaModelId = (modelId: string): string | null => {
  // Offline fallback for legacy aliases when the server catalog metadata is
  // unavailable. All aliases now resolve to Stella's single supported model.
  switch (modelId) {
    case "stella/light":
    case "stella/priority":
    case "stella/builder":
    case "stella/designer":
    case "stella/vision":
    case "stella/max":
    case STELLA_STANDARD_MODEL:
    case STELLA_DEFAULT_MODEL:
      return STELLA_DEFAULT_UPSTREAM_MODEL;
    default: {
      const upstream = getStellaVerbatimUpstreamModel(modelId);
      if (upstream) return upstream;
      const barePrefix = `${STELLA_PROVIDER}/`;
      if (modelId.startsWith(barePrefix)) {
        return managedUpstreamForBareStellaModel(
          modelId.slice(barePrefix.length),
        );
      }
      return null;
    }
  }
};

const readJwtExpiryMs = (token: string): number | null => {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
};

const shouldRefreshToken = (token: string): boolean => {
  const expiresAtMs = readJwtExpiryMs(token);
  return (
    expiresAtMs !== null &&
    expiresAtMs <= Date.now() + STELLA_AUTH_REFRESH_SKEW_MS
  );
};

const modelName = (modelId: string): string => modelId.replace(/^stella\//, "");

const providerNativeModelId = (
  resolvedModelId: string,
  provider: ManagedGatewayProvider,
): string => {
  if (
    (provider === "openai" ||
      provider === "anthropic" ||
      provider === "google" ||
      provider === "deepseek" ||
      provider === "crof" ||
      provider === "wafer") &&
    resolvedModelId.startsWith(`${provider}/`)
  ) {
    return resolvedModelId.slice(provider.length + 1);
  }
  return resolvedModelId;
};

const registryProviderForRelay = (provider: ManagedGatewayProvider): string =>
  provider === "fireworks" ? "fireworks" : provider;

const apiForRelay = (
  provider: ManagedGatewayProvider,
  registryModel: Model<Api> | null,
  resolvedModelId?: string,
): Api => {
  switch (provider) {
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "fireworks":
    case "deepseek":
      return "openai-responses";
    case "crof":
      return "openai-completions";
    case "wafer":
      // Wafer is OpenAI-compatible chat completions only.
      return "openai-completions";
    case "openrouter":
      // OpenRouter hosts a mix of protocols. Muse Spark 1.2 Contributor uses
      // Responses; every other OpenRouter model stays on Chat Completions.
      return resolvedModelId && isMuseSpark12ContributorModel(resolvedModelId)
        ? "openai-responses"
        : "openai-completions";
    case "openai":
      return registryModel?.api ?? "openai-responses";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

export const getManagedStellaRegistryLookup = (
  resolvedModelId: string,
): {
  provider: ManagedGatewayProvider;
  candidates: string[];
} => {
  const provider = inferManagedGatewayProviderFromModel(resolvedModelId);
  const nativeId = providerNativeModelId(resolvedModelId, provider);
  return {
    provider,
    candidates: uniqueModelCandidates([
      resolvedModelId,
      nativeId,
      nativeId.replace(/\./g, "-"),
    ]),
  };
};

const createRelayModel = (args: {
  siteBaseUrl: string;
  gatewayOrigin: string | null;
  requestedModelId: string;
  resolvedModelId: string;
  provider: ManagedGatewayProvider;
  agentType: string;
  registryModel?: Model<Api> | null;
}): Model<Api> => {
  const lookup = getManagedStellaRegistryLookup(args.resolvedModelId);
  const nativeId = providerNativeModelId(args.resolvedModelId, args.provider);
  const registryModel =
    args.registryModel ??
    findRegistryModel(
      registryProviderForRelay(args.provider),
      lookup.candidates,
    );

  const model = {
    ...(registryModel ?? {
      id: nativeId,
      name: nativeId,
      provider: args.provider,
      api: apiForRelay(args.provider, null),
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: STELLA_CONTEXT_WINDOW,
      maxTokens: STELLA_MAX_TOKENS,
    }),
    id: args.requestedModelId,
    name: modelName(args.requestedModelId),
    provider: registryModel?.provider ?? args.provider,
    api: apiForRelay(args.provider, registryModel, args.resolvedModelId),
    baseUrl: gatewayRelayBaseUrl(
      args.gatewayOrigin ?? STELLA_GATEWAY_ORIGIN_PENDING,
    ),
    ...(isDeepSeekV4FlashModel(args.resolvedModelId)
      ? {
          thinkingLevelMap: {
            ...registryModel?.thinkingLevelMap,
            ...(args.provider === "crof" || args.provider === "wafer"
              ? {
                  // CrofAI and Wafer accept none | low | medium | high.
                  minimal: "low",
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "high",
                  off: "none",
                }
              : {
                  // DeepSeek's native ladder is low | high | max. The relay
                  // applies the same clamp for older builds without this map.
                  minimal: "low",
                  low: "low",
                  medium: "high",
                  high: "max",
                  xhigh: "max",
                  off: "none",
                }),
          },
        }
      : {}),
    ...(isMuseSpark12ContributorModel(args.resolvedModelId)
      ? {
          // Muse accepts xhigh on the Responses API and reasoning is
          // mandatory. Without this map the runtime clamps xhigh to high.
          thinkingLevelMap: {
            ...registryModel?.thinkingLevelMap,
            xhigh: "xhigh",
          } as NonNullable<Model<Api>["thinkingLevelMap"]>,
        }
      : {}),
    headers: {
      ...(registryModel?.headers ?? {}),
      // `X-Stella-Agent-Type` lets the gateway validate the capability's
      // agent-type allowlist and attribute usage to the right per-agent
      // bucket; it is stripped before forwarding upstream. Provider adapters
      // detect the gateway by baseUrl (`/v1/relay`), never by header, so a
      // missing header can never accidentally route native auth headers
      // through to providers that wouldn't accept a capability token.
      "X-Stella-Agent-Type": args.agentType,
    },
  } as Model<Api>;

  // Stash the resolved upstream model id so provider adapters can make
  // model-capability decisions (e.g. Anthropic adaptive vs budget-based
  // thinking, which Opus 4.7 rejects in budget form) when `model.id`
  // carries a user-facing Stella alias like `stella/designer` that doesn't
  // include the underlying model slug.
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    nativeId;
  if (!args.gatewayOrigin) {
    // Provisional route (built before any catalog fetch): resolve the relay
    // base lazily so the route self-heals the moment the catalog remembers
    // the origin, instead of pinning the unresolvable sentinel forever.
    Object.defineProperty(model, "baseUrl", {
      enumerable: true,
      configurable: true,
      get: () =>
        gatewayRelayBaseUrl(
          getRememberedStellaGatewayOrigin(args.siteBaseUrl) ??
            STELLA_GATEWAY_ORIGIN_PENDING,
        ),
    });
  }
  return model;
};

export const normalizeStellaBase = readConfiguredStellaSiteUrl;

export const createStellaRoute = (args: {
  site: StellaSiteConfig;
  agentType: string;
  modelId: string;
  resolvedModelId?: string;
  registryModel?: Model<Api> | null;
  /**
   * Gateway origin advertised by the model catalog. Defaults to the origin
   * remembered from the last catalog fetch for this site; a route built
   * before any catalog fetch gets the pending sentinel and must go through
   * `withStellaModelCatalogMetadata` before use.
   */
  gatewayOrigin?: string | null;
}): ResolvedLlmRoute | null => {
  const siteBaseUrl = normalizeStellaBase(args.site.baseUrl);
  const authToken = args.site.getAuthToken()?.trim();
  const canRefreshMissingToken =
    Boolean(args.site.refreshAuthToken) &&
    args.site.hasConnectedAccount?.() === true;
  if (!siteBaseUrl || (!authToken && !canRefreshMissingToken)) {
    return null;
  }

  const resolvedModelId =
    args.resolvedModelId ?? resolveOfflineStellaModelId(args.modelId);
  if (!resolvedModelId) return null;
  const relayProvider = inferManagedGatewayProviderFromModel(resolvedModelId);
  const gatewayOrigin =
    args.gatewayOrigin ?? getRememberedStellaGatewayOrigin(siteBaseUrl);

  const refreshAuthToken = async (): Promise<string | undefined> => {
    const nextToken = (await args.site.refreshAuthToken?.())?.trim();
    return nextToken || undefined;
  };

  // The Better Auth JWT never reaches a model request. It is exchanged at the
  // gateway for a session capability; near-expiry JWTs are refreshed first
  // so the exchange itself never fails on a stale token.
  const currentAuthToken = async (): Promise<string | undefined> => {
    const currentToken = args.site.getAuthToken()?.trim() || authToken;
    if (currentToken && shouldRefreshToken(currentToken)) {
      return (await refreshAuthToken()) || currentToken;
    }
    return currentToken || (await refreshAuthToken()) || undefined;
  };

  const session = createGatewaySessionClient({
    // Resolved per call: a provisional route created before the catalog
    // fetch learns the origin as soon as the catalog remembers it.
    gatewayOrigin: () =>
      gatewayOrigin ?? getRememberedStellaGatewayOrigin(siteBaseUrl),
    getAuthToken: currentAuthToken,
    refreshAuthToken: args.site.refreshAuthToken ? refreshAuthToken : undefined,
    deviceId: args.site.deviceId,
  });

  return {
    route: "stella",
    model: createRelayModel({
      siteBaseUrl,
      gatewayOrigin,
      requestedModelId: args.modelId,
      resolvedModelId,
      provider: relayProvider,
      agentType: args.agentType,
      registryModel: args.registryModel,
    }),
    getApiKey: () => session.getCapability(),
    // A 401/402 from the gateway means the capability is no longer good
    // (expired, revoked by a data-generation bump, or budget exhausted):
    // drop it and exchange a fresh one for the retry.
    refreshApiKey: () => session.refreshCapability(),
  };
};
