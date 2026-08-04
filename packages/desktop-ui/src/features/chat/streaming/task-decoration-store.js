/**
 * Module-level store for per-thread ephemeral stream decoration —
 * statusText ticks, tool activity, reasoning — keyed by the thread's
 * durable `agentId`, never by run. Authoritative task state (status,
 * description, timestamps, result) lives in the thread-activity rows;
 * a decoration only carries the high-frequency display extras the rows
 * don't persist. The latest lifecycle observation stays until the durable
 * row catches up or a newer attempt replaces it, which closes the brief
 * completed-row/follow-up race without making stream data authoritative.
 *
 * Lives outside the React tree so BOTH kinds of consumer can read it:
 * the conversation-level task list (`useFullShellChat` merges the whole
 * snapshot via `buildActivityTasks`) and individual inline chat cards
 * (`BackgroundWorkCard` subscribes to just its own thread, so a
 * reasoning tick re-renders one card, not every activity surface).
 */
import { normalizeTaskDisplayStatusText, } from '@/features/chat/lib/event-transforms';
export const MAX_AGENT_REASONING_CHARS = 8_000;
/** New starts replace terminal observations and the cap bounds completed
 * observations that remain after the authoritative row catches up. */
export const MAX_TASK_DECORATIONS = 64;
const decorations = new Map();
/** Immutable snapshot rebuilt on mutation — stable identity between writes
 *  so `useSyncExternalStore` consumers can memo off it. */
let snapshot = {};
const globalListeners = new Set();
const agentListeners = new Map();
const notify = (agentIds) => {
    snapshot = Object.fromEntries(decorations);
    for (const listener of globalListeners)
        listener();
    for (const agentId of agentIds) {
        const listeners = agentListeners.get(agentId);
        if (!listeners)
            continue;
        for (const listener of listeners)
            listener();
    }
};
const setDecoration = (next) => {
    const isNew = !decorations.has(next.agentId);
    decorations.set(next.agentId, next);
    // Updates can't grow the map — only a genuinely new key pays the
    // eviction scan.
    if (isNew && decorations.size > MAX_TASK_DECORATIONS) {
        let oldestId;
        let oldestAtMs = Infinity;
        for (const [agentId, decoration] of decorations) {
            if (decoration.lastUpdatedAtMs < oldestAtMs) {
                oldestAtMs = decoration.lastUpdatedAtMs;
                oldestId = agentId;
            }
        }
        if (oldestId !== undefined && oldestId !== next.agentId) {
            decorations.delete(oldestId);
            notify([next.agentId, oldestId]);
            return;
        }
    }
    notify([next.agentId]);
};
const isOlderLifecycleSignal = (existing, signal) => {
    if (existing.attemptGeneration !== undefined &&
        signal.attemptGeneration !== undefined &&
        existing.attemptGeneration !== signal.attemptGeneration) {
        return signal.attemptGeneration < existing.attemptGeneration;
    }
    if (existing.runId &&
        signal.runId &&
        existing.runId !== signal.runId &&
        existing.attemptGeneration === signal.attemptGeneration) {
        return signal.startsAttempt !== true;
    }
    if (existing.status !== undefined &&
        existing.status !== 'running' &&
        signal.startsAttempt !== true &&
        signal.settlesAttempt !== true &&
        existing.attemptGeneration === signal.attemptGeneration) {
        return true;
    }
    return (existing.lifecycleSequence !== undefined &&
        signal.lifecycleSequence !== undefined &&
        signal.lifecycleSequence < existing.lifecycleSequence);
};
export const decorateTask = (input) => {
    const existing = decorations.get(input.agentId);
    if (existing && isOlderLifecycleSignal(existing, input))
        return;
    const now = Date.now();
    const retained = input.startsAttempt ? undefined : existing;
    setDecoration({
        agentId: input.agentId,
        conversationId: input.conversationId,
        runId: input.runId ?? retained?.runId,
        status: 'running',
        attemptGeneration: input.attemptGeneration ?? retained?.attemptGeneration,
        lifecycleSequence: input.lifecycleSequence ?? retained?.lifecycleSequence,
        startedAtMs: input.startsAttempt ? now : (retained?.startedAtMs ?? now),
        observedAtMs: now,
        anchorTurnId: input.anchorTurnId ?? retained?.anchorTurnId,
        statusText: normalizeTaskDisplayStatusText(input.statusText) ?? retained?.statusText,
        toolActivity: input.toolActivity ?? retained?.toolActivity,
        reasoningText: retained?.reasoningText,
        lastUpdatedAtMs: now,
    });
};
export const appendTaskReasoning = (input) => {
    if (!input.chunk)
        return;
    const existing = decorations.get(input.agentId);
    if (existing && isOlderLifecycleSignal(existing, input))
        return;
    const now = Date.now();
    const nextReasoningText = `${existing?.reasoningText ?? ''}${input.chunk}`;
    setDecoration({
        agentId: input.agentId,
        conversationId: input.conversationId,
        runId: input.runId ?? existing?.runId,
        status: 'running',
        attemptGeneration: input.attemptGeneration ?? existing?.attemptGeneration,
        lifecycleSequence: input.lifecycleSequence ?? existing?.lifecycleSequence,
        startedAtMs: existing?.startedAtMs ?? now,
        observedAtMs: now,
        anchorTurnId: existing?.anchorTurnId,
        statusText: existing?.statusText,
        toolActivity: existing?.toolActivity,
        reasoningText: nextReasoningText.length > MAX_AGENT_REASONING_CHARS
            ? nextReasoningText.slice(-MAX_AGENT_REASONING_CHARS)
            : nextReasoningText,
        lastUpdatedAtMs: now,
    });
};
export const settleTaskDecoration = (input) => {
    const existing = decorations.get(input.agentId);
    if (existing &&
        isOlderLifecycleSignal(existing, { ...input, settlesAttempt: true })) {
        return;
    }
    const now = Date.now();
    setDecoration({
        agentId: input.agentId,
        conversationId: input.conversationId,
        runId: input.runId ?? existing?.runId,
        status: input.status,
        attemptGeneration: input.attemptGeneration ?? existing?.attemptGeneration,
        lifecycleSequence: input.lifecycleSequence ?? existing?.lifecycleSequence,
        startedAtMs: existing?.startedAtMs ?? now,
        observedAtMs: now,
        anchorTurnId: existing?.anchorTurnId,
        statusText: existing?.statusText,
        lastUpdatedAtMs: now,
    });
};
export const clearTaskDecoration = (agentId) => {
    if (!decorations.delete(agentId))
        return;
    notify([agentId]);
};
export const clearConversationTaskDecorations = (conversationId) => {
    const removed = [];
    for (const [agentId, decoration] of decorations) {
        if (decoration.conversationId === conversationId) {
            decorations.delete(agentId);
            removed.push(agentId);
        }
    }
    if (removed.length > 0)
        notify(removed);
};
export const getTaskDecorationsSnapshot = () => snapshot;
export const getTaskDecoration = (agentId) => snapshot[agentId];
export const subscribeTaskDecorations = (listener) => {
    globalListeners.add(listener);
    return () => {
        globalListeners.delete(listener);
    };
};
export const subscribeTaskDecoration = (agentId, listener) => {
    let listeners = agentListeners.get(agentId);
    if (!listeners) {
        listeners = new Set();
        agentListeners.set(agentId, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            agentListeners.delete(agentId);
        }
    };
};
export const __privateTaskDecorationStore = {
    resetForTests() {
        decorations.clear();
        snapshot = {};
        globalListeners.clear();
        agentListeners.clear();
    },
};
