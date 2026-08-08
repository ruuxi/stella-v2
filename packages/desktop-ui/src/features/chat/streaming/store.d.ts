/**
 * Pure reducer + types for the local agent stream.
 *
 * All side-effecting concerns (timers, IPC subscriptions, rAF batching,
 * React state) live in the surrounding hooks; this module is a plain
 * data transition layer so the same shapes are usable from tests
 * without a React renderer.
 */
import type { AttachmentRef } from './chat-types';
export type RunRecord = {
    runId: string;
    conversationId: string;
    requestId?: string;
    userMessageId?: string;
    uiVisibility?: 'visible' | 'hidden';
    terminal: boolean;
    outcome?: 'completed' | 'error' | 'canceled';
    statusText: string | null;
    hasToolActivity: boolean;
    /**
     * `true` while the orchestrator is actively emitting visible answer
     * text. Set on each visible STREAM chunk; reset when a tool starts (the
     * model has stopped talking to do work) and on run start. Drives the
     * inline working indicator's "Thinking → gone" handoff. Tracked at the
     * run level (not derived from the overlay array) so reasoning gaps
     * *after* an interim/preamble message still show the indicator, and so
     * runs without a user-message anchor (proactive / non-`user_turn`) get
     * the same handoff even though they never create a streaming overlay.
     */
    isStreamingText: boolean;
    /** Rejects any out-of-order response marker for a finalized preamble. */
    pendingToolAfterPreamble: boolean;
    activeToolCalls: Record<string, {
        toolName: string;
        statusText: string | null;
    }>;
};
export type StreamStoreState = {
    runsById: Record<string, RunRecord>;
    activeRunIdByConversation: Record<string, string | null>;
    requestToRunId: Record<string, string>;
};
export type ActiveRunSnapshot = {
    runId: string;
    conversationId: string;
    requestId?: string;
    userMessageId?: string;
    uiVisibility?: 'visible' | 'hidden';
} | null;
export type StreamStoreAction = {
    type: 'run-started';
    runId: string;
    conversationId: string;
    requestId?: string;
    userMessageId?: string;
    uiVisibility?: 'visible' | 'hidden';
} | {
    type: 'run-status';
    runId: string;
    statusText: string | null;
} | {
    type: 'mark-streaming-text';
    runId: string;
} | {
    type: 'assistant-message-boundary';
    runId: string;
    /**
     * True when the message that just finalized ends with a tool call
     * (an interim preamble, not the run's final answer). Re-arms the
     * working indicator by clearing `isStreamingText` at the boundary so
     * it stays up across the gap until the tool starts — rather than
     * lingering dismissed over the visible preamble text.
     */
    followedByToolCall?: boolean;
} | {
    type: 'tool-start';
    runId: string;
    conversationId: string;
    toolCallId?: string;
    toolName?: string;
    statusText?: string | null;
} | {
    type: 'tool-end';
    runId: string;
    toolCallId?: string;
    toolName?: string;
    exitCode?: number;
} | {
    type: 'tool-activity-observed';
    runId: string;
} | {
    type: 'run-finished';
    runId: string;
    conversationId: string;
    outcome: 'completed' | 'error' | 'canceled';
} | {
    type: 'clear-conversation-run';
    conversationId: string;
} | {
    type: 'hydrate-conversation';
    conversationId: string;
    activeRun: ActiveRunSnapshot;
};
export declare const initialStoreState: StreamStoreState;
export declare function streamStoreReducer(state: StreamStoreState, action: StreamStoreAction): StreamStoreState;
export declare function attachmentsForStartChat(attachments: AttachmentRef[] | undefined): {
    url: string;
    mimeType?: string;
    previewUrl?: string;
}[] | undefined;
