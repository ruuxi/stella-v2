import type { ExtensionFactory, HookDefinition } from "./types.js";
import { createConnectorAvailabilityReminderHook } from "./hooks/connector-availability-reminder.hook.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createRestartContinuationReminderHooks } from "./hooks/restart-continuation-reminder.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";

/**
 * Stella's runtime extension.
 *
 * Bundles every Stella-specific runtime behavior that used to live as
 * hardcoded calls inside the kernel:
 *
 *   - Agent registration from backend-synchronized home markdown
 *   - Stale-user reminder
 *   - Dynamic memory reminder
 *   - Memory review spawn (post-orchestrator finalize)
 *   - Dream scheduler notify (post-subagent finalize)
 *   - Thread-summaries record (post-subagent finalize, capability-gated)
 *
 * Lives under `~/.stella/extensions/stella-runtime/` so users can fork any of
 * these behaviors in place. The kernel has no special bundled tier.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  // Prompt bodies remain live and user-editable under `~/.stella/agents/`.
  // Shipped capability metadata comes from this runtime extension so a body
  // customization cannot freeze an older tool allowlist across updates.
  const agentMetadataDir = new URL("./agent-metadata/", import.meta.url);
  for (const agent of services.runtime.loadHomeAgents(agentMetadataDir)) {
    pi.registerAgent(agent);
  }

  // Orchestrator + subagent lifecycle hooks. Each `create…Hook` returns
  // a HookDefinition closing over whatever subset of services it
  // needs; we register them via a single helper to keep the factory
  // body flat.
  const register = (hook: HookDefinition): void => {
    pi.on(hook.event, hook.handler);
  };

  register(createStaleUserReminderHook(services.runtime));
  register(createDynamicMemoryReminderHook(services.runtime));
  for (const hook of createRestartContinuationReminderHooks({
    runtime: services.runtime,
    store: services.store,
  })) {
    register(hook);
  }
  // Connector-format reminder: one hidden `<system_reminder>` on the
  // single turn where the user's routing surface changes (desktop ⇄
  // connector / connector ⇄ different connector). Cheap — the
  // transition decision is precomputed in `prepareOrchestratorRun`.
  register(createConnectorFormatReminderHook(services.runtime));
  // Connector-availability reminder: deterministic keyword match of each
  // user message against the connector catalog; injects a hidden
  // connected/not-connected note for the orchestrator, deduped once per
  // active context window (compaction resets eligibility; declines win).
  register(
    createConnectorAvailabilityReminderHook({
      runtime: services.runtime,
    }),
  );
  register(
    createMemoryReviewHook({
      runtime: services.runtime,
      store: services.store,
    }),
  );
  register(
    createDreamSchedulerNotifyHook({
      runtime: services.runtime,
    }),
  );
  register(
    createThreadSummariesRecordHook({
      runtime: services.runtime,
      store: services.store,
    }),
  );
};

export default stellaRuntimeExtension;
