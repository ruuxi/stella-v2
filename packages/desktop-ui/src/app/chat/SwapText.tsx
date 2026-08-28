import { useEffect, useRef, useState } from "react";
import { useMinimumVisibleValue } from "@/shared/hooks/use-minimum-visible-value";
import { TextShimmer } from "./TextShimmer";

interface SwapTextProps {
  text: string;
  active?: boolean;

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
