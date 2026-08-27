import type { DesktopThreadActivityRecord as ThreadActivityRecord } from "@/features/chat/thread-activity-types";

export type AgentAssistantSummary = {
  text: string;
  atMs: number;
  sequence?: number;
};

export const selectLatestAgentAssistantMessage = (
  messages: readonly string[] | undefined,
): string | undefined => {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.trim();
    if (text) return text;
  }
  return undefined;
};

const isLaterSummary = (
  candidate: AgentAssistantSummary,
  current: AgentAssistantSummary,
): boolean => {
  if (
    candidate.sequence !== undefined &&
    current.sequence !== undefined &&
    candidate.sequence !== current.sequence
  ) {
    return candidate.sequence > current.sequence;
  }
  return candidate.atMs > current.atMs;
};

export const selectLatestThreadAssistantSummary = (
  records: readonly ThreadActivityRecord[],
  options: {
    threadIds: readonly string[];
    excludedThreadIds?: readonly string[];
    attemptGenerationsByThread?: Readonly<Record<string, number>>;
    rootRunIdsByThread?: Readonly<Record<string, string>>;
    startedAtMsByThread?: Readonly<Record<string, number>>;
  },
): AgentAssistantSummary | undefined => {
  const included = new Set(options.threadIds);
  const excluded = new Set(options.excludedThreadIds ?? []);
  let latest: AgentAssistantSummary | undefined;

  for (const record of records) {
    if (!included.has(record.threadId) || excluded.has(record.threadId)) {
      continue;
    }
    const expectedAttempt =
      options.attemptGenerationsByThread?.[record.threadId];
    if (
      expectedAttempt !== undefined &&
      record.attemptGeneration !== expectedAttempt
    ) {
      continue;
    }
    const expectedRootRunId = options.rootRunIdsByThread?.[record.threadId];
    if (expectedRootRunId && record.rootRunId !== expectedRootRunId) continue;

    const text = selectLatestAgentAssistantMessage(record.assistantMessages);
    const atMs = record.assistantMessagesUpdatedAt ?? 0;
    const startedAtMs = options.startedAtMsByThread?.[record.threadId] ?? 0;
    if (!text || atMs < startedAtMs) continue;

    const candidate: AgentAssistantSummary = {
      text,
      atMs,
      ...(record.assistantMessagesUpdatedSequence === undefined
        ? {}
        : { sequence: record.assistantMessagesUpdatedSequence }),
    };
    if (!latest || isLaterSummary(candidate, latest)) latest = candidate;
  }

  return latest;
};
