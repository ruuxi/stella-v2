import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";

export const createStaleUserReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      const text = payload.staleUserReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.stale_user_reminder",
          },
        ],
      };
    },
  });
