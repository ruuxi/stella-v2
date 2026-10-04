/**
 * A pausable cue timeline. Each cue flips once, at its time, and React only
 * re-renders on those flips (a dozen per chapter), never per frame: the
 * motion between them is springs on the UI thread.
 *
 * Pausing (card scrolled away, app backgrounded) remembers the elapsed time
 * and resumes from it. With `instant` every cue is reached at once, for
 * reduced motion.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cue } from "./chapters";

export function useChoreography({
  cues,
  playing,
  instant,
  onDone,
}: {
  cues: readonly Cue[];
  playing: boolean;
  instant: boolean;
  onDone: () => void;
}) {
  const [reached, setReached] = useState(instant ? cues.length - 1 : -1);
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!instant) return;
    setReached(cues.length - 1);
  }, [cues.length, instant]);

  useEffect(() => {
    if (!playing || instant || doneRef.current) return;
    const startedAt = Date.now() - elapsedRef.current;
    const timers: ReturnType<typeof setTimeout>[] = [];
    cues.forEach((cue, index) => {
      const delay = cue.at - elapsedRef.current;
      if (delay < 0) return;
      timers.push(
        setTimeout(() => {
          setReached((previous) => Math.max(previous, index));
          if (index === cues.length - 1) {
            doneRef.current = true;
            onDoneRef.current();
          }
        }, delay),
      );
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
      elapsedRef.current = Date.now() - startedAt;
    };
  }, [cues, instant, playing]);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    cues.forEach((cue, index) => map.set(cue.id, index));
    return map;
  }, [cues]);

  return useCallback(
    (id: string) => {
      const index = indexById.get(id);
      return index !== undefined && index <= reached;
    },
    [indexById, reached],
  );
}

export type Has = (cue: string) => boolean;
