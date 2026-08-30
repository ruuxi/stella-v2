"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

class SceneCancel extends Error {}

export type Scene = {
  /* Sleeps, then throws internally if the scene was cancelled while
     sleeping — scripts never run another step after cancellation. */
  sleep: (ms: number) => Promise<void>;
  /* Wait for the browser's next paint so visual updates land on real frames. */
  frame: () => Promise<number>;
  /* Type `text` through `onChar` at `ms` per character. */
  type: (text: string, onChar: (typed: string) => void, ms?: number) => Promise<void>;
};

/**
 * Runs `script` in a loop while `ref` is on screen, fully unwinding it the
 * moment the section scrolls away. The script receives scene helpers and is
 * expected to set component state as it goes; `reset` is called whenever the
 * loop stops so the section returns to its opening frame.
 *
 * Under `prefers-reduced-motion` the loop never starts and `reduced` is
 * true, so sections can render a settled final frame instead.
 */
export function useSceneLoop(
  ref: RefObject<HTMLElement | null>,
  script: (scene: Scene) => Promise<void>,
  reset: () => void,
  { threshold = 0.3, restartDelayMs = 900 }: { threshold?: number; restartDelayMs?: number } = {},
) {
  const [running, setRunning] = useState(false);
  const [reduced, setReduced] = useState(false);
  const scriptRef = useRef(script);
  const resetRef = useRef(reset);

  useEffect(() => {
    scriptRef.current = script;
    resetRef.current = reset;
  }, [script, reset]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const raf = requestAnimationFrame(() => setReduced(true));
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      ([entry]) => setRunning(entry.isIntersecting),
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const pendingTimers = new Map<number, () => void>();
    const pendingFrames = new Map<number, () => void>();

    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingTimers.delete(timer);
          if (cancelled) reject(new SceneCancel());
          else resolve();
        }, ms);
        pendingTimers.set(timer, () => reject(new SceneCancel()));
      });

    const frame = () =>
      new Promise<number>((resolve, reject) => {
        const id = window.requestAnimationFrame((time) => {
          pendingFrames.delete(id);
          if (cancelled) reject(new SceneCancel());
          else resolve(time);
        });
        pendingFrames.set(id, () => reject(new SceneCancel()));
      });

    const type = async (
      text: string,
      onChar: (typed: string) => void,
      ms = 26,
    ) => {
      const startedAt = performance.now();
      let visibleLength = 0;
      while (visibleLength < text.length) {
        const now = await frame();
        const nextLength = Math.min(
          text.length,
          Math.max(1, Math.floor((now - startedAt) / ms) + 1),
        );
        if (nextLength === visibleLength) continue;
        visibleLength = nextLength;
        onChar(text.slice(0, visibleLength));
      }
    };

    (async () => {
      await sleep(450);
      while (!cancelled) {
        await scriptRef.current({ sleep, frame, type });
        await sleep(restartDelayMs);
        resetRef.current();
        await sleep(700);
      }
    })().catch((error) => {
      if (!(error instanceof SceneCancel)) throw error;
    });

    return () => {
      cancelled = true;
      for (const [timer, cancel] of pendingTimers) {
        window.clearTimeout(timer);
        cancel();
      }
      pendingTimers.clear();
      for (const [frameId, cancel] of pendingFrames) {
        window.cancelAnimationFrame(frameId);
        cancel();
      }
      pendingFrames.clear();
      resetRef.current();
    };
  }, [running, restartDelayMs]);

  return { reduced };
}
