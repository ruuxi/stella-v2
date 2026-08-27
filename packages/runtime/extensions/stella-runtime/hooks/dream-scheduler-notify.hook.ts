import { agentHasCapability } from "@stella/contracts/agent-runtime";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";
import { getCompactionTriggerTokens } from "../../../kernel/thread-runtime.js";

const logger = createRuntimeLogger("stella-runtime.dream-notify");

export const createDreamSchedulerNotifyHook = (opts: {
  stellaDataDir: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "triggersDreamScheduler")) {
      return;
    }
    const services = payload.services;
    if (!services?.resolvedLlm) return;

    const tokenEstimate = services.orchestratorTokenEstimate;
    if (typeof tokenEstimate !== "number") {

      logger.debug("dream-scheduler.notify-missing-token-estimate", {
        agentType: payload.agentType,
      });
    }
    const compactionImminent =
      typeof tokenEstimate === "number" &&
      tokenEstimate >= getCompactionTriggerTokens(services.resolvedLlm);
    const trigger = compactionImminent ? "pre_compaction" : "token_interval";

    try {
      const { maybeSpawnDreamRun } = await import(
        "../../../kernel/agent-runtime/dream-scheduler.js"
      );
      void maybeSpawnDreamRun({
        stellaDataDir: opts.stellaDataDir,
        store: opts.store,
        resolvedLlm: services.resolvedLlm,
        trigger,
        ...(typeof tokenEstimate === "number"
          ? { orchestratorTokenEstimate: tokenEstimate }
          : {}),
      }).catch((error) => {
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
});
