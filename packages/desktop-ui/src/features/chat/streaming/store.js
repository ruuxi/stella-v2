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
        case 'assistant-message-boundary': {
            // A preamble message that ends with a tool call is interim, not the
            // final answer. Record that a tool is expected next so the working
            // indicator's label/tool tracking stays coherent across the gap
            // before `tool-start` arrives.
            // No-op for a plain boundary (the run's final answer).
            if (!action.followedByToolCall) {
                return state;
            }
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
                        // `pendingToolAfterPreamble` is released in `tool-end`, once
                        // the whole tool phase is over — not here, so parallel tool
                        // calls keep it set for the duration.
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
                        // Release the preamble marker only once the whole tool phase is
                        // over (no tool still in flight); that also covers parallel
                        // tool calls.
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
