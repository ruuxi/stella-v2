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
   * `true` while the run is active — i.e. the orchestrator is thinking or
   * running a tool. Assistant text arrives as a whole message, so there is
   * no "answer is streaming" middle state to hand off to: the indicator is
   * up for the life of the run and the message appears beneath it.
   * Flipping to `false` triggers the grow-out exit; the component stays
   * mounted until the exit completes. If `active` flips back to true
   * mid-exit, the exit is canceled and the indicator resumes live updates.
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
  isToolActive,
  activeToolName,
  activeToolCallId,
  runtimeStatusText,
}: {
  isStreaming: boolean;
  isToolActive: boolean;
  activeToolName?: string | null;
  activeToolCallId?: string | null;
  runtimeStatusText?: string | null;
}): InlineWorkingIndicatorMountProps {
  const active = getInlineWorkingIndicatorActive({
    isStreaming,
    isToolActive,
  });
  const isThinking = isStreaming && !isToolActive;
  return {
    active,
    // The run going terminal is the end of the work — drop the
    // minimum-visible hold so no stale row trails the settled turn.
    ...(!isStreaming ? { exitImmediately: true } : {}),
    runningTool: isToolActive ? (activeToolName ?? undefined) : undefined,
    runningToolId: isToolActive ? (activeToolCallId ?? undefined) : undefined,
    status: isThinking ? (runtimeStatusText ?? null) : null,
  };
}

/**
 * Rig state for the working indicator's Stella character.
 *
 * | indicator state              | rig state   |
 * |------------------------------|-------------|
 * | no tool, reasoning           | "thinking"  |
 * | no tool, not reasoning       | "working"   |
 * | tool matches search / web    | "searching" |
 * | tool matches read / fetch    | "reading"   |
 * | tool matches write / edit    | "writing"   |
 * | tool matches shell / command | "working"   |
 * | any other tool               | "working"   |
 *
 * Matching is substring-based on the normalized tool name so runtime tool
 * families (`web`, `tool_search`, `str_replace`, `exec_command`, …) land on
 * the right animation without an exhaustive table.
 */
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

/**
 * The indicator is up whenever there is work in flight. Assistant text is
 * delivered as one whole message, so there is no partial-answer state that
 * could dismiss it early: it stays up for the life of the run and naturally
 * reappears between a preamble and the tool call that follows it.
 */
export function getInlineWorkingIndicatorActive({
  isStreaming,
  isToolActive,
}: {
  isStreaming: boolean;
  isToolActive: boolean;
}): boolean {
  return isStreaming || isToolActive;
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
