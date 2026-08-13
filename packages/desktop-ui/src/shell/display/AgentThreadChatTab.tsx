import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/app/chat/Markdown";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import {
  buildBackgroundTaskLifecycleIndex,
  type BackgroundTaskCardState,
  type BackgroundTaskLifecycleIndex,
} from "@/features/chat/lib/background-task-lifecycle";
import { isAgentStartedEvent } from "@/features/chat/lib/event-transforms";
import { useT, useTPlural } from "@/shared/i18n";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { MessageSquare } from "@/ui/icons";
import type {
  AgentThreadMessageRecord,
  DesktopThreadActivityUpdatedPayload,
} from "@/features/chat/thread-activity-types";
import "./agent-thread-chat-tab.css";

const MESSAGE_LIMIT = 200;
const NEAR_BOTTOM_PX = 56;

/** Returns a catalog *key*; the caller resolves it against the active locale. */
const roleLabelKey = (role: AgentThreadMessageRecord["role"]): string => {
  switch (role) {
    case "user":
      return "shell.display.agentThread.role.user";
    case "assistant":
      return "shell.display.agentThread.role.assistant";
    case "reasoning":
      return "shell.display.agentThread.role.reasoning";
    case "tool":
      return "shell.display.agentThread.role.tool";
    case "checkpoint":
      return "shell.display.agentThread.role.checkpoint";
    case "lifecycle":
      return "shell.display.agentThread.role.lifecycle";
  }
};

const compactPreview = (value: string, maxChars = 120): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars
    ? `${compact.slice(0, maxChars).trimEnd()}…`
    : compact;
};

const ReasoningTranscriptItem = ({
  message,
  cacheKey,
}: {
  message: AgentThreadMessageRecord;
  cacheKey: string;
}) => {
  const t = useT();
  return (
    <details className="agent-thread-chat__trace" data-trace-kind="reasoning">
      <summary>
        <span className="agent-thread-chat__trace-title">
          {t("shell.display.agentThread.role.reasoning")}
        </span>
        <span className="agent-thread-chat__trace-preview">
          {compactPreview(message.content)}
        </span>
      </summary>
      <div className="agent-thread-chat__trace-body">
        <Markdown
          text={message.content}
          cacheKey={cacheKey}
          hideHorizontalRules
        />
      </div>
    </details>
  );
};

const ToolTranscriptItem = ({
  message,
}: {
  message: AgentThreadMessageRecord;
}) => {
  const t = useT();
  const activity = message.toolActivity;
  if (!activity) return null;
  const statusKey =
    activity.status === "running"
      ? "shell.display.agentThread.status.running"
      : activity.status === "completed"
        ? "shell.display.agentThread.status.completed"
        : "shell.display.agentThread.status.error";
  return (
    <details
      className="agent-thread-chat__trace"
      data-trace-kind="tool"
      data-tool-status={activity.status}
    >
      <summary>
        <span className="agent-thread-chat__trace-title">
          {activity.toolName}
        </span>
        <span className="agent-thread-chat__tool-status">{t(statusKey)}</span>
      </summary>
      <div className="agent-thread-chat__trace-body agent-thread-chat__tool-details">
        {activity.input ? (
          <section>
            <span>{t("shell.display.agentThread.toolInput")}</span>
            <pre>{activity.input}</pre>
          </section>
        ) : null}
        {activity.output ? (
          <section>
            <span>{t("shell.display.agentThread.toolOutput")}</span>
            <pre>{activity.output}</pre>
          </section>
        ) : activity.status === "running" ? (
          <p>{t("shell.display.agentThread.toolRunning")}</p>
        ) : null}
      </div>
    </details>
  );
};

/**
 * Consecutive tool/reasoning trace messages between two conversation
 * messages collapse into one quiet clickable text row ("12 tool calls" /
 * "Reasoning"). Expanding lists the individual trace items, each of which
 * opens further into its full input/output detail.
 */
const TraceGroupRow = ({
  traceKind,
  entries,
  expanded,
  onToggle,
  threadId,
}: {
  traceKind: "tool" | "reasoning";
  entries: { message: AgentThreadMessageRecord; index: number }[];
  expanded: boolean;
  onToggle: () => void;
  threadId: string;
}) => {
  const tPlural = useTPlural();
  const label =
    traceKind === "tool"
      ? tPlural("shell.display.agentThread.toolGroup", entries.length)
      : tPlural("shell.display.agentThread.reasoningGroup", entries.length);
  return (
    <div
      className="agent-thread-chat__trace-group"
      data-trace-kind={traceKind}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="agent-thread-chat__trace-group-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="agent-thread-chat__trace-group-chevron" aria-hidden="true">
          ›
        </span>
        <span>{label}</span>
      </button>
      {expanded ? (
        <div className="agent-thread-chat__trace-group-items">
          {entries.map(({ message, index }) =>
            message.role === "tool" ? (
              <ToolTranscriptItem
                key={message.entryId ?? `${message.timestamp}:${index}`}
                message={message}
              />
            ) : (
              <ReasoningTranscriptItem
                key={message.entryId ?? `${message.timestamp}:${index}`}
                message={message}
                cacheKey={message.entryId ?? `${threadId}:${index}`}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
};

const CheckpointTranscriptItem = ({
  message,
  cacheKey,
}: {
  message: AgentThreadMessageRecord;
  cacheKey: string;
}) => {
  const t = useT();
  return (
    <details className="agent-thread-chat__trace" data-trace-kind="checkpoint">
      <summary>
        <span className="agent-thread-chat__trace-title">
          {t("shell.display.agentThread.role.checkpoint")}
        </span>
        <span className="agent-thread-chat__trace-preview">
          {compactPreview(message.content)}
        </span>
      </summary>
      <div className="agent-thread-chat__trace-body">
        <Markdown
          text={message.content}
          cacheKey={cacheKey}
          hideHorizontalRules
        />
      </div>
    </details>
  );
};

const ThreadLifecycleCard = ({
  state,
  index,
  conversationId,
  modelConfigByThread,
}: {
  state: BackgroundTaskCardState;
  index: BackgroundTaskLifecycleIndex;
  conversationId: string;
  modelConfigByThread: AgentModelConfigsByThread;
}) => {
  if (state.status === "completed" && state.completion) {
    return (
      <AgentCompletionCard
        sections={[state.completion]}
        cardId={state.cardId}
        conversationId={conversationId}
        modelConfigByThread={modelConfigByThread}
      />
    );
  }
  const superseded = [...index.byStartEventId.values()].some(
    (candidate) =>
      candidate.agentId === state.agentId &&
      candidate.startEventId !== state.startEventId &&
      (candidate.attemptGeneration !== undefined &&
      state.attemptGeneration !== undefined
        ? candidate.attemptGeneration > state.attemptGeneration
        : candidate.startedAtMs > state.startedAtMs),
  );
  return (
    <BackgroundWorkCard
      threadIds={[state.agentId]}
      completedThreadIds={state.status === "completed" ? [state.agentId] : []}
      pausedThreadIds={state.status === "canceled" ? [state.agentId] : []}
      failedThreadIds={state.status === "failed" ? [state.agentId] : []}
      supersededThreadIds={superseded ? [state.agentId] : []}
      spawnedAtMs={{ [state.agentId]: state.startedAtMs }}
      descriptions={{ [state.agentId]: state.title }}
      statusTexts={state.isFollowUp ? { [state.agentId]: state.title } : {}}
      followUpThreadIds={state.isFollowUp ? [state.agentId] : []}
      cardId={state.cardId}
      startEventIdsByThread={{ [state.agentId]: state.startEventId }}
      attemptGenerationsByThread={
        state.attemptGeneration !== undefined
          ? { [state.agentId]: state.attemptGeneration }
          : {}
      }
      rootRunIdsByThread={
        state.rootRunId ? { [state.agentId]: state.rootRunId } : {}
      }
      terminalEventIdsByThread={
        state.terminalEventId ? { [state.agentId]: state.terminalEventId } : {}
      }
      conversationId={conversationId}
    />
  );
};

const messageIdentity = (
  message: AgentThreadMessageRecord,
  index: number,
): string =>
  message.entryId ??
  `${message.timestamp}:${message.role}:${message.lifecycleEvent?._id ?? ""}:${message.content}:${index}`;

const countAppendedMessages = (
  previous: AgentThreadMessageRecord[],
  next: AgentThreadMessageRecord[],
): number => {
  if (previous.length === 0) return next.length;
  const previousLast = messageIdentity(
    previous[previous.length - 1]!,
    previous.length - 1,
  );
  const retainedIndex = next.findIndex(
    (message, index) => messageIdentity(message, index) === previousLast,
  );
  if (retainedIndex >= 0) return Math.max(0, next.length - retainedIndex - 1);

  const previousIds = new Set(
    previous.map((message, index) => messageIdentity(message, index)),
  );
  return next.reduce(
    (count, message, index) =>
      count + (previousIds.has(messageIdentity(message, index)) ? 0 : 1),
    0,
  );
};

const newestMessageAnnouncement = (
  messages: AgentThreadMessageRecord[],
  count: number,
  t: (key: string, params?: Record<string, string | number>) => string,
  tPlural: (
    key: string,
    count: number,
    params?: Record<string, string | number>,
  ) => string,
): string => {
  const newest = messages.at(-1);
  if (!newest) return "";
  const preview = newest.content.replace(/\s+/g, " ").trim().slice(0, 140);
  const countPhrase = tPlural("shell.display.agentThread.newMessages", count);
  if (!preview) return countPhrase;
  return t("shell.display.agentThread.newMessagesWithPreview", {
    countPhrase,
    role: t(roleLabelKey(newest.role)).toLowerCase(),
    preview,
  });
};

export function AgentThreadChatTab({
  threadId,
  conversationId,
  agentType,
  source = "stella",
  readOnly = true,
  parentAgentId,
}: {
  threadId: string;
  conversationId: string;
  agentType: string;
  source?: "stella" | "claude-native";
  readOnly?: boolean;
  parentAgentId?: string;
}) {
  const t = useT();
  const tPlural = useTPlural();
  const { records: threadActivity } = useThreadActivity(conversationId);
  const activityRecord = useMemo(
    () => threadActivity.find((record) => record.threadId === threadId),
    [threadActivity, threadId],
  );
  const resolvedSource = activityRecord?.source ?? source;
  const isClaudeNative = resolvedSource === "claude-native";
  const resolvedReadOnly = activityRecord?.readOnly ?? readOnly;
  const resolvedParentId = activityRecord?.parentAgentId ?? parentAgentId;
  const parentRecord = useMemo(
    () =>
      resolvedParentId
        ? threadActivity.find((record) => record.threadId === resolvedParentId)
        : undefined,
    [resolvedParentId, threadActivity],
  );
  const statusLabel = useMemo(() => {
    switch (activityRecord?.status) {
      case "running":
        return t("shell.display.agentThread.status.running");
      case "completed":
        return t("shell.display.agentThread.status.completed");
      case "error":
        return t("shell.display.agentThread.status.error");
      case "canceled":
        return t("shell.display.agentThread.status.canceled");
      default:
        return undefined;
    }
  }, [activityRecord?.status, t]);
  const [messages, setMessages] = useState<AgentThreadMessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const requestGeneration = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<AgentThreadMessageRecord[]>([]);
  const pinnedToLatestRef = useRef(true);
  const scrollToLatestAfterRenderRef = useRef(false);
  const lifecycleIndex = useMemo(
    () =>
      buildBackgroundTaskLifecycleIndex(
        messages.flatMap((message) =>
          message.role === "lifecycle" && message.lifecycleEvent
            ? [message.lifecycleEvent]
            : [],
        ),
      ),
    [messages],
  );
  const modelConfigByThread = useMemo<AgentModelConfigsByThread>(
    () =>
      Object.fromEntries(
        threadActivity.map((record) => [
          record.threadId,
          record.modelConfigSnapshot,
        ]),
      ),
    [threadActivity],
  );
  const visibleMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (message.role !== "lifecycle") return true;
        if (
          message.source === "claude-native" &&
          message.content.trim().length > 0
        ) {
          return true;
        }
        return Boolean(
          message.lifecycleEvent &&
            isAgentStartedEvent(message.lifecycleEvent) &&
            lifecycleIndex.byStartEventId.has(message.lifecycleEvent._id),
        );
      }),
    [lifecycleIndex, messages],
  );

  // Consecutive tool calls (and reasoning blocks) between two conversation
  // messages fold into one collapsed row each. Group identity keys off the
  // first trace entry so a group stays expanded while new entries append to
  // it live (the row's count just ticks up).
  const renderItems = useMemo(() => {
    type TraceEntry = { message: AgentThreadMessageRecord; index: number };
    const items: (
      | { kind: "single"; message: AgentThreadMessageRecord; index: number }
      | {
          kind: "trace-group";
          traceKind: "tool" | "reasoning";
          key: string;
          entries: TraceEntry[];
        }
    )[] = [];
    visibleMessages.forEach((message, index) => {
      const traceKind =
        message.role === "tool"
          ? ("tool" as const)
          : message.role === "reasoning"
            ? ("reasoning" as const)
            : null;
      if (!traceKind) {
        items.push({ kind: "single", message, index });
        return;
      }
      const last = items.at(-1);
      if (last?.kind === "trace-group" && last.traceKind === traceKind) {
        last.entries.push({ message, index });
        return;
      }
      items.push({
        kind: "trace-group",
        traceKind,
        key: `${traceKind}:${message.entryId ?? `${message.timestamp}:${index}`}`,
        entries: [{ message, index }],
      });
    });
    return items;
  }, [visibleMessages]);
  // Session-local, collapsed by default; keyed per group.
  const [expandedTraceGroups, setExpandedTraceGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleTraceGroup = useCallback((key: string) => {
    setExpandedTraceGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const load = useCallback(
    async (reason: "initial" | "refresh") => {
      const generation = ++requestGeneration.current;
      const list = window.electronAPI?.localChat?.listAgentThreadMessages;
      if (reason === "refresh") setRefreshing(true);
      if (!list) {
        setError(t("shell.display.agentThread.unavailable"));
        setAnnouncement("");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      try {
        const next = await list({ threadId, limit: MESSAGE_LIMIT });
        if (generation !== requestGeneration.current) return;
        const previous = messagesRef.current;
        const appendedCount = countAppendedMessages(previous, next);
        const wasPinned = pinnedToLatestRef.current;
        messagesRef.current = next;
        setMessages(next);
        setError(null);
        if (reason === "initial") {
          pinnedToLatestRef.current = true;
          scrollToLatestAfterRenderRef.current = true;
          setNewMessageCount(0);
          setAnnouncement("");
        } else {
          if (wasPinned) {
            scrollToLatestAfterRenderRef.current = true;
            setNewMessageCount(0);
          }
          if (appendedCount > 0) {
            setAnnouncement(
              newestMessageAnnouncement(next, appendedCount, t, tPlural),
            );
          }
          if (!wasPinned && appendedCount > 0) {
            setNewMessageCount((count) => count + appendedCount);
          }
        }
      } catch (cause) {
        if (generation !== requestGeneration.current) return;
        const nextError =
          cause instanceof Error
            ? cause.message
            : t("shell.display.agentThread.loadFailed");
        setError(nextError);
        // The visible error owns its focused live announcement through
        // `role=alert`; do not repeat it through the update status region.
        setAnnouncement("");
      } finally {
        if (generation === requestGeneration.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [threadId, t, tPlural],
  );

  useEffect(() => {
    let disposed = false;
    let refreshQueued = false;
    let refreshInFlight = false;
    let refreshPending = false;
    const scheduleRefresh = () => {
      refreshPending = true;
      if (disposed || refreshQueued || refreshInFlight) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (disposed) return;
        refreshPending = false;
        refreshInFlight = true;
        void load("refresh").finally(() => {
          refreshInFlight = false;
          if (refreshPending && !disposed) scheduleRefresh();
        });
      });
    };

    messagesRef.current = [];
    pinnedToLatestRef.current = true;
    scrollToLatestAfterRenderRef.current = true;
    setMessages([]);
    setLoading(true);
    setRefreshing(false);
    setError(null);
    setNewMessageCount(0);
    setAnnouncement("");
    void load("initial");
    const unsubscribe =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.((payload) => {
        if (payload.conversationId !== conversationId) return;
        const activityPayload = payload as DesktopThreadActivityUpdatedPayload;
        const exactThreadId =
          activityPayload.transcriptUpdate?.threadId ??
          activityPayload.assistantUpdate?.threadId;
        // Transcript/authored-update pushes identify their exact thread.
        // Lifecycle persistence also emits a conversation-level invalidation
        // with no thread id; refresh the one visible viewer for that signal so
        // external-engine/finalization writes cannot leave it frozen.
        if (exactThreadId && exactThreadId !== threadId) return;
        scheduleRefresh();
      });
    return () => {
      disposed = true;
      requestGeneration.current += 1;
      unsubscribe?.();
    };
  }, [conversationId, load, threadId]);

  useLayoutEffect(() => {
    if (!scrollToLatestAfterRenderRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scrollToLatestAfterRenderRef.current = false;
    scroll.scrollTop = scroll.scrollHeight;
    pinnedToLatestRef.current = true;
  }, [messages]);

  const handleScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const distanceFromBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    const pinned = distanceFromBottom <= NEAR_BOTTOM_PX;
    pinnedToLatestRef.current = pinned;
    if (pinned) setNewMessageCount(0);
  }, []);

  const showLatest = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
    pinnedToLatestRef.current = true;
    setNewMessageCount(0);
    setAnnouncement(t("shell.display.agentThread.showingNewest"));
  }, [t]);

  return (
    <section
      className="agent-thread-chat"
      aria-label={
        isClaudeNative
          ? t("shell.display.agentThread.claudeAriaLabel")
          : `${agentType} read-only chat`
      }
      data-thread-id={threadId}
      data-source={resolvedSource}
      data-read-only={resolvedReadOnly ? "true" : undefined}
      aria-busy={loading || refreshing}
    >
      <header className="agent-thread-chat__header">
        <span className="agent-thread-chat__eyebrow">
          {isClaudeNative
            ? t("shell.display.agentThread.claudeBadge")
            : t("shell.display.agentThread.badge")}
        </span>
        <span className="agent-thread-chat__agent">
          {isClaudeNative ? "Claude Code" : agentType}
          {statusLabel ? ` · ${statusLabel}` : ""}
        </span>
      </header>
      {error && messages.length > 0 ? (
        <div
          className="agent-thread-chat__refresh-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <span>Couldn’t refresh this thread. {error}</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void load("refresh")}
          >
            {refreshing
              ? t("shell.display.agentThread.retrying")
              : t("common.tryAgain")}
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="agent-thread-chat__scroll"
        onScroll={handleScroll}
      >
        {loading && messages.length === 0 ? (
          <div className="agent-thread-chat__state" role="status">
            Loading conversation…
          </div>
        ) : error && messages.length === 0 ? (
          <div
            className="agent-thread-chat__state"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <span>{error}</span>
            <button type="button" onClick={() => void load("initial")}>
              Try again
            </button>
          </div>
        ) : visibleMessages.length === 0 ? (
          <div className="agent-thread-chat__state">
            <MessageSquare size={22} strokeWidth={1.5} aria-hidden="true" />
            <span>{t("shell.display.agentThread.empty")}</span>
          </div>
        ) : (
          // `chat-conversation-surface--sidebar` reuses the panel chat's
          // shared bubble styling (see compact-conversation.css) so this
          // read-only view renders exactly like the normal sidebar chat.
          <ol className="agent-thread-chat__messages chat-conversation-surface chat-conversation-surface--sidebar">
            {renderItems.map((item) => {
              if (item.kind === "trace-group") {
                return (
                  <li
                    key={item.key}
                    className="agent-thread-chat__message"
                    data-role={`${item.traceKind}-group`}
                  >
                    <TraceGroupRow
                      traceKind={item.traceKind}
                      entries={item.entries}
                      expanded={expandedTraceGroups.has(item.key)}
                      onToggle={() => toggleTraceGroup(item.key)}
                      threadId={threadId}
                    />
                  </li>
                );
              }
              const { message, index } = item;
              return (
              <li
                key={message.entryId ?? `${message.timestamp}:${index}`}
                className="agent-thread-chat__message"
                data-role={message.role}
              >
                {message.role === "lifecycle" && message.lifecycleEvent ? (
                  <ThreadLifecycleCard
                    state={
                      lifecycleIndex.byStartEventId.get(
                        message.lifecycleEvent._id,
                      )!
                    }
                    index={lifecycleIndex}
                    conversationId={conversationId}
                    modelConfigByThread={modelConfigByThread}
                  />
                ) : message.role === "checkpoint" ? (
                  <CheckpointTranscriptItem
                    message={message}
                    cacheKey={message.entryId ?? `${threadId}:${index}`}
                  />
                ) : (
                  <>
                    <span className="agent-thread-chat__role">
                      {t(roleLabelKey(message.role))}
                    </span>
                    {message.role === "assistant" ||
                    (message.role === "lifecycle" &&
                      message.source === "claude-native") ? (
                      <div className="event-item assistant">
                        <Markdown
                          text={message.content}
                          cacheKey={message.entryId ?? `${threadId}:${index}`}
                          hideHorizontalRules
                        />
                      </div>
                    ) : (
                      <div className="event-item user">
                        <div className="event-body">{message.content}</div>
                      </div>
                    )}
                  </>
                )}
              </li>
              );
            })}
          </ol>
        )}
        {newMessageCount > 0 ? (
          <button
            type="button"
            className="agent-thread-chat__new-messages"
            onClick={showLatest}
            aria-label={t("shell.display.agentThread.showNewMessagesAria", {
              countPhrase: tPlural(
                "shell.display.agentThread.newMessagesButton",
                newMessageCount,
              ),
            })}
          >
            {tPlural(
              "shell.display.agentThread.newMessagesButton",
              newMessageCount,
            )}
          </button>
        ) : null}
      </div>
      {isClaudeNative ? (
        <footer className="agent-thread-chat__ownership-note">
          Changes from this conversation are included with the parent General
          agent’s update
          {parentRecord?.description.trim()
            ? `: ${parentRecord.description.trim()}`
            : ""}
          .
        </footer>
      ) : null}
      <p
        className="agent-thread-chat__announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </section>
  );
}
