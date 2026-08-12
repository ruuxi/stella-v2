const getRuntimeMetadata = (message) => {
    if (message.type !== "assistant_message")
        return null;
    const payload = message.payload;
    const runtime = payload?.metadata?.runtime;
    return runtime && typeof runtime === "object" ? runtime : null;
};
const getOwningUserMessageId = (message) => {
    if (message.type !== "assistant_message")
        return null;
    const payload = message.payload;
    const userMessageId = payload?.userMessageId;
    return typeof userMessageId === "string" && userMessageId.length > 0
        ? userMessageId
        : null;
};
/**
 * Once a direct-mode turn completes, remove the transient narration from any
 * earlier assistant segment that ended in a tool call. The message itself and
 * its tool events stay in the timeline so generated images, files, receipts,
 * and other inline artifacts remain visible. Orchestrated, active, failed,
 * canceled, and legacy unmarked turns are unchanged.
 */
export const suppressCompletedDirectPreambleText = (messages) => {
    const completedDirectTurnIds = new Set();
    for (const message of messages) {
        const runtime = getRuntimeMetadata(message);
        const userMessageId = getOwningUserMessageId(message);
        if (userMessageId &&
            runtime?.workingMode === "direct" &&
            runtime.turnComplete === true) {
            completedDirectTurnIds.add(userMessageId);
        }
    }
    if (completedDirectTurnIds.size === 0)
        return messages;
    let changed = false;
    const next = messages.map((message) => {
        const runtime = getRuntimeMetadata(message);
        // Live overlays own their own renderer-drain + dwell + fade handoff.
        // Suppressing them at turnComplete would cut that transition short;
        // their hidden overlays continue masking the persisted preamble row.
        if (message._id.startsWith("stream-overlay:") &&
            typeof runtime?.assistantTextTransition === "string")
            return message;
        const userMessageId = getOwningUserMessageId(message);
        if (!userMessageId ||
            !completedDirectTurnIds.has(userMessageId) ||
            runtime?.workingMode !== "direct" ||
            runtime.followedByToolCall !== true ||
            runtime.turnComplete === true ||
            typeof message.payload?.text !== "string" ||
            message.payload.text.length === 0) {
            return message;
        }
        changed = true;
        return {
            ...message,
            payload: {
                ...message.payload,
                text: "",
            },
        };
    });
    return changed ? next : messages;
};
