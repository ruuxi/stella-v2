import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { getApiProvider, resolveApiProviderInternal } from "./api-registry.js";
import { aiRuntime } from "./effect-runtime.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";
import type { AssistantMessageEvent } from "./types.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
  TextContent,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

/**
 * Build a synthetic terminal error message for a provider that could not
 * be resolved/loaded. Pushed as an `error` event so the stream's
 * `result()` settles and async iteration terminates, matching the
 * provider-level error protocol instead of leaving the stream hung.
 */
function makeProviderErrorMessage(
  model: Model<Api>,
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

// The provider event pipelines below run on the ai/ area runtime
// (./effect-runtime.ts) — one requirements-free runtime per facade family,
// context rides in closures.

/**
 * Drive `inner` (the real provider stream, produced after the lazy
 * provider load resolves) into `out` (the stream returned synchronously
 * to callers) as a true Effect Stream (M5 surface 3, phase 3). Event
 * bytes and order are preserved exactly — each element is forwarded
 * untouched in sequence — and both consumption modes keep working: async
 * iteration over `out` and `out.result()`. An iteration failure maps to
 * the same terminal `error` event the pre-Effect loop pushed, and `end`
 * always runs exactly once (`ensuring`).
 */
async function pipeStream(
  model: Model<Api>,
  out: AssistantMessageEventStream,
  produce: () => Promise<AssistantMessageEventStream>,
): Promise<void> {
  let inner: AssistantMessageEventStream;
  try {
    inner = await produce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.push({
      type: "error",
      reason: "error",
      error: makeProviderErrorMessage(
        model,
        `Failed to load API provider for ${model.api}: ${message}`,
      ),
    });
    out.end();
    return;
  }
  await aiRuntime.runPromise(
    Stream.fromAsyncIterable(
      inner as AsyncIterable<AssistantMessageEvent>,
      (error) => error,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          out.push(event);
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          const message =
            error instanceof Error ? error.message : String(error);
          out.push({
            type: "error",
            reason: "error",
            error: makeProviderErrorMessage(model, message),
          });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          out.end();
        }),
      ),
    ),
  );
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const eager = getApiProvider(model.api);
  if (eager) {
    return eager.streamSimple(model as Model<Api>, context, options);
  }
  const out = new AssistantMessageEventStream();
  void pipeStream(model as Model<Api>, out, async () => {
    const provider = await resolveApiProviderInternal(model.api);
    return provider.streamSimple(model as Model<Api>, context, options);
  });
  return out;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const eager = getApiProvider(model.api);
  if (eager) {
    return eager.stream(model as Model<Api>, context, options as StreamOptions);
  }
  const out = new AssistantMessageEventStream();
  void pipeStream(model as Model<Api>, out, async () => {
    const provider = await resolveApiProviderInternal(model.api);
    return provider.stream(
      model as Model<Api>,
      context,
      options as StreamOptions,
    );
  });
  return out;
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const s = streamSimple(model, context, options);
  return s.result();
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const s = stream(model, context, options);
  return s.result();
}

export function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}
