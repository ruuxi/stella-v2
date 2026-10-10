"use client";

import { useRef } from "react";
import { prefersReducedMotion, useLayerLive } from "./motion";
import { StellaCharacter } from "./stella-character";
import t from "./skin-trader.module.css";

const W = 600;
const H = 260;
const LIMIT = 118;
const LO = 114;
const HI = 126;

function series() {
  const pts: number[] = [];
  let v = 123.4;
  let seed = 11;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 120; i += 1) {
    const drift = i < 70 ? -0.085 : i < 82 ? -0.02 : 0.07;
    v += drift + (r() - 0.5) * 0.55;
    if (i === 76) v = 117.9;
    pts.push(v);
  }
  return pts;
}

const SERIES = series();
const yOf = (v: number) => H - ((v - LO) / (HI - LO)) * H;
const PATH = SERIES.map((v, i) => `${i ? "L" : "M"}${((i / (SERIES.length - 1)) * W).toFixed(1)} ${yOf(v).toFixed(1)}`).join(" ");
const FILL_X = (76 / (SERIES.length - 1)) * W;

const WATCH = [
  { s: "AAPL", p: "228.14", c: "+0.8%", up: true, d: "M0 14 L10 12 L20 13 L30 9 L40 10 L50 6 L60 7" },
  { s: "MSFT", p: "431.02", c: "+1.2%", up: true, d: "M0 13 L10 13 L20 10 L30 11 L40 7 L50 8 L60 4" },
  { s: "TSLA", p: "203.55", c: "-2.6%", up: false, d: "M0 4 L10 6 L20 5 L30 9 L40 8 L50 12 L60 13" },
  { s: "AMZN", p: "187.40", c: "+0.3%", up: true, d: "M0 10 L10 11 L20 9 L30 10 L40 8 L50 9 L60 8" },
  { s: "SPY", p: "561.87", c: "+0.4%", up: true, d: "M0 12 L10 11 L20 11 L30 9 L40 9 L50 7 L60 7" },
];

const TAPE = "NVDA 118.24 ▼1.4%   AAPL 228.14 ▲0.8%   MSFT 431.02 ▲1.2%   TSLA 203.55 ▼2.6%   AMZN 187.40 ▲0.3%   META 512.66 ▲0.9%   SPY 561.87 ▲0.4%   QQQ 482.10 ▲0.6%   ";

export function TraderSkin() {
  const rootRef = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);

  useLayerLive(rootRef, (live) => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.play = live ? "1" : "0";
    if (!live) return;
    const reduce = prefersReducedMotion();
    const start = performance.now() + 450;
    const tick = (now: number) => {
      if (root.dataset.play !== "1") return;
      const p = reduce ? 1 : Math.max(0, Math.min(1, (now - start) / 2200));
      const idx = Math.round(p * (SERIES.length - 1));
      const v = SERIES[idx];
      if (priceRef.current) priceRef.current.textContent = v.toFixed(2);
      if (dotRef.current) {
        dotRef.current.style.left = `${((idx / (SERIES.length - 1)) * 100).toFixed(2)}%`;
        dotRef.current.style.top = `${((yOf(v) / H) * 100).toFixed(2)}%`;
      }
      root.style.setProperty("--draw", p.toFixed(4));
      root.dataset.filled = idx >= 76 ? "1" : "0";
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return (
    <div ref={rootRef} className={t.trader} data-play="0" data-filled="0">
      <div className={t.bar}>
        <span className={t.lights}>
          <i />
          <i />
          <i />
        </span>
        <span className={t.desk}>
          <StellaCharacter size={18} eyeColor="#0b0f14" />
          Desk
        </span>
        <span className={t.market}>
          <i /> NYSE open · 10:42
        </span>
        <span className={t.balance}>
          <small>Today</small> <b>+$2,418.60</b>
        </span>
      </div>
      <div className={t.tape}>
        <span>
          {TAPE}
          {TAPE}
        </span>
      </div>
      <div className={t.main}>
        <section className={t.chart}>
          <header className={t.quote}>
            <b>NVDA</b>
            <span className={t.price} ref={priceRef}>123.40</span>
            <span className={t.change}>▼ 1.4%</span>
            <span className={t.ranges}>
              <i data-on="1">1D</i>
              <i>5D</i>
              <i>1M</i>
              <i>1Y</i>
            </span>
          </header>
          <div className={t.plot}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="trader-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#3fb950" stopOpacity="0.28" />
                  <stop offset="1" stopColor="#3fb950" stopOpacity="0" />
                </linearGradient>
                <clipPath id="trader-clip">
                  <rect className={t.clipRect} x="0" y="0" width={W} height={H} />
                </clipPath>
              </defs>
              {[0.2, 0.4, 0.6, 0.8].map((g) => (
                <line key={g} className={t.grid} x1="0" x2={W} y1={H * g} y2={H * g} />
              ))}
              <g clipPath="url(#trader-clip)">
                <path className={t.area} d={`${PATH} L${W} ${H} L0 ${H} Z`} />
                <path className={t.line} d={PATH} />
              </g>
              <line className={t.limit} x1="0" x2={W} y1={yOf(LIMIT)} y2={yOf(LIMIT)} />
              <line className={t.earn} x1={W * 0.88} x2={W * 0.88} y1="0" y2={H} />
            </svg>
            <span className={t.fillDot} style={{ left: `${(FILL_X / W) * 100}%`, top: `${(yOf(117.9) / H) * 100}%` }} />
            <span ref={dotRef} className={t.dot} style={{ left: "0%", top: `${(yOf(123.4) / H) * 100}%` }} />
            <span className={t.limitTag} style={{ top: `${(yOf(LIMIT) / H) * 100}%` }}>
              Buy limit 118.00 · 20 sh
            </span>
            <span className={t.earnTag}>Earnings Thu</span>
            <span className={t.axis}>
              <i>126</i>
              <i>123</i>
              <i>120</i>
              <i>117</i>
            </span>
            <div className={t.callout} style={{ left: `${(FILL_X / W) * 100}%`, top: `${(yOf(117.9) / H) * 100}%` }}>
              <StellaCharacter size={16} eyeColor="#161b22" />
              <span>
                <b>Filled 20 at 118.00</b>
              </span>
            </div>
          </div>
        </section>
        <aside className={t.side}>
          <p className={t.sideHead}>Watchlist</p>
          {WATCH.map((w) => (
            <div key={w.s} className={t.row}>
              <b>{w.s}</b>
              <span>{w.p}</span>
              <em data-up={w.up ? "1" : "0"}>{w.c}</em>
            </div>
          ))}
          <p className={t.sideHead}>Watching</p>
          <p className={t.watch}>
            <i /> TSLA under 200
          </p>
          <p className={t.watch}>
            <i /> Trim AAPL into earnings
          </p>
          <p className={t.watch} data-done="1">
            <i /> NVDA under 118
          </p>
        </aside>
        <aside className={t.chat}>
          <p className={t.chatHead}>
            <StellaCharacter size={18} eyeColor="#0f141a" state="working" />
            Stella
          </p>
          <div className={t.thread}>
            <p className={t.stamp}>Today 9:31 AM</p>
            <p className={t.me}>Morning. Anything I should know?</p>
            <p className={t.her}>CPI came in soft and futures are up 0.6%. TSLA is near your 200 alert.</p>
            <p className={t.me}>What&apos;s moving NVDA?</p>
            <p className={t.her}>Down 1.4% on a supplier note. Nothing changed for earnings Thursday.</p>
            <p className={t.me}>Buy 20 if it dips under 118, stop at 112</p>
            <p className={t.her}>Limit set. I&apos;ll watch it.</p>
            <p className={t.her} data-fill="1">
              Filled 20 at 118.00. Stop is in at 112, and I&apos;ll check in before earnings.
            </p>
          </div>
          <div className={t.prompt}>
            <span>Do anything</span>
            <b>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </b>
          </div>
        </aside>
      </div>
    </div>
  );
}
