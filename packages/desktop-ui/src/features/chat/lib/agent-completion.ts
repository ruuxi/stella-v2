import type { EventRecord } from "./event-transforms";
import {
  fallbackTaskDescription,
  isAgentCompletedEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import { deriveAgentFilesMap } from "@/features/workspace-display/agent-files";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import { isDeclaredOutputPath } from "@/features/workspace-display/path-to-viewer";

export type AgentCompletionSection = {
  agentId: string;
  agentType?: string;
  title: string;

  startEventId?: string;
  completionEventId?: string;
  rootRunId?: string;

  completedAtMs: number;

  files: ConversationFileEntry[];

  summary?: string;
};

export type AgentMeta = {
  description?: string;
  agentType?: string;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const rankDeliverablesFirst = (
  entries: ConversationFileEntry[],
): ConversationFileEntry[] => [
  ...entries.filter((entry) => isDeclaredOutputPath(entry.path)),
  ...entries.filter((entry) => !isDeclaredOutputPath(entry.path)),
];

export function buildAgentMetaMap(
  events: ReadonlyArray<EventRecord>,
): Map<string, AgentMeta> {
  const byId = new Map<string, AgentMeta>();
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const existing = byId.get(agentId) ?? {};
    const next: AgentMeta = { ...existing };
    if (!next.description) {
      next.description = asNonEmptyString(event.payload.description);
    }
    if (!next.agentType) {
      next.agentType = asNonEmptyString(event.payload.agentType);
    }
    byId.set(agentId, next);
  }
  return byId;
}

export function deriveAgentCompletionFiles(
  toolEvents: ReadonlyArray<EventRecord>,
): Map<string, ConversationFileEntry[]> {
  return deriveAgentFilesMap(toolEvents, isAgentCompletedEvent);
}

const SUMMARY_MAX_CHARS = 200;

const SUMMARY_BOUNDARY_SLACK = 32;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const truncateAtGrapheme = (value: string, max: number): string => {
  if (value.length <= max) return value;
  if (!graphemeSegmenter) {

    const cut = value.slice(0, max);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  }
  let end = 0;
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return value.slice(0, end);
};

const stripBlockMarkdown = (text: string): string =>
  text
    .split(/\r?\n/)

    .filter((line) => !/^\s*(?:```|~~~)/.test(line))
    .map((line) =>
      line

        .replace(/^\s{0,3}#{1,6}\s+/, "")

        .replace(/^\s*(?:>\s?)+/, "")

        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")

        .replace(/^\s*(?:[-*_]\s*){3,}$/, ""),
    )
    .join("\n");

const removeLastOccurrence = (text: string, marker: string): string => {
  const index = text.lastIndexOf(marker);
  if (index === -1) return text;
  return text.slice(0, index) + text.slice(index + marker.length);
};

const countOccurrences = (text: string, marker: string): number =>
  text.split(marker).length - 1;

const dropDanglingInlineMarkers = (text: string): string => {
  let out = text;
  if (countOccurrences(out, "`") % 2 === 1) {
    out = removeLastOccurrence(out, "`");
  }
  if (countOccurrences(out, "**") % 2 === 1) {
    out = removeLastOccurrence(out, "**");
  }
  if (countOccurrences(out, "~~") % 2 === 1) {
    out = removeLastOccurrence(out, "~~");
  }
  const singleStars =
    countOccurrences(out, "*") - 2 * countOccurrences(out, "**");
  if (singleStars % 2 === 1) {
    out = removeLastOccurrence(out, "*");
  }
  return out;
};

const toSummaryExcerpt = (result: string): string => {
  const compact = stripBlockMarkdown(result).replace(/\s+/g, " ").trim();
  if (compact.length <= SUMMARY_MAX_CHARS) {
    return dropDanglingInlineMarkers(compact);
  }

  const head = truncateAtGrapheme(compact, SUMMARY_MAX_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut =
    lastSpace >= SUMMARY_MAX_CHARS - SUMMARY_BOUNDARY_SLACK
      ? head.slice(0, lastSpace)
      : head;
  return `${dropDanglingInlineMarkers(cut.trimEnd()).trimEnd()}…`;
};

export function buildAgentCompletionSections(
  toolEvents: ReadonlyArray<EventRecord>,
  agentMetaById: ReadonlyMap<string, AgentMeta>,
): AgentCompletionSection[] {
  const files = deriveAgentCompletionFiles(toolEvents);

  const completedAgentIds: string[] = [];
  const completedAtByAgent = new Map<string, number>();
  const completionEventIdByAgent = new Map<string, string>();
  const rootRunIdByAgent = new Map<string, string>();
  const summaryByAgent = new Map<string, string>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const prev = completedAtByAgent.get(agentId);
    if (prev === undefined) completedAgentIds.push(agentId);
    if (prev === undefined || event.timestamp >= prev) {
      completedAtByAgent.set(agentId, Math.max(prev ?? 0, event.timestamp));
      completionEventIdByAgent.set(agentId, event._id);
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      if (rootRunId) rootRunIdByAgent.set(agentId, rootRunId);
      else rootRunIdByAgent.delete(agentId);
      const result = asNonEmptyString(event.payload.result);

      if (result) summaryByAgent.set(agentId, toSummaryExcerpt(result));
      else summaryByAgent.delete(agentId);
    }
  }

  const sections: AgentCompletionSection[] = [];
  for (const agentId of completedAgentIds) {
    const meta = agentMetaById.get(agentId);
    const title =
      meta?.description?.trim() ||
      fallbackTaskDescription(agentId);
    const entries = files.get(agentId) ?? [];
    const summary = summaryByAgent.get(agentId);
    sections.push({
      agentId,
      ...(meta?.agentType ? { agentType: meta.agentType } : {}),
      title,
      completedAtMs: completedAtByAgent.get(agentId) ?? 0,
      ...(completionEventIdByAgent.get(agentId)
        ? { completionEventId: completionEventIdByAgent.get(agentId) }
        : {}),
      ...(rootRunIdByAgent.get(agentId)
        ? { rootRunId: rootRunIdByAgent.get(agentId) }
        : {}),
      files: rankDeliverablesFirst([...entries]),
      ...(summary ? { summary } : {}),
    });
  }
  return sections;
}
