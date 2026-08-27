import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { getAllModels } from "@stella/contracts/model-catalog";
import { getModels } from "../ai/models.js";
import {
  mergeModelHeaders,
  modelRuntime,
} from "../ai/model-runtime.js";
import {
  formatLlmRouteFailure,
  type LlmRouteFailure,
} from "@stella/contracts/llm-route-failure";
import {
  getAccessibleLocalLlmApiKey,
  getAccessibleLocalLlmOAuthApiKey,
  hasAccessibleLocalLlmApiKey,
  hasAccessibleLocalLlmOAuthCredential,
} from "./storage/local-llm-credential-access.js";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";
import {
  findRegistryModel,
  getEngineNativeStellaModelAlternative,
  isOpenEndedGatewayProvider,
  parseModelReference,
  uniqueModelCandidates,
} from "./model-routing-matching.js";
import {
  createStellaRoute,
  resolveOfflineStellaModelId,
  STELLA_PROVIDER,
  type StellaSiteConfig,
} from "./model-routing-stella.js";

export type ResolvedLlmRoute = {
  model: Model<Api>;
  toolPolicyModel?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
  route: "direct-provider" | "stella";

  credentialless?: boolean;
  getApiKey: () => Promise<string | undefined> | string | undefined;
  refreshApiKey?: () => Promise<string | undefined> | string | undefined;
};

const LOCAL_PROVIDER = "local";
const DEFAULT_LOCAL_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";

const createLocalOpenAICompatibleModel = (
  modelId: string,
  baseUrl = DEFAULT_LOCAL_OPENAI_BASE_URL,
): Model<"openai-completions"> => ({
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider: LOCAL_PROVIDER,
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
});

const parseLocalModelId = (
  rawModelId: string,
): { modelId: string; baseUrl: string } | null => {
  const trimmed = rawModelId.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    let maybeBaseUrl: string;
    try {
      maybeBaseUrl = decodeURIComponent(trimmed.slice(0, slash));
    } catch {
      maybeBaseUrl = "";
    }
    const modelId = trimmed.slice(slash + 1).trim();
    if (/^https?:\/\//i.test(maybeBaseUrl) && modelId) {
      return {
        modelId,
        baseUrl: maybeBaseUrl,
      };
    }
  }

  return {
    modelId: trimmed,
    baseUrl: DEFAULT_LOCAL_OPENAI_BASE_URL,
  };
};

export const getResolvedLlmApiKey = async (
  resolved: ResolvedLlmRoute,
): Promise<string | undefined> => {
  const apiKey = (await resolved.getApiKey())?.trim();
  return apiKey ? apiKey : undefined;
};

export const resolvedLlmSupportsCredentiallessCalls = (
  resolved: ResolvedLlmRoute,
): boolean =>
  resolved.route === "direct-provider" && resolved.credentialless === true;

const hasLocalProviderAuth = (
  stellaAppDir: string,
  providerId: string,
): boolean =>
  hasAccessibleLocalLlmApiKey(stellaAppDir, providerId) ||
  hasAccessibleLocalLlmOAuthCredential(stellaAppDir, providerId) ||
  modelRuntime.hasRuntimeManagedAuth(providerId);

const getLocalProviderApiKey = async (
  stellaAppDir: string,
  providerId: string,
): Promise<string | undefined> => {
  const apiKey = (
    await getAccessibleLocalLlmApiKey(stellaAppDir, providerId)
  )?.trim();
  if (apiKey) return apiKey;
  const oauthKey = (
    await getAccessibleLocalLlmOAuthApiKey(stellaAppDir, providerId)
  )?.trim();
  return oauthKey || modelRuntime.getRuntimeManagedApiKey(providerId);
};

const getDirectProviderCandidates = (
  provider: string,
  modelId: string,
): {
  credentialProvider: string;
  registryProvider: string;
  candidates: string[];
  allowBaseUrlWithoutCredential?: boolean;
} | null => {
  switch (provider) {
    case "anthropic":
      return {
        credentialProvider: "anthropic",
        registryProvider: "anthropic",
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
      };
    case "moonshotai":
      if (modelRuntime.hasRuntimeProviderOrigin(provider)) {
        return {
          credentialProvider: provider,
          registryProvider: provider,
          allowBaseUrlWithoutCredential:
            modelRuntime.allowsCredentiallessRouting(provider),
          candidates: uniqueModelCandidates([
            modelId,
            modelId.replace(/\./g, "-"),
          ]),
        };
      }
      return {
        credentialProvider: "kimi-coding",
        registryProvider: "kimi-coding",
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
          modelId === "kimi-k2.5" ? "k2p5" : "",
          modelId === "kimi-k2" ? "kimi-k2" : "",
        ]),
      };
    case "openai":
    case "openai-codex":
    case "google":
    case "opencode":
    case "cerebras":
    case "xai":
    case "zai":
    case "openrouter":
    case "vercel-ai-gateway":
      return {
        credentialProvider: provider,
        registryProvider: provider,
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
      };
    default: {

      const extensionModels = getModels(provider as never) as Model<Api>[];
      if (extensionModels.length > 0) {
        return {
          credentialProvider: provider,
          registryProvider: provider,
          allowBaseUrlWithoutCredential:
            modelRuntime.allowsCredentiallessRouting(provider),
          candidates: uniqueModelCandidates([
            modelId,
            modelId.replace(/\./g, "-"),
          ]),
        };
      }
      return null;
    }
  }
};

const resolveCatalogContextWindow = (modelId: string): number | undefined => {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  const baseId = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  let best = 0;
  for (const model of getAllModels()) {
    const id = model.id;
    const idSlash = id.indexOf("/");
    const idBase = idSlash > 0 ? id.slice(idSlash + 1) : id;
    if (id !== trimmed && idBase !== baseId) continue;
    const window = Number(model.contextWindow);
    if (Number.isFinite(window) && window > best) best = window;
  }
  return best > 0 ? Math.floor(best) : undefined;
};

const synthesizeGatewayModelFromTemplate = (
  registryProvider: string,
  modelId: string,
): Model<Api> | null => {
  if (!isOpenEndedGatewayProvider(registryProvider)) return null;
  const template = (getModels(registryProvider as never) as Model<Api>[])[0];
  if (!template) return null;
  return {
    ...template,
    id: modelId,
    name: modelId,
    input: ["text", "image"],
    maxTokens: 0,

    contextWindow: Math.max(
      resolveCatalogContextWindow(modelId) ??
        (Number.isFinite(template.contextWindow) ? template.contextWindow : 0),
      200_000,
    ),
  };
};

type DirectProviderRouteResult =
  | { kind: "route"; route: ResolvedLlmRoute }

  | { kind: "unsupported-provider" }

  | { kind: "unknown-model" }

  | { kind: "missing-credential" };

const resolveDirectProviderRoute = (args: {
  stellaAppDir: string;
  provider: string;
  modelId: string;
  fullModelId: string;
}): DirectProviderRouteResult => {
  if (args.provider === LOCAL_PROVIDER && args.modelId.trim()) {
    const local = parseLocalModelId(args.modelId);
    if (!local) return { kind: "unknown-model" };
    return {
      kind: "route",
      route: {
        model: createLocalOpenAICompatibleModel(local.modelId, local.baseUrl),
        route: "direct-provider",

        credentialless: true,
        getApiKey: () => "",
      },
    };
  }

  const directProvider = getDirectProviderCandidates(
    args.provider,
    args.modelId,
  );
  if (!directProvider) {
    return { kind: "unsupported-provider" };
  }

  const requestedCandidates = uniqueModelCandidates([
    args.fullModelId,
    ...directProvider.candidates,
  ]);

  const directModel =
    findRegistryModel(directProvider.registryProvider, requestedCandidates) ??
    synthesizeGatewayModelFromTemplate(
      directProvider.registryProvider,
      args.modelId,
    );
  if (!directModel) {
    return { kind: "unknown-model" };
  }
  const routedModel = {
    ...directModel,
    headers: directModel.headers,
  };
  let configuredHeadersState:
    | { ok: true; applied: boolean; headers?: Record<string, string> }
    | { ok: false; error: unknown }
    | undefined;
  const applyConfiguredHeaders = (): void => {
    if (!configuredHeadersState) {
      try {
        configuredHeadersState = {
          ok: true,
          applied: false,
          headers: modelRuntime.getConfiguredHeaders(
            directProvider.registryProvider,
            directModel.id,
          ),
        };
      } catch (error) {
        configuredHeadersState = { ok: false, error };
      }
    }
    if (!configuredHeadersState.ok) throw configuredHeadersState.error;
    if (configuredHeadersState.applied) return;
    routedModel.headers = mergeModelHeaders(
      routedModel.headers,
      configuredHeadersState.headers,
    );
    configuredHeadersState.applied = true;
  };

  if (
    hasLocalProviderAuth(args.stellaAppDir, directProvider.credentialProvider)
  ) {
    const getRequestApiKey = async (): Promise<string | undefined> => {
      applyConfiguredHeaders();
      const apiKey = await getLocalProviderApiKey(
        args.stellaAppDir,
        directProvider.credentialProvider,
      );
      if (
        apiKey &&
        modelRuntime.usesConfiguredAuthHeader(directProvider.registryProvider)
      ) {
        routedModel.headers = mergeModelHeaders(routedModel.headers, {
          Authorization: `Bearer ${apiKey}`,
        });
      }
      return apiKey;
    };
    return {
      kind: "route",
      route: {
        model: routedModel,
        route: "direct-provider",
        getApiKey: getRequestApiKey,
      },
    };
  }

  if (directProvider.allowBaseUrlWithoutCredential && routedModel.baseUrl) {
    return {
      kind: "route",
      route: {
        model: routedModel,
        route: "direct-provider",

        credentialless: true,
        getApiKey: () => {
          applyConfiguredHeaders();
          return "";
        },
      },
    };
  }

  return { kind: "missing-credential" };
};

const CLAUDE_CODE_ENGINE_PROVIDER = "claude-code";
const CODEX_CLI_ENGINE_PROVIDER = "codex-cli";

const normalizeDesktopLocalEngineModelReference = (
  modelName: string | undefined,
): string | undefined => {
  const parsed = parseModelReference(modelName);
  if (!parsed) return modelName;

  if (parsed.provider === CODEX_CLI_ENGINE_PROVIDER) {
    return `openai-codex/${parsed.modelId}`;
  }

  if (parsed.provider === CLAUDE_CODE_ENGINE_PROVIDER) {
    return undefined;
  }
  return modelName;
};

type LlmRouteResolution =
  | { ok: true; route: ResolvedLlmRoute }
  | { ok: false; failure: LlmRouteFailure };

const resolveLlmRouteResult = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
  reasoningEffort?: string;
  deferBareStellaModelFailure?: boolean;
}): LlmRouteResolution => {
  const parsed = parseModelReference(
    normalizeDesktopLocalEngineModelReference(args.modelName),
  );

  if (!parsed) {
    const route = createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: STELLA_DEFAULT_MODEL,
    });
    return route
      ? { ok: true, route }
      : { ok: false, failure: { kind: "no-stella-route" } };
  }

  if (parsed.provider === STELLA_PROVIDER) {
    let route = createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: parsed.fullModelId,
    });
    if (
      !route &&
      args.deferBareStellaModelFailure &&
      !parsed.modelId.includes("/")
    ) {
      route = createStellaRoute({
        site: args.site,
        agentType: args.agentType,
        modelId: parsed.fullModelId,

        resolvedModelId: parsed.modelId,
      });
    }
    if (route) return { ok: true, route };
    const suggestedModel = getEngineNativeStellaModelAlternative(
      parsed.fullModelId,
      args.reasoningEffort,
    );
    return resolveOfflineStellaModelId(parsed.fullModelId) === null
      ? {
          ok: false,
          failure: {
            kind: "unknown-model",
            provider: STELLA_PROVIDER,
            model: parsed.fullModelId,
            ...(suggestedModel ? { suggestedModel } : {}),
          },
        }
      : { ok: false, failure: { kind: "no-stella-route" } };
  }

  const direct = resolveDirectProviderRoute({
    stellaAppDir: args.stellaAppDir,
    provider: parsed.provider,
    modelId: parsed.modelId,
    fullModelId: parsed.fullModelId,
  });
  if (direct.kind === "route") {
    return { ok: true, route: direct.route };
  }

  return {
    ok: false,
    failure: {
      kind: direct.kind,
      provider: parsed.provider,
      model: parsed.fullModelId,
    },
  };
};

export const canResolveLlmRoute = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType?: string;
  site: StellaSiteConfig;
}): boolean => {
  const agentType = args.agentType ?? AGENT_IDS.ORCHESTRATOR;
  const result = resolveLlmRouteResult({ ...args, agentType });
  if (result.ok) return true;

  if (result.failure.kind === "no-stella-route") {
    return false;
  }
  return Boolean(
    createStellaRoute({
      site: args.site,
      agentType,
      modelId: STELLA_DEFAULT_MODEL,
    }),
  );
};

export const resolveLlmRoute = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
  reasoningEffort?: string;
}): ResolvedLlmRoute => {
  const result = resolveLlmRouteResult(args);
  if (result.ok) return result.route;
  throw new Error(formatLlmRouteFailure(result.failure));
};

export const resolveLlmRouteForCatalogEnrichment = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
  reasoningEffort?: string;
}): ResolvedLlmRoute => {
  const result = resolveLlmRouteResult({
    ...args,
    deferBareStellaModelFailure: true,
  });
  if (result.ok) return result.route;
  throw new Error(formatLlmRouteFailure(result.failure));
};
