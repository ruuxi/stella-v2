/**
 * Keepalive for the orchestrator's 1h prompt-cache entry while background
 * agents run past the hour (pi-mono `cache-warmer.ts`, c596d09d9 +
 * 3390bd936).
 *
 * The 1h tier (`orchestrator-cache-retention.ts`) covers the common case: an
 * agent that finishes within the hour wakes the orchestrator on a warm
 * prefix. Past the hour that wake would re-write the whole prompt at the 1h
 * write price (2x input). Re-sending the last request with a one-token
 * output cap at ~90% of the TTL reads the prefix (0.1x) and restarts its
 * hour, so while an agent is still running (its completion WILL wake the
 * orchestrator) one refresh costs about 1/19 of the miss it prevents.
 *
 * Safety rails:
 *   - Armed only when the session goes idle after a 1h-tier request and the
 *     model can replay that request without changing its cache key.
 *   - Any real request, session disposal, compaction, or history refresh
 *     cancels it; an in-flight refresh is aborted through its fiber.
 *   - Each refresh re-checks that no turn is in flight and an agent is still
 *     running, skips a late timer (sleep, event-loop stall) whose refresh
 *     would land after expiry, and gives up after three hours.
 *   - Refreshes go straight to the provider stream: no run recorder, no
 *     transcript row, no UI callbacks, no retries.
 */
import { Effect, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import type { Api, Model, SimpleStreamOptions } from "../../ai/types.js";
import type { StreamFn } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import {
  LONG_PROMPT_CACHE_TTL_MS,
  supportsLongPromptCacheRetention,
  type PromptCacheRequest,
} from "./orchestrator-cache-retention.js";

const logger = createRuntimeLogger("prompt-cache-warmer");
const cacheWarmerRuntime = ManagedRuntime.make(Layer.empty);
const cacheWarmerScope = Scope.makeUnsafe();

/** A refresh is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a still-running background agent wakes the orchestrator before
 * the refreshed entry expires again. Agent completion always wakes it; the
 * discount covers cancelled agents and conversations the user abandons.
 */
const BACKGROUND_AGENT_WAKE_PROBABILITY = 0.9;
/** Warming never continues past this long after the session went idle. */
const MAX_IDLE_WARMING_AGE_MS = 3 * 60 * 60 * 1000;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export const getCacheWarmingDelayMs = (ttlMs: number): number | undefined => {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
};

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Budget-based Anthropic thinking (pre-4.6 Claude) derives
 * `budget_tokens` from `max_tokens`, which keys the message cache; adaptive
 * thinking and no-reasoning requests do not.
 */
export const isReplayable = async (
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): Promise<boolean> => {
  if (!options?.reasoning || model.api !== "anthropic-messages") return true;
  // Loaded only when a refresh is due; the adapter is resident by then.
  const { supportsAdaptiveThinking } =
    await import("../../ai/providers/anthropic.js");
  const upstream = (model as { upstreamModelId?: unknown }).upstreamModelId;
  return supportsAdaptiveThinking(
    typeof upstream === "string" && upstream ? upstream : model.id,
  );
};

export type CacheWarmingDecision = {
  /** Price of one refresh: a cache read of the prompt plus one output token. */
  warmCost: number;
  /** Extra price of the wake request if the entry expires (1h re-write vs read). */
  missCost: number;
  continuationProbability: number;
  expectedSavings: number;
  /** False when the prompt size or the model's prices are unknown. */
  economicsAvailable: boolean;
  action: "warm" | "stop";
};

export const evaluateCacheWarming = (
  model: Pick<Model<Api>, "cost">,
  promptTokens: number,
  continuationProbability: number,
): CacheWarmingDecision => {
  const perToken = (rate: number) => rate / 1_000_000;
  const warmCost =
    promptTokens * perToken(model.cost.cacheRead) + perToken(model.cost.output);
  const missCost = Math.max(
    0,
    promptTokens *
      (2 * perToken(model.cost.input) - perToken(model.cost.cacheRead)),
  );
  const economicsAvailable = promptTokens > 0 && model.cost.input > 0;
  const expectedSavings = continuationProbability * missCost - warmCost;
  return {
    warmCost,
    missCost,
    continuationProbability,
    expectedSavings,
    economicsAvailable,
    action:
      economicsAvailable &&
      expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS
        ? "warm"
        : "stop",
  };
};

/**
 * Replay options: the request as sent minus every per-run hook (payload and
 * response observers, retry status, lifecycle proofs, the shared request
 * budget, the run's abort signal) so a refresh can never surface in a run.
 * `refreshApiKey` stays so an expired capability token can be renewed.
 */
const toReplayOptions = (
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions => {
  const replay: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (typeof value === "function" && key !== "refreshApiKey") continue;
    replay[key] = value;
  }
  delete replay.signal;
  delete replay.requestBudget;
  delete replay.omitMaxTokens;
  return replay as SimpleStreamOptions;
};

export type PromptCacheWarmerDeps = {
  /** Raw provider stream (never the run-scoped wrapper). */
  send: StreamFn;
  /** True while no turn is in flight and a background agent is still running. */
  shouldWarm: () => boolean;
  /** Prompt size of the last real request as reported by the provider. */
  getPromptTokens: () => number;
  /** Fresh credential for the refresh; falls back to the request's key. */
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  now?: () => number;
  logContext?: Record<string, unknown>;
};

/**
 * Keeps the cache entry of one orchestrator session's last request alive
 * while the session idles with background agents running.
 */
export class PromptCacheWarmer {
  private request: PromptCacheRequest | null = null;
  private fiber: Fiber.Fiber<void> | null = null;
  private runToken: object | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PromptCacheWarmerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** True while a refresh is scheduled or in flight. */
  get armed(): boolean {
    return this.fiber !== null;
  }

  /** A real request went out: drop any pending refresh and remember it. */
  noteRequest(request: PromptCacheRequest): void {
    this.cancel();
    this.request = request;
  }

  /** The session went idle: arm a refresh for the last request if it can pay off. */
  onIdle(): void {
    this.cancel();
    const request = this.request;
    if (!request) return;
    if (
      request.retention !== "long" ||
      !supportsLongPromptCacheRetention(request.model)
    ) {
      this.log("cache-warmer.inactive", { reason: "no 1h cache entry" });
      return;
    }
    const delayMs = getCacheWarmingDelayMs(LONG_PROMPT_CACHE_TTL_MS)!;
    const idleSince = this.now();
    const loop = (refreshedAt: number): Effect.Effect<void> => {
      const nextWarmAt = refreshedAt + delayMs;
      if (nextWarmAt > idleSince + MAX_IDLE_WARMING_AGE_MS) {
        return Effect.sync(() =>
          this.log("cache-warmer.stopped", { reason: "idle limit reached" }),
        );
      }
      // A late timer keeps half of the pre-expiry margin for dispatch;
      // later than that the refresh would likely be a full-price write.
      const deadlineAt =
        nextWarmAt + Math.floor((LONG_PROMPT_CACHE_TTL_MS - delayMs) / 2);
      return Effect.sleep(Math.max(0, nextWarmAt - this.now())).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) => this.refresh(request, deadlineAt, signal),
            catch: (error) => error,
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            this.log("cache-warmer.stopped", {
              reason: "refresh failed",
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }),
        ),
        Effect.flatMap((sentAt) =>
          sentAt === null ? Effect.void : loop(sentAt),
        ),
      );
    };
    this.log("cache-warmer.armed", {
      nextWarmInMs: Math.max(0, request.at + delayMs - idleSince),
    });
    // The loop can settle synchronously inside runSync; the token (not the
    // fiber binding) tells its finalizer whether it is still the live run.
    const token = {};
    this.runToken = token;
    const fiber = cacheWarmerRuntime.runSync(
      Effect.forkIn(
        loop(request.at).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (this.runToken !== token) return;
              this.runToken = null;
              this.fiber = null;
            }),
          ),
        ),
        cacheWarmerScope,
        { startImmediately: true },
      ),
    );
    if (this.runToken === token) this.fiber = fiber;
  }

  /** Stop warming; an in-flight refresh is aborted. */
  cancel(): void {
    const fiber = this.fiber;
    this.fiber = null;
    this.runToken = null;
    fiber?.interruptUnsafe();
  }

  /** Stop warming and forget the request (session disposal). */
  dispose(): void {
    this.cancel();
    this.request = null;
  }

  /** Returns the send time of a successful refresh, or null to stop. */
  private async refresh(
    request: PromptCacheRequest,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<number | null> {
    if (this.now() > deadlineAt) {
      this.log("cache-warmer.stopped", { reason: "refresh deadline missed" });
      return null;
    }
    if (!this.deps.shouldWarm()) {
      this.log("cache-warmer.stopped", {
        reason: "session busy or no background agent running",
      });
      return null;
    }
    if (!(await isReplayable(request.model, request.options))) {
      this.log("cache-warmer.stopped", {
        reason: "request cannot be replayed safely",
      });
      return null;
    }
    const decision = evaluateCacheWarming(
      request.model,
      this.deps.getPromptTokens(),
      BACKGROUND_AGENT_WAKE_PROBABILITY,
    );
    if (decision.action === "stop") {
      this.log("cache-warmer.stopped", {
        reason: decision.economicsAvailable
          ? "expected savings below threshold"
          : "cache economics unavailable",
        ...decision,
      });
      return null;
    }
    const apiKey =
      (await this.deps.getApiKey?.())?.trim() || request.options?.apiKey;
    if (signal.aborted) return null;
    const sentAt = this.now();
    const message = await (
      await this.deps.send(request.model, request.context, {
        ...toReplayOptions(request.options),
        ...(apiKey ? { apiKey } : {}),
        maxTokens: 1,
        maxRetries: 0,
        signal,
      })
    ).result();
    if (signal.aborted) return null;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      this.log("cache-warmer.stopped", {
        reason: "refresh request failed",
        error: message.errorMessage,
      });
      return null;
    }
    this.log("cache-warmer.refreshed", {
      model: request.model.id,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      input: message.usage.input,
      output: message.usage.output,
      expectedSavings: decision.expectedSavings,
    });
    return sentAt;
  }

  private log(event: string, data: Record<string, unknown>): void {
    logger.debug(event, { ...this.deps.logContext, ...data });
  }
}
