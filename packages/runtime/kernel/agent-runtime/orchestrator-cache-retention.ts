/**
 * Prompt-cache tier for the long-lived orchestrator.
 *
 * The orchestrator spawns background agents and then sits idle until their
 * completion (or the user) wakes it, usually well past Anthropic's 5-minute
 * cache TTL. The wake then re-writes the whole cached prefix at 1.25x input
 * price instead of reading it at 0.1x. Orchestrator requests to Anthropic
 * therefore always ask for the 1-hour tier:
 *
 *   - Anthropic bills a write only for the tokens past the longest cached
 *     prefix, while the entry covers the whole prompt. The 1h tier costs
 *     (2x - 1.25x) of each request's NEW tokens; one idle gap between 5 and
 *     60 minutes saves 1.15x of the WHOLE prompt.
 *   - The tier has to be steady, not switched on when agents start: a 1h
 *     request does not read entries written at 5m (measured: a 5m-warm 11.7k
 *     prefix re-written in full at 2x on the first 1h request), while 5m
 *     and 1h requests both read 1h entries.
 *   - Compared with keepalive requests (pi-mono `cache-warmer.ts`), each of
 *     which reads the whole prompt every ~4.5 minutes, the 1h premium on a
 *     60k prompt whose last request added 3k tokens is ~2.3k input-token
 *     equivalents once, against four 6k reads for a 20-minute agent run. See
 *     `cache-warmer.ts` for the keepalive that remains past one hour.
 *
 * Providers without an explicit cache tier (OpenAI automatic caching,
 * Gemini implicit caching, DeepSeek/Fireworks) and Anthropic-compatible
 * third parties are left on their default.
 */
import type {
  Api,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
} from "../../ai/types.js";
import type { StreamFn } from "../agent-core/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";

/** Lifetime of an Anthropic `ttl: "1h"` cache entry. */
export const LONG_PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * True when the adapter maps `cacheRetention: "long"` to Anthropic's 1h
 * tier: first-party Anthropic models, direct or through the Stella relay
 * (which forwards `cache_control` verbatim). Anthropic-compatible third
 * parties (Copilot, MiniMax, Kimi, gateways) may reject or ignore `ttl`.
 */
export const supportsLongPromptCacheRetention = (model: Model<Api>): boolean =>
  model.api === "anthropic-messages" &&
  model.provider === "anthropic" &&
  (model as Model<"anthropic-messages">).compat?.supportsLongCacheRetention !==
    false;

/**
 * Whether a background agent spawned from this conversation is still
 * running, i.e. whether its completion will wake the orchestrator later.
 * Best-effort: a store failure reads as "none".
 */
export const hasRunningBackgroundAgents = (
  store: Pick<RuntimeStore, "listAgentRecordsByStatus">,
  conversationId: string,
): boolean => {
  try {
    return store
      .listAgentRecordsByStatus("running")
      .some((record) => record.conversationId === conversationId);
  } catch {
    return false;
  }
};

/** One real provider request exactly as the orchestrator sent it. */
export type PromptCacheRequest = {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  /** Retention the request was sent with; undefined = provider default. */
  retention: CacheRetention | undefined;
  at: number;
};

/**
 * Wrap the orchestrator's stream function so every provider request uses
 * the 1h tier where supported. An explicit caller retention always wins.
 */
export const withOrchestratorCacheRetention = (
  base: StreamFn,
  args: {
    onRequest?: (request: PromptCacheRequest) => void;
    now?: () => number;
  } = {},
): StreamFn => {
  const now = args.now ?? Date.now;
  return (model, context, options) => {
    const retention: CacheRetention | undefined =
      options?.cacheRetention ??
      (supportsLongPromptCacheRetention(model) ? "long" : undefined);
    const requestOptions =
      retention === options?.cacheRetention
        ? options
        : { ...options, cacheRetention: retention };
    args.onRequest?.({
      model,
      context,
      options: requestOptions,
      retention,
      at: now(),
    });
    return base(model, context, requestOptions);
  };
};
