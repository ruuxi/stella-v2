"use client";

import { useEffect } from "react";

export function Backdrop() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-landing-root]");
    if (!root) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-bg]"));
    if (!sections.length) return;
    const ratios = new Map<Element, number>();
    let current = "";

    const apply = (color: string) => {
      if (color === current) return;
      current = color;
      root.style.backgroundColor = color;
    };

    root.style.transition = "none";
    apply(sections[0].dataset.bg || "#ffffff");
    requestAnimationFrame(() => {
      root.style.transition = "background-color 900ms cubic-bezier(0.4, 0, 0.2, 1)";
    });

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(entry.target, entry.isIntersecting ? 1 : 0);
        const active = sections.find((s) => ratios.get(s));
        if (active) apply(active.dataset.bg || "#ffffff");
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  return null;
}
