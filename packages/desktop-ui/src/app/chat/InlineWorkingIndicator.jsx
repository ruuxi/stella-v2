/**
 * Inline working indicator — the Claude-style "next-line" indicator.
 *
 * Mounted (persistently) as a keyed `ChatTimeline` item
 * (`.event-list-working-indicator`), so it reads as the line directly below
 * the streaming/last assistant message and above any queued user messages.
 *
 * Behavior:
 *  - While the assistant is reasoning (no answer text yet) it shows a
 *    rotating thinking label ("Thinking", "Mulling it over", …) seeded
 *    per turn; while a tool is running it shows that tool's friendly
 *    status. It ordinarily stays up until the assistant's first visible
 *    provider delta arrives (the streaming-text hand-off), then deactivates.
 *    After a tool result, its newest friendly receipt stays visible until the
 *    turn finishes, then exits immediately.
 *    through the `MIN_VISIBLE_MS` floor. Because deactivation always runs
 *    through that floor (no immediate-exit shortcut), on a fast (sub-2s)
 *    turn the indicator briefly lingers over the start of the streaming
 *    answer rather than vanishing the instant text appears.
 *  - Long-running agent task presence lives in the composer's task chip; this
 *    inline indicator only follows the orchestrator's thinking/tool lifecycle.
 *  - When the work finishes (`active` flips false) the indicator stays visible
 *    for at least `MIN_VISIBLE_MS`, then plays a short grow-out/fade for
 *    `EXIT_ANIMATION_MS` showing its last-known label. The parent mounts the
 *    indicator unconditionally and toggles `active` so React doesn't rip
 *    the node out before the exit animation runs. If `active` flips back
 *    true mid-exit, the exit is canceled and live updates resume.
 *  - Once fully exited, the inner content is removed (`--vacated`); the
 *    timeline wrapper's `:has(--vacated)` rule then collapses the slot so an
 *    idle chat carries no ghost gutter.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { getInlineWorkingIndicatorExitDelayMs, INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS, } from "@/features/chat/working-indicator-state";
import { WorkingIndicator } from "./WorkingIndicator";
import "./indicators.css";
/**
 * Exit timing. There's no hold beat anymore (the indicator used to linger
 * to show a "Done · task" state) — once work stops we want the indicator
 * gone promptly, with just a short grow-out so it doesn't snap away.
 */
const EXIT_ANIMATION_MS = 240;
const ENTER_ANIMATION_MS = 320;
const MIN_VISIBLE_MS = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS;
export function InlineWorkingIndicator({ active, exitImmediately, runningTool, runningToolId, status, minimumVisibleMs, }) {
    // Snapshot the live props the moment `active` flips false so the exit
    // animation displays a stable last-known label even though upstream
    // tool/status flags clear out.
    const liveProps = useMemo(() => ({ runningTool, runningToolId, status, minimumVisibleMs }), [runningTool, runningToolId, status, minimumVisibleMs]);
    const frozenPropsRef = useRef(liveProps);
    useEffect(() => {
        if (active) {
            frozenPropsRef.current = liveProps;
        }
    }, [active, liveProps]);
    const displayProps = active ? liveProps : frozenPropsRef.current;
    // Stay mounted until the exit animation finishes. If `active` flips back
    // to true mid-animation, cancel the exit and resume live updates.
    const [renderShell, setRenderShell] = useState(active);
    const [entering, setEntering] = useState(active);
    const [leaving, setLeaving] = useState(false);
    const exitTimerRef = useRef(null);
    const activatedAtRef = useRef(active ? Date.now() : null);
    const wasActiveRef = useRef(active);
    // Per-activation seed so the reasoning label ("Thinking" / "Mulling it
    // over" / …) varies across turns but stays stable within one.
    const [reasoningSeed, setReasoningSeed] = useState(() => String(Date.now()));
    // Keep the entrance class scoped to the actual idle -> visible transition.
    // If activity briefly drops and returns while the exit shell is still
    // mounted, removing `--leaving` must not replay the entrance animation.
    useEffect(() => {
        if (!entering)
            return;
        const timer = window.setTimeout(() => {
            setEntering(false);
        }, ENTER_ANIMATION_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [entering]);
    useEffect(() => {
        const clearTimer = () => {
            if (exitTimerRef.current !== null) {
                window.clearTimeout(exitTimerRef.current);
                exitTimerRef.current = null;
            }
        };
        if (active) {
            clearTimer();
            const isReactivation = !wasActiveRef.current;
            if (isReactivation) {
                activatedAtRef.current = Date.now();
                setReasoningSeed(String(Date.now()));
            }
            wasActiveRef.current = true;
            if (!renderShell) {
                setEntering(true);
            }
            else if (isReactivation) {
                setEntering(false);
            }
            setLeaving(false);
            setRenderShell(true);
            return;
        }
        wasActiveRef.current = false;
        setEntering(false);
        if (!renderShell)
            return;
        const startExit = () => {
            setLeaving(true);
            exitTimerRef.current = window.setTimeout(() => {
                exitTimerRef.current = null;
                setRenderShell(false);
                setLeaving(false);
            }, EXIT_ANIMATION_MS);
        };
        // A visible answer handoff or terminal run must not leave a stale row
        // behind — skip the minimum-visible hold and exit now.
        const remainingMs = exitImmediately
            ? 0
            : getInlineWorkingIndicatorExitDelayMs({
                activatedAtMs: activatedAtRef.current ?? Date.now(),
                nowMs: Date.now(),
                minVisibleMs: MIN_VISIBLE_MS,
            });
        if (remainingMs > 0) {
            exitTimerRef.current = window.setTimeout(startExit, remainingMs);
        }
        else {
            startExit();
        }
        return () => {
            clearTimer();
        };
    }, [active, renderShell, exitImmediately]);
    // The wrapper itself is always rendered with a fixed height once the
    // indicator has appeared — `renderShell` only gates the inner content,
    // so the gutter the indicator carved out below the assistant message
    // remains after the grow-out exit completes (no layout shift). A new
    // turn replaces the wrapper entirely (different React key in
    // `ChatTimeline`), at which point the new wrapper occupies the slot.
    const showInner = renderShell;
    // The indicator is its own timeline item below the assistant row, so it
    // extends the live tail without touching any subtree the keyed scroll-follow
    // watches — nothing would re-run targeting for it, and the row-only follow
    // would leave it parked under the viewport edge. Announce the growth the way
    // the inline cards do; the scroll surfaces decide whether to act on it.
    useLayoutEffect(() => {
        if (!showInner)
            return;
        notifyChatContentGrowth();
    }, [showInner]);
    return (<div className={`inline-working-indicator${entering ? " inline-working-indicator--entering" : ""}${leaving ? " inline-working-indicator--leaving" : ""}${showInner ? "" : " inline-working-indicator--vacated"}`} aria-live="polite">
      {showInner && (<WorkingIndicator className="inline-working-indicator__indicator" status={displayProps.status ?? undefined} toolName={displayProps.runningTool} toolCallId={displayProps.runningToolId} isReasoning={!displayProps.runningTool} reasoningSeed={reasoningSeed} minimumVisibleMs={displayProps.minimumVisibleMs} animationActive={active && !leaving}/>)}
    </div>);
}
