/**
 * Presentational chat timeline.
 *
 * Renders the chat as a virtualized list using `@legendapp/list/react`
 * (Legend List v3 web entry). Both the home full chat and the sidebar
 * mount this same component — they only differ in the props they pass
 * (rows, listRef from their own scroll-management instance)
 * and the surface-level CSS that wraps the list.
 *
 * Virtualization rules of thumb that this surface honors:
 *  - `keyExtractor` → `row.id` (already stabilized by `useEventRows` via
 *    `stabilizeTurnRows`/`eventRowEqual`, so unchanged rows reuse their
 *    React identity).
 *  - `recycleItems` reuses item containers; `useStreamingChat`/
 *    `useEventRows` keep the streaming assistant row's id stable
 *    across the live → persisted handoff so Streamdown's parse cache
 *    and the row's component instance are reused (no remount, no
 *    flash).
 *  - `maintainVisibleContentPosition` replaces the prior column-reverse
 *    + manual `captureResizeAnchor`/`restoreResizeAnchor` dance.
 *  - Every row renders as its own virtualized item, so measurements
 *    survive a user-send turn boundary. The prior "tail synthetic item
 *    that wraps the latest user message + following assistant rows" was
 *    re-keyed on every send (its key tracked `tailRows[0].id`); the
 *    re-key tore down the wrapper, ejected a tall just-finished
 *    assistant reply into `olderRows` as a freshly-mounted virtualized
 *    item (initial size = `estimatedItemSize`), and dropped `scrollHeight`
 *    by the gap between the real assistant height and the estimate. The
 *    browser then clamped `scrollTop` up to the new max — visible as a
 *    jump back to the top of the previous assistant reply just before
 *    the post-send nudge animated back down. The fixed bottom-floor
 *    `min-height` lives on the `ListFooterComponent`; the collapsed queue is
 *    one keyed list item after every active assistant slot.
 *  - Older-history pagination is driven by the scroll hook's native input
 *    listener, not Legend's data-sensitive `onStartReached` callback.
 *
 * Empty / loading-history states render outside the list, matching the
 * previous flat-`.event-list` behavior (the list isn't useful when
 * there's nothing to virtualize and we want full-bleed empty state
 * styling).
 */
import { memo, startTransition, useCallback, useEffect, useMemo, useState, } from "react";
import { LegendList, } from "@legendapp/list/react";
import { AssistantMessageRow, UserMessageRow, } from "@/app/chat/MessageRow";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import { InlineWorkingIndicator, } from "./InlineWorkingIndicator";
import { buildChatTimelineItems, } from "@/features/chat/lib/chat-timeline-items";
import { LoaderCircle } from "@/ui/icons";
/* ------------------------------------------------------------------
 * Chat vertical-rhythm contract — the BETWEEN-rows half.
 *
 * These constants are THE definition of inter-row spacing for every
 * chat surface (full chat, sidebar, and orb all mount this
 * timeline). They render as virtualized separator heights below each
 * row. The WITHIN-row half (message -> cards -> action strip) is
 * `--chat-item-part-gap` in full-shell.chat.css.
 *
 * When judging perceived spacing remember each text-bearing assistant
 * row ends with the part gap plus the reserved hover-action strip before
 * the between-row separator.
 * ------------------------------------------------------------------ */
/** Turn boundary: spacing across a sender change (user <-> assistant). */
const ROW_GAP = 30;
/**
 * Spacing between two consecutive assistant rows (no user message or
 * other content between them) — tightened so a multi-message assistant
 * reply reads as one continuous block rather than separate turns.
 */
const ASSISTANT_RUN_GAP = 8;
/**
 * Spacing between two consecutive user rows — tightened (vs the full
 * inter-turn `ROW_GAP`) so a burst of back-to-back user messages reads as
 * one grouped sequence rather than a stack of separate turns, while still
 * staying looser than the continuous assistant run.
 */
const USER_RUN_GAP = 10;
/**
 * Spacing between two consecutive card/artifact-only assistant rows
 * (resource cards, source diffs, inline images, schedule receipts, …).
 * Matches the within-row part gap so a run of stacked cards reads as one
 * grouped list. (Card rows used to sit inside 12px+12px of invisible
 * assistant-bubble padding, which is why this could be 0 before; that
 * padding is gone, so the group gap is explicit now.)
 */
const CARD_RUN_GAP = 8;
/**
 * A "card row" is an assistant row whose body is purely an inline
 * artifact card with no message text — these are the rows we want to
 * stack flush when several land back to back.
 */
const isCardRow = (row) => row.kind === "assistant" &&
    row.text.trim().length === 0 &&
    Boolean(row.resourcePayload ||
        row.sourceDiffPayloads?.length ||
        row.inlineImagePayloads?.length ||
        row.officePreviewRef ||
        row.scheduleReceipt ||
        row.backgroundWork ||
        row.customSlot);
const gapAfterRow = (current, next) => {
    if (!next)
        return ROW_GAP;
    if (isCardRow(current) && isCardRow(next))
        return CARD_RUN_GAP;
    if (current.kind === "assistant" && next.kind === "assistant") {
        return ASSISTANT_RUN_GAP;
    }
    // A run of same-sender user bubbles groups tighter than a cross-sender
    // turn boundary; different-sender turns keep the full inter-turn gap.
    if (current.kind === "user" && next.kind === "user") {
        return USER_RUN_GAP;
    }
    return ROW_GAP;
};
/**
 * Keep the first list paint close to Legend's default, then use idle time to
 * mount a wider runway around the viewport before the user scrolls. Chat rows
 * are unusually expensive virtual items (Streamdown markdown, cards, images,
 * and variable-height measurement), so the library's 250px default can be
 * exhausted within one trackpad frame and briefly expose an unpainted recycled
 * container. Warming to roughly two viewports keeps that work ahead of direct
 * input without adding it to the conversation's initial render.
 */
export const CHAT_DRAW_DISTANCE_COLD_PX = 300;
export const CHAT_DRAW_DISTANCE_WARM_PX = 1_200;
const CHAT_DRAW_DISTANCE_FALLBACK_DELAY_MS = 240;
const useChatDrawDistance = (dataKey) => {
    const [warmedDataKey, setWarmedDataKey] = useState(null);
    useEffect(() => {
        if (!dataKey || warmedDataKey === dataKey)
            return;
        const scheduleIdle = window.requestIdleCallback ??
            ((callback) => window.setTimeout(() => callback({
                didTimeout: false,
                timeRemaining: () => 0,
            }), CHAT_DRAW_DISTANCE_FALLBACK_DELAY_MS));
        const cancelIdle = window.cancelIdleCallback ??
            ((handle) => window.clearTimeout(handle));
        const handle = scheduleIdle(() => {
            startTransition(() => setWarmedDataKey(dataKey));
        });
        return () => cancelIdle(handle);
    }, [dataKey, warmedDataKey]);
    return warmedDataKey === dataKey
        ? CHAT_DRAW_DISTANCE_WARM_PX
        : CHAT_DRAW_DISTANCE_COLD_PX;
};
const ItemSeparator = ({ leadingItem }) => (<div style={{ height: leadingItem.gapAfter }} aria-hidden="true"/>);
const renderRow = (row, conversationId, agentModelConfigByThread) => {
    if (row.kind === "user") {
        return <UserMessageRow key={row.id} row={row}/>;
    }
    return (<AssistantMessageRow key={row.id} row={row} conversationId={conversationId} agentModelConfigByThread={agentModelConfigByThread}/>);
};
const TimelineUserItem = ({ item, onCancelQueued, }) => {
    if (item.type === "queued-users") {
        return (<ComposerQueuedMessages messages={item.messages} onCancel={onCancelQueued}/>);
    }
    return item.row.kind === "user" ? <UserMessageRow row={item.row}/> : null;
};
export const ChatTimeline = memo(function ChatTimeline({ rows, conversationId, agentModelConfigByThread, hasOlderEvents, isLoadingOlder, isLoadingHistory, emptyState, extraTail, queuedUserMessages, onCancelQueued, indicator, listRef, recycleItems = true, alignItemsAtEnd = false, estimatedItemSize = 120, className, contentContainerStyle, }) {
    const listItems = useMemo(() => {
        const items = buildChatTimelineItems({
            rows,
            queuedUserMessages: queuedUserMessages ?? [],
            includeWorkingIndicator: Boolean(indicator),
        });
        return items.map((item, index) => {
            const next = items[index + 1];
            if (item.type === "message") {
                const nextRow = next?.type === "message" ? next.row : undefined;
                return { ...item, gapAfter: gapAfterRow(item.row, nextRow) };
            }
            if (item.type === "working-indicator") {
                return { ...item, gapAfter: next?.type === "queued-users" ? 20 : 0 };
            }
            return {
                ...item,
                gapAfter: next?.type === "queued-users" ? 6 : ROW_GAP,
            };
        });
    }, [indicator, queuedUserMessages, rows]);
    const renderItem = useCallback(({ item }) => {
        if (item.type === "working-indicator") {
            return indicator ? (<div className="event-list-working-indicator">
            <InlineWorkingIndicator {...indicator}/>
          </div>) : null;
        }
        if (item.type === "queued-users" || item.row.kind === "user") {
            return (<TimelineUserItem item={item} onCancelQueued={onCancelQueued}/>);
        }
        return renderRow(item.row, conversationId, agentModelConfigByThread);
    }, [agentModelConfigByThread, conversationId, indicator, onCancelQueued]);
    const keyExtractor = useCallback((item) => item.id, []);
    const hasQueuedTimelineItem = listItems.some((item) => item.type === "queued-users");
    const drawDistance = useChatDrawDistance(rows.length > 0 ? (conversationId ?? listItems[0]?.id ?? null) : null);
    /**
     * Header: only the older-loading status banner. Empty/loading-history
     * fallbacks render before the list, not as a header.
     */
    const ListHeader = useMemo(() => {
        if (!isLoadingOlder || !hasOlderEvents)
            return null;
        return (<div className="event-history-status" role="status" aria-live="polite">
        Loading earlier messages...
      </div>);
    }, [hasOlderEvents, isLoadingOlder]);
    /**
     * Footer: any surface-specific `extraTail` node and a bottom-floor
     * `min-height`. Working state and the collapsed queue are keyed list data
     * directly above this footer so a growing/new assistant slot cannot paint
     * below them. The min-height pre-allocates the empty reading
     * area below the just-sent user bubble (and below short streaming
     * replies) without reserving the full viewport. Living here — rather
     * than wrapping the latest user/assistant rows in a re-keyed synthetic
     * list item — means rows never migrate between virtualized contexts on
     * send, so their measured sizes don't collapse into `estimatedItemSize`
     * for a frame and `scrollHeight` doesn't dip back below the user's
     * current `scrollTop`.
     */
    const ListFooter = useMemo(() => (<div className={"event-list-trailing-region" +
            (hasQueuedTimelineItem
                ? " event-list-trailing-region--after-queue"
                : "")}>
        {extraTail && (<div className="event-list-extra-tail">{extraTail}</div>)}
      </div>), [extraTail, hasQueuedTimelineItem]);
    if (isLoadingHistory && rows.length === 0) {
        return (<div className="event-list-fallback" data-loading-history="true" role="status" aria-live="polite" aria-label="Loading conversation">
        <LoaderCircle className="stella-loader-circle" size={18} strokeWidth={2} aria-hidden="true"/>
      </div>);
    }
    if (rows.length === 0) {
        return (<div className="event-list-fallback" data-empty="true">
        {emptyState ?? <div className="event-empty">Start a conversation</div>}
      </div>);
    }
    return (<LegendList ref={listRef} data={listItems} keyExtractor={keyExtractor} renderItem={renderItem} estimatedItemSize={estimatedItemSize} drawDistance={drawDistance} recycleItems={recycleItems} alignItemsAtEnd={alignItemsAtEnd} maintainVisibleContentPosition initialScrollAtEnd
    // Scroll UI state is driven by useChatScrollManagement's passive native
    // listener. Legend's web `onScroll` adapter synchronously reads full
    // content geometry on every frame, forcing layout for no useful data.
    // Do not use Legend's `onStartReached`: it deliberately re-enters on a
    // data change while the threshold is visible, so each prepend can load
    // the next page without another user action. The same passive native
    // listener owns the intent-gated two-viewport threshold instead.
    ListHeaderComponent={ListHeader ?? undefined} ListFooterComponent={ListFooter} ItemSeparatorComponent={ItemSeparator} className={className} contentContainerStyle={contentContainerStyle} style={{ height: "100%", width: "100%" }}/>);
});
