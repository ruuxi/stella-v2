/**
 * Inline working indicator — the Claude-style "next-line" indicator.
 *
 * Mounted (persistently) as a keyed `ChatTimeline` item
 * (`.event-list-working-indicator`), so it reads as the line directly below
 * the streaming/last assistant message and above any queued user messages.
 *
 * Behavior:
 *  - While the assistant is thinking it shows the mark alone; while a tool is
 *    running it shows that tool's friendly status. A run passes through both
 *    repeatedly — preamble, tool, answer — and the indicator stays up across
 *    the whole of it.
 *  - Long-running agent task presence lives in the composer's task chip; this
 *    inline indicator only follows the orchestrator's thinking/tool lifecycle.
 *  - There are three ways out, and which one runs is the caller's call:
 *    the ordinary grow-out after the `MIN_VISIBLE_MS` floor; an immediate
 *    exit (`exitImmediately`) when the run went terminal without answering,
 *    e.g. a cancel; and the handoff exit (`handoff`) when the run's final
 *    message landed, which keeps the row's height while it clears so the
 *    reply drops into the line the indicator was holding.
 *  - The parent mounts the indicator unconditionally and toggles `active` so
 *    React doesn't rip the node out before the exit animation runs. If
 *    `active` flips back true mid-exit, the exit is canceled and live updates
 *    resume.
 *  - Once fully exited, the inner content is removed (`--vacated`); the
 *    timeline wrapper's `:has(--vacated)` rule then collapses the slot so an
 *    idle chat carries no ghost gutter.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import {
  getInlineWorkingIndicatorExitDelayMs,
  INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
  type InlineWorkingIndicatorMountProps,
  type InlineWorkingIndicatorProps,
} from "@/features/chat/working-indicator-state";
import { WorkingIndicator } from "./WorkingIndicator";
import "./indicators.css";
import { useBubbleMorphSource } from "./BubbleMorph";

export type {
  InlineWorkingIndicatorMountProps,
  InlineWorkingIndicatorProps,
} from "@/features/chat/working-indicator-state";

/**
 * Exit timing. There's no hold beat anymore (the indicator used to linger
 * to show a "Done · task" state) — once work stops we want the indicator
 * gone promptly, with just a short grow-out so it doesn't snap away.
 */
const EXIT_ANIMATION_MS = 240;
const ENTER_ANIMATION_MS = 320;
const ENTER_DELAY_MS = 200;
const MIN_VISIBLE_MS = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS;

function newReasoningSeed(): string {
  return `${Date.now()}-${Math.random()}`;
}

export function InlineWorkingIndicator({
  active,
  exitImmediately,
  handoff,
  runningTool,
  runningToolId,
  status,
  minimumVisibleMs,
}: InlineWorkingIndicatorMountProps) {
  const morph = useBubbleMorphSource();
  const rootRef = useRef<HTMLDivElement>(null);
  const [consumed, setConsumed] = useState(false);
  useEffect(() => {
    if (!consumed || !active) return;
    const timer = window.setTimeout(() => setConsumed(false), 240);
    return () => window.clearTimeout(timer);
  }, [active, consumed]);

  // Snapshot the live props the moment `active` flips false so the exit
  // animation displays a stable last-known label even though upstream
  // tool/status flags clear out.
  const liveProps = useMemo<InlineWorkingIndicatorProps>(
    () => ({ runningTool, runningToolId, status, minimumVisibleMs }),
    [runningTool, runningToolId, status, minimumVisibleMs],
  );
  const frozenPropsRef = useRef<InlineWorkingIndicatorProps>(liveProps);

  useEffect(() => {
    if (active) {
      frozenPropsRef.current = liveProps;
    }
  }, [active, liveProps]);

  const displayProps = active ? liveProps : frozenPropsRef.current;

  // Stay mounted until the exit animation finishes. If `active` flips back
  // to true mid-animation, cancel the exit and resume live updates.
  const [renderShell, setRenderShell] = useState(false);
  useEffect(() => {
    if (!renderShell) setConsumed(false);
  }, [renderShell]);
  const [entering, setEntering] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const exitTimerRef = useRef<number | null>(null);
  const activatedAtRef = useRef<number | null>(null);
  const wasActiveRef = useRef(false);
  const showingThinking = active && !runningTool;
  const wasShowingThinkingRef = useRef(showingThinking);
  // Seeds the reasoning label ("Thinking" / "Mulling it over" / …). It rerolls
  // on every entry into thinking, not once per turn: a run returns to thinking
  // after each tool, and repeating the turn's first label there would read as
  // if nothing had moved.
  const [reasoningSeed, setReasoningSeed] = useState(newReasoningSeed);

  useEffect(() => {
    if (showingThinking && !wasShowingThinkingRef.current) {
      setReasoningSeed(newReasoningSeed());
    }
    wasShowingThinkingRef.current = showingThinking;
  }, [showingThinking]);

  useEffect(() => {
    if (!entering) return;
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
      if (!renderShell) {
        // Cancel this pending entrance if work ends before the delay elapses.
        exitTimerRef.current = window.setTimeout(() => {
          exitTimerRef.current = null;
          setEntering(true);
          setRenderShell(true);
        }, ENTER_DELAY_MS);
        return clearTimer;
      }
      const isReactivation = !wasActiveRef.current;
      if (isReactivation) {
        activatedAtRef.current = Date.now();
      }
      wasActiveRef.current = true;
      setLeaving(false);
      setRenderShell(true);
      return;
    }

    wasActiveRef.current = false;
    setEntering(false);
    if (!renderShell) return;

    const startExit = () => {
      setLeaving(true);
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        setRenderShell(false);
        setLeaving(false);
      }, EXIT_ANIMATION_MS);
    };
    // A text bubble normally consumes the indicator as it lands. Terminal
    // runs and replies without a text bubble still clear promptly here.
    const remainingMs =
      exitImmediately || handoff
        ? 0
        : getInlineWorkingIndicatorExitDelayMs({
            activatedAtMs: activatedAtRef.current ?? Date.now(),
            nowMs: Date.now(),
            minVisibleMs: MIN_VISIBLE_MS,
          });
    if (remainingMs > 0) {
      exitTimerRef.current = window.setTimeout(startExit, remainingMs);
    } else {
      startExit();
    }

    return () => {
      clearTimer();
    };
  }, [active, renderShell, exitImmediately, handoff]);

  // The wrapper itself is always rendered with a fixed height once the
  // indicator has appeared — `renderShell` only gates the inner content,
  // so the gutter the indicator carved out below the assistant message
  // remains after the grow-out exit completes (no layout shift). A new
  // turn replaces the wrapper entirely (different React key in
  // `ChatTimeline`), at which point the new wrapper occupies the slot.
  const showInner = renderShell && !consumed;

  useLayoutEffect(() => {
    const element = rootRef.current?.querySelector<HTMLElement>(".working-indicator");
    if (!morph || !element || !showInner) return;
    const source = { element, hide: () => setConsumed(true) };
    morph.source = source;
    return () => { if (morph.source === source) morph.source = null; };
  }, [morph, showInner]);

  // The indicator is its own timeline item below the assistant row, so it
  // extends the live tail without touching any subtree the keyed scroll-follow
  // watches — nothing would re-run targeting for it, and the row-only follow
  // would leave it parked under the viewport edge. Announce the growth the way
  // the inline cards do; the scroll surfaces decide whether to act on it.
  useLayoutEffect(() => {
    if (!showInner) return;
    notifyChatContentGrowth();
  }, [showInner]);

  return (
    <div
      ref={rootRef}
      className={`inline-working-indicator${entering ? " inline-working-indicator--entering" : ""}${leaving ? " inline-working-indicator--leaving" : ""}${leaving && handoff ? " inline-working-indicator--handoff" : ""}${showInner ? "" : " inline-working-indicator--vacated"}`}
      aria-live="polite"
    >
      {showInner && (
        <WorkingIndicator
          className="inline-working-indicator__indicator"
          status={displayProps.status ?? undefined}
          toolName={displayProps.runningTool}
          toolCallId={displayProps.runningToolId}
          isReasoning={!displayProps.runningTool}
          reasoningSeed={reasoningSeed}
          minimumVisibleMs={displayProps.minimumVisibleMs}
          animationActive={active && !leaving}
        />
      )}
    </div>
  );
}
