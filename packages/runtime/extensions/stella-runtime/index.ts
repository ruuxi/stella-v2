import path from "node:path";
import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createConnectorAvailabilityReminderHook } from "./hooks/connector-availability-reminder.hook.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";
import { resolveRuntimeSourceAsset } from "../../kernel/shared/runtime-paths.js";

const bundledAgentMetadataDir = () =>
  resolveRuntimeSourceAsset("extensions", "stella-runtime", "agent-metadata");

/**
 * Register agents from the system mirror (shipped bodies) merged with bundled
 * capability metadata, plus any standalone user-defined agents.
 *
 * - `~/.stella/system/agents/<id>.md` provides the shipped prompt body;
 *   capability metadata (tools, model, maxAgentDepth) always comes from the
 *   bundled `agent-metadata/<id>.md` so a body update can never change an
 *   agent's tool surface.
 * - User customizations under `~/.stella/agents/` are NOT registered as
 *   agents for ids the system already ships — they are overlays/replacements
 *   composed per turn by `loadHomeAgentSystemPrompt`. Only ids with no system
 *   counterpart register as standalone user agents.
 * - `promptSource: bundled` metadata registers wholesale when the system
 *   mirror has no file for it yet (offline first boot before any sync).
 */
export const loadStellaRuntimeAgents = (
  stellaDataDir: string,
  agentMetadataDir: string | URL = bundledAgentMetadataDir(),
) => {
  const metadataAgents = loadParsedAgentsFromDir(agentMetadataDir);
  const metadataById = new Map(
    metadataAgents.map((agent) => [agent.id, agent]),
  );
  const systemAgents = loadParsedAgentsFromDir(
    path.join(stellaDataDir, "system", "agents"),
  );
  const registeredIds = new Set(systemAgents.map((agent) => agent.id));
  const reconciled = systemAgents.map((systemAgent) => {
    const metadata = metadataById.get(systemAgent.id);
    if (!metadata) return systemAgent;
    return {
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      systemPrompt: systemAgent.systemPrompt,
      agentTypes: metadata.agentTypes,
      ...(metadata.toolsAllowlist
        ? { toolsAllowlist: metadata.toolsAllowlist }
        : {}),
      ...(metadata.model ? { model: metadata.model } : {}),
      ...(typeof metadata.maxAgentDepth === "number"
        ? { maxAgentDepth: metadata.maxAgentDepth }
        : {}),
    };
  });
  for (const metadata of metadataAgents) {
    if (metadata.promptSource === "bundled" && !registeredIds.has(metadata.id)) {
      reconciled.push(metadata);
      registeredIds.add(metadata.id);
    }
  }
  for (const userAgent of loadParsedAgentsFromDir(
    path.join(stellaDataDir, "agents"),
  )) {
    if (registeredIds.has(userAgent.id)) continue;
    if (userAgent.id.endsWith(".replace")) continue;
    if (metadataById.has(userAgent.id)) continue;
    reconciled.push(userAgent);
    registeredIds.add(userAgent.id);
  }
  return reconciled;
};

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
 * Lives in `runtime/extensions/stella-runtime/` so power users can fork
 * any of these behaviors in place. The kernel has no special "bundled"
 * tier anymore — this extension goes through the same loader path as
 * any third-party extension, with `services` (stellaDataDir, stellaAppDir,
 * store) supplied by the runtime at registration time.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  // Prompt bodies remain live and user-editable under `~/.stella/agents/`.
  // Shipped capability metadata comes from this runtime extension so a body
  // customization cannot freeze an older tool allowlist across updates.
  for (const agent of loadStellaRuntimeAgents(services.stellaDataDir)) {
    pi.registerAgent(agent);
  }

  // Orchestrator + subagent lifecycle hooks. Each `create…Hook` returns
  // a HookDefinition closing over whatever subset of services it
  // needs; we register them via a single helper to keep the factory
  // body flat.
  const register = <E extends Parameters<typeof pi.on>[0]>(
    hook: HookDefinition<E>,
  ): void => {
    pi.on(hook.event, hook.handler, hook.filter);
  };

  register(createStaleUserReminderHook());
  register(createDynamicMemoryReminderHook());
  // Connector-format reminder: one hidden `<system_reminder>` on the
  // single turn where the user's routing surface changes (desktop ⇄
  // connector / connector ⇄ different connector). Cheap — the
  // transition decision is precomputed in `prepareOrchestratorRun`.
  register(createConnectorFormatReminderHook());
  // Connector-availability reminder: deterministic keyword match of each
  // user message against the connector catalog; injects a hidden
  // connected/not-connected note for the orchestrator, deduped once per
  // active context window (compaction resets eligibility; declines win).
  register(
    createConnectorAvailabilityReminderHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
    }),
  );
  register(
    createMemoryReviewHook({
      stellaDataDir: services.stellaDataDir,
      stellaAppDir: services.stellaAppDir,
      store: services.store,
    }),
  );
  register(
    createDreamSchedulerNotifyHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
    }),
  );
  register(createThreadSummariesRecordHook({ store: services.store }));
};

export default stellaRuntimeExtension;
