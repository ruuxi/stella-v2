import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ThreadTranscript,
  ThreadTranscriptEntry,
} from "@stella/contracts/local-chat";
import { AlertCircle, CheckCircle2, Code, User } from "@/ui/icons";
import { Markdown } from "@/app/chat/Markdown";
import "./thread-chat-tab.css";

const THREAD_TRANSCRIPT_LIMIT = 300;

const entryLabel = (entry: ThreadTranscriptEntry): string => {
  if (entry.kind === "assistant") return "Agent";
  if (entry.kind === "tool-result") return entry.toolName || "Tool result";
  if (entry.kind === "event") return "Activity";
  return "Task input";
};

export function ThreadChatTab({ threadId }: { threadId: string }) {
  const [transcript, setTranscript] = useState<ThreadTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await window.electronAPI?.localChat?.listThreadTranscript({
        threadId,
        limit: THREAD_TRANSCRIPT_LIMIT,
      });
      if (request !== requestRef.current) return;
      conversationIdRef.current = next?.conversationId ?? null;
      setTranscript(next ?? null);
      setError(next ? null : "This agent thread is no longer available.");
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(
        cause instanceof Error ? cause.message : "Couldn’t load this thread.",
      );
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setLoading(true);
    setTranscript(null);
    setError(null);
    void load();
    const unsubscribe =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.((payload) => {
        if (
          payload.assistantUpdate?.threadId === threadId ||
          (conversationIdRef.current !== null &&
            payload.conversationId === conversationIdRef.current)
        ) {
          void load();
        }
      });
    return () => {
      requestRef.current += 1;
      unsubscribe?.();
    };
  }, [load, threadId]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !followLatestRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [transcript?.entries.length]);

  return (
    <section className="thread-chat-tab" aria-label="Read-only agent chat">
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
        {loading ? (
          <div className="thread-chat-tab__state" role="status">
            Loading thread…
          </div>
        ) : error ? (
          <div className="thread-chat-tab__state thread-chat-tab__state--error">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : transcript?.entries.length ? (
          <div className="thread-chat-tab__entries">
            {transcript.truncated ? (
              <p className="thread-chat-tab__notice">
                Showing the latest {THREAD_TRANSCRIPT_LIMIT} thread entries.
              </p>
            ) : null}
            {transcript.entries.map((entry) => (
              <article
                key={entry.id}
                className="thread-chat-tab__entry"
                data-kind={entry.kind}
              >
                <div className="thread-chat-tab__entry-meta">
                  {entry.kind === "tool-result" ? (
                    entry.isError ? (
                      <AlertCircle size={13} aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    )
                  ) : entry.kind === "assistant" ? (
                    <User size={13} aria-hidden="true" />
                  ) : null}
                  <span>{entryLabel(entry)}</span>
                  <time dateTime={new Date(entry.timestamp).toISOString()}>
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
                    <p className="thread-chat-tab__text">{entry.text}</p>
                  )
                ) : null}
                {entry.tools?.map((tool) => (
                  <details
                    key={tool.toolCallId}
                    className="thread-chat-tab__tool"
                  >
                    <summary>
                      <Code size={13} aria-hidden="true" />
                      <span>{tool.name}</span>
                    </summary>
                    {tool.argumentsPreview ? (
                      <pre>{tool.argumentsPreview}</pre>
                    ) : null}
                  </details>
                ))}
              </article>
            ))}
          </div>
        ) : (
          <div className="thread-chat-tab__state" role="status">
            No messages in this thread yet.
          </div>
        )}
      </div>
    </section>
  );
}
