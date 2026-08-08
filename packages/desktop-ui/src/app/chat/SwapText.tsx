/**
 * SwapText: crossfades + slides between text values when `text` changes.
 *
 * Used by the working indicator so that transitions like
 *   Working · X → Updating · X → Working · X
 * and multi-agent rotation row swaps animate instead of snapping.
 *
 * Width changes are not explicitly animated; the grid stack keeps both
 * layers in the same cell during the transition (cell sizes to the
 * larger of the two), then snaps to the new content's natural width
 * once the outgoing layer is unmounted. In the sticky footer the
 * surrounding flex container absorbs that final size change without
 * shifting layout.
 */

import { useEffect, useRef, useState } from "react";
import { TextShimmer } from "./TextShimmer";

interface SwapTextProps {
  text: string;
  active?: boolean;
  /** Let a parent-owned entrance animation reveal the initial text as part of
   * one atomic surface, while preserving animated swaps after it changes. */
  animateInitial?: boolean;
  minimumVisibleMs?: number;
  className?: string;
  shimmerGroup?: string;
  shimmerPriority?: number;
}

const SWAP_DURATION_MS = 240;

function useMinimumVisibleText(text: string, minimumVisibleMs: number): string {
  const [visibleText, setVisibleText] = useState(text);
  const visibleTextRef = useRef(text);
  const visibleSinceRef = useRef(Date.now());
  const pendingTextRef = useRef(text);
  const holdTimerRef = useRef<number | null>(null);
  useEffect(() => {
    pendingTextRef.current = text;
    const clearTimer = () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
    const showText = (nextText: string) => {
      if (nextText === visibleTextRef.current) return;
      visibleTextRef.current = nextText;
      visibleSinceRef.current = Date.now();
      setVisibleText(nextText);
    };
    if (text === visibleTextRef.current) {
      clearTimer();
      return;
    }
    const remainingMs = Math.max(
      0,
      minimumVisibleMs - (Date.now() - visibleSinceRef.current),
    );
    if (remainingMs === 0) {
      clearTimer();
      showText(text);
      return;
    }
    if (holdTimerRef.current === null) {
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        showText(pendingTextRef.current);
      }, remainingMs);
    }
  }, [minimumVisibleMs, text]);
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
      }
    },
    [],
  );
  return visibleText;
}

export function SwapText({
  text,
  active = true,
  animateInitial = true,
  minimumVisibleMs = 0,
  className,
  shimmerGroup,
  shimmerPriority,
}: SwapTextProps) {
  const visibleText = useMinimumVisibleText(text, minimumVisibleMs);
  const [current, setCurrent] = useState(visibleText);
  const [previous, setPrevious] = useState<string | null>(null);
  const [hasChanged, setHasChanged] = useState(false);
  const lastTextRef = useRef(visibleText);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (visibleText === lastTextRef.current) {
      return;
    }
    setPrevious(lastTextRef.current);
    setCurrent(visibleText);
    setHasChanged(true);
    lastTextRef.current = visibleText;

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [visibleText]);

  return (
    <span className={`swap-text ${className ?? ""}`}>
      {previous !== null && (
        <span
          key={`out:${previous}`}
          className="swap-text__layer swap-text__layer--out"
          aria-hidden="true"
        >
          {previous}
        </span>
      )}
      <span
        key={`in:${current}`}
        className={`swap-text__layer swap-text__layer--in${!animateInitial && !hasChanged ? " swap-text__layer--initial-static" : ""}`}
      >
        <TextShimmer
          text={current}
          active={active}
          exclusiveGroup={shimmerGroup}
          exclusivePriority={shimmerPriority}
        />
      </span>
    </span>
  );
}
