import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createConnectorAvailabilityReminderHook } from "./hooks/connector-availability-reminder.hook.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createLinkSpendNotifyHook } from "./hooks/link-spend-notify.hook.js";
import { createLinkWalletReminderHook } from "./hooks/link-wallet-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createOrchestratorReminderHook } from "./hooks/orchestrator-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";
import { resolveRuntimeSourceAsset } from "../../kernel/shared/runtime-paths.js";

const bundledAgentMetadataDir = () =>
  resolveRuntimeSourceAsset("extensions", "stella-runtime", "agent-metadata");

export const loadStellaRuntimeAgents = (
  _stellaDataDir: string,
  agentMetadataDir: string | URL = bundledAgentMetadataDir(),
) => loadParsedAgentsFromDir(agentMetadataDir);

const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {

  for (const agent of loadStellaRuntimeAgents(services.stellaDataDir)) {
    pi.registerAgent(agent);
  }

  const register = <E extends Parameters<typeof pi.on>[0]>(
    hook: HookDefinition<E>,
  ): void => {
    pi.on(hook.event, hook.handler, hook.filter);
  };

  register(createStaleUserReminderHook());
  register(createOrchestratorReminderHook());

  register(createConnectorFormatReminderHook());

  register(
    createConnectorAvailabilityReminderHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
    }),
  );
  register(
    createLinkWalletReminderHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
    }),
  );
  register(createLinkSpendNotifyHook(services));
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
