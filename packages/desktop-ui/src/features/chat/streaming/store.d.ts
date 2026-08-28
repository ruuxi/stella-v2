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

    pendingToolAfterPreamble: boolean;
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
