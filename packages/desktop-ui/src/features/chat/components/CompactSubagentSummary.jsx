/**
 * Condensed subagent-group summary — the collapsed presentation of a general
 * agent that owns subagents. It renders either a per-agent dot grid (≤16 owned
 * agents) or a segmented progress bar (17+), plus a single running/done/failed
 * tally line.
 *
 * Extracted from the activity workspace strip so the right-sidebar Home list
 * (`FilesSection`) and the workspace strip (`WorkspaceSections`) share ONE
 * implementation of the collapsed group summary and stay visually identical.
 */
import { memo, useEffect, useState } from "react";
import { getCompactActivityStatusText } from "@/features/chat/lib/event-transforms";
import { selectLatestAgentAssistantMessage } from "@/features/chat/lib/agent-assistant-summary";
import "@/app/chat/chat-workspace-strip.css";

// Past this the elapsed timer stops resolving to a duration and shows a short
// placeholder phrase instead (owner may tweak the copy).
const ELAPSED_STILL_GOING_MS = 2 * 60 * 60 * 1000;

/** "3s" → "12m" → "1h", then "still going" past ~2h. */
const formatElapsedLabel = (elapsedMs) => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (elapsedMs >= ELAPSED_STILL_GOING_MS) return "still going";
  return `${Math.floor(totalMinutes / 60)}h`;
};

/**
 * Live elapsed-running label. Ticks every second under a minute, then every
 * minute (cheap, self-scheduling), and stops once it settles into "still
 * going". Returns null when there's nothing to time.
 */
const useElapsedRunningLabel = (startedAtMs) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return undefined;
    let timer = 0;
    const schedule = () => {
      const elapsed = Date.now() - startedAtMs;
      setNowMs(Date.now());
      // No further ticks needed once we've crossed into "still going".
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

/**
 * Compact state visualization + tally for a collapsed group of owned agents.
 * `summary` comes from `summarizeCompactActivity`; `prioritizeFailure` pulls a
 * failing child to the front of the tally while the owner is still running.
 */
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
              // Stable task identity keeps state changes on this final grid
              // slot; only the local paint fades/pulses, never its position.
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
