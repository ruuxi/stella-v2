import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ThreadTranscript,
  ThreadTranscriptEntry,
} from "@stella/contracts/local-chat";
import { AlertCircle, User } from "@/ui/icons";
import { Markdown } from "@/app/chat/Markdown";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import {
  buildBackgroundTaskLifecycleIndex,
  type BackgroundTaskCardState,
  type BackgroundTaskLifecycleIndex,
} from "@/features/chat/lib/background-task-lifecycle";
import { isAgentStartedEvent } from "@/features/chat/lib/event-transforms";
import "./thread-chat-tab.css";

const THREAD_TRANSCRIPT_LIMIT = 300;

const entryLabel = (entry: ThreadTranscriptEntry): string => {
  if (entry.kind === "assistant") return "Agent";
  return "Task input";
};

const ThreadLifecycleCard = ({
  state,
  index,
  conversationId,
}: {
  state: BackgroundTaskCardState;
  index: BackgroundTaskLifecycleIndex;
  conversationId: string;
}) => {
  if (state.status === "completed" && state.completion) {
    return (
      <AgentCompletionCard
        sections={[state.completion]}
        cardId={state.cardId}
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

export function ThreadChatTab({ threadId }: { threadId: string }) {
  const [transcript, setTranscript] = useState<ThreadTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const lifecycleIndex = useMemo(
    () =>
      buildBackgroundTaskLifecycleIndex(
        transcript?.entries.flatMap((entry) =>
          entry.kind === "lifecycle" && entry.lifecycleEvent
            ? [entry.lifecycleEvent]
            : [],
        ) ?? [],
      ),
    [transcript],
  );
  const visibleEntries = useMemo(
    () =>
      transcript?.entries.filter((entry) => {
        if (entry.kind !== "lifecycle") return true;
        return Boolean(
          entry.lifecycleEvent &&
            isAgentStartedEvent(entry.lifecycleEvent) &&
            lifecycleIndex.byStartEventId.has(entry.lifecycleEvent._id),
        );
      }) ?? [],
    [lifecycleIndex, transcript],
  );

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    reloadRef.current?.();
  }, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let refreshTimer: number | null = null;

    const load = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      do {
        queued = false;
        try {
          const next =
            await window.electronAPI?.localChat?.listThreadTranscript({
              threadId,
              limit: THREAD_TRANSCRIPT_LIMIT,
            });
          if (disposed) break;
          setTranscript(next ?? null);
          setError(next ? null : "This agent thread is no longer available.");
        } catch (cause) {
          if (disposed) break;
          setError(
            cause instanceof Error
              ? cause.message
              : "Couldn’t load this thread.",
          );
        } finally {
          if (!disposed) setLoading(false);
        }
      } while (!disposed && queued);
      inFlight = false;
    };

    const scheduleLoad = () => {
      if (refreshTimer !== null || disposed) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void load();
      }, 16);
    };

    setLoading(true);
    setTranscript(null);
    setError(null);
    reloadRef.current = () => void load();
    void load();
    const unsubscribeTranscript =
      window.electronAPI?.localChat?.onThreadTranscriptUpdated?.((payload) => {
        if (payload.threadId === threadId) scheduleLoad();
      });
    // Compatibility with authored updates from an older runtime. This stays
    // exact-thread scoped; conversation-wide Activity changes must not make
    // an unrelated transcript refetch.
    const unsubscribeActivity =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.((payload) => {
        if (payload.assistantUpdate?.threadId === threadId) scheduleLoad();
      });
    return () => {
      disposed = true;
      reloadRef.current = null;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      unsubscribeTranscript?.();
      unsubscribeActivity?.();
    };
  }, [threadId]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !followLatestRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [transcript?.entries.length]);

  return (
    <section
      className="chat-panel-tab thread-chat-tab"
      aria-label="Read-only agent thread"
      data-agent-type={transcript?.agentType}
    >
      <header className="thread-chat-tab__header">
        <span className="thread-chat-tab__avatar" aria-hidden="true">
          <User size={16} strokeWidth={1.8} />
        </span>
        <span className="thread-chat-tab__heading">
          <strong>{transcript?.description || "Agent thread"}</strong>
          <span>
            {transcript
              ? `${transcript.agentType === "manager" ? "Manager" : "Agent"} · ${transcript.status}`
              : "Read-only chat"}
          </span>
        </span>
        <span className="thread-chat-tab__readonly">Read only</span>
      </header>

      <div
        ref={scrollRef}
        className="thread-chat-tab__scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          followLatestRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {loading && !transcript ? (
          <div className="thread-chat-tab__state" role="status">
            Loading thread…
          </div>
        ) : (
          <>
            {error ? (
              <div
                className="thread-chat-tab__state thread-chat-tab__state--error"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
                <button type="button" onClick={retry}>
                  Retry
                </button>
              </div>
            ) : null}
            {visibleEntries.length ? (
              <div className="thread-chat-tab__entries">
                {transcript?.truncated ? (
                  <p className="thread-chat-tab__notice">
                    Showing the latest {THREAD_TRANSCRIPT_LIMIT} thread entries.
                  </p>
                ) : null}
                {visibleEntries.map((entry) => (
                  <article
                    key={entry.id}
                    className="thread-chat-tab__entry"
                    data-kind={entry.kind}
                  >
                    {entry.kind === "lifecycle" && entry.lifecycleEvent ? (
                      <ThreadLifecycleCard
                        state={
                          lifecycleIndex.byStartEventId.get(
                            entry.lifecycleEvent._id,
                          )!
                        }
                        index={lifecycleIndex}
                        conversationId={transcript?.conversationId ?? ""}
                      />
                    ) : (
                      <>
                        <div className="thread-chat-tab__entry-meta">
                          {entry.kind === "assistant" ? (
                            <User size={13} aria-hidden="true" />
                          ) : null}
                          <span>{entryLabel(entry)}</span>
                          <time
                            dateTime={new Date(entry.timestamp).toISOString()}
                          >
                            {new Date(entry.timestamp).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        {entry.text ? (
                          entry.kind === "assistant" ? (
                            <Markdown
                              text={entry.text}
                              cacheKey={`thread:${threadId}:${entry.id}`}
                            />
                          ) : (
                            <p className="thread-chat-tab__text">
                              {entry.text}
                            </p>
                          )
                        ) : null}
                      </>
                    )}
                  </article>
                ))}
              </div>
            ) : error ? null : (
              <div className="thread-chat-tab__state" role="status">
                No messages in this thread yet.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
