import { agentHasCapability } from "@stella/contracts/agent-runtime";
import {
  MEMORY_REVIEW_TURN_THRESHOLD,
  spawnMemoryReview,
} from "../../../kernel/agent-runtime/memory-review.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";
import { getCompactionTriggerTokens } from "../../../kernel/thread-runtime.js";

export const createMemoryReviewHook = (opts: {
  stellaDataDir: string;
  stellaAppDir: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "triggersMemoryReview")) return;
    const services = payload.services;
    if (!services) return;
    if (!services.resolvedLlm) return;
    if (!services.messagesSnapshot) return;
    if (!payload.conversationId) return;

    const turns = services.userTurnsSinceMemoryReview;
    const reachedTurnThreshold =
      turns != null && turns >= MEMORY_REVIEW_TURN_THRESHOLD;
    const tokenEstimate = services.orchestratorTokenEstimate;
    const compactionImminent =
      typeof tokenEstimate === "number" &&
      tokenEstimate >= getCompactionTriggerTokens(services.resolvedLlm);
    if (!reachedTurnThreshold && !compactionImminent) return;

    const { lastReviewedMessageTs } = opts.store.getMemoryReviewState(
      payload.conversationId,
    );

    spawnMemoryReview({
      conversationId: payload.conversationId,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      messagesSnapshot: services.messagesSnapshot,
      sinceMessageTs: lastReviewedMessageTs,
      resolvedLlm: services.resolvedLlm,
      store: opts.store,
    });
    return;
  },
});
