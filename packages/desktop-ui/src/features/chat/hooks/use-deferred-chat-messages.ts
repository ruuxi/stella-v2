import { useRef } from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";

const oldestId = (messages: MessageRecord[]): string | null =>
  messages[0]?._id ?? null;

const newestId = (messages: MessageRecord[]): string | null =>
  messages.length === 0 ? null : (messages[messages.length - 1]?._id ?? null);

/**
 * Holds the last painted timeline while the user is actively scrolling so a
 * streaming token or newly persisted tail row cannot hitch the list mid-
 * gesture.
 *
 * Older-page prepends are *not* deferred. Those rows have to land while the
 * upward gesture is still live so Legend MVCP and the residual-anchor
 * restore can pin the visible content before the user reaches the painted
 * top. Deferring them until wheel-idle dumped 200 rows at once and cancelled
 * the prepend restore.
 *
 * Conversation / scope changes always flush immediately.
 */
export function useDeferredChatMessages(
  messages: MessageRecord[],
  deferUpdates: boolean,
  scopeKey?: string | null,
): MessageRecord[] {
  const paintedRef = useRef(messages);
  const scopeRef = useRef(scopeKey);

  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    paintedRef.current = messages;
    return messages;
  }

  if (!deferUpdates) {
    paintedRef.current = messages;
    return messages;
  }

  const painted = paintedRef.current;
  const prepended =
    messages.length > painted.length &&
    newestId(messages) === newestId(painted) &&
    oldestId(messages) !== oldestId(painted);
  if (prepended) {
    paintedRef.current = messages;
    return messages;
  }

  return painted;
}
