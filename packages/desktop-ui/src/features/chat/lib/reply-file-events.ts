import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";

/**
 * Stella's replies that link files, in the event shape the Files panel reads
 * (it takes the links from the text), as the chat log's file feed gives them
 * for a conversation kept on this computer.
 */
export const replyFileEvents = (messages: readonly MessageRecord[]): EventRecord[] => {
  const events: EventRecord[] = [];
  for (const message of messages) {
    if (message.type !== "assistant_message") continue;
    const text = typeof message.payload?.text === "string" ? message.payload.text : "";
    if (!text.includes("](")) continue;
    events.push({ _id: message._id, timestamp: message.timestamp, type: "assistant_message", payload: { text } });
  }
  return events;
};

const LIFECYCLE_TYPES = new Set(["agent-started", "agent-completed", "agent-failed", "agent-canceled"]);

/** One event's identity across sources: a task's start or end is one event wherever it was recorded. */
const eventKey = (event: EventRecord): string => {
  const agentId = event.payload?.agentId;
  return LIFECYCLE_TYPES.has(event.type) && typeof agentId === "string" ? `${event.type}\u0000${agentId}` : event._id;
};

/** Event lists merged in time order, each event once (the first list's copy wins). */
export const mergeEvents = (...lists: readonly (readonly EventRecord[])[]): EventRecord[] => {
  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length === 1) return nonEmpty[0] as EventRecord[];
  const seen = new Set<string>();
  const merged: EventRecord[] = [];
  for (const list of nonEmpty) {
    for (const event of list) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
};
