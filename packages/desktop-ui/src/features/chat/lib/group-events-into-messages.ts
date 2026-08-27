import type {
  EventRecord,
  MessageRecord,
} from "@stella/contracts/local-chat";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";

const isTurnDecorationEvent = (event: EventRecord): boolean =>
  event.type === "tool_request" ||
  event.type === "tool_result" ||
  event.type === "agent-started" ||
  event.type === "agent-progress" ||
  event.type === "agent-completed" ||
  event.type === "agent-failed" ||
  event.type === "agent-canceled";

const toMessageRecord = (event: EventRecord): MessageRecord => ({
  _id: event._id,
  timestamp: event.timestamp,
  type: event.type,
  ...(event.deviceId ? { deviceId: event.deviceId } : {}),
  ...(event.requestId ? { requestId: event.requestId } : {}),
  ...(event.targetDeviceId ? { targetDeviceId: event.targetDeviceId } : {}),
  ...(event.payload ? { payload: event.payload } : {}),
  ...(event.channelEnvelope ? { channelEnvelope: event.channelEnvelope } : {}),
  toolEvents: [],
});

export const groupEventsIntoMessages = (
  events: readonly EventRecord[],
): MessageRecord[] => {
  const messages: MessageRecord[] = [];
  let turnUserMessage: MessageRecord | null = null;
  let currentAssistant: MessageRecord | null = null;
  let pendingPreAssistantTools: EventRecord[] = [];

  const finalizePreAssistantTools = () => {
    if (pendingPreAssistantTools.length > 0 && turnUserMessage) {
      turnUserMessage.toolEvents = [
        ...turnUserMessage.toolEvents,
        ...pendingPreAssistantTools,
      ];
    }
    pendingPreAssistantTools = [];
  };

  for (const event of events) {
    if (event.type === "user_message") {
      finalizePreAssistantTools();
      const message = toMessageRecord(event);
      messages.push(message);
      turnUserMessage = message;
      currentAssistant = null;
      continue;
    }
    if (event.type === "assistant_message") {
      const message = toMessageRecord(event);
      messages.push(message);
      const hidden = isUiHiddenChatMessagePayload(event.payload ?? null);

      if (!hidden && pendingPreAssistantTools.length > 0) {
        message.toolEvents = [
          ...message.toolEvents,
          ...pendingPreAssistantTools,
        ];
        pendingPreAssistantTools = [];
      }
      if (!hidden) {
        currentAssistant = message;
      }
      continue;
    }
    if (isTurnDecorationEvent(event)) {
      if (currentAssistant) {
        currentAssistant.toolEvents = [...currentAssistant.toolEvents, event];
      } else {
        pendingPreAssistantTools.push(event);
      }
    }
  }

  finalizePreAssistantTools();
  return messages;
};
