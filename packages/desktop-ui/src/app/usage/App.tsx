import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalModelUsagePage } from "@stella/contracts/local-chat";
import { useViewportActivity } from "@/shared/hooks/useViewportActivity";
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
import { threadLabel } from "./format";
import { UsageFiltersBar, type UsageSearchPatch } from "./UsageFiltersBar";
import { UsageSummaryCards } from "./UsageSummaryCards";
import { UsageTimelineChart } from "./UsageTimelineChart";
import { UsageThreadsTable } from "./UsageThreadsTable";
import { UsageCallsTable } from "./UsageCallsTable";
import "./usage.css";

const EMPTY_PAGE: LocalModelUsagePage = { records: [], truncated: false };

type UsageFiltersState = {
  range: UsageRange;
  conversation?: string;
  thread?: string;
  agent?: string;
  model?: string;
};

export function UsagePanel() {
  const [filters, setFilters] = useState<UsageFiltersState>({ range: "7d" });
  const [basePage, setBasePage] = useState<LocalModelUsagePage>(EMPTY_PAGE);
  const [scoped, setScoped] = useState<{
    key: string;
    page: LocalModelUsagePage;
  } | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const fetchingRef = useRef(false);
  const { ref: rootRef, isActive } = useViewportActivity<HTMLElement>();
  const isActiveRef = useRef(isActive);
  const pendingWhileHiddenRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  const range = filters.range;
  const load = useCallback(async () => {
    const api = window.electronAPI?.localChat;
    if (!api?.listModelUsage) {
      setError("Local usage is available in the Stella desktop app.");
      setPhase("error");
      return;
    }
    setPhase((current) => (current === "ready" ? current : "loading"));
    fetchingRef.current = true;
    try {
      const next = await api.listModelUsage({
        fromMs: rangeStartMs(range),
        limit: 10_000,
      });
      setBasePage(next);
      setError("");
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    } finally {
      fetchingRef.current = false;
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const scopedKey = `${filters.conversation ?? ""}|${filters.thread ?? ""}|${range}`;
  const needsScopedPage =
    basePage.truncated && Boolean(filters.conversation || filters.thread);
  useEffect(() => {
    if (!needsScopedPage) {
      setScoped(null);
      return;
    }
    const api = window.electronAPI?.localChat;
    if (!api?.listModelUsage) return;
    let cancelled = false;
    void api
      .listModelUsage({
        fromMs: rangeStartMs(range),
        limit: 10_000,
        conversationId: filters.conversation,
        threadId: filters.thread,
      })
      .then((page) => {
        if (!cancelled) setScoped({ key: scopedKey, page });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [
    basePage,
    needsScopedPage,
    range,
    scopedKey,
    filters.conversation,
    filters.thread,
  ]);

  useEffect(() => {
    let timeout = 0;
    const refresh = () => {
      if (!isActiveRef.current) {
        pendingWhileHiddenRef.current = true;
        return;
      }
      if (fetchingRef.current) {
        timeout = window.setTimeout(refresh, 2000);
        return;
      }
      setRefreshKey((value) => value + 1);
    };
    refreshRef.current = refresh;
    const queueRefresh = () => {
      if (!isActiveRef.current) {
        pendingWhileHiddenRef.current = true;
        return;
      }
      window.clearTimeout(timeout);
      timeout = window.setTimeout(refresh, 2000);
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

  useEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive || !pendingWhileHiddenRef.current) return;
    pendingWhileHiddenRef.current = false;
    refreshRef.current();
  }, [isActive]);

  const baseRecords = basePage.records;
  const activePage =
    scoped && scoped.key === scopedKey ? scoped.page : basePage;

  const records = useMemo(
    () =>
      filterUsageRecords(activePage.records, {
        conversationId: filters.conversation,
        threadId: filters.thread,
        agentType: filters.agent,
        model: filters.model,
      }),
    [
      activePage,
      filters.agent,
      filters.conversation,
      filters.model,
      filters.thread,
    ],
  );
  const summary = useMemo(() => summarizeUsage(records), [records]);
  const threads = useMemo(() => groupUsageByThread(records), [records]);
  const timeline = useMemo(
    () => buildUsageTimeline(records, range),
    [range, records],
  );

  const updateSearch = useCallback((patch: UsageSearchPatch) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);
  const selectThread = useCallback(
    (conversationId: string, threadId: string) =>
      updateSearch({ conversation: conversationId, thread: threadId }),
    [updateSearch],
  );

  const selectedThread = filters.thread
    ? (baseRecords.find((record) => record.threadId === filters.thread) ??
      records.find((record) => record.threadId === filters.thread))
    : undefined;

  return (
    <main
      ref={rootRef}
      className="usage-screen"
      aria-busy={phase === "loading" || undefined}
    >
      <header className="usage-header">
        <p>
          Provider calls persisted on this device. Costs are local estimates;
          backend billing remains authoritative.
        </p>
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

      <UsageFiltersBar
        range={range}
        conversation={filters.conversation}
        thread={filters.thread}
        agent={filters.agent}
        model={filters.model}
        records={baseRecords}
        onSearchChange={updateSearch}
      />

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
          {activePage.truncated ? (
            <div className="usage-warning" role="status">
              Showing the latest 10,000 calls in this range. Narrow the time
              range for exact totals.
            </div>
          ) : null}

          <UsageSummaryCards summary={summary} />
          <UsageTimelineChart timeline={timeline} />
          <UsageThreadsTable threads={threads} onSelectThread={selectThread} />
          <UsageCallsTable records={records} onSelectThread={selectThread} />
        </>
      )}
    </main>
  );
}
