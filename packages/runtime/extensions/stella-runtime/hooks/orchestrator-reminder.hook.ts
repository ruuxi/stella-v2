import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../../../kernel/storage/shared.js";

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
            customType: ORCHESTRATOR_ROSTER_CUSTOM_TYPE,
          },
        ],
      };
    },
  });
