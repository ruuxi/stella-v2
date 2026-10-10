import type { useRouter } from "expo-router";
import { setPendingShare } from "./pending-share";

/**
 * Starts a request to Stella from somewhere other than the chat: the text
 * waits in the composer, unsent, and the chat comes back to the front.
 */
export function startChatWith(
  router: ReturnType<typeof useRouter>,
  text: string,
): void {
  setPendingShare({ text });
  router.dismissTo("/chat");
}
