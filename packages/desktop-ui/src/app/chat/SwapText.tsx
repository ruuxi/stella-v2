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

type HeldPhrase = {
  text: string;
  minimumVisibleMs: number;
};

function useMinimumVisibleText(text: string, minimumVisibleMs: number): string {
  const [visibleText, setVisibleText] = useState(text);
  const visibleRef = useRef<HeldPhrase>({ text, minimumVisibleMs });
  const visibleSinceRef = useRef(Date.now());
  const queueRef = useRef<HeldPhrase[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const remainingMs = () =>
      Math.max(
        0,
        visibleRef.current.minimumVisibleMs -
          (Date.now() - visibleSinceRef.current),
      );
    const show = (phrase: HeldPhrase) => {
      visibleRef.current = phrase;
      visibleSinceRef.current = Date.now();
      setVisibleText(phrase.text);
    };
    const drainReady = () => {
      clearTimer();
      while (queueRef.current.length > 0 && remainingMs() === 0) {
        const next = queueRef.current.shift();
        if (!next) break;
        if (next.text !== visibleRef.current.text) {
          show(next);
        }
      }
      if (queueRef.current.length === 0) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        drainReady();
      }, remainingMs());
    };

    if (text === visibleRef.current.text) {
      const lastQueued = queueRef.current.at(-1);
      if (lastQueued?.text === text) {
        lastQueued.minimumVisibleMs = minimumVisibleMs;
      } else if (queueRef.current.length === 0) {
        visibleRef.current.minimumVisibleMs = minimumVisibleMs;
      }
      return;
    }

    const lastQueued = queueRef.current.at(-1);
    if (lastQueued?.text === text) {
      lastQueued.minimumVisibleMs = minimumVisibleMs;
    } else if (!queueRef.current.some((phrase) => phrase.text === text)) {
      queueRef.current.push({ text, minimumVisibleMs });
    }
    if (timerRef.current === null) {
      drainReady();
    }
  }, [minimumVisibleMs, text]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
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
