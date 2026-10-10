"use client";

import { useRef } from "react";
import { prefersReducedMotion, useLayerLive } from "./motion";
import { StellaCharacter } from "./stella-character";
import k from "./skin-kitchen.module.css";

const TIMERS = [
  { label: "Chicken", total: 360, start: 348, hue: "#d9653b" },
  { label: "Rice", total: 900, start: 682, hue: "#6f8f5e" },
];

const INGREDIENTS = [
  { t: "4 chicken thighs", done: true },
  { t: "2 lemons", done: true },
  { t: "6 cloves garlic", done: true },
  { t: "1½ cups rice", done: true },
  { t: "Thyme, a handful", done: false },
  { t: "Butter, 2 tbsp", done: false },
];

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function KitchenSkin() {
  const rootRef = useRef<HTMLDivElement>(null);
  const timeRefs = useRef<(HTMLElement | null)[]>([]);
  const ringRefs = useRef<(SVGCircleElement | null)[]>([]);

  useLayerLive(rootRef, (live) => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.play = live ? "1" : "0";
    if (!live) return;
    const reduce = prefersReducedMotion();
    const start = performance.now();
    let last = -1;
    const tick = (now: number) => {
      if (root.dataset.play !== "1") return;
      const elapsed = reduce ? 0 : (now - start) / 1000;
      const whole = Math.floor(elapsed);
      if (whole !== last) {
        last = whole;
        TIMERS.forEach((timer, i) => {
          const left = Math.max(0, timer.start - whole);
          const el = timeRefs.current[i];
          if (el) el.textContent = fmt(left);
          const ring = ringRefs.current[i];
          if (ring) ring.style.strokeDashoffset = String(1 - left / timer.total);
        });
      }
      if (!reduce) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return (
    <div ref={rootRef} className={k.kitchen} data-play="0">
      <div className={k.bar}>
        <span className={k.lights}>
          <i />
          <i />
          <i />
        </span>
        <span className={k.dish}>Lemon chicken &amp; rice · serves 4</span>
        <span className={k.steps}>
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} data-s={i < 3 ? "done" : i === 3 ? "on" : "todo"} />
          ))}
        </span>
        <span className={k.hands}>
          <i /> Hands-free
        </span>
      </div>
      <div className={k.main}>
        <section className={k.step}>
          <p className={k.stepNo}>Step 4 of 9</p>
          <p className={k.instruction}>
            Lay the chicken skin-side down. <em>Don&apos;t touch it</em> for six minutes.
          </p>
          <p className={k.next}>Next: flip, add lemon and garlic, baste with butter.</p>
        </section>
        <aside className={k.side}>
          <div className={k.timers}>
            {TIMERS.map((timer, i) => (
              <div key={timer.label} className={k.timer} style={{ ["--hue" as string]: timer.hue }}>
                <svg viewBox="0 0 44 44" aria-hidden="true">
                  <circle className={k.track} cx="22" cy="22" r="19" pathLength={1} />
                  <circle
                    ref={(el) => {
                      ringRefs.current[i] = el;
                    }}
                    className={k.ring}
                    cx="22"
                    cy="22"
                    r="19"
                    pathLength={1}
                    style={{ strokeDashoffset: 1 - timer.start / timer.total }}
                  />
                </svg>
                <span>
                  <b
                    ref={(el) => {
                      timeRefs.current[i] = el;
                    }}
                  >
                    {fmt(timer.start)}
                  </b>
                  <small>{timer.label}</small>
                </span>
              </div>
            ))}
          </div>
          <ul className={k.list}>
            {INGREDIENTS.map((item) => (
              <li key={item.t} data-done={item.done ? "1" : "0"}>
                <i />
                {item.t}
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <div className={k.voice}>
        <StellaCharacter size={30} state="listening" eyeColor="#fffaf2" />
        <span className={k.heard}>&ldquo;How long on the rice?&rdquo;</span>
        <span className={k.reply}>Eleven minutes. I&apos;ll call you when the chicken&apos;s ready to flip.</span>
      </div>
    </div>
  );
}
