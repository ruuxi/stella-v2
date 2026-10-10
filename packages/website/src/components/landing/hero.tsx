"use client";

import { DownloadButton } from "@/components/download-button";
import { AuroraField } from "./aurora-field";
import { StellaSkin } from "./skins";
import h from "./hero.module.css";

export function Hero() {
  return (
    <section className={h.hero} data-tone="light" data-bg="#ffffff" aria-labelledby="hero-title">
      <div className={h.aurora}>
        <AuroraField className={h.auroraCanvas} />
      </div>
      <div className={h.content}>
        <h1 id="hero-title" className={h.title}>
          <span className={h.line}>Ask for</span>
          <span className={h.line}>anything.</span>
        </h1>
        <div className={h.cta}>
          <DownloadButton />
          <span className={h.free}>Free.</span>
        </div>
      </div>
      <div className={h.peek} aria-hidden="true">
        <div className={h.peekBox}>
          <StellaSkin />
        </div>
      </div>
    </section>
  );
}
