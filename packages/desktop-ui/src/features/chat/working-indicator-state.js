import { isStandaloneTaskStatusText, normalizeTaskDisplayStatusText, } from "@/features/chat/lib/event-transforms";
import { friendlyInlineToolStatus } from "@/features/chat/lib/friendly-tool-status";
import { computeStatus, normalizeDisplayStatusText } from "./status-utils";
export const INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS = 2000;
/**
 * Single source of truth for the inline working indicator's mount props,
 * shared by every chat surface so they cannot
 * drift. Pass the raw streaming snapshot; the helper derives `active`,
 * the friendly label inputs, and the immediate-exit handoff.
 */
export function buildInlineWorkingIndicatorProps({ isStreaming, isStreamingResponseText, isToolActive, hasToolActivity, activeToolName, activeToolCallId, latestCompletedTool, runtimeStatusText, }) {
    const completedToolStatus = latestCompletedTool
        ? friendlyInlineToolStatus({
            ...latestCompletedTool,
            label: latestCompletedTool.toolName,
            state: "completed",
        })
        : null;
    const active = getInlineWorkingIndicatorActive({
        isStreaming,
        isStreamingResponseText,
        isToolActive,
        hasCompletedTool: Boolean(latestCompletedTool),
    });
    // Initial thinking is pre-tool only. Once a tool lifecycle begins the
    // indicator follows live TOOL_START/TOOL_END state instead of the
    // long-lived root run, so spawn_agent/send_input do not pin it while the
    // agent works.
    const isPreToolThinking = isStreaming && !isStreamingResponseText && !hasToolActivity;
    return {
        active,
        ...(!isStreaming ? { exitImmediately: true } : {}),
        ...(completedToolStatus ? { minimumVisibleMs: 0 } : {}),
        // A completed-tool receipt bypasses the ordinary phrase hold so every
        // result replaces the previous one immediately. Terminal run state
        // uses `exitImmediately` above, so the receipt does not persist.
        runningTool: isToolActive && !completedToolStatus ? (activeToolName ?? undefined) : undefined,
        runningToolId: isToolActive && !completedToolStatus ? (activeToolCallId ?? undefined) : undefined,
        // Active tools always go through the short friendly phrase map. Runtime
        // status text is an internal diagnostic surface and can contain raw
        // tool labels such as "Running Exec Command".
        status: completedToolStatus ??
            (isPreToolThinking ? (runtimeStatusText ?? null) : null),
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
export function shouldTreatResumedAnswerAsStarted({ isStreaming, isStreamingResponseText, hasLiveStreamingOverlay, activeTurnAnswerVisible, }) {
    if (!isStreaming)
        return false;
    if (isStreamingResponseText)
        return false;
    if (hasLiveStreamingOverlay)
        return false;
    return activeTurnAnswerVisible;
}
export function getRunningTaskIndicatorText(task) {
    if (task.status !== "running")
        return undefined;
    const statusText = normalizeTaskDisplayStatusText(task.statusText);
    if (!statusText)
        return undefined;
    if (statusText === task.description.trim())
        return undefined;
    return statusText;
}
export function getInlineWorkingIndicatorActive({ isStreaming, isStreamingResponseText, isToolActive, hasCompletedTool = false, }) {
    if (isStreaming && hasCompletedTool)
        return true;
    if (isToolActive)
        return true;
    // Before any result, hand off on the assistant's first visible delta. Once
    // a tool completes, keep its newest one-line receipt visible through the
    // rest of the active turn; terminal state removes it.
    return isStreaming && !isStreamingResponseText;
}
export function getInlineWorkingIndicatorExitDelayMs({ activatedAtMs, nowMs, minVisibleMs = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS, }) {
    return Math.max(0, minVisibleMs - (nowMs - activatedAtMs));
}
export function getWorkingIndicatorDisplayStatus({ status, toolName, toolCallId, tasks, isReasoning, reasoningSeed, }) {
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
