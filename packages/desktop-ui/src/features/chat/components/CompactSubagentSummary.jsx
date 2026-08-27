import { memo, useEffect, useState } from "react";
import { getCompactActivityStatusText } from "@/features/chat/lib/event-transforms";
import { selectLatestAgentAssistantMessage } from "@/features/chat/lib/agent-assistant-summary";
import "@/app/chat/chat-workspace-strip.css";

const ELAPSED_STILL_GOING_MS = 2 * 60 * 60 * 1000;

const formatElapsedLabel = (elapsedMs) => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (elapsedMs >= ELAPSED_STILL_GOING_MS) return "still going";
  return `${Math.floor(totalMinutes / 60)}h`;
};

const useElapsedRunningLabel = (startedAtMs) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return undefined;
    let timer = 0;
    const schedule = () => {
      const elapsed = Date.now() - startedAtMs;
      setNowMs(Date.now());

      if (elapsed >= ELAPSED_STILL_GOING_MS) return;
      timer = window.setTimeout(schedule, elapsed < 60_000 ? 1_000 : 60_000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [startedAtMs]);
  if (startedAtMs == null) return null;
  return formatElapsedLabel(nowMs - startedAtMs);
};

const compactTaskState = (task) => {
  switch (task.status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "error":
      return "failed";
    case "canceled":
      return "stopped";
    default:
      return task.status;
  }
};

const compactTaskTooltip = (task) => {
  const label = task.description.trim() || "Agent";
  const detail = (
    selectLatestAgentAssistantMessage(task.assistantMessages) ?? ""
  ).replace(/\s+/g, " ");
  const clipped = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  return `${label} · ${compactTaskState(task)}${clipped ? ` — ${clipped}` : ""}`;
};

export const CompactChildState = memo(function CompactChildState({
  summary,
  prioritizeFailure,
  startedAtMs,
  running = false,
}) {
  const statusText = getCompactActivityStatusText(summary, prioritizeFailure);
  const elapsedLabel = useElapsedRunningLabel(
    running && typeof startedAtMs === "number" ? startedAtMs : null,
  );
  return (
    <>
      {summary.usesProgressBar ? (
        <span
          className="chat-workspace-strip__compact-progress"
          aria-hidden="true"
        >
          <span className="chat-workspace-strip__compact-bar">
            {summary.completedCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--done"
                style={{ flexGrow: summary.completedCount }}
              />
            ) : null}
            {summary.runningCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--running"
                style={{ flexGrow: summary.runningCount }}
              />
            ) : null}
            {summary.errorCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--error"
                style={{ flexGrow: summary.errorCount }}
              />
            ) : null}
            {summary.canceledCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--queued"
                style={{ flexGrow: summary.canceledCount }}
              />
            ) : null}
          </span>
          <span className="chat-workspace-strip__compact-progress-count">
            {summary.completedCount}/{summary.totalCount}
          </span>
        </span>
      ) : (
        <span
          className="chat-workspace-strip__compact-cells"
          aria-hidden="true"
        >
          {summary.tasks.map((task, index) => (
            <span
              key={task.id}
              className={`chat-workspace-strip__compact-cell chat-workspace-strip__compact-cell--${task.status}`}

              style={{ "--cell-order": index }}
              title={compactTaskTooltip(task)}
            />
          ))}
        </span>
      )}
      <span
        className="chat-workspace-strip__compact-status"
        data-failure={
          prioritizeFailure && summary.errorCount > 0 ? "true" : undefined
        }
      >
        {statusText}
        {elapsedLabel ? ` · ${elapsedLabel}` : ""}
      </span>
    </>
  );
});
