"use client";

import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Site-wide inertial scrolling (Lenis), mounted once from the root layout.
 *
 * - Drives Lenis from our own rAF loop (`autoRaf: false`) so there is exactly
 *   one ticker and it stops cleanly on unmount.
 * - Honors `prefers-reduced-motion`: Lenis is never constructed while the
 *   query matches, and is torn down if the user flips it on mid-session —
 *   native scrolling (and the `html { scroll-behavior }` rule) take over.
 * - Keeps anchors working: `anchors: true` routes same-page `#hash` clicks
 *   (e.g. the Learn More sidebar) through `lenis.scrollTo`; cross-page hash
 *   navigations and programmatic jumps stay native and Lenis simply syncs to
 *   the new position.
 * - Stays out of the desktop app's embedded WebContentsView, where the host
 *   window already owns scrolling feel.
 *
 * Scroll-driven work elsewhere (IntersectionObserver reveals, scene loops)
 * is unaffected: Lenis scrolls the real document, not a transformed wrapper.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (document.documentElement.dataset.embedded === "true") return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lenis: Lenis | null = null;
    let frame = 0;

    const start = () => {
      if (lenis) return;
      lenis = new Lenis({
        autoRaf: false,
        lerp: 0.1,
        wheelMultiplier: 1,
        touchMultiplier: 1,
        anchors: { offset: -8 },
        // Leave scrollable UI (code blocks, dialogs, inner panels) native.
        prevent: (node) =>
          node.hasAttribute("data-lenis-prevent") ||
          node.closest("[data-lenis-prevent]") !== null,
      });
      const loop = (time: number) => {
        lenis?.raf(time);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lenis?.destroy();
      lenis = null;
    };

    const sync = () => (reduceMotion.matches ? stop() : start());
    sync();
    reduceMotion.addEventListener("change", sync);

    return () => {
      reduceMotion.removeEventListener("change", sync);
      stop();
    };
  }, []);

  return null;
}
