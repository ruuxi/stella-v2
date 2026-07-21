import { agentHasCapability } from "@stella/contracts/agent-runtime";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";
import { wrapInternalSystemReminder } from "@stella/contracts/system-reminders";

import {
  MEMORY_REVIEW_TURN_THRESHOLD,
  spawnMemoryReview,
} from "../agent-runtime/memory-review.js";
import { maybeSpawnDreamRun } from "../agent-runtime/dream-scheduler.js";
import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "../agents/local-agent-manager.js";
import { loadHomeAgentsWithMetadata } from "../agents/agents.js";
import { getConnectorDecline } from "../connectors/connect-preferences.js";
import { getNativeConnectorConnectionState } from "../connectors/connection-status.js";
import {
  getConnectorKeywordIndex,
  matchConnectorsInMessage,
} from "../connectors/keyword-index.js";
import type { NativeConnectorCatalogEntry } from "../connectors/native-integrations.js";
import { createRuntimeLogger } from "../debug.js";
import {
  isReminderShownInActiveWindow,
  recordReminderShown,
} from "../runner/reminder-window-gate.js";
import {
  RESTART_CONTINUATION_REMINDER_CUSTOM_TYPE,
  attachRestartReminderForConversation,
  buildRestartReminderText,
  describeCurrentThreadState,
  isRestartContinuationEnabled,
  resolveRestartReminderOutcome,
} from "../restart-continuation.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { getCompactionTriggerTokens } from "../thread-runtime.js";

/**
 * Stable engine capabilities exposed to home-loaded extensions.
 *
 * Extension files live outside the application bundle, so they must not reach
 * back into repo-relative kernel modules. The loader passes this object to
 * every factory instead. It deliberately exposes callable capabilities rather
 * than source paths, keeping the install layout private to the engine.
 */
export const createExtensionRuntimeApi = (options: {
  stellaDataDir: string;
  stellaAppDir: string;
  store: RuntimeStore;
}) => ({
  loadHomeAgents(metadataDir: string | URL) {
    return loadHomeAgentsWithMetadata(options.stellaDataDir, metadataDir);
  },
  agentHasCapability,
  wrapSystemReminder,
  wrapInternalSystemReminder,
  createLogger: createRuntimeLogger,
  getCompactionTriggerTokens,
  connectors: {
    async match(prompt: string): Promise<NativeConnectorCatalogEntry[]> {
      const index = await getConnectorKeywordIndex(options.stellaDataDir);
      return matchConnectorsInMessage(index, prompt);
    },
    getConnectionState(entry: NativeConnectorCatalogEntry) {
      return getNativeConnectorConnectionState(options.stellaDataDir, entry);
    },
    getDecline(connectorId: string) {
      return getConnectorDecline(options.stellaDataDir, connectorId);
    },
    isReminderShown(threadKey: string, key: string) {
      return isReminderShownInActiveWindow({
        stellaDataDir: options.stellaDataDir,
        store: options.store,
        threadKey,
        key,
      });
    },
    recordReminderShown(threadKey: string, key: string) {
      return recordReminderShown({
        stellaDataDir: options.stellaDataDir,
        threadKey,
        key,
      });
    },
  },
  memory: {
    reviewTurnThreshold: MEMORY_REVIEW_TURN_THRESHOLD,
    spawnReview(
      args: Omit<
        Parameters<typeof spawnMemoryReview>[0],
        "stellaDataDir" | "stellaAppDir" | "store"
      >,
    ) {
      return spawnMemoryReview({
        ...args,
        stellaDataDir: options.stellaDataDir,
        stellaAppDir: options.stellaAppDir,
        store: options.store,
      });
    },
    maybeSpawnDreamRun(
      args: Omit<
        Parameters<typeof maybeSpawnDreamRun>[0],
        "stellaDataDir" | "store"
      >,
    ) {
      return maybeSpawnDreamRun({
        ...args,
        stellaDataDir: options.stellaDataDir,
        store: options.store,
      });
    },
  },
  restartContinuation: {
    reminderCustomType: RESTART_CONTINUATION_REMINDER_CUSTOM_TYPE,
    enabled: () => isRestartContinuationEnabled(process.env),
    attach: (
      args: Parameters<typeof attachRestartReminderForConversation>[1],
    ) => attachRestartReminderForConversation(options.stellaDataDir, args),
    settle: (args: Parameters<typeof resolveRestartReminderOutcome>[1]) =>
      resolveRestartReminderOutcome(options.stellaDataDir, args),
    buildReminderText: buildRestartReminderText,
    describeCurrentThreadState: (
      record: Parameters<typeof describeCurrentThreadState>[0],
    ) =>
      describeCurrentThreadState(record, {
        pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
        restartCancelReasons: [
          AGENT_ORPHANED_RESTART_CANCEL_REASON,
          AGENT_SHUTDOWN_CANCEL_REASON,
        ],
      }),
  },
});

export type ExtensionRuntimeApi = ReturnType<typeof createExtensionRuntimeApi>;
