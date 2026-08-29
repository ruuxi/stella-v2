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
    /** Rejects any out-of-order response marker for a finalized preamble. */
    pendingToolAfterPreamble: boolean;
    /**
     * The run's final assistant message has landed. Tracked at the run level
     * rather than derived from the overlay array so runs with no user-message
     * anchor (proactive / non-`user_turn`) get the same handoff even though
     * they never create an overlay.
     */
    answerLanded: boolean;
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
    type: 'assistant-message-boundary';
    runId: string;
    /**
     * True when the message that just finalized ends with a tool call — an
     * interim preamble, not the run's final answer. Keeps the working
     * indicator up across the gap until the tool starts, rather than letting
     * it hand off over a preamble the run is not finished with.
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
