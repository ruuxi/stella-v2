export const initialStoreState = {
    runsById: {},
    activeRunIdByConversation: {},
    requestToRunId: {},
};
const toToolCallKey = (args) => {
    const callId = args.toolCallId?.trim();
    if (callId)
        return callId;
    const toolName = args.toolName?.trim();
    if (toolName)
        return `${args.runId}:${toolName}`;
    return `${args.runId}:tool`;
};
/**
 * Resolve which active tool-call a `tool-end` refers to, tolerant of the
 * runtime keying the end event differently from its start (e.g. a
 * `toolCallId` on start but only a `toolName` on end). A `tool-end` whose
 * exact key is missing must still clear the in-flight tool — otherwise a
 * phantom entry pins `isToolActive` true and the working indicator stays
 * stuck on a tool label until the run finishes. Returns `null` only when
 * nothing can be safely matched (so concurrent tools never clear the wrong
 * entry).
 */
const resolveToolEndKey = (activeToolCalls, action) => {
    const exact = toToolCallKey(action);
    if (exact in activeToolCalls)
        return exact;
    const callId = action.toolCallId?.trim();
    if (callId && callId in activeToolCalls)
        return callId;
    const toolName = action.toolName?.trim();
    if (toolName) {
        const nameKey = `${action.runId}:${toolName}`;
        if (nameKey in activeToolCalls)
            return nameKey;
        const matchingByName = Object.keys(activeToolCalls).filter((key) => activeToolCalls[key]?.toolName === toolName);
        const lastMatch = matchingByName.at(-1);
        if (lastMatch)
            return lastMatch;
    }
    const keys = Object.keys(activeToolCalls);
    // With a single tool in flight, an unresolved end unambiguously closes it.
    if (keys.length === 1)
        return keys[0];
    return null;
};
const createEmptyRunRecord = (args) => ({
    runId: args.runId,
    conversationId: args.conversationId,
    ...(args.requestId ? { requestId: args.requestId } : {}),
    ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    terminal: args.terminal ?? false,
    ...(args.outcome ? { outcome: args.outcome } : {}),
    statusText: args.statusText ?? null,
    hasToolActivity: false,
    latestCompletedTool: null,
    isStreamingText: false,
    pendingToolAfterPreamble: false,
    activeToolCalls: {},
});
export function streamStoreReducer(state, action) {
    switch (action.type) {
        case 'run-started': {
            const current = state.runsById[action.runId];
            const nextRun = createEmptyRunRecord({
                runId: action.runId,
                conversationId: action.conversationId,
                requestId: action.requestId ?? current?.requestId,
                userMessageId: action.userMessageId ?? current?.userMessageId,
                uiVisibility: action.uiVisibility ?? current?.uiVisibility,
            });
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: nextRun,
                },
                activeRunIdByConversation: {
                    ...state.activeRunIdByConversation,
                    [action.conversationId]: action.runId,
                },
                requestToRunId: action.requestId
                    ? {
                        ...state.requestToRunId,
                        [action.requestId]: action.runId,
                    }
                    : state.requestToRunId,
            };
        }
        case 'run-status': {
            const current = state.runsById[action.runId];
            if (!current || current.terminal) {
                return state;
            }
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        statusText: action.statusText,
                    },
                },
            };
        }
        case 'mark-streaming-text': {
            const current = state.runsById[action.runId];
            if (!current ||
                current.terminal ||
                current.isStreamingText ||
                // A preamble→tool boundary just fired: this marker belongs to the
                // finalized preamble, not a fresh answer, so it must not re-suppress
                // the working indicator across the gap before the tool starts.
                current.pendingToolAfterPreamble) {
                return state;
            }
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        isStreamingText: true,
                    },
                },
            };
        }
        case 'assistant-message-boundary': {
            // A preamble message that ends with a tool call is interim, not the
            // final answer. Clear `isStreamingText` here so the working indicator
            // re-appears immediately at the boundary and stays up across the gap
            // before `tool-start` arrives — otherwise it lingers dismissed over
            // the visible preamble text, making it look like nothing is happening.
            // No-op for a plain boundary (final answer): keep its existing hand-off.
            if (!action.followedByToolCall) {
                return state;
            }
            const current = state.runsById[action.runId];
            if (!current || current.terminal) {
                return state;
            }
            // Set the suppression flag unconditionally so a stale marker cannot
            // reopen the gap regardless of event ordering.
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        isStreamingText: false,
                        pendingToolAfterPreamble: true,
                    },
                },
            };
        }
        case 'tool-start': {
            const current = state.runsById[action.runId] ??
                createEmptyRunRecord({
                    runId: action.runId,
                    conversationId: action.conversationId,
                });
            if (current.terminal) {
                return state;
            }
            const toolCallKey = toToolCallKey(action);
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        hasToolActivity: true,
                        // The model has stopped emitting text to run a tool; clear the
                        // streaming-text flag so the post-tool reasoning gap shows the
                        // working indicator again. Re-arming is safe: the post-tool
                        // answer is a new assistant message (the agent loop emits the
                        // `message_end` boundary before this tool start), so it streams
                        // into a fresh overlay slot and its first visible provider delta
                        // sets `isStreamingText` back to true.
                        isStreamingText: false,
                        // Deliberately DO NOT release `pendingToolAfterPreamble` here.
                        // An out-of-order preamble marker could arrive after this
                        // `tool-start`. Clearing the flag here would let that marker set
                        // `isStreamingText: true`; it stays masked by `isToolActive`
                        // while the tool runs, but sticks true after `tool-end`, blanking
                        // the indicator across the post-tool reasoning gap (dead air,
                        // most visible after `spawn_agent`). The suppression is released
                        // in `tool-end` instead, once the tool phase is fully over.
                        statusText: action.statusText ?? current.statusText,
                        latestCompletedTool: null,
                        activeToolCalls: {
                            ...(current.activeToolCalls ?? {}),
                            [toolCallKey]: {
                                toolName: action.toolName ?? 'tool',
                                statusText: action.statusText ?? null,
                            },
                        },
                    },
                },
            };
        }
        case 'tool-end': {
            const current = state.runsById[action.runId];
            if (!current || current.terminal) {
                return state;
            }
            const nextActiveToolCalls = { ...(current.activeToolCalls ?? {}) };
            const toolCallKey = resolveToolEndKey(nextActiveToolCalls, action);
            const endedTool = toolCallKey
                ? nextActiveToolCalls[toolCallKey]
                : undefined;
            if (toolCallKey) {
                delete nextActiveToolCalls[toolCallKey];
            }
            const nextActiveTool = Object.values(nextActiveToolCalls).at(-1);
            const toolPhaseOver = Object.keys(nextActiveToolCalls).length === 0;
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        hasToolActivity: true,
                        // Release stale-marker suppression only once the whole tool phase
                        // is over (no tool still in flight), so an out-of-order preamble
                        // marker cannot set `isStreamingText: true` and blank the indicator in the
                        // post-tool reasoning gap. Keeping it set until the last tool ends
                        // also covers parallel tool calls. The post-tool answer's first
                        // visible delta then hands off normally.
                        ...(toolPhaseOver ? { pendingToolAfterPreamble: false } : {}),
                        statusText: nextActiveTool?.statusText ?? null,
                        latestCompletedTool: action.toolName || endedTool?.toolName
                            ? {
                                toolCallId: action.toolCallId ?? toolCallKey ?? "",
                                toolName: action.toolName ?? endedTool?.toolName ?? "tool",
                                ...(typeof action.exitCode === "number"
                                    ? { exitCode: action.exitCode }
                                    : {}),
                            }
                            : current.latestCompletedTool,
                        activeToolCalls: nextActiveToolCalls,
                    },
                },
            };
        }
        case 'tool-activity-observed': {
            const current = state.runsById[action.runId];
            if (!current || current.terminal) {
                return state;
            }
            const hasActiveTool = Object.keys(current.activeToolCalls ?? {}).length > 0;
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: {
                        ...current,
                        hasToolActivity: true,
                        statusText: hasActiveTool ? current.statusText : null,
                    },
                },
            };
        }
        case 'run-finished': {
            const current = state.runsById[action.runId];
            const nextRun = createEmptyRunRecord({
                runId: action.runId,
                conversationId: action.conversationId,
                requestId: current?.requestId,
                userMessageId: current?.userMessageId,
                terminal: true,
                outcome: action.outcome,
            });
            const activeRunId = state.activeRunIdByConversation[action.conversationId] ?? null;
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [action.runId]: nextRun,
                },
                activeRunIdByConversation: activeRunId === action.runId
                    ? {
                        ...state.activeRunIdByConversation,
                        [action.conversationId]: null,
                    }
                    : state.activeRunIdByConversation,
            };
        }
        case 'clear-conversation-run': {
            const activeRunId = state.activeRunIdByConversation[action.conversationId] ?? null;
            if (activeRunId === null) {
                return state;
            }
            return {
                ...state,
                activeRunIdByConversation: {
                    ...state.activeRunIdByConversation,
                    [action.conversationId]: null,
                },
            };
        }
        case 'hydrate-conversation': {
            if (!action.activeRun) {
                return {
                    ...state,
                    activeRunIdByConversation: {
                        ...state.activeRunIdByConversation,
                        [action.conversationId]: null,
                    },
                };
            }
            const runId = action.activeRun.runId;
            return {
                ...state,
                runsById: {
                    ...state.runsById,
                    [runId]: {
                        ...createEmptyRunRecord({
                            runId,
                            conversationId: action.conversationId,
                            requestId: action.activeRun.requestId,
                            userMessageId: action.activeRun.userMessageId,
                            uiVisibility: action.activeRun.uiVisibility,
                        }),
                    },
                },
                activeRunIdByConversation: {
                    ...state.activeRunIdByConversation,
                    [action.conversationId]: runId,
                },
                requestToRunId: action.activeRun.requestId
                    ? {
                        ...state.requestToRunId,
                        [action.activeRun.requestId]: runId,
                    }
                    : state.requestToRunId,
            };
        }
        default:
            return state;
    }
}
export function attachmentsForStartChat(attachments) {
    if (!attachments?.length)
        return undefined;
    const mapped = attachments
        .filter((a) => typeof a.url === 'string' && a.url.length > 0)
        .map((a) => {
        const item = {
            url: a.url,
        };
        if (a.mimeType)
            item.mimeType = a.mimeType;
        if (a.previewUrl)
            item.previewUrl = a.previewUrl;
        return item;
    });
    return mapped.length ? mapped : undefined;
}
