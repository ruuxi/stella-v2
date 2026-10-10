"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";
import f from "./models-act.module.css";

const LEADS = [
  { name: "Claude Code", logo: "/landing/logos/claude-code.svg", tile: "claude", glow: "rgba(217, 119, 87, 0.55)" },
  { name: "ChatGPT", logo: "/landing/logos/chatgpt.svg", tile: "chatgpt", glow: "rgba(255, 255, 255, 0.35)" },
  { name: "Pi", logo: "/landing/logos/pi.svg", tile: "pi", glow: "rgba(240, 144, 130, 0.45)" },
];

const MORE = [
  { name: "Gemini", logo: "gemini" },
  { name: "DeepSeek", logo: "deepseek" },
  { name: "Qwen", logo: "qwen" },
  { name: "Mistral", logo: "mistral" },
  { name: "Grok", logo: "grok" },
  { name: "Kimi", logo: "kimi" },
  { name: "Llama", logo: "meta" },
  { name: "OpenRouter", logo: "openrouter" },
];

export function ModelsAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const on = entry?.isIntersecting ?? false;
        setRunning(on);
        if (on) el.dataset.in = "1";
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!running || prefersReducedMotion()) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % LEADS.length), active === 0 ? 2400 : 1800);
    return () => window.clearTimeout(id);
  }, [running, active]);

  return (
    <section ref={sectionRef} className={f.act} data-tone="dark" data-bg="#000000" aria-labelledby="models-title">
      <h2 id="models-title" className={f.title}>
        Any <span>model.</span>
      </h2>
      <ul className={f.leads}>
        {LEADS.map((lead, i) => (
          <li
            key={lead.name}
            className={f.lead}
            data-on={i === active ? "1" : "0"}
            style={{ ["--i" as string]: i, ["--glow" as string]: lead.glow }}
          >
            <span className={f.tile} data-tile={lead.tile}>
              <img src={lead.logo} alt="" width={160} height={160} />
            </span>
            <b>{lead.name}</b>
          </li>
        ))}
      </ul>
      <ul className={f.more} aria-label="And other models">
        {MORE.map((m, i) => (
          <li key={m.name} style={{ ["--i" as string]: i }}>
            <span
              className={f.mono}
              style={{ ["--logo" as string]: `url(/landing/logos/${m.logo}.svg)` }}
              aria-hidden="true"
            />
            {m.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
