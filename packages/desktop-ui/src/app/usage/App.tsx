import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type {
  LocalModelUsagePage,
  LocalModelUsageRecord,
} from "@stella/contracts/local-chat";
import { Select } from "@/ui/select";
import { RefreshCw } from "@/ui/icons";
import {
  buildUsageTimeline,
  executionLabel,
  filterUsageRecords,
  groupUsageByThread,
  rangeStartMs,
  summarizeUsage,
  type UsageRange,
} from "./usage-data";
import "./usage.css";

const ALL = "__all__";
const RANGE_OPTIONS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
] satisfies Array<{ value: UsageRange; label: string }>;

const formatTokens = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);

const formatCost = (value: number) => {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(3)}`;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const shortId = (value: string) =>
  value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;

const threadLabel = (record: {
  threadName: string;
  agentType: string;
  agentDepth?: number;
}) =>
  record.threadName ||
  `${executionLabel(record)} · ${record.agentType || "unknown"}`;

const UsageTooltip = ({ active, payload, label }: TooltipContentProps) => {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as
    | ReturnType<typeof buildUsageTimeline>[number]
    | undefined;
  if (!point) return null;
  return (
    <div className="usage-chart-tooltip">
      <strong>{label}</strong>
      <span>{formatCost(point.totalCostUsd)} estimated</span>
      <span>{formatTokens(point.totalTokens)} tokens</span>
      <span>{point.calls} model calls</span>
    </div>
  );
};

export function UsageApp() {
  const search = useSearch({ from: "/usage" });
  const navigate = useNavigate({ from: "/usage" });
  const [page, setPage] = useState<LocalModelUsagePage>({
    records: [],
    truncated: false,
  });
  const [optionRecords, setOptionRecords] = useState<LocalModelUsageRecord[]>(
    [],
  );
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const range = search.range ?? "7d";
  const load = useCallback(async () => {
    const api = window.electronAPI?.localChat;
    if (!api?.listModelUsage) {
      setError("Local usage is available in the Stella desktop app.");
      setPhase("error");
      return;
    }
    setPhase((current) => (current === "ready" ? current : "loading"));
    try {
      const baseRequest = {
        fromMs: rangeStartMs(range),
        limit: 10_000,
      };
      const facetsPromise = api.listModelUsage(baseRequest);
      const scopedPromise =
        search.conversation || search.thread
          ? api.listModelUsage({
              ...baseRequest,
              conversationId: search.conversation,
              threadId: search.thread,
            })
          : facetsPromise;
      const [facets, next] = await Promise.all([facetsPromise, scopedPromise]);
      setOptionRecords(facets.records);
      setPage(next);
      setError("");
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }, [range, search.conversation, search.thread]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    let timeout = 0;
    const queueRefresh = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(
        () => setRefreshKey((value) => value + 1),
        300,
      );
    };
    const removeChat = window.electronAPI?.localChat?.onUpdated?.(queueRefresh);
    const removeThreads =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.(queueRefresh);
    return () => {
      window.clearTimeout(timeout);
      removeChat?.();
      removeThreads?.();
    };
  }, []);

  const allRecords = page.records;
  const conversationOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const record of optionRecords) {
      byId.set(record.conversationId, record.conversationTitle);
    }
    return [
      { value: ALL, label: "All conversations" },
      ...[...byId.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [optionRecords]);

  const recordsForConversation = useMemo(
    () =>
      search.conversation
        ? optionRecords.filter(
            (record) => record.conversationId === search.conversation,
          )
        : optionRecords,
    [optionRecords, search.conversation],
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
      ...[...new Set(optionRecords.map((record) => record.agentType))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [optionRecords],
  );
  const modelOptions = useMemo(
    () => [
      { value: ALL, label: "All models" },
      ...[...new Set(optionRecords.map((record) => record.model))]
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [optionRecords],
  );

  const records = useMemo(
    () =>
      filterUsageRecords(allRecords, {
        conversationId: search.conversation,
        threadId: search.thread,
        agentType: search.agent,
        model: search.model,
      }),
    [
      allRecords,
      search.agent,
      search.conversation,
      search.model,
      search.thread,
    ],
  );
  const summary = useMemo(() => summarizeUsage(records), [records]);
  const threads = useMemo(() => groupUsageByThread(records), [records]);
  const timeline = useMemo(
    () => buildUsageTimeline(records, range),
    [range, records],
  );

  const updateSearch = useCallback(
    (patch: Partial<typeof search>) => {
      void navigate({
        search: (current) => ({ ...current, ...patch }),
        replace: true,
      });
    },
    [navigate],
  );

  const selectedThread = search.thread
    ? (optionRecords.find((record) => record.threadId === search.thread) ??
      allRecords.find((record) => record.threadId === search.thread))
    : undefined;

  return (
    <main className="usage-screen" aria-busy={phase === "loading" || undefined}>
      <header className="usage-hero">
        <div>
          <p className="usage-eyebrow">Local telemetry</p>
          <h1>Model usage</h1>
          <p>
            Provider calls persisted on this device. Costs are local estimates;
            backend billing remains authoritative.
          </p>
        </div>
        <button
          type="button"
          className="usage-refresh"
          onClick={() => setRefreshKey((value) => value + 1)}
          aria-label="Refresh usage"
          title="Refresh usage"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </header>

      <section className="usage-filters" aria-label="Usage filters">
        <Select
          value={range}
          onValueChange={(value) =>
            updateSearch({ range: value as UsageRange })
          }
          options={RANGE_OPTIONS}
          aria-label="Time range"
        />
        <Select
          value={search.conversation ?? ALL}
          onValueChange={(value) =>
            updateSearch({
              conversation: value === ALL ? undefined : value,
              thread: undefined,
            })
          }
          options={conversationOptions}
          aria-label="Conversation"
        />
        <Select
          value={search.thread ?? ALL}
          onValueChange={(value) => {
            const record = allRecords.find((item) => item.threadId === value);
            updateSearch({
              thread: value === ALL ? undefined : value,
              ...(record ? { conversation: record.conversationId } : {}),
            });
          }}
          options={threadOptions}
          aria-label="Thread"
        />
        <Select
          value={search.agent ?? ALL}
          onValueChange={(value) =>
            updateSearch({ agent: value === ALL ? undefined : value })
          }
          options={agentOptions}
          aria-label="Agent type"
        />
        <Select
          value={search.model ?? ALL}
          onValueChange={(value) =>
            updateSearch({ model: value === ALL ? undefined : value })
          }
          options={modelOptions}
          aria-label="Model"
        />
      </section>

      {selectedThread ? (
        <section className="usage-selection" aria-label="Selected thread">
          <div>
            <span>{executionLabel(selectedThread)}</span>
            <strong>{threadLabel(selectedThread)}</strong>
            <code>{selectedThread.threadId}</code>
          </div>
          <button
            type="button"
            onClick={() => updateSearch({ thread: undefined })}
          >
            View all threads
          </button>
        </section>
      ) : null}

      {phase === "loading" ? (
        <div className="usage-state" role="status" aria-live="polite">
          Loading local usage…
        </div>
      ) : phase === "error" ? (
        <div className="usage-state" role="alert">
          <strong>Couldn’t load local usage</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : records.length === 0 ? (
        <div className="usage-state" role="status">
          <strong>No model calls match these filters.</strong>
          <span>
            Native calls appear here after their provider returns a terminal
            usage payload.
          </span>
        </div>
      ) : (
        <>
          {page.truncated ? (
            <div className="usage-warning" role="status">
              Showing the latest 10,000 calls in this range. Narrow the time or
              thread filter for exact totals.
            </div>
          ) : null}

          <section className="usage-summary" aria-label="Usage summary">
            <article>
              <span>Estimated cost</span>
              <strong>{formatCost(summary.totalCostUsd)}</strong>
              <small>{summary.calls} provider calls</small>
            </article>
            <article>
              <span>Total tokens</span>
              <strong>{formatTokens(summary.totalTokens)}</strong>
              <small>{formatTokens(summary.inputTokens)} uncached input</small>
            </article>
            <article>
              <span>Cache read</span>
              <strong>{formatPercent(summary.cacheReadRate)}</strong>
              <small>
                {formatTokens(summary.cacheReadTokens)} read ·{" "}
                {formatTokens(summary.cacheWriteTokens)} written
              </small>
            </article>
            <article>
              <span>Output</span>
              <strong>{formatTokens(summary.outputTokens)}</strong>
              <small>
                {formatTokens(summary.reasoningTokens)} reasoning tokens
              </small>
            </article>
          </section>

          <section className="usage-panel usage-chart-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>Timeline</h2>
                <p>Estimated cost and total tokens per time bucket.</p>
              </div>
            </div>
            <div
              className="usage-chart"
              role="img"
              aria-label="Timeline of estimated model cost and token usage"
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={timeline}
                  margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="usageCostFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="var(--accent, #7c6cf2)"
                        stopOpacity={0.35}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--accent, #7c6cf2)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border-weak)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    yAxisId="cost"
                    tickFormatter={(value) => formatCost(Number(value))}
                    tickLine={false}
                    axisLine={false}
                    width={58}
                  />
                  <YAxis
                    yAxisId="tokens"
                    orientation="right"
                    tickFormatter={(value) => formatTokens(Number(value))}
                    tickLine={false}
                    axisLine={false}
                    width={54}
                  />
                  <Tooltip content={UsageTooltip} />
                  <Legend />
                  <Area
                    yAxisId="cost"
                    type="monotone"
                    dataKey="totalCostUsd"
                    name="Estimated cost"
                    stroke="var(--accent, #7c6cf2)"
                    fill="url(#usageCostFill)"
                    strokeWidth={2}
                  />
                  <Line
                    yAxisId="tokens"
                    type="monotone"
                    dataKey="totalTokens"
                    name="Tokens"
                    stroke="var(--foreground)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="usage-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>Threads</h2>
                <p>Orchestrator, agents, and nested sub-agents.</p>
              </div>
            </div>
            <div className="usage-table-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Execution</th>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Tokens</th>
                    <th>Cache</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.map((thread) => (
                    <tr key={thread.threadId}>
                      <td>
                        <button
                          type="button"
                          className="usage-thread-link"
                          onClick={() =>
                            updateSearch({
                              conversation: thread.conversationId,
                              thread: thread.threadId,
                            })
                          }
                        >
                          <span>{executionLabel(thread)}</span>
                          <strong>{threadLabel(thread)}</strong>
                          <small title={thread.threadId}>
                            {shortId(thread.threadId)}
                          </small>
                        </button>
                      </td>
                      <td title={thread.models.join(", ")}>
                        {thread.models.join(", ")}
                      </td>
                      <td>{thread.calls}</td>
                      <td>{formatTokens(thread.totalTokens)}</td>
                      <td>{formatPercent(thread.cacheReadRate)}</td>
                      <td>{formatCost(thread.totalCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="usage-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>Provider calls</h2>
                <p>
                  Output includes reasoning where the provider includes it;
                  reasoning is also shown separately when reported.
                </p>
              </div>
            </div>
            <div className="usage-table-scroll">
              <table className="usage-table usage-call-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Execution</th>
                    <th>Provider / model</th>
                    <th>Input</th>
                    <th>Cache R / W</th>
                    <th>Output</th>
                    <th>Reasoning</th>
                    <th>Cost</th>
                    <th>Stop</th>
                  </tr>
                </thead>
                <tbody>
                  {records.slice(0, 500).map((record) => (
                    <tr key={record.id}>
                      <td title={new Date(record.timestamp).toISOString()}>
                        {new Date(record.timestamp).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="usage-call-thread"
                          onClick={() =>
                            updateSearch({
                              conversation: record.conversationId,
                              thread: record.threadId,
                            })
                          }
                          title={record.threadId}
                        >
                          {executionLabel(record)} · {record.agentType}
                        </button>
                      </td>
                      <td>
                        <span>{record.provider}</span>
                        <strong>{record.responseModel || record.model}</strong>
                        <small>{record.api}</small>
                      </td>
                      <td>{formatTokens(record.inputTokens)}</td>
                      <td>
                        {formatTokens(record.cacheReadTokens)} /{" "}
                        {formatTokens(record.cacheWriteTokens)}
                      </td>
                      <td>{formatTokens(record.outputTokens)}</td>
                      <td>{formatTokens(record.reasoningTokens)}</td>
                      <td
                        title={`Input ${formatCost(record.inputCostUsd)} · cache read ${formatCost(record.cacheReadCostUsd)} · cache write ${formatCost(record.cacheWriteCostUsd)} · output ${formatCost(record.outputCostUsd)}`}
                      >
                        {formatCost(record.totalCostUsd)}
                      </td>
                      <td
                        data-stop={record.stopReason}
                        title={record.errorMessage}
                      >
                        {record.stopReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {records.length > 500 ? (
              <p className="usage-table-note">
                Showing the latest 500 matching calls; summary totals include
                all
                {` ${records.length.toLocaleString()} `}loaded calls.
              </p>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}
