import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "@stella/contracts/system-reminders";

export const createConnectorFormatReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      const text = payload.connectorTransitionReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.connector_format_reminder",
          },
        ],
      };
    },
  });
