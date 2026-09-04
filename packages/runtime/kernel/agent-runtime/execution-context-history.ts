import { readExecutionContextSnapshot } from "@stella/contracts/execution-context";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import {
  buildResidentContextMessages,
  residentIdentityForCustomMessage,
} from "./resident-context.js";

type ResidentEntry = {
  role: "runtimeInternal";
  customMessage: { customType: string; content: string };
};

/**
 * The shared journal stores context as user-message metadata, never visible
 * chat text. Rebuild its resident blocks through the same registry as local
 * threads. A shortened journal window starts with a fresh canonical copy;
 * within the window only changes append, preserving every existing byte.
 */
export const executionContextHistoryEntries = <
  T extends { role: string; timestamp?: number },
>(
  messages: readonly T[],
): Array<
  | { kind: "message"; message: T }
  | { kind: "resident"; prompt: RuntimePromptMessage; timestamp: number }
> => {
  const result: ReturnType<typeof executionContextHistoryEntries<T>> = [];
  const latest = new Map<string, ResidentEntry>();
  for (const message of messages) {
    const executionContext =
      message.role === "user"
        ? readExecutionContextSnapshot(message)
        : undefined;
    if (executionContext) {
      const prompts: RuntimePromptMessage[] = buildResidentContextMessages({
        executionContext,
        threadHistory: [...latest.values()],
      });
      for (const prompt of prompts) {
        result.push({
          kind: "resident",
          prompt,
          timestamp: message.timestamp ?? 0,
        });
        if (prompt.customType === "bootstrap.startup_doc") {
          const identity = residentIdentityForCustomMessage({
            customType: prompt.customType,
            content: prompt.text,
          });
          if (identity)
            latest.set(identity, {
              role: "runtimeInternal",
              customMessage: {
                customType: prompt.customType,
                content: prompt.text,
              },
            });
        }
      }
    }
    result.push({ kind: "message", message });
  }
  return result;
};
