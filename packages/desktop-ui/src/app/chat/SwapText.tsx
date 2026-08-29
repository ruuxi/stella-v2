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
 *
 * Deciding *which* values are worth showing is not this component's job: it
 * animates whatever it is handed. Callers that need a legibility floor hold
 * their value through `useMinimumVisibleValue` first.
 */

import { useEffect, useRef, useState } from "react";
import { useMinimumVisibleValue } from "@/shared/hooks/use-minimum-visible-value";
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

export function SwapText({
  text,
  active = true,
  animateInitial = true,
  minimumVisibleMs = 0,
  className,
  shimmerGroup,
  shimmerPriority,
}: SwapTextProps) {
  const visibleText = useMinimumVisibleValue(text, minimumVisibleMs);
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
