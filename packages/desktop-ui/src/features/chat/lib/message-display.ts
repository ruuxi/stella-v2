import type { EventRecord } from "./event-transforms";
import type { MessageRecord } from "@stella/contracts/local-chat";
import {
  isUiDisplayableChatEvent,
  isUiHiddenChatMessagePayload,
} from "@stella/contracts/chat-event-visibility";

export const isUiHiddenMessagePayload = isUiHiddenChatMessagePayload;

function isUiDisplayableEvent(event: EventRecord): boolean {
  return isUiDisplayableChatEvent(event);
}

export function filterEventsForUiDisplay(events: EventRecord[]): EventRecord[] {
  return events.filter(isUiDisplayableEvent);
}

export function filterMessagesForUiDisplay(
  messages: MessageRecord[],
): MessageRecord[] {
  return messages.filter((message) => isUiDisplayableChatEvent(message));
}
