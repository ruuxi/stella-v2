import { memo, useMemo } from "react";
import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";
import { Select } from "@/ui/select";
import { executionLabel, type UsageRange } from "./usage-data";
import { threadLabel } from "./format";

const ALL = "__all__";
const RANGE_OPTIONS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
] satisfies Array<{ value: UsageRange; label: string }>;

export type UsageSearchPatch = {
  range?: UsageRange;
  conversation?: string | undefined;
  thread?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
};

type UsageFiltersBarProps = {
  range: UsageRange;
  conversation?: string | undefined;
  thread?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  records: LocalModelUsageRecord[];
  onSearchChange: (patch: UsageSearchPatch) => void;
};

export const UsageFiltersBar = memo(function UsageFiltersBar({
  range,
  conversation,
  thread,
  agent,
  model,
  records,
  onSearchChange,
}: UsageFiltersBarProps) {
  const conversationOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const record of records) {
      byId.set(record.conversationId, record.conversationTitle);
    }
    return [
      { value: ALL, label: "All conversations" },
      ...[...byId.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [records]);

  const recordsForConversation = useMemo(
    () =>
      conversation
        ? records.filter((record) => record.conversationId === conversation)
        : records,
    [conversation, records],
  );
  const threadOptions = useMemo(() => {
    const byId = new Map<string, LocalModelUsageRecord>();
    for (const record of recordsForConversation) {
      if (!byId.has(record.threadId)) byId.set(record.threadId, record);
    }
    return [
      { value: ALL, label: "All threads" },
      ...[...byId.values()].map((record) => ({
        value: record.threadId,
        label: `${executionLabel(record)} · ${threadLabel(record)}`,
      })),
    ];
  }, [recordsForConversation]);
  const agentOptions = useMemo(
    () => [
      { value: ALL, label: "All agent types" },
      ...[...new Set(records.map((record) => record.agentType))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [records],
  );
  const modelOptions = useMemo(
    () => [
      { value: ALL, label: "All models" },
      ...[...new Set(records.map((record) => record.model))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [records],
  );

  return (
    <section className="usage-filters" aria-label="Usage filters">
      <Select
        value={range}
        onValueChange={(value) =>
          onSearchChange({ range: value as UsageRange })
        }
        options={RANGE_OPTIONS}
        aria-label="Time range"
      />
      <Select
        value={conversation ?? ALL}
        onValueChange={(value) =>
          onSearchChange({
            conversation: value === ALL ? undefined : value,
            thread: undefined,
          })
        }
        options={conversationOptions}
        aria-label="Conversation"
      />
      <Select
        value={thread ?? ALL}
        onValueChange={(value) => {
          const record = records.find((item) => item.threadId === value);
          onSearchChange({
            thread: value === ALL ? undefined : value,
            ...(record ? { conversation: record.conversationId } : {}),
          });
        }}
        options={threadOptions}
        aria-label="Thread"
      />
      <Select
        value={agent ?? ALL}
        onValueChange={(value) =>
          onSearchChange({ agent: value === ALL ? undefined : value })
        }
        options={agentOptions}
        aria-label="Agent type"
      />
      <Select
        value={model ?? ALL}
        onValueChange={(value) =>
          onSearchChange({ model: value === ALL ? undefined : value })
        }
        options={modelOptions}
        aria-label="Model"
      />
    </section>
  );
});
