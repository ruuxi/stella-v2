import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  responseTextForFileLinks,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";

export function deriveAgentFilesMap(
  activities: ReadonlyArray<EventRecord>,
  eventFilter?: (event: EventRecord) => boolean,
): Map<string, ConversationFileEntry[]> {
  const eventsByAgent = new Map<string, EventRecord[]>();
  for (const event of activities) {
    if (eventFilter && !eventFilter(event)) continue;
    const agentId = (event.payload as { agentId?: unknown } | undefined)
      ?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    const list = eventsByAgent.get(agentId);
    if (list) list.push(event);
    else eventsByAgent.set(agentId, [event]);
  }
  const filesByAgent = new Map<string, ConversationFileEntry[]>();
  for (const [agentId, events] of eventsByAgent) {
    const files = deriveConversationFiles(events);
    if (files.length > 0) filesByAgent.set(agentId, files);
  }
  return filesByAgent;
}

const eventAgentId = (event: EventRecord): string | null => {
  const agentId = (event.payload as { agentId?: unknown } | undefined)
    ?.agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : null;
};

export function mergeAgentFileEvents(
  activities: ReadonlyArray<EventRecord>,
  fileEvents: ReadonlyArray<EventRecord>,
): ReadonlyArray<EventRecord> {
  if (fileEvents.length === 0) return activities;
  const seenIds = new Set<string>();
  for (const event of activities) seenIds.add(event._id);
  const extras = fileEvents.filter(
    (event) =>
      !seenIds.has(event._id) &&
      eventAgentId(event) !== null &&
      eventContributesFiles(event),
  );
  if (extras.length === 0) return activities;
  const before = (a: EventRecord, b: EventRecord): boolean =>
    a.timestamp < b.timestamp ||
    (a.timestamp === b.timestamp && a._id <= b._id);
  const merged: EventRecord[] = [];
  let i = 0;
  let j = 0;
  while (i < activities.length && j < extras.length) {
    if (before(activities[i], extras[j])) merged.push(activities[i++]);
    else merged.push(extras[j++]);
  }
  while (i < activities.length) merged.push(activities[i++]);
  while (j < extras.length) merged.push(extras[j++]);
  return merged;
}

export function eventContributesFiles(event: EventRecord): boolean {
  return extractLocalFileLinkPaths(responseTextForFileLinks(event)).length > 0;
}

export function agentFilesSignature(
  activities: ReadonlyArray<EventRecord>,
): string {
  let signature = "";
  for (const event of activities) {
    const agentId = (event.payload as { agentId?: unknown } | undefined)
      ?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    if (!eventContributesFiles(event)) continue;
    const fileCount = extractLocalFileLinkPaths(
      responseTextForFileLinks(event),
    ).length;
    signature += `${agentId}\u001f${event._id}\u001f${event.timestamp}\u001f${fileCount}\u001e`;
  }
  return signature;
}
