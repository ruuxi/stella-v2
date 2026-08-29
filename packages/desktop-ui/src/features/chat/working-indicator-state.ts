import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  isStandaloneTaskStatusText,
  normalizeTaskDisplayStatusText,
} from "@/features/chat/lib/event-transforms";
import { computeStatus, normalizeDisplayStatusText } from "./status-utils";

export const INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS = 2000;

/**
 * How long the answer row is held back after it lands, and how long the
 * indicator's handoff exit runs. The two share one constant because the
 * reply is meant to appear exactly as the indicator finishes clearing the
 * row it occupied.
 */
export const WORKING_INDICATOR_HANDOFF_MS = 240;

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
   * `true` while the orchestrator is thinking or running a tool. Flipping to
   * `false` triggers the exit; the component stays mounted until the exit
   * completes. If `active` flips back to true mid-exit, the exit is canceled
   * and the indicator resumes live updates.
   */
  active: boolean;
  /** Skip the `MIN_VISIBLE_MS` floor on deactivation. Set when the run went
   * terminal without producing an answer, e.g. a user cancel. */
  exitImmediately?: boolean;
  /**
   * The run's final answer landed. The indicator plays the handoff exit
   * instead of the ordinary grow-out: it keeps the row's height while it
   * clears, so the reply drops into the same line the indicator held.
   */
  handoff?: boolean;
};

/**
 * Single source of truth for the inline working indicator's mount props,
 * shared by every chat surface so they cannot drift. Pass the raw streaming
 * snapshot; the helper derives `active` and the exit mode.
 */
export function buildInlineWorkingIndicatorProps({
  isStreaming,
  isToolActive,
  answerLanded,
  activeToolName,
  activeToolCallId,
  runtimeStatusText,
}: {
  isStreaming: boolean;
  isToolActive: boolean;
  /** The run's final assistant message landed (no tool followed it). */
  answerLanded?: boolean;
  activeToolName?: string | null;
  activeToolCallId?: string | null;
  runtimeStatusText?: string | null;
}): InlineWorkingIndicatorMountProps {
  // A tool still in flight outranks a landed answer: a preamble's message
  // boundary can race ahead of the tool start it precedes.
  const handoff = Boolean(answerLanded) && !isToolActive;
  const active = getInlineWorkingIndicatorActive({
    isStreaming,
    isToolActive,
    answerLanded: handoff,
  });
  const isThinking = isStreaming && !isToolActive;
  return {
    active,
    ...(!isStreaming && !handoff ? { exitImmediately: true } : {}),
    ...(handoff ? { handoff: true } : {}),
    runningTool: isToolActive ? (activeToolName ?? undefined) : undefined,
    runningToolId: isToolActive ? (activeToolCallId ?? undefined) : undefined,
    status: isThinking ? (runtimeStatusText ?? null) : null,
  };
}

/** Which pose the character mark holds while the indicator is up. */
export type WorkingIndicatorCharacterState =
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "reading";

export function getWorkingIndicatorCharacterState({
  toolName,
  isReasoning,
}: {
  toolName?: string;
  isReasoning?: boolean;
}): WorkingIndicatorCharacterState {
  const tool = toolName?.trim().toLowerCase() ?? "";
  if (!tool) return isReasoning ? "thinking" : "working";
  if (/search|web/.test(tool)) return "searching";
  if (/read|fetch/.test(tool)) return "reading";
  if (/write|edit/.test(tool)) return "writing";
  if (/shell|command/.test(tool)) return "working";
  return "working";
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
  isToolActive,
  answerLanded,
}: {
  isStreaming: boolean;
  isToolActive: boolean;
  /** The run's final assistant message landed (no tool followed it). */
  answerLanded?: boolean;
}): boolean {
  return (isStreaming && !answerLanded) || isToolActive;
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
  /** Per-turn seed for the no-tool reasoning/idle label so it rotates
   * across turns instead of always reading "Thinking". */
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
