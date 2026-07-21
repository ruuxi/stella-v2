import type {
  ExtensionRuntime,
  ExtensionStore,
  HookDefinition,
} from "../types.js";

/**
 * Background memory review (stella-runtime).
 *
 * Fires after a successful Orchestrator turn whenever the
 * memory-review counter (`prepareOrchestratorRun` increments it on
 * every real user turn for agents that declare `triggersMemoryReview`)
 * has reached threshold. The review is a fire-and-forget LLM pass that
 * sees the recent user/assistant transcript and may queue a gated memory
 * candidate in the Dream inbox (kind `memory_note`) for Dream to
 * consolidate.
 *
 * Pre-migration this was an inline branch inside
 * `finalizeOrchestratorSuccess`. Moving it to a hook keeps the kernel
 * agnostic about Stella's memory product and lets users disable or
 * fork the review without editing kernel code.
 *
 * Service deps:
 *   - `store`, `stellaDataDir`, `stellaAppDir` (factory-time, closure).
 *   - `payload.services.resolvedLlm` (per-turn) — drives the review
 *     completion.
 *   - `payload.services.messagesSnapshot` (per-turn) — transcript the
 *     review reads.
 *   - `payload.services.userTurnsSinceMemoryReview` (per-turn) — the
 *     counter to compare against threshold.
 */
export const createMemoryReviewHook = (opts: {
  runtime: ExtensionRuntime;
  store: ExtensionStore;
}): HookDefinition => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (
      !opts.runtime.agentHasCapability(
        payload.agentType,
        "triggersMemoryReview",
      )
    ) {
      return;
    }
    const services = payload.services;
    if (!services) return;
    if (!services.resolvedLlm) return;
    if (!services.messagesSnapshot) return;
    if (!payload.conversationId) return;

    // Capture on the normal cadence (every N turns), OR force a capture when a
    // compaction is imminent so the about-to-be-summarized window is reviewed
    // before its detail is replaced by the summary. The frozen messagesSnapshot
    // means the review reads the pre-compaction detail even though the actual
    // compaction runs asynchronously after this hook.
    const turns = services.userTurnsSinceMemoryReview;
    const reachedTurnThreshold =
      turns != null && turns >= opts.runtime.memory.reviewTurnThreshold;
    const tokenEstimate = services.orchestratorTokenEstimate;
    const compactionImminent =
      typeof tokenEstimate === "number" &&
      tokenEstimate >=
        opts.runtime.getCompactionTriggerTokens(services.resolvedLlm);
    if (!reachedTurnThreshold && !compactionImminent) return;

    // Read the previous watermark before spawnMemoryReview advances it, so the
    // pass reviews only messages created since the last review.
    const { lastReviewedMessageTs } = opts.store.getMemoryReviewState(
      payload.conversationId,
    );

    opts.runtime.memory.spawnReview({
      conversationId: payload.conversationId,
      messagesSnapshot: services.messagesSnapshot,
      sinceMessageTs: lastReviewedMessageTs,
      resolvedLlm: services.resolvedLlm,
    });
    return;
  },
});
