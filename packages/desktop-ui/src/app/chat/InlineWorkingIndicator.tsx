/**
 * Inline working indicator — the Claude-style "next-line" indicator.
 *
 * Mounted (persistently) as a keyed `ChatTimeline` item
 * (`.event-list-working-indicator`), so it reads as the line directly below
 * the streaming/last assistant message and above any queued user messages.
 *
 * Behavior:
 *  - While the assistant is reasoning it shows a
 *    rotating thinking label ("Thinking", "Mulling it over", …) seeded
 *    per turn; while a tool is running it shows that tool's friendly
 *    status. One submitted root turn owns the same visible instance from
 *    optimistic insertion until terminal completion, including provider and
 *    tool phase transitions.
 *  - Long-running agent task presence lives in the composer's task chip; this
 *    inline indicator only follows the orchestrator's thinking/tool lifecycle.
 *  - When the work finishes (`active` flips false) the indicator promptly
 *    plays a short grow-out/fade for `EXIT_ANIMATION_MS` showing its last-known
 *    label. The parent mounts the
 *    indicator unconditionally and toggles `active` so React doesn't rip
 *    the node out before the exit animation runs. If `active` flips back
 *    true mid-exit, the exit is canceled and live updates resume.
 *  - Once fully exited, the inner content is removed (`--vacated`); the
 *    timeline wrapper's `:has(--vacated)` rule then collapses the slot so an
 *    idle chat carries no ghost gutter.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getInlineWorkingIndicatorExitDelayMs,
  INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
  type InlineWorkingIndicatorMountProps,
  type InlineWorkingIndicatorProps,
} from "@/features/chat/working-indicator-state";
import { WorkingIndicator } from "./WorkingIndicator";
import "./indicators.css";

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
const MIN_VISIBLE_MS = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS;

export function InlineWorkingIndicator({
  active,
  exitImmediately,
  runningTool,
  runningToolId,
  status,
}: InlineWorkingIndicatorMountProps) {
  // Snapshot the live props the moment `active` flips false so the exit
  // animation displays a stable last-known label even though upstream
  // tool/status flags clear out.
  const liveProps = useMemo<InlineWorkingIndicatorProps>(
    () => ({ runningTool, runningToolId, status }),
    [runningTool, runningToolId, status],
  );
  const frozenPropsRef = useRef<InlineWorkingIndicatorProps>(liveProps);

  useEffect(() => {
    if (active) {
      frozenPropsRef.current = liveProps;
    }
  }, [active, liveProps]);

  const displayProps = active ? liveProps : frozenPropsRef.current;
  const rootPlaceholder = useMemo(() => document.createElement("div"), []);
  const rootRef = useRef(rootPlaceholder);

  // The timeline virtualizer can detach and reinsert the same cell while it
  // reconciles post-send geometry. A permanently assigned CSS animation
  // restarts on that DOM reattachment even though React identity is stable.
  // Tie the entrance to the logical false -> true activation instead.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!active || !element) return;
    if (document.hidden || !document.hasFocus()) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const animation = element.animate(
      [
        { opacity: 0, transform: "translateY(4px) scale(0.96)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: 320,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
    return () => animation.cancel();
  }, [active]);

  // Stay mounted until the exit animation finishes. If `active` flips back
  // to true mid-animation, cancel the exit and resume live updates.
  const [renderShell, setRenderShell] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const exitTimerRef = useRef<number | null>(null);
  const activatedAtRef = useRef<number | null>(active ? Date.now() : null);
  const wasActiveRef = useRef(active);
  // Per-activation seed so the reasoning label ("Thinking" / "Mulling it
  // over" / …) varies across turns but stays stable within one.
  const [reasoningSeed, setReasoningSeed] = useState(() => String(Date.now()));

  useEffect(() => {
    const clearTimer = () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };

    if (active) {
      clearTimer();
      if (!wasActiveRef.current) {
        activatedAtRef.current = Date.now();
        setReasoningSeed(String(Date.now()));
      }
      wasActiveRef.current = true;
      setLeaving(false);
      setRenderShell(true);
      return;
    }

    wasActiveRef.current = false;
    if (!renderShell) return;

    const startExit = () => {
      setLeaving(true);
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        setRenderShell(false);
        setLeaving(false);
      }, EXIT_ANIMATION_MS);
    };
    // When answer text has started streaming, the indicator must not trail
    // the growing message — skip the min-visible hold and exit now.
    const remainingMs = exitImmediately
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
  }, [active, renderShell, exitImmediately]);

  // The wrapper itself is always rendered with a fixed height once the
  // indicator has appeared — `renderShell` only gates the inner content,
  // so the gutter the indicator carved out below the assistant message
  // remains after the grow-out exit completes (no layout shift). The fixed
  // timeline key keeps this wrapper stable across lifecycle phases and turns.
  const showInner = active || renderShell;

  return (
    <div
      ref={rootRef}
      className={`inline-working-indicator${leaving ? " inline-working-indicator--leaving" : ""}${showInner ? "" : " inline-working-indicator--vacated"}`}
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
          animationActive={active && !leaving}
        />
      )}
    </div>
  );
}
