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

export type {
  InlineWorkingIndicatorMountProps,
  InlineWorkingIndicatorProps,
} from "@/features/chat/working-indicator-state";

const EXIT_ANIMATION_MS = 240;
const ENTER_ANIMATION_MS = 320;
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

  const [renderShell, setRenderShell] = useState(active);
  const [entering, setEntering] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const exitTimerRef = useRef<number | null>(null);
  const activatedAtRef = useRef<number | null>(active ? Date.now() : null);
  const wasActiveRef = useRef(active);
  const showingThinking = active && !runningTool;
  const wasShowingThinkingRef = useRef(showingThinking);
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
      const isReactivation = !wasActiveRef.current;
      if (isReactivation) {
        activatedAtRef.current = Date.now();
      }
      wasActiveRef.current = true;
      if (!renderShell) {
        setEntering(true);
      } else if (isReactivation) {
        setEntering(false);
      }
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

  const showInner = renderShell;

  useLayoutEffect(() => {
    if (!showInner) return;
    notifyChatContentGrowth();
  }, [showInner]);

  return (
    <div
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
