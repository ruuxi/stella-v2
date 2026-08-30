"use client";

import { useLayoutEffect, useRef } from "react";

const FOLLOW_TIME_MS = 115;

/**
 * Keeps a mini-chat transcript top-aligned until it actually overflows, then
 * follows the newest turn with one continuous compositor-only movement.
 *
 * This deliberately moves an inner track instead of changing scrollTop. It
 * means layout changes that arrive close together (send, thinking, work rows)
 * update one target instead of starting a stack of independent smooth scrolls.
 */
export function useMiniChatScroll() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    let frame = 0;
    let lastTime = 0;
    let current = 0;
    let target = 0;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const paint = () => {
      track.style.transform = `translate3d(0, ${-current}px, 0)`;
    };

    const follow = (now: number) => {
      const elapsed = lastTime ? Math.min(34, now - lastTime) : 16;
      lastTime = now;
      const distance = target - current;

      if (Math.abs(distance) < 0.15) {
        current = target;
        paint();
        frame = 0;
        lastTime = 0;
        return;
      }

      // Time-based exponential following stays equally smooth at 60 and
      // 120Hz, and naturally retargets without a second scroll animation.
      current += distance * (1 - Math.exp(-elapsed / FOLLOW_TIME_MS));
      paint();
      frame = requestAnimationFrame(follow);
    };

    const measure = () => {
      const style = getComputedStyle(viewport);
      const bottomPadding = Number.parseFloat(style.paddingBottom) || 0;
      const available = Math.max(0, viewport.clientHeight - bottomPadding);
      const next = Math.max(0, track.scrollHeight - available);
      viewport.toggleAttribute("data-overflow", next > 0.5);

      // Empty/reset transcripts always return to the top immediately, ready
      // for the next first message. Reduced-motion frames settle immediately.
      if (track.childElementCount === 0 || reduced) {
        target = next;
        current = next;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastTime = 0;
        paint();
        return;
      }

      target = next;
      if (!frame && Math.abs(target - current) >= 0.15) {
        frame = requestAnimationFrame(follow);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return { viewportRef, trackRef };
}
