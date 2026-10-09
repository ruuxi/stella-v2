/**
 * Models the user brings their own key for (BYOK), on upstream pi-ai's
 * providers: a pick like `anthropic/claude-sonnet-4-5` runs on the
 * `anthropic` provider with the user's stored key, `chatgpt/<model>` on their
 * ChatGPT plan (Sign in with ChatGPT), and `local/<model>` on an
 * OpenAI-compatible server the user runs (Ollama, LM Studio, …).
 *
 * Keys stay where Stella keeps them. The credential store pi-ai reads per
 * request is a read-only view over them, so pi never writes or refreshes a
 * credential: an OAuth login is handed over as the current access token,
 * and the app refreshes it as it always has.
 */
import type { Api, AuthContext, Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { STELLA_PROVIDER_ID } from "./stella.ts";

/** What the user picked, by where it runs. */
export type ModelPick =
  | { kind: "stella"; alias: string }
  | { kind: "direct"; provider: string; modelId: string }
  | { kind: "local"; raw: string; modelId: string; baseUrl: string };

export const LOCAL_PROVIDER_ID = "local";
export const CHATGPT_PROVIDER_ID = "chatgpt";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** A local server often takes no key, but the OpenAI client always sends one. */
const LOCAL_PLACEHOLDER_KEY = "stella-local";

/** Providers the user's picker names that run on another provider here. */
const PROVIDER_ALIASES: Record<string, string> = {
  // The Codex engine's picks run on the same ChatGPT plan.
  "codex-cli": CHATGPT_PROVIDER_ID,
  codex: CHATGPT_PROVIDER_ID,
};
/** Providers whose models pi-ai splits across several: the first that has the model runs it. */
const PROVIDER_FAMILIES: Record<string, string[]> = { moonshotai: ["moonshotai", "kimi-coding"] };
/** Picks for an engine that runs its own turns (Claude Code): the orchestrator stays on Stella. */
const ENGINE_PROVIDERS = new Set(["claude-code"]);

/** `local/<model>` or `local/<encoded base URL>/<model>`. */
const parseLocal = (raw: string): ModelPick | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    let baseUrl = "";
    try {
      baseUrl = decodeURIComponent(trimmed.slice(0, slash));
    } catch {
      baseUrl = "";
    }
    const modelId = trimmed.slice(slash + 1).trim();
    if (/^https?:\/\//i.test(baseUrl) && modelId) return { kind: "local", raw: trimmed, modelId, baseUrl };
  }
  return { kind: "local", raw: trimmed, modelId: trimmed, baseUrl: DEFAULT_LOCAL_BASE_URL };
};

/** The user's model pick (`getModelOverride`), or undefined when it names nothing. */
export const parseModelPick = (pick: string | undefined): ModelPick | undefined => {
  const trimmed = pick?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("stella/")) return { kind: "stella", alias: trimmed };
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1).trim();
  if (!modelId || ENGINE_PROVIDERS.has(provider)) return undefined;
  if (provider === LOCAL_PROVIDER_ID) return parseLocal(modelId);
  return { kind: "direct", provider: PROVIDER_ALIASES[provider] ?? provider, modelId };
};

/** How the app reads the keys it keeps, by its own provider names. */
export type StellaCredentialAccess = {
  apiKey(provider: string): Promise<string | null | undefined>;
  oauthToken(provider: string): Promise<string | null | undefined>;
};

/**
 * pi-ai's credential store over the app's keys, read-only: a stored API key,
 * or else the current OAuth access token, as an API key. Nothing is written,
 * so pi-ai never refreshes or rotates what the app owns.
 */
export const stellaCredentialStore = (access: StellaCredentialAccess): CredentialStore => {
  const read = async (providerId: string): Promise<Credential | undefined> => {
    if (providerId === STELLA_PROVIDER_ID) return undefined;
    const key = (await access.apiKey(providerId))?.trim() || (await access.oauthToken(providerId))?.trim();
    return key ? { type: "api_key", key } : undefined;
  };
  return {
    read,
    list: async () => [],
    modify: async (providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) =>
      (await fn(await read(providerId))) ?? (await read(providerId)),
    delete: async () => {},
  };
};

/** Auth from the store only: no environment variables or files on this machine stand in for a key. */
export const storeOnlyAuthContext: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/**
 * BYOK models in a pi-ai `Models`: the upstream providers, registered once,
 * and the `local` provider, which gains each local model as it is picked.
 * `ensure` answers the model a pick runs on, or why it can't run.
 */
export function byokModels(models: MutableModels) {
  let upstream: ReturnType<typeof builtinProviders> | undefined;
  const upstreamProviders = () => (upstream ??= builtinProviders());
  let registered = false;
  const registerUpstream = () => {
    if (registered) return;
    registered = true;
    for (const provider of upstreamProviders()) {
      if ([STELLA_PROVIDER_ID, LOCAL_PROVIDER_ID, CHATGPT_PROVIDER_ID].includes(provider.id)) continue;
      models.setProvider(provider);
    }
  };

  /**
   * ChatGPT plan models: OpenAI's Responses API with the signed-in account's
   * access token, which pi-ai's `openai` API keeps to the plan's request
   * limits. They run under their own provider, so the plan's token and an
   * OpenAI API key never stand in for each other, and the plan costs nothing
   * per call.
   */
  const chatgpt = new Map<string, Model<"openai-responses">>();
  const responses = openAIResponsesApi();
  const asOpenAI = <M extends Model<Api>>(model: M): M => ({ ...model, provider: "openai", baseUrl: OPENAI_BASE_URL });
  const registerChatGpt = () =>
    models.setProvider(
      createProvider({
        id: CHATGPT_PROVIDER_ID,
        name: "ChatGPT",
        baseUrl: OPENAI_BASE_URL,
        auth: {
          apiKey: {
            name: "ChatGPT plan",
            resolve: async ({ credential }) =>
              credential?.key ? { auth: { apiKey: credential.key }, source: "Stella" } : undefined,
          },
        },
        models: [...chatgpt.values()],
        api: {
          "openai-responses": {
            stream: (model, context, options) => responses.stream(asOpenAI(model), context, options),
            streamSimple: (model, context, options) => responses.streamSimple(asOpenAI(model), context, options),
          },
        },
      }),
    );
  const ensureChatGpt = (modelId: string): ModelRef | { error: string } => {
    if (!chatgpt.has(modelId)) {
      const openai = (upstreamProviders().find((provider) => provider.id === "openai")?.getModels() ?? []).filter(
        (model): model is Model<"openai-responses"> => model.api === "openai-responses",
      );
      // A model the plan lists that pi-ai doesn't know yet runs like OpenAI's newest reasoning model.
      const known = openai.find((model) => model.id === modelId || model.id === modelId.replace(/\./g, "-"));
      const template = known ?? openai.filter((model) => model.reasoning).at(-1);
      if (!template) return { error: `chatgpt/${modelId} isn't a model Stella can run on your ChatGPT plan.` };
      chatgpt.set(modelId, {
        ...template,
        id: modelId,
        name: known?.name ?? modelId,
        provider: CHATGPT_PROVIDER_ID,
        baseUrl: OPENAI_BASE_URL,
        cost: NO_COST,
      });
      registerChatGpt();
    }
    return { provider: CHATGPT_PROVIDER_ID, modelId };
  };

  /** Local models by their pick (`raw`), each asking its server for its own model name. */
  const local = new Map<string, Model<"openai-completions">>();
  const localNames = new Map<string, string>();
  const completions = openAICompletionsApi();
  const asNamed = <M extends Model<Api>>(model: M): M => ({ ...model, id: localNames.get(model.id) ?? model.id });
  const registerLocal = () =>
    models.setProvider(
      createProvider({
        id: LOCAL_PROVIDER_ID,
        name: "Local",
        baseUrl: DEFAULT_LOCAL_BASE_URL,
        auth: {
          apiKey: {
            name: "Local model key",
            resolve: async ({ credential }) => ({
              auth: { apiKey: credential?.key?.trim() || LOCAL_PLACEHOLDER_KEY },
              source: credential?.key ? "Stella" : "none",
            }),
          },
        },
        models: [...local.values()],
        api: {
          "openai-completions": {
            stream: (model, context, options) => completions.stream(asNamed(model), context, options),
            streamSimple: (model, context, options) => completions.streamSimple(asNamed(model), context, options),
          },
        },
      }),
    );

  const ensureLocal = (pick: Extract<ModelPick, { kind: "local" }>): ModelRef => {
    if (!local.has(pick.raw)) {
      localNames.set(pick.raw, pick.modelId);
      local.set(pick.raw, {
        id: pick.raw,
        name: pick.modelId,
        api: "openai-completions",
        provider: LOCAL_PROVIDER_ID,
        baseUrl: pick.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: NO_COST,
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
      } as Model<"openai-completions">);
      registerLocal();
    }
    return { provider: LOCAL_PROVIDER_ID, modelId: pick.raw };
  };

  /** Models the user picked that a provider's catalog doesn't list, by provider. */
  const unlisted = new Map<string, Model<Api>[]>();
  const ensureDirect = (pick: Extract<ModelPick, { kind: "direct" }>): ModelRef | { error: string } => {
    registerUpstream();
    const family = PROVIDER_FAMILIES[pick.provider] ?? [pick.provider];
    // The picker writes some ids with dots where the provider uses dashes.
    for (const provider of family) {
      for (const candidate of [pick.modelId, pick.modelId.replace(/\./g, "-")]) {
        if (models.getModel(provider, candidate)) return { provider, modelId: candidate };
      }
    }
    // A model pi-ai's catalog doesn't list (older, or newer than this build)
    // runs on its provider's API, shaped like the provider's latest model.
    const provider = upstreamProviders().find((entry) => entry.id === family[0]);
    const template = provider?.getModels().at(-1);
    if (!provider || !template) {
      return { error: `${pick.provider}/${pick.modelId} isn't a model Stella can run with your key.` };
    }
    const extra = [...(unlisted.get(provider.id) ?? []), { ...template, id: pick.modelId, name: pick.modelId }];
    unlisted.set(provider.id, extra);
    models.setProvider({
      ...provider,
      getModels: () => [...provider.getModels(), ...extra],
      getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), ...extra],
    });
    return { provider: provider.id, modelId: pick.modelId };
  };

  return {
    /** The model a BYOK pick runs on, registered; or why it can't run. */
    ensure(pick: Exclude<ModelPick, { kind: "stella" }>): ModelRef | { error: string } {
      if (pick.kind === "local") return ensureLocal(pick);
      return pick.provider === CHATGPT_PROVIDER_ID ? ensureChatGpt(pick.modelId) : ensureDirect(pick);
    },
    /** A model a conversation was left on (after a restart), registered again. */
    restore(ref: ModelRef): void {
      if (ref.provider === LOCAL_PROVIDER_ID) {
        const pick = parseLocal(ref.modelId);
        if (pick?.kind === "local") ensureLocal(pick);
      } else if (ref.provider === CHATGPT_PROVIDER_ID) {
        ensureChatGpt(ref.modelId);
      } else if (ref.provider !== STELLA_PROVIDER_ID) {
        registerUpstream();
        if (!models.getModel(ref.provider, ref.modelId)) ensureDirect({ kind: "direct", ...ref });
      }
    },
  };
}
