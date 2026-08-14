import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";

/**
 * Orchestrator reminder (stella-runtime) — injects the runtime's
 * `orchestratorReminderText` (today the "# Other Threads" active-threads
 * roster) as a hidden runtime-internal user message.
 *
 * The cadence decision (which turns flip `shouldInjectDynamicReminder`)
 * is owned by the runtime via
 * `runtime/kernel/agent-runtime/thread-memory.ts:updateOrchestratorReminderState`;
 * this hook only consumes the decision.
 */
export const createOrchestratorReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      if (!payload.shouldInjectDynamicReminder) return;
      const text = payload.orchestratorReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.orchestrator_reminder",
          },
        ],
      };
    },
  });
