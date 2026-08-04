import { isUiDisplayableChatEvent, isUiHiddenChatMessagePayload, } from "@stella/contracts/chat-event-visibility";
export const isUiHiddenMessagePayload = isUiHiddenChatMessagePayload;
function isUiDisplayableEvent(event) {
    return isUiDisplayableChatEvent(event);
}
export function filterEventsForUiDisplay(events) {
    return events.filter(isUiDisplayableEvent);
}
export function filterMessagesForUiDisplay(messages) {
    return messages.filter((message) => isUiDisplayableChatEvent(message));
}
