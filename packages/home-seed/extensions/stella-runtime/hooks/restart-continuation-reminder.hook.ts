import type {
  ExtensionRuntime,
  ExtensionStore,
  HookDefinition,
} from "../types.js";

/**
 * Restart-continuation reminder (stella-runtime).
 *
 * When a restart/quit interrupted in-flight agent work, the FIRST user
 * message in an affected conversation after boot carries a hidden
 * `<system-reminder>`: a one-line restart notice plus the CURRENT state of
 * the threads that were running at shutdown (resolved live from the durable
 * thread rows — no before-state snapshotting).
 *
 * Delivery-safe one-shot: attaching only marks the reminder PENDING on the
 * carrying run; the paired `agent_end` hook consumes it when that run
 * completes successfully and clears the pending mark on failure/interruption
 * so the reminder re-attaches on the next user message.
 *
 * Complements the boot-time synthetic continuation turn per conversation:
 *  - the turn COMPLETED there → brief confirmation variant;
 *  - the turn failed, hung, was gated off, or the user messaged first → the
 *    reminder is the primary recovery path with full resume guidance.
 *
 * Clean-idle shutdowns never produce an interruption state, so these hooks
 * are cheap no-ops on normal boots. Automation/system turns run hidden
 * (`isUserTurn === false`) and never attach or consume the reminder —
 * including the synthetic continuation turn itself.
 */

export const createRestartContinuationReminderHooks = (options: {
  runtime: ExtensionRuntime;
  store: ExtensionStore;
}): [HookDefinition, HookDefinition] => {
  const attachHook: HookDefinition = {
    event: "before_user_message",
    async handler(payload) {
      if (payload.agentType !== "orchestrator") return;
      if (payload.isUserTurn === false) return;
      const conversationId = payload.conversationId;
      if (!conversationId) return;
      if (!options.runtime.restartContinuation.enabled()) return;

      let attached: ReturnType<
        ExtensionRuntime["restartContinuation"]["attach"]
      >;
      try {
        attached = options.runtime.restartContinuation.attach({
          conversationId,
          ...(payload.runId ? { runId: payload.runId } : {}),
        });
      } catch {
        return;
      }
      if (!attached) return;

      const threads = attached.threads.map((ref) => {
        const record = options.store.getAgentRecord?.(ref.threadId) ?? null;
        const current =
          options.runtime.restartContinuation.describeCurrentThreadState(
            record,
          );
        return {
          threadId: ref.threadId,
          description: record?.description ?? "(unknown task)",
          agentType: record?.agentType ?? "unknown",
          stateLabel: current.label,
        };
      });

      const text = options.runtime.restartContinuation.buildReminderText({
        reason: attached.state.reason,
        shutdownAt: attached.state.shutdownAt,
        syntheticTurnCompleted: attached.turnCompleted,
        threads,
      });
      return {
        prependMessages: [
          {
            text: options.runtime.wrapSystemReminder(text),
            uiVisibility: "hidden" as const,
            messageType: "message" as const,
            customType: options.runtime.restartContinuation.reminderCustomType,
          },
        ],
      };
    },
  };

  const settleHook: HookDefinition = {
    event: "agent_end",
    async handler(payload) {
      if (payload.agentType !== "orchestrator") return;
      const conversationId = payload.conversationId;
      if (!conversationId) return;
      if (!options.runtime.restartContinuation.enabled()) return;
      try {
        options.runtime.restartContinuation.settle({
          conversationId,
          ...(payload.runId ? { runId: payload.runId } : {}),
          succeeded: payload.outcome === "success",
          ...(payload.isUserTurn !== undefined
            ? { isUserTurn: payload.isUserTurn }
            : {}),
        });
      } catch {
        // Best-effort: an unsettled pending reminder re-attaches next turn.
      }
    },
  };

  return [attachHook, settleHook];
};
