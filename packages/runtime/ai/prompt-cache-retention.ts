/**
 * Dependency-free prompt-cache tier policy for the long-lived orchestrator.
 *
 * The cloud orchestrator (the Durable Object in `workers/cloud-builder`)
 * idles between turns while background agents run, and the wake usually
 * lands past Anthropic's 5-minute TTL. It therefore asks first-party
 * Anthropic for the 1-hour tier on every request:
 *
 *   - Anthropic bills a write only for the tokens past the longest cached
 *     prefix, so the 1h tier costs (2x - 1.25x) = 0.75x of each request's NEW
 *     tokens, while one idle gap between 5 and 60 minutes saves 1.15x of the
 *     WHOLE prompt (a 0.1x read instead of a 1.25x re-write).
 *   - The tier has to be steady per model: a 1h request does not read an
 *     entry written at 5m (measured: a 5m-warm 11.7k prefix was re-written in
 *     full at 2x on the first 1h request). Deriving it from the model alone
 *     keeps retries and resumed requests on the same tier.
 *
 * Only types are imported here so a Worker can use it without Node types.
 */
import type { Api, CacheRetention, Model } from "./types.js";

/**
 * True when the adapter maps `cacheRetention: "long"` to Anthropic's 1h
 * tier: first-party Anthropic models, direct or through the Stella relay or
 * model gateway (which forward `cache_control` verbatim). Anthropic-
 * compatible third parties (Copilot, MiniMax, Kimi, OpenRouter) may reject
 * or ignore `ttl`, and providers with implicit caching have no tier at all.
 */
const supportsLongPromptCacheRetention = (model: Model<Api>): boolean =>
  model.api === "anthropic-messages" &&
  model.provider === "anthropic" &&
  (model as Model<"anthropic-messages">).compat?.supportsLongCacheRetention !==
    false;

/**
 * Retention for one orchestrator provider request: an explicit caller
 * retention always wins, otherwise the 1h tier where supported and the
 * provider default elsewhere.
 */
export const resolveOrchestratorCacheRetention = (
  model: Model<Api>,
  explicit: CacheRetention | undefined,
): CacheRetention | undefined =>
  explicit ?? (supportsLongPromptCacheRetention(model) ? "long" : undefined);
