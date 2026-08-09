import { memo, useMemo } from "react";
import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";
import { Select } from "@/ui/select";
import { useT } from "@/shared/i18n";
import { executionLabel, type UsageRange } from "./usage-data";
import { threadLabel } from "./format";

const ALL = "__all__";
const RANGE_OPTIONS = [
  { value: "24h", labelKey: "app.usage.filters.range.24h" },
  { value: "7d", labelKey: "app.usage.filters.range.7d" },
  { value: "30d", labelKey: "app.usage.filters.range.30d" },
  { value: "all", labelKey: "app.usage.filters.range.all" },
] satisfies Array<{ value: UsageRange; labelKey: string }>;

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
  const t = useT();
  const rangeOptions = useMemo(
    () =>
      RANGE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t],
  );
  const conversationOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const record of records) {
      byId.set(record.conversationId, record.conversationTitle);
    }
    return [
      { value: ALL, label: t("app.usage.filters.allConversations") },
      ...[...byId.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [records, t]);

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
      { value: ALL, label: t("app.usage.filters.allThreads") },
      ...[...byId.values()].map((record) => ({
        value: record.threadId,
        label: `${executionLabel(record)} · ${threadLabel(record)}`,
      })),
    ];
  }, [recordsForConversation, t]);
  const agentOptions = useMemo(
    () => [
      { value: ALL, label: t("app.usage.filters.allAgentTypes") },
      ...[...new Set(records.map((record) => record.agentType))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [records, t],
  );
  const modelOptions = useMemo(
    () => [
      { value: ALL, label: t("app.usage.filters.allModels") },
      ...[...new Set(records.map((record) => record.model))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [records, t],
  );

  return (
    <section
      className="usage-filters"
      aria-label={t("app.usage.filters.label")}
    >
      <Select
        value={range}
        onValueChange={(value) =>
          onSearchChange({ range: value as UsageRange })
        }
        options={rangeOptions}
        aria-label={t("app.usage.filters.timeRange")}
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
        aria-label={t("app.usage.filters.conversation")}
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
        aria-label={t("app.usage.filters.thread")}
      />
      <Select
        value={agent ?? ALL}
        onValueChange={(value) =>
          onSearchChange({ agent: value === ALL ? undefined : value })
        }
        options={agentOptions}
        aria-label={t("app.usage.filters.agentType")}
      />
      <Select
        value={model ?? ALL}
        onValueChange={(value) =>
          onSearchChange({ model: value === ALL ? undefined : value })
        }
        options={modelOptions}
        aria-label={t("app.usage.filters.model")}
      />
    </section>
  );
});
