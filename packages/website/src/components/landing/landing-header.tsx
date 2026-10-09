"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { SiteHeaderAccount } from "@/components/auth/site-header-account";
import { StellaMark } from "@/components/stella-mark";
import h from "./landing-header.module.css";

export function LandingHeader() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const header = ref.current;
    if (!header) return;
    let sections: HTMLElement[] = [];
    let frame = 0;

    const collect = () => {
      sections = Array.from(document.querySelectorAll<HTMLElement>("main [data-tone], footer[data-tone]"));
    };

    const update = () => {
      frame = 0;
      const probe = 32;
      let tone = "light";
      for (const section of sections) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) {
          tone = section.dataset.tone || "light";
          break;
        }
      }
      if (header.dataset.tone !== tone) header.dataset.tone = tone;
      header.dataset.scrolled = window.scrollY > 40 ? "1" : "0";
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    collect();
    update();
    const mo = new MutationObserver(onScroll);
    for (const section of sections) {
      mo.observe(section, { attributes: true, attributeFilter: ["data-tone"] });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", collect);
    return () => {
      mo.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", collect);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header ref={ref} className={h.header} data-tone="light">
      <Link href="/" className={h.brand} aria-label="Stella home">
        <span className={h.mark}>
          <StellaMark size={30} />
        </span>
        <span className={h.word}>Stella</span>
      </Link>
      <nav className={h.nav} aria-label="Primary">
        <Link href="/learn-more">Learn</Link>
        <Link href="/pricing">Pricing</Link>
        <span className={h.account}>
          <SiteHeaderAccount />
        </span>
        <a href="#get" className={h.get}>
          Get Stella
        </a>
      </nav>
    </header>
  );
}
