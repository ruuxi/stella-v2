"use client";

import { useEffect } from "react";

type Stop = { top: number; rgb: [number, number, number] };

function parse(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function Backdrop() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-landing-root]");
    if (!root) return;
    let stops: Stop[] = [];
    let frame = 0;
    let last = "";

    const measure = () => {
      const y = window.scrollY;
      stops = Array.from(root.querySelectorAll<HTMLElement>("[data-bg]")).map((el) => ({
        top: el.getBoundingClientRect().top + y,
        rgb: parse(el.dataset.bg || "#ffffff"),
      }));
      update();
    };

    const update = () => {
      frame = 0;
      if (!stops.length) return;
      const vh = window.innerHeight;
      const y = window.scrollY;
      let rgb = stops[0].rgb;
      for (let i = 1; i < stops.length; i += 1) {
        const boundary = stops[i].top - y;
        const t = Math.min(1, Math.max(0, (vh * 0.72 - boundary) / (vh * 0.5)));
        if (t <= 0) break;
        if (t >= 1) {
          rgb = stops[i].rgb;
          continue;
        }
        const e = t * t * (3 - 2 * t);
        const a = stops[i - 1].rgb;
        const b = stops[i].rgb;
        rgb = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
        break;
      }
      const color = `rgb(${rgb.map((v) => Math.round(v)).join(",")})`;
      if (color !== last) {
        last = color;
        root.style.backgroundColor = color;
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return null;
}
