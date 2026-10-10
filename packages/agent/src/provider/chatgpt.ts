/**
 * ChatGPT plan models (Sign in with ChatGPT) as one pi-ai provider,
 * `chatgpt`: OpenAI's Responses API with the account's access token. pi-ai's
 * Responses adapter keeps a request carrying a signed-in token to the plan's
 * limits (nothing stored, none of the fields the plan refuses), so the
 * provider runs its models through that adapter as OpenAI's. They stay under
 * their own provider, so the plan's token and an OpenAI API key never stand
 * in for each other, and the plan costs nothing per call.
 *
 * On the desktop a request goes to OpenAI with the user's token. In the
 * cloud a `transport` sends it to the model gateway's native lane, which puts
 * the owner's token on it.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";

export const CHATGPT_PROVIDER_ID = "chatgpt";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** The adapter's bearer when the transport sets the real one; not an `sk-` key, so the plan's limits apply. */
const TRANSPORT_PLACEHOLDER_KEY = "stella-chatgpt-plan";

/** Where a request goes instead of OpenAI, for the conversation it belongs to. */
export type ChatGptTransport = {
  baseUrl: string;
  fetch(request: Request, route: { sessionId?: string }): Promise<Response>;
};

/**
 * A plan model by its ChatGPT slug: pi-ai's entry for the OpenAI model, or,
 * for one pi-ai doesn't know yet, one shaped like OpenAI's newest reasoning
 * model.
 */
export const chatGptModel = (modelId: string): Model<"openai-responses"> | undefined => {
  const openai = (Object.values(OPENAI_MODELS) as Model<Api>[]).filter(
    (model): model is Model<"openai-responses"> => model.api === "openai-responses",
  );
  const known = openai.find((model) => model.id === modelId || model.id === modelId.replace(/\./g, "-"));
  const template = known ?? openai.filter((model) => model.reasoning).at(-1);
  if (!template) return undefined;
  return {
    ...template,
    id: modelId,
    name: known?.name ?? modelId,
    provider: CHATGPT_PROVIDER_ID,
    baseUrl: OPENAI_BASE_URL,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
};

/** The `chatgpt` provider over `models`, sent to OpenAI or through `transport`. */
export function chatGptProvider(options: {
  models: readonly Model<"openai-responses">[];
  transport?: ChatGptTransport;
}): Provider {
  const responses = openAIResponsesApi();
  const { transport } = options;
  const asOpenAI = <M extends Model<Api>>(model: M): M => ({ ...model, provider: "openai", baseUrl: OPENAI_BASE_URL });
  const routed = (sessionId: string | undefined): typeof fetch | undefined =>
    transport
      ? (((input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          const url = transport.baseUrl.replace(/\/+$/, "") + request.url.slice(OPENAI_BASE_URL.length);
          return transport.fetch(new Request(url, request), sessionId ? { sessionId } : {});
        }) as typeof fetch)
      : undefined;
  const sent = <O extends { sessionId?: string; fetch?: typeof fetch }>(options: O | undefined): O | undefined => {
    const fetch = routed(options?.sessionId);
    return fetch ? ({ ...options, fetch } as O) : options;
  };
  return createProvider({
    id: CHATGPT_PROVIDER_ID,
    name: "ChatGPT",
    baseUrl: OPENAI_BASE_URL,
    auth: {
      apiKey: {
        name: "ChatGPT plan",
        resolve: async ({ credential }) => {
          const key = credential?.key?.trim() || (transport ? TRANSPORT_PLACEHOLDER_KEY : undefined);
          return key ? { auth: { apiKey: key }, source: transport ? "Stella cloud" : "Stella" } : undefined;
        },
      },
    },
    models: [...options.models],
    api: {
      "openai-responses": {
        stream: (model, context, streamOptions) => responses.stream(asOpenAI(model), context, sent(streamOptions)),
        streamSimple: (model, context, streamOptions) =>
          responses.streamSimple(asOpenAI(model), context, sent(streamOptions)),
      },
    },
  });
}
