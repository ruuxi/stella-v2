/** Latest non-empty assistant prose from an already chronological message list. */
export const selectLatestAgentAssistantMessage = (messages) => {
    if (!messages)
        return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const text = messages[index]?.trim();
        if (text)
            return text;
    }
    return undefined;
};
const isLaterSummary = (candidate, current) => {
    if (candidate.sequence !== undefined &&
        current.sequence !== undefined &&
        candidate.sequence !== current.sequence) {
        return candidate.sequence > current.sequence;
    }
    return candidate.atMs > current.atMs;
};
/**
 * Select assistant prose for an exact set of child threads. Thread identity,
 * attempt generation, root run, and spawn time are all checked before
 * recency, so a parent/root message or a resumed attempt cannot bleed into a
 * historical inline card. Durable insertion sequence wins over timestamps.
 */
export const selectLatestThreadAssistantSummary = (records, options) => {
    const included = new Set(options.threadIds);
    const excluded = new Set(options.excludedThreadIds ?? []);
    let latest;
    for (const record of records) {
        if (!included.has(record.threadId) || excluded.has(record.threadId)) {
            continue;
        }
        const expectedAttempt = options.attemptGenerationsByThread?.[record.threadId];
        if (expectedAttempt !== undefined &&
            record.attemptGeneration !== expectedAttempt) {
            continue;
        }
        const expectedRootRunId = options.rootRunIdsByThread?.[record.threadId];
        if (expectedRootRunId && record.rootRunId !== expectedRootRunId)
            continue;
        const text = selectLatestAgentAssistantMessage(record.assistantMessages);
        const atMs = record.assistantMessagesUpdatedAt ?? 0;
        const startedAtMs = options.startedAtMsByThread?.[record.threadId] ?? 0;
        if (!text || atMs < startedAtMs)
            continue;
        const candidate = {
            text,
            atMs,
            ...(record.assistantMessagesUpdatedSequence === undefined
                ? {}
                : { sequence: record.assistantMessagesUpdatedSequence }),
        };
        if (!latest || isLaterSummary(candidate, latest))
            latest = candidate;
    }
    return latest;
};
