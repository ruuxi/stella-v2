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
