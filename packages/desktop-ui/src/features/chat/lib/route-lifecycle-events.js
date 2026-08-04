import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
const LIFECYCLE_EVENT_TYPES = new Set([
    "agent-started",
    "agent-progress",
    "agent-completed",
    "agent-failed",
    "agent-canceled",
]);
const isLifecycleEvent = (event) => LIFECYCLE_EVENT_TYPES.has(event.type);
/** Synthetic `_id` prefix of streaming-overlay rows (see streaming-types). */
const STREAMING_OVERLAY_ID_PREFIX = "stream-overlay:";
export const createLifecycleRoutingState = () => ({
    sticky: new Map(),
    routedByBase: new WeakMap(),
});
const getAssistantUserMessageId = (message) => {
    const payload = message.payload;
    return typeof payload?.userMessageId === "string" &&
        payload.userMessageId.length > 0
        ? payload.userMessageId
        : undefined;
};
const getStreamStartedAtMs = (message) => {
    if (message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX)) {
        // Overlay rows sort by (and were created at) their first-chunk time.
        return message.timestamp;
    }
    const metadata = message.payload?.metadata;
    const value = metadata?.runtime?.streamStartedAtMs;
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
};
const compareEvents = (a, b) => a.timestamp !== b.timestamp
    ? a.timestamp - b.timestamp
    : a._id.localeCompare(b._id);
const sameToolEventIds = (a, b) => {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i]._id !== b[i]._id)
            return false;
    }
    return true;
};
/**
 * Re-anchor lifecycle events across the merged display messages per the
 * arrival-order rule above. Pure aside from the caller-owned `state`
 * (sticky decisions + identity cache). Returns the input array reference
 * when nothing moves.
 */
export const routeLifecycleEvents = (messages, state) => {
    // Fast bail: no lifecycle events anywhere.
    let hasLifecycle = false;
    for (const message of messages) {
        if (message.toolEvents.some(isLifecycleEvent)) {
            hasLifecycle = true;
            break;
        }
    }
    if (!hasLifecycle)
        return messages;
    // `messageIndex -> final toolEvents` for messages whose events changed.
    const routedEventsByIndex = new Map();
    const assistantCountByUserMessageId = new Map();
    let turn = [];
    const flushTurn = () => {
        if (turn.length === 0)
            return;
        const entries = turn;
        turn = [];
        // One routing decision per EVENT ID. The SQLite/tail-refresh handoff
        // can briefly leave the same lifecycle event on two rows (the stale
        // pre-assistant copy on the user anchor plus the fresh copy the
        // grouping forward-attached to the assistant); resolving per id
        // collapses those duplicates onto a single target so the card can
        // never render twice (or produce a doubled toolEvents list). The
        // LAST source in walk order is the canonical one — for a duplicate
        // it is the anchor the grouping most recently attached the event to,
        // while the earlier copy is the stale leftover.
        const sourcesByEventId = new Map();
        // Entries whose toolEvents may change (lose a duplicate/moved copy or
        // gain a routed-in event). Everything else skips the rebuild below —
        // this runs per stream chunk, so untouched rows must stay allocation
        // free.
        const changed = new Set();
        for (const entry of entries) {
            for (const event of entry.message.toolEvents) {
                if (!isLifecycleEvent(event))
                    continue;
                const existing = sourcesByEventId.get(event._id);
                if (existing) {
                    // Duplicate copy: at most one of the involved rows keeps it.
                    changed.add(existing.lastSource);
                    changed.add(entry);
                    existing.lastSource = entry;
                }
                else {
                    sourcesByEventId.set(event._id, { event, lastSource: entry });
                }
            }
        }
        if (sourcesByEventId.size === 0)
            return;
        const anchorsByKey = new Map();
        for (const entry of entries)
            anchorsByKey.set(entry.anchor.key, entry);
        // Routing targets: anchors with a defined start, in walk order (their
        // startTs are non-decreasing by construction of the timeline).
        const targets = entries.filter((entry) => entry.anchor.startTs !== undefined);
        const isOverlayEntry = (entry) => entry.message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX);
        const resolveTarget = (source, event) => {
            let stickyKey = state.sticky.get(event._id);
            if (stickyKey !== undefined) {
                const pinned = anchorsByKey.get(stickyKey);
                if (pinned) {
                    // A pin is only ever recorded while its anchor's stream start
                    // was <= the event's timestamp, and a persisted twin keeps
                    // (roughly) its overlay's start. So an OVERLAY occupying the
                    // pinned slot with a LATER start is a different, newer stream
                    // reusing the slot of an aborted segment — the pin is stale and
                    // must not capture the new run's row.
                    const pinnedStart = pinned.anchor.startTs;
                    const stale = isOverlayEntry(pinned) &&
                        pinnedStart !== undefined &&
                        pinnedStart > event.timestamp;
                    if (!stale)
                        return pinned;
                    state.sticky.delete(event._id);
                    stickyKey = undefined;
                }
                // The pinned anchor is not in this window (trimmed / the one-frame
                // overlay -> twin handoff gap / an aborted segment whose twin never
                // lands). Fall back to a per-frame computation but KEEP the pin —
                // the anchor may come back, and stomping it here is what let a
                // transient frame permanently re-home a painted card. If it never
                // comes back (abort), the per-frame fallback IS the release.
            }
            // Legacy assistants (no stream-start metadata) keep their events:
            // there is no way to place them chronologically, and moving them
            // would churn transcripts persisted before this rule existed.
            if (source.anchor.startTs === undefined) {
                if (stickyKey === undefined) {
                    state.sticky.set(event._id, source.anchor.key);
                }
                return source;
            }
            let resolved;
            for (const candidate of targets) {
                const startTs = candidate.anchor.startTs;
                if (startTs !== undefined && startTs <= event.timestamp) {
                    resolved = candidate;
                }
            }
            const target = resolved ?? source;
            // Pin overlay routings too: the overlay and its persisted twin share
            // one slot key, so the pin survives the handoff even when the twin's
            // worker-stamped stream start lands a few ms AFTER the event (clock
            // skew would otherwise exclude it from `targets` and yank the card
            // above the text), or when the overlay is cleared a frame before the
            // twin loads.
            if (stickyKey === undefined) {
                state.sticky.set(event._id, target.anchor.key);
            }
            return target;
        };
        const targetByEventId = new Map();
        for (const [eventId, { event, lastSource }] of sourcesByEventId) {
            targetByEventId.set(eventId, resolveTarget(lastSource, event));
        }
        // Incoming lifecycle events per anchor key (routed from elsewhere),
        // and the set of ids each target already carries (so a routed-in copy
        // is added at most once and prefers the copy already on the target).
        const incomingByKey = new Map();
        const placedIds = new Set();
        for (const [eventId, target] of targetByEventId) {
            if (target.message.toolEvents.some((event) => event._id === eventId && isLifecycleEvent(event))) {
                placedIds.add(eventId);
            }
        }
        for (const entry of entries) {
            for (const event of entry.message.toolEvents) {
                if (!isLifecycleEvent(event))
                    continue;
                const target = targetByEventId.get(event._id);
                if (!target || target === entry)
                    continue;
                changed.add(entry); // loses this copy
                if (placedIds.has(event._id))
                    continue;
                placedIds.add(event._id);
                changed.add(target); // gains the routed-in copy
                let incoming = incomingByKey.get(target.anchor.key);
                if (!incoming)
                    incomingByKey.set(target.anchor.key, (incoming = []));
                incoming.push(event);
            }
        }
        for (const entry of entries) {
            if (!changed.has(entry))
                continue;
            const incoming = incomingByKey.get(entry.anchor.key);
            // Keep events that stay on this anchor, dropping moved-away copies
            // and any duplicate occurrences beyond the first. Merge routed-in
            // lifecycle events by authoritative event chronology: appending an
            // older moved event after a newer kept start reverses follow-up cards.
            // A message whose events did not move keeps an identical id sequence.
            const seenHere = new Set();
            const kept = entry.message.toolEvents.filter((event) => {
                if (!isLifecycleEvent(event))
                    return true;
                if (targetByEventId.get(event._id) !== entry)
                    return false;
                if (seenHere.has(event._id))
                    return false;
                seenHere.add(event._id);
                return true;
            });
            const next = incoming ? [...kept, ...incoming].sort(compareEvents) : kept;
            if (sameToolEventIds(next, entry.message.toolEvents))
                continue;
            routedEventsByIndex.set(entry.anchor.messageIndex, next);
        }
    };
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.type === "user_message") {
            flushTurn();
            turn.push({
                anchor: {
                    key: `user:${message._id}`,
                    startTs: Number.NEGATIVE_INFINITY,
                    messageIndex: index,
                },
                message,
            });
            continue;
        }
        if (message.type !== "assistant_message")
            continue;
        // Hidden assistants never anchor cards (mirrors the grouping walk);
        // leave them and their (normally empty) toolEvents untouched.
        if (isUiHiddenChatMessagePayload(message.payload ?? null))
            continue;
        const userMessageId = getAssistantUserMessageId(message);
        let key;
        if (userMessageId !== undefined) {
            const indexInTurn = (assistantCountByUserMessageId.get(userMessageId) ?? 0) + 1;
            assistantCountByUserMessageId.set(userMessageId, indexInTurn);
            // Slot key shared by a streaming overlay and its persisted twin
            // (both occupy the same `(userMessageId, indexInTurn)` slot, only
            // one of which is present at a time) so sticky decisions survive
            // the overlay -> persisted handoff.
            key = `slot:${userMessageId}:${indexInTurn}`;
        }
        else {
            key = `id:${message._id}`;
        }
        turn.push({
            anchor: {
                key,
                startTs: getStreamStartedAtMs(message),
                messageIndex: index,
            },
            message,
        });
    }
    flushTurn();
    if (routedEventsByIndex.size === 0)
        return messages;
    const result = messages.slice();
    for (const [index, toolEvents] of routedEventsByIndex) {
        const base = messages[index];
        const cached = state.routedByBase.get(base);
        if (cached && sameToolEventIds(cached.toolEvents, toolEvents)) {
            result[index] = cached;
            continue;
        }
        const routed = { ...base, toolEvents };
        state.routedByBase.set(base, routed);
        result[index] = routed;
    }
    return result;
};
