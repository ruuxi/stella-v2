/**
 * Prompt-cache tier for the cloud orchestrator's provider requests.
 *
 * Same policy as the desktop orchestrator (see
 * `@stella/runtime/ai/prompt-cache-retention`): a conversation idles between
 * turns while its background agents run, and their completion wakes it well
 * past Anthropic's 5-minute TTL. Every orchestrator request to first-party
 * Anthropic (a connected Claude subscription, or a managed
 * `stella/anthropic/...` model on the gateway's Anthropic lane) therefore
 * asks for the 1-hour tier. Managed OpenRouter / OpenAI-compatible routes
 * (the audience default) keep their provider default.
 *
 * The tier is derived from the relay route alone, never from turn state, so
 * a retry, a resumed turn after a Durable Object restart, and the next wake
 * all send the same `cache_control` bytes as the request that wrote the
 * entry (a 1h request cannot read a 5m entry).
 *
 * No keepalive: the desktop refreshes the entry at ~54 minutes while agents
 * still run, but here that would mean an alarm that rebuilds the whole
 * request (prompt context, tools, journal window) in an evicted object, for
 * the rare agent that outlives the hour on an Anthropic-routed conversation.
 */
import type { Api, Model } from "@stella/runtime/ai/types.js";
import { resolveOrchestratorCacheRetention } from "@stella/runtime/ai/prompt-cache-retention.js";
import type { StreamFn } from "@stella/runtime/kernel/agent-core/types.js";

/**
 * Wrap an orchestrator turn's stream function so each provider request uses
 * the 1h tier where the route supports it. `routeModel` is the relay
 * session's live model: the relay ignores the Agent's model argument and
 * sends its own (re-resolved on a gateway revision mismatch).
 */
export const withOrchestratorCacheRetention =
  (base: StreamFn, routeModel: () => Model<Api>): StreamFn =>
  (model, context, options) => {
    const retention = resolveOrchestratorCacheRetention(
      routeModel(),
      options?.cacheRetention,
    );
    return base(
      model,
      context,
      retention === options?.cacheRetention
        ? options
        : { ...options, cacheRetention: retention },
    );
  };

/**
 * One-off requests (history summaries) are never replayed, so writing them
 * to the prompt cache only pays the write premium. `"none"` also drops the
 * session id from OpenAI-style requests, keeping the summary off the
 * conversation's routing affinity.
 */
export const withoutPromptCache =
  (base: StreamFn): StreamFn =>
  (model, context, options) =>
    base(model, context, { ...options, cacheRetention: "none" });
