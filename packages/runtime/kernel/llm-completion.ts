/**
 * One completion on a resolved model route (`model-routing.ts`), on
 * upstream pi-ai: a Stella route runs on the `stella` provider over the
 * route's gateway session, a route on the user's own key on that provider's
 * upstream implementation. One-shot completions and thread summaries use
 * it; chats run on pi-durable (`@stella/agent`).
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CHATGPT_PROVIDER_ID,
  chatGptModel,
  chatGptProvider,
} from "@stella/agent/provider/chatgpt";
import { LOCAL_PROVIDER_ID } from "@stella/agent/provider/byok";
import { stellaModel, stellaProvider } from "@stella/agent/provider/stella";
import type { ResolvedLlmRoute } from "./model-routing.js";

export type RouteCompletionOptions = Pick<
  SimpleStreamOptions,
  "reasoning" | "maxTokens" | "temperature" | "cacheRetention" | "signal"
> & {
  /** The route's key when the caller already read it; read from the route otherwise. */
  apiKey?: string;
};

/** A local server often takes no key, but the OpenAI client always sends one. */
const LOCAL_PLACEHOLDER_KEY = "stella-local";

let upstream: readonly Provider[] | undefined;
const upstreamProvider = (id: string): Provider | undefined =>
  (upstream ??= builtinProviders()).find((provider) => provider.id === id);

/** A provider that signs requests with the key it is given and streams by the model's API. */
const keyedProvider = (id: string, model: Model<Api>, fallbackKey?: string): Provider =>
  createProvider({
    id,
    auth: {
      apiKey: {
        name: `${id} key`,
        resolve: async ({ credential }) => {
          const apiKey = credential?.key?.trim() || fallbackKey;
          return apiKey ? { auth: { apiKey } } : undefined;
        },
      },
    },
    models: [model],
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
    },
  });

/** The provider and model a route on the user's own key runs on. */
const directTarget = (route: ResolvedLlmRoute): { provider: Provider; model: Model<Api> } => {
  const { model } = route;
  if (model.provider === CHATGPT_PROVIDER_ID) {
    const plan = chatGptModel(model.id);
    if (!plan) throw new Error(`chatgpt/${model.id} isn't a model Stella can run on your ChatGPT plan.`);
    return { provider: chatGptProvider({ models: [plan] }), model: plan };
  }
  if (model.provider === LOCAL_PROVIDER_ID) {
    return { provider: keyedProvider(LOCAL_PROVIDER_ID, model, LOCAL_PLACEHOLDER_KEY), model };
  }
  const provider = upstreamProvider(model.provider);
  if (!provider) return { provider: keyedProvider(model.provider, model), model };
  // pi-ai's own entry carries the request shape its implementation expects.
  const known = provider.getModels().find((candidate) => candidate.id === model.id);
  return { provider, model: known ?? model };
};

const UNAUTHORIZED = /(?:^|\b)401(?:\b|$)|\bunauthorized\b|\btoken_(?:expired|revoked)\b|authentication token is expired/i;

export async function completeOnRoute(
  route: ResolvedLlmRoute,
  context: Context,
  options: RouteCompletionOptions = {},
): Promise<AssistantMessage> {
  const { apiKey: givenKey, ...request } = options;
  const models = createModels();
  if (route.stella) {
    // The gateway decides how a Stella model reasons, so a request carries
    // no reasoning controls at all (not even an explicit "none").
    const { reasoning: _reasoning, ...managed } = request;
    const { access } = route.stella;
    const spec = { ...route.stella.spec, reasoning: false };
    models.setProvider(stellaProvider({ access, models: [spec] }));
    return await models.completeSimple(stellaModel(spec, access.relayBaseUrl), context, managed);
  }
  const { provider, model } = directTarget(route);
  models.setProvider(provider);
  const send = (apiKey: string | undefined) =>
    models.completeSimple(model, context, { ...request, ...(apiKey ? { apiKey } : {}) });
  const apiKey = givenKey ?? (await route.getApiKey())?.trim();
  const message = await send(apiKey);
  // A short-lived credential the provider rejected is minted again once.
  if (message.stopReason !== "error" || !route.refreshApiKey || !UNAUTHORIZED.test(message.errorMessage ?? "")) {
    return message;
  }
  const refreshed = (await route.refreshApiKey())?.trim();
  return refreshed ? await send(refreshed) : message;
}

/** The text of an answer, trimmed. */
export const readAssistantText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();

