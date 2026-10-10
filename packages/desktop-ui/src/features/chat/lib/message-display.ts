import {
  isUiDisplayableChatEvent,
  isUiHiddenChatMessagePayload,
} from "@stella/contracts/chat-event-visibility";

type ChatEventLike = Parameters<typeof isUiDisplayableChatEvent>[0];

export const isUiHiddenMessagePayload = isUiHiddenChatMessagePayload;
function isUiDisplayableEvent(event: ChatEventLike): boolean {
  return isUiDisplayableChatEvent(event);
}
export function filterEventsForUiDisplay<T extends ChatEventLike>(
  events: readonly T[],
): T[] {
  return events.filter(isUiDisplayableEvent);
}
export function filterMessagesForUiDisplay<T extends ChatEventLike>(
  messages: readonly T[],
): T[] {
  return messages.filter((message) => isUiDisplayableChatEvent(message));
}
