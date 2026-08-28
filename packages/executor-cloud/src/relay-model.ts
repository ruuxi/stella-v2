import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  isDeepSeekV4FlashModel,
  isMuseSpark12ContributorModel,
  stellaCloudModelEndpointFromSiteUrl,
  stellaManagedRelayBaseUrlFromSiteUrl,
} from "@stella/contracts/stella-api";
import { clampThinkingLevel } from "@stella/runtime/ai/models.js";
import type {
  Api,
  Model,
  ModelThinkingLevel,
} from "@stella/runtime/ai/types.js";
import {
  CLOUD_MODEL_DIAGNOSTIC_SENTINELS,
  CLOUD_MODEL_PROXY_DIAGNOSTIC_CODES,
  CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER,
  type CloudModelDiagnosticCode,
} from "@stella/contracts/cloud-model-diagnostic";
import { findRegistryModel } from "@stella/runtime/kernel/model-routing-matching.js";
import type { ThinkingLevel } from "@stella/runtime/kernel/agent-core/types.js";

/**
 * Header carrying the opaque per-turn token to Convex. The relay resolves it
 * to the turn's owner and authorized execution selection; credentials never
 * enter the sandbox.
 */
export const CLOUD_TURN_TOKEN_HEADER = "x-stella-turn-token";

/**
 * Selects an owner-connected subscription. This is only a provider flag; the
 * relay resolves and refreshes the encrypted OAuth credential server-side.
 */
export const CLOUD_LLM_CREDENTIAL_HEADER = "x-stella-llm-credential";

export const DEFAULT_CLOUD_ANTHROPIC_ENGINE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CLOUD_CODEX_ENGINE_MODEL = "gpt-5.6-sol";

const MANAGED_RELAY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "deepseek",
  "crof",
  "wafer",
  "openrouter",
  "meta",
  "xai",
] as const;
type ManagedRelayProvider = (typeof MANAGED_RELAY_PROVIDERS)[number];

const MANAGED_PROTOCOLS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
] as const satisfies readonly Api[];
type ManagedProtocol = (typeof MANAGED_PROTOCOLS)[number];

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const ENGINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const ANTHROPIC_ENGINE_MODEL_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\])$/;
const LOCAL_ONLY_STELLA_PREFIXES = [
  "stella/local/",
  "stella/ollama/",
  "stella/lmstudio/",
  "stella/openai-codex/",
] as const;

const REASONING_EFFORTS = new Set<AgentModelReasoningEffort>([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const validateCloudExecutionSelection = (
  execution: CloudExecutionSelection,
): CloudExecutionSelection => {
  if (execution.engine !== execution.provider) {
    throw new Error(
      "Cloud execution engine and provider must identify the same route.",
    );
  }
  if (!REASONING_EFFORTS.has(execution.reasoningEffort)) {
    throw new Error("Unsupported cloud reasoning effort.");
  }
  const model = execution.model.trim();
  const validModelSyntax =
    MODEL_ID_PATTERN.test(model) ||
    (execution.engine === "anthropic" &&
      model.length <= 192 &&
      ANTHROPIC_ENGINE_MODEL_PATTERN.test(model));
  if (!model || !validModelSyntax || model !== execution.model) {
    throw new Error("Cloud execution requires a valid exact model id.");
  }
  if (execution.engine === "stella") {
    if (
      !model.startsWith("stella/") ||
      model === "stella/" ||
      LOCAL_ONLY_STELLA_PREFIXES.some((prefix) => model.startsWith(prefix))
    ) {
      throw new Error(
        `"${model}" is not available to cloud execution. Select a Stella-managed model, Claude, or ChatGPT.`,
      );
    }
    return execution;
  }
  if (
    execution.engine === "anthropic" &&
    (model.length > 192 || !ANTHROPIC_ENGINE_MODEL_PATTERN.test(model))
  ) {
    throw new Error(
      `${execution.engine} cloud execution requires an engine-native model id.`,
    );
  }
  if (
    execution.engine === "openai-codex" &&
    !ENGINE_MODEL_PATTERN.test(model)
  ) {
    throw new Error(
      `${execution.engine} cloud execution requires an engine-native model id.`,
    );
  }
  return execution;
};

const genericSubscriptionModel = (
  provider: "anthropic" | "openai-codex",
  modelId: string,
): Model<Api> => ({
  id: modelId,
  name: modelId,
  api:
    provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
  provider,
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_384,
});

const subscriptionRelayModel = (args: {
  execution: CloudExecutionSelection;
  siteUrl: string;
  turnToken: string;
  agentType: string;
}): Model<Api> => {
  const provider = args.execution.engine as "anthropic" | "openai-codex";
  const modelId = args.execution.model;
  const registryModel =
    findRegistryModel(provider, [modelId, modelId.replace(/\./g, "-")]) ??
    genericSubscriptionModel(provider, modelId);
  const relayModelId = `stella/${provider}/${modelId}`;
  return {
    ...registryModel,
    id: relayModelId,
    name:
      provider === "anthropic"
        ? "Claude (subscription)"
        : "ChatGPT (subscription)",
    provider,
    api:
      provider === "anthropic"
        ? "anthropic-messages"
        : "openai-codex-responses",
    baseUrl: stellaManagedRelayBaseUrlFromSiteUrl(args.siteUrl),
    headers: {
      ...(registryModel.headers ?? {}),
      "X-Stella-Agent-Type": args.agentType,
      [CLOUD_TURN_TOKEN_HEADER]: args.turnToken,
      [CLOUD_LLM_CREDENTIAL_HEADER]: provider,
    },
  } as Model<Api>;
};

export const createResolvedManagedRelayModel = (args: {
  execution: CloudExecutionSelection;
  siteUrl: string;
  turnToken: string;
  agentType: string;
  resolvedModelId: string;
  relayProvider: string;
  api?: string;
}): Model<Api> => {
  if (
    !MODEL_ID_PATTERN.test(args.resolvedModelId) ||
    !(MANAGED_RELAY_PROVIDERS as readonly string[]).includes(
      args.relayProvider,
    ) ||
    (args.api !== undefined &&
      !(MANAGED_PROTOCOLS as readonly string[]).includes(args.api))
  ) {
    throw new Error(
      "The cloud model resolver returned invalid provider metadata.",
    );
  }
  const relayProvider = args.relayProvider as ManagedRelayProvider;
  const directModelPrefix =
    relayProvider === "xai" ? "x-ai/" : `${relayProvider}/`;
  const nativeModelId =
    (relayProvider === "anthropic" ||
      relayProvider === "openai" ||
      relayProvider === "google" ||
      relayProvider === "deepseek" ||
      relayProvider === "crof" ||
      relayProvider === "wafer" ||
      relayProvider === "xai" ||
      relayProvider === "meta") &&
    args.resolvedModelId.startsWith(directModelPrefix)
      ? args.resolvedModelId.slice(directModelPrefix.length)
      : args.resolvedModelId;
  const registryModel = findRegistryModel(relayProvider, [
    args.resolvedModelId,
    nativeModelId,
    nativeModelId.replace(/\./g, "-"),
  ]);
  const api: Api = args.api
    ? (args.api as ManagedProtocol)
    : relayProvider === "anthropic"
      ? "anthropic-messages"
      : relayProvider === "google"
        ? "google-generative-ai"
        : relayProvider === "crof" || relayProvider === "wafer"
          ? "openai-completions"
          : relayProvider === "openrouter"
            ? isMuseSpark12ContributorModel(args.resolvedModelId)
              ? "openai-responses"
              : "openai-completions"
            : registryModel?.api ?? "openai-responses";
  const model = {
    ...(registryModel ?? {
      id: nativeModelId,
      name: nativeModelId,
      provider: relayProvider,
      api,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 80_000,
      maxTokens: 16_384,
    }),
    id: args.execution.model,
    name: args.execution.model.replace(/^stella\//, ""),
    provider: registryModel?.provider ?? relayProvider,
    api,
    baseUrl: stellaManagedRelayBaseUrlFromSiteUrl(args.siteUrl),
    ...(isDeepSeekV4FlashModel(args.resolvedModelId)
      ? {
          thinkingLevelMap: {
            ...registryModel?.thinkingLevelMap,
            ...(relayProvider === "crof" || relayProvider === "wafer"
              ? {
                  minimal: "low",
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "high",
                  off: "none",
                }
              : {
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
          thinkingLevelMap: {
            ...registryModel?.thinkingLevelMap,
            xhigh: "xhigh",
          } as NonNullable<Model<Api>["thinkingLevelMap"]>,
        }
      : {}),
    headers: {
      ...(registryModel?.headers ?? {}),
      "X-Stella-Agent-Type": args.agentType,
      [CLOUD_TURN_TOKEN_HEADER]: args.turnToken,
    },
  } as Model<Api>;
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    nativeModelId;
  return model;
};

const managedRelayModel = async (args: {
  execution: CloudExecutionSelection;
  siteUrl: string;
  turnToken: string;
  agentType: string;
  signal?: AbortSignal;
  loopbackStage?: () =>
    | "idle"
    | "entered"
    | "broker_started"
    | "broker_responded";
}): Promise<Model<Api>> => {
  const timeoutSignal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(
      stellaCloudModelEndpointFromSiteUrl(args.siteUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CLOUD_TURN_TOKEN_HEADER]: args.turnToken,
        },
        body: JSON.stringify({ model: args.execution.model }),
        signal: args.signal
          ? AbortSignal.any([args.signal, timeoutSignal])
          : timeoutSignal,
      },
    );
  } catch (error) {
    // Preserve an explicit turn cancellation. Every other loopback failure is
    // collapsed to a static sentinel; exception causes can contain transport
    // or provider detail and must not enter Builder logs or acceptance output.
    if (args.signal?.aborted) throw error;
    const loopbackStage = args.loopbackStage?.() ?? "idle";
    if (loopbackStage === "entered") {
      throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_handler);
    }
    if (loopbackStage === "broker_started") {
      throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_broker);
    }
    if (loopbackStage === "broker_responded") {
      throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_response);
    }
    const transportCode = (() => {
      if (!error || typeof error !== "object") return "";
      const direct = Reflect.get(error, "code");
      if (typeof direct === "string") return direct;
      const cause = Reflect.get(error, "cause");
      if (!cause || typeof cause !== "object") return "";
      const nested = Reflect.get(cause, "code");
      return typeof nested === "string" ? nested : "";
    })();
    if (
      transportCode === "ConnectionRefused" ||
      transportCode === "ECONNREFUSED"
    ) {
      throw new Error(
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_refused,
      );
    }
    if (transportCode === "Timeout" || transportCode === "ETIMEDOUT") {
      throw new Error(
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_timeout,
      );
    }
    if (
      transportCode === "NetworkUnreachable" ||
      transportCode === "ENETUNREACH" ||
      transportCode === "EHOSTUNREACH"
    ) {
      throw new Error(
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_unreachable,
      );
    }
    throw new Error(
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_connect,
    );
  }
  if (!response.ok) {
    const localDiagnostic = response.headers.get(
      CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER,
    );
    await response.body?.cancel().catch(() => undefined);
    if (
      CLOUD_MODEL_PROXY_DIAGNOSTIC_CODES.includes(
        localDiagnostic as (typeof CLOUD_MODEL_PROXY_DIAGNOSTIC_CODES)[number],
      )
    ) {
      throw new Error(
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS[
          localDiagnostic as CloudModelDiagnosticCode
        ],
      );
    }
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_http_failure);
  }
  let resolution: {
    resolvedModel?: unknown;
    relayProvider?: unknown;
    api?: unknown;
  };
  try {
    resolution = (await response.json()) as typeof resolution;
  } catch {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
  if (
    typeof resolution.resolvedModel !== "string" ||
    typeof resolution.relayProvider !== "string" ||
    typeof resolution.api !== "string"
  ) {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
  try {
    return createResolvedManagedRelayModel({
      ...args,
      resolvedModelId: resolution.resolvedModel,
      relayProvider: resolution.relayProvider,
      api: resolution.api,
    });
  } catch {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
};

/**
 * Create the exact relay adapter selected at dispatch. Managed routes retain
 * Stella's provider-specific request shape; connected subscriptions use their
 * native Anthropic/Codex adapters while credentials remain in Convex.
 */
export const createCloudRelayModel = async (args: {
  siteUrl: string;
  turnToken: string;
  agentType: string;
  execution: CloudExecutionSelection;
  /** Exact turn fiber cancellation; connected routes are synchronous/local. */
  signal?: AbortSignal;
  /** Bounded local proxy progress, used only to classify a failed loopback. */
  loopbackStage?: () =>
    | "idle"
    | "entered"
    | "broker_started"
    | "broker_responded";
}): Promise<Model<Api>> => {
  const execution = validateCloudExecutionSelection(args.execution);
  return execution.engine === "stella"
    ? await managedRelayModel({ ...args, execution })
    : subscriptionRelayModel({ ...args, execution });
};

/**
 * Resolve the requested reasoning effort to the closest level the exact model
 * supports. `none` is an explicit off request; `default` preserves Stella's
 * normal medium/off behavior.
 */
export const resolveCloudThinkingLevel = (
  model: Model<Api>,
  requested: AgentModelReasoningEffort,
): ThinkingLevel => {
  if (requested === "default") {
    return model.reasoning ? "medium" : "off";
  }
  const desired: ModelThinkingLevel = requested === "none" ? "off" : requested;
  return clampThinkingLevel(model, desired);
};
