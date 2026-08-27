import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  isStandaloneTaskStatusText,
  normalizeTaskDisplayStatusText,
} from "@/features/chat/lib/event-transforms";
import { computeStatus, normalizeDisplayStatusText } from "./status-utils";

export const INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS = 2000;

export type InlineWorkingIndicatorProps = {
  runningTool?: string;
  /** Stable id of the in-flight tool call; seeds the friendly status
   * label so it doesn't churn on every re-render. */
  runningToolId?: string;
  /** Run-level orchestrator status (spawn / pause / compaction, etc.). */
  status?: string | null;
  minimumVisibleMs?: number;
};

export type InlineWorkingIndicatorMountProps = InlineWorkingIndicatorProps & {
  /**
   * `true` while the orchestrator is thinking or running a tool (and not
   * yet streaming answer text). Flipping to `false` triggers the grow-out
   * exit; the component stays mounted until the exit completes. If
   * `active` flips back to true mid-exit, the exit is canceled and the
   * indicator resumes live updates.
   */
  active: boolean;
  /** Skip the `MIN_VISIBLE_MS` floor on deactivation. */
  exitImmediately?: boolean;
};

/**
 * Single source of truth for the inline working indicator's mount props,
 * shared by every chat surface so they cannot
 * drift. Pass the raw streaming snapshot; the helper derives `active`,
 * the friendly label inputs, and the immediate-exit handoff.
 */
export function buildInlineWorkingIndicatorProps({
  isStreaming,
  isStreamingResponseText,
  isToolActive,
  activeToolName,
  activeToolCallId,
  runtimeStatusText,
}: {
  isStreaming: boolean;
  /** True once the in-flight run emits its first visible provider delta. */
  isStreamingResponseText: boolean;
  isToolActive: boolean;
  activeToolName?: string | null;
  activeToolCallId?: string | null;
  runtimeStatusText?: string | null;
}): InlineWorkingIndicatorMountProps {
  const active = getInlineWorkingIndicatorActive({
    isStreaming,
    isStreamingResponseText,
    isToolActive,
  });
  const isThinking =
    isStreaming && !isStreamingResponseText && !isToolActive;
  return {
    active,
    ...(!isStreaming || isStreamingResponseText
      ? { exitImmediately: true }
      : {}),
    runningTool: isToolActive ? (activeToolName ?? undefined) : undefined,
    runningToolId: isToolActive ? (activeToolCallId ?? undefined) : undefined,
    status: isThinking ? (runtimeStatusText ?? null) : null,
  };
}

/**
 * On run resume/reactivation the assistant's already-streamed answer is
 * rehydrated from persistence (a real `assistant_message` row) with no live
 * stream event to mark response text. Because the resume snapshot seeds the
 * active run with
 * `isStreamingText: false`, the inline working indicator would otherwise
 * hang "Thinking" *under* the fully-visible resumed answer until the run
 * finally goes terminal.
 *
 * Detect exactly that shape — the run is still active, the indicator has
 * not handed off yet, there is no live streaming overlay (a live turn
 * always has at least a placeholder overlay), and the active turn's answer
 * is already on screen — so the caller can treat the resumed text as started.
 * It is a no-op for live streaming, where `hasLiveStreamingOverlay` is true
 * (or `isStreamingResponseText` already flipped by a provider delta).
 */
export function shouldTreatResumedAnswerAsStarted({
  isStreaming,
  isStreamingResponseText,
  hasLiveStreamingOverlay,
  activeTurnAnswerVisible,
}: {
  isStreaming: boolean;
  isStreamingResponseText: boolean;
  hasLiveStreamingOverlay: boolean;
  activeTurnAnswerVisible: boolean;
}): boolean {
  if (!isStreaming) return false;
  if (isStreamingResponseText) return false;
  if (hasLiveStreamingOverlay) return false;
  return activeTurnAnswerVisible;
}

export function getRunningTaskIndicatorText(
  task: TaskItem,
): string | undefined {
  if (task.status !== "running") return undefined;
  const statusText = normalizeTaskDisplayStatusText(task.statusText);
  if (!statusText) return undefined;
  if (statusText === task.description.trim()) return undefined;
  return statusText;
}

export function getInlineWorkingIndicatorActive({
  isStreaming,
  isStreamingResponseText,
  isToolActive,
}: {
  isStreaming: boolean;
  /** True once the assistant emits its first visible provider delta. */
  isStreamingResponseText: boolean;
  isToolActive: boolean;
}): boolean {
  if (isToolActive) return true;
  return isStreaming && !isStreamingResponseText;
}

export function getInlineWorkingIndicatorExitDelayMs({
  activatedAtMs,
  nowMs,
  minVisibleMs = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
}: {
  activatedAtMs: number;
  nowMs: number;
  minVisibleMs?: number;
}): number {
  return Math.max(0, minVisibleMs - (nowMs - activatedAtMs));
}

export function getWorkingIndicatorDisplayStatus({
  status,
  toolName,
  toolCallId,
  tasks,
  isReasoning,
  reasoningSeed,
}: {
  status?: string;
  toolName?: string;
  toolCallId?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
  /** Seed for the no-tool reasoning/idle label. */
  reasoningSeed?: string;
}): string {
  if (status) {
    return normalizeDisplayStatusText(status) ?? status;
  }

  if (tasks && tasks.length > 0) {
    const task = tasks[0];
    if (task.status === "completed") {
      const taskText = normalizeTaskDisplayStatusText(task.statusText);
      return taskText ? `Done · ${taskText}` : "Done";
    }
    if (task.status === "running") {
      const statusText = getRunningTaskIndicatorText(task);
      if (statusText && !isStandaloneTaskStatusText(statusText)) {
        return statusText;
      }
      if (statusText && isStandaloneTaskStatusText(statusText)) {
        return statusText;
      }
      if (toolName) {
        return computeStatus({ toolName, seed: toolCallId });
      }
      return computeStatus({ toolName: "spawn_agent", seed: "" });
    }
  }

  return computeStatus({
    toolName,
    seed: toolCallId ?? reasoningSeed,
    isReasoning,
  });
}
