import type { ExtensionRuntime, HookDefinition } from "../types.js";

/**
 * Dream scheduler notify (stella-runtime).
 *
 * On a successful orchestrator turn, evaluates whether Dream should run based
 * on orchestrator context growth — not on per-event pings:
 *   - the thread has grown ~`tokenInterval` since the last run
 *     (`token_interval`), or
 *   - the thread is at/over the compaction trigger, so a consolidation flush
 *     should happen before the middle is summarized (`pre_compaction`).
 *
 * Dream reads the durable Dream inbox, so it
 * still self-skips via its own eligibility gate when nothing is pending. Only
 * the orchestrator declares `triggersDreamScheduler`; subagent rollouts just
 * accumulate as Dream-inbox rows and get folded on the next
 * orchestrator-driven Dream run.
 *
 * Service deps:
 *   - `store`, `stellaDataDir` (factory-time, closure).
 *   - `payload.services.resolvedLlm` + `orchestratorTokenEstimate` (per-turn).
 *   - The `dream-scheduler` module is dynamically imported inside the handler
 *     to keep it off the runtime worker's cold-start path.
 */
export const createDreamSchedulerNotifyHook = (opts: {
  runtime: ExtensionRuntime;
}): HookDefinition => {
  const logger = opts.runtime.createLogger("stella-runtime.dream-notify");
  return {
    event: "agent_end",
    async handler(payload) {
      if (payload.outcome !== "success") return;
      if (
        !opts.runtime.agentHasCapability(
          payload.agentType,
          "triggersDreamScheduler",
        )
      ) {
        return;
      }
      const services = payload.services;
      if (!services?.resolvedLlm) return;

      const tokenEstimate = services.orchestratorTokenEstimate;
      if (typeof tokenEstimate !== "number") {
        // Without the estimate, `token_interval` can't measure growth and
        // `pre_compaction` can't be detected — the orchestrator-driven cadence
        // stalls (only startup_catchup/manual remain). Surface it so the stall is
        // diagnosable rather than silent.
        logger.debug("dream-scheduler.notify-missing-token-estimate", {
          agentType: payload.agentType,
        });
      }
      const compactionImminent =
        typeof tokenEstimate === "number" &&
        tokenEstimate >=
          opts.runtime.getCompactionTriggerTokens(services.resolvedLlm);
      const trigger = compactionImminent ? "pre_compaction" : "token_interval";

      try {
        void opts.runtime.memory
          .maybeSpawnDreamRun({
            resolvedLlm: services.resolvedLlm,
            trigger,
            ...(typeof tokenEstimate === "number"
              ? { orchestratorTokenEstimate: tokenEstimate }
              : {}),
            ...(payload.conversationId
              ? { conversationId: payload.conversationId }
              : {}),
          })
          .catch((error) => {
            logger.debug("dream-scheduler.notify-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } catch (error) {
        logger.debug("dream-scheduler.notify-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    },
  };
};
