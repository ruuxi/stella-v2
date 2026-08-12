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
import { memo } from "react";
import { getCompactActivityStatusText } from "@/features/chat/lib/event-transforms";
import { selectLatestAgentAssistantMessage } from "@/features/chat/lib/agent-assistant-summary";
import "@/app/chat/chat-workspace-strip.css";

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
}) {
  const statusText = getCompactActivityStatusText(summary, prioritizeFailure);
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
      </span>
    </>
  );
});
