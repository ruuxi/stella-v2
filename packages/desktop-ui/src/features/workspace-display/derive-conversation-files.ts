import type { EventRecord } from "@/features/chat/lib/event-transforms";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";

export type ConversationFileEntry = {
  path: string;
  timestamp: number;
  payload: DisplayTabPayload;
};

export const responseTextForFileLinks = (event: EventRecord): string => {
  if (!event.payload || typeof event.payload !== "object") return "";
  if (event.type === "assistant_message") {
    return typeof event.payload.text === "string" ? event.payload.text : "";
  }
  if (event.type === "agent-completed") {
    return typeof event.payload.result === "string" ? event.payload.result : "";
  }
  return "";
};

export function deriveConversationFiles(
  events: ReadonlyArray<EventRecord>,
  options?: { cap?: number },
): ConversationFileEntry[] {
  const seen = new Map<string, ConversationFileEntry>();

  for (const event of events) {
    for (const filePath of extractLocalFileLinkPaths(
      responseTextForFileLinks(event),
    )) {
      const payload = buildPayloadFromBarePath(filePath, event.timestamp, {
        developerResourcesEnabled: true,
      });
      if (!payload || !isDisplayTabPayload(payload)) continue;
      seen.set(filePath, { path: filePath, timestamp: event.timestamp, payload });
    }
  }

  const all = Array.from(seen.values()).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  return options?.cap === undefined ? all : all.slice(0, options.cap);
}
