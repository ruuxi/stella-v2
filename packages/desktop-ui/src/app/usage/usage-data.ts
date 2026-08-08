import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";

export type UsageRange = "24h" | "7d" | "30d" | "all";

export type UsageFilters = {
  conversationId?: string;
  threadId?: string;
  agentType?: string;
  model?: string;
};

export type UsageSummary = {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  cacheReadRate: number;
};

export type UsageThreadGroup = UsageSummary & {
  threadId: string;
  conversationId: string;
  conversationTitle: string;
  threadName: string;
  agentType: string;
  agentDescription?: string;
  agentDepth?: number;
  parentAgentId?: string;
  firstAt: number;
  lastAt: number;
  models: string[];
};

export type UsageTimelinePoint = UsageSummary & {
  timestamp: number;
  label: string;
};

export const rangeStartMs = (range: UsageRange, now = Date.now()) => {
  if (range === "all") return undefined;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return now - hours * 60 * 60 * 1000;
};

export const filterUsageRecords = (
  records: readonly LocalModelUsageRecord[],
  filters: UsageFilters,
) =>
  records.filter(
    (record) =>
      (!filters.conversationId ||
        record.conversationId === filters.conversationId) &&
      (!filters.threadId || record.threadId === filters.threadId) &&
      (!filters.agentType || record.agentType === filters.agentType) &&
      (!filters.model || record.model === filters.model),
  );

export const summarizeUsage = (
  records: readonly LocalModelUsageRecord[],
): UsageSummary => {
  const summary = records.reduce<UsageSummary>(
    (total, record) => ({
      calls: total.calls + 1,
      inputTokens: total.inputTokens + record.inputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      reasoningTokens: total.reasoningTokens + record.reasoningTokens,
      totalTokens: total.totalTokens + record.totalTokens,
      totalCostUsd: total.totalCostUsd + record.totalCostUsd,
      cacheReadRate: 0,
    }),
    {
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      cacheReadRate: 0,
    },
  );
  const promptTokens =
    summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  summary.cacheReadRate =
    promptTokens > 0 ? summary.cacheReadTokens / promptTokens : 0;
  return summary;
};

export const groupUsageByThread = (
  records: readonly LocalModelUsageRecord[],
): UsageThreadGroup[] => {
  const buckets = new Map<string, LocalModelUsageRecord[]>();
  for (const record of records) {
    const bucket = buckets.get(record.threadId);
    if (bucket) bucket.push(record);
    else buckets.set(record.threadId, [record]);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const latest = bucket.reduce((best, record) =>
        record.timestamp > best.timestamp ? record : best,
      );
      return {
        ...summarizeUsage(bucket),
        threadId: latest.threadId,
        conversationId: latest.conversationId,
        conversationTitle: latest.conversationTitle,
        threadName: latest.threadName,
        agentType: latest.agentType,
        ...(latest.agentDescription
          ? { agentDescription: latest.agentDescription }
          : {}),
        ...(typeof latest.agentDepth === "number"
          ? { agentDepth: latest.agentDepth }
          : {}),
        ...(latest.parentAgentId
          ? { parentAgentId: latest.parentAgentId }
          : {}),
        firstAt: Math.min(...bucket.map((record) => record.timestamp)),
        lastAt: Math.max(...bucket.map((record) => record.timestamp)),
        models: [...new Set(bucket.map((record) => record.model))],
      };
    })
    .sort(
      (a, b) =>
        b.totalCostUsd - a.totalCostUsd ||
        b.totalTokens - a.totalTokens ||
        b.lastAt - a.lastAt,
    );
};

const bucketStart = (
  timestamp: number,
  granularity: "hour" | "day" | "month",
) => {
  const date = new Date(timestamp);
  if (granularity === "hour") {
    date.setMinutes(0, 0, 0);
  } else if (granularity === "day") {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
};

export const buildUsageTimeline = (
  records: readonly LocalModelUsageRecord[],
  range: UsageRange,
): UsageTimelinePoint[] => {
  if (records.length === 0) return [];
  const first = Math.min(...records.map((record) => record.timestamp));
  const last = Math.max(...records.map((record) => record.timestamp));
  const spanDays = (last - first) / (24 * 60 * 60 * 1000);
  const granularity =
    range === "24h"
      ? "hour"
      : range === "all" && spanDays > 120
        ? "month"
        : "day";
  const buckets = new Map<number, LocalModelUsageRecord[]>();
  for (const record of records) {
    const key = bucketStart(record.timestamp, granularity);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, bucket]) => ({
      ...summarizeUsage(bucket),
      timestamp,
      label:
        granularity === "hour"
          ? new Date(timestamp).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
          : granularity === "month"
            ? new Date(timestamp).toLocaleDateString([], {
                month: "short",
                year: "2-digit",
              })
            : new Date(timestamp).toLocaleDateString([], {
                month: "short",
                day: "numeric",
              }),
    }));
};

export const executionLabel = (
  record: Pick<LocalModelUsageRecord, "agentType" | "agentDepth">,
) => {
  if (record.agentType === "orchestrator") return "Orchestrator";
  if ((record.agentDepth ?? 0) > 1) return "Sub-agent";
  return "Agent";
};
