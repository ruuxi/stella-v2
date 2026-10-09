"use client";

import { useEffect, useRef } from "react";
import { createSpring, ease, lerp, seg, useScene, type Spring } from "./scroll-engine";
import c from "./computer-act.module.css";

const W = 1200;
const H = 750;
const D = 3.4;

type Key = { u: number; x: number; y: number };

const PATH: Key[] = [
  { u: 0.35, x: 1320, y: 470 },
  { u: 0.85, x: 430, y: 117 },
  { u: 1.3, x: 450, y: 125 },
  { u: 1.6, x: 706, y: 304 },
  { u: 1.75, x: 706, y: 304 },
  { u: 2.0, x: 352, y: 392 },
  { u: 2.12, x: 352, y: 392 },
  { u: 2.3, x: 460, y: 574 },
  { u: 2.42, x: 460, y: 574 },
  { u: 2.72, x: 1015, y: 446 },
  { u: 2.85, x: 1015, y: 446 },
  { u: 3.2, x: 1110, y: 640 },
];

const CLICKS = [0.9, 1.65, 2.06, 2.36, 2.8];
const QUERY = "flights to lisbon, may 14";

function pathAt(u: number) {
  if (u <= PATH[0].u) return PATH[0];
  for (let i = 1; i < PATH.length; i += 1) {
    const a = PATH[i - 1];
    const b = PATH[i];
    if (u <= b.u) {
      const t = ease.inOut((u - a.u) / (b.u - a.u));
      return { u, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    }
  }
  return PATH[PATH.length - 1];
}

function stageAt(u: number) {
  if (u < 1.3) return "search";
  if (u < 1.68) return "results";
  if (u < 2.08) return "seats";
  if (u < 2.38) return "confirm";
  if (u < 2.8) return "drag";
  return "done";
}

export function ComputerAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const queryRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const fit = useRef({ scale: 1, zoom: 1, vw: 0, vh: 0 });
  const springs = useRef<{ x: Spring; y: Spring } | null>(null);
  const live = useRef({ x: 1320, y: 470, stage: "", query: "", dragging: false, enter: 0 });

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const apply = () => {
      const f = fit.current;
      const l = live.current;
      const z = f.zoom;
      const s = f.scale * z;
      const camX = Math.min(Math.max(l.x, (f.vw / s) / 2), W - (f.vw / s) / 2);
      const camY = Math.min(Math.max(l.y, (f.vh / s) / 2), H - (f.vh / s) / 2);
      const cx = z > 1.01 ? camX : W / 2;
      const cy = z > 1.01 ? camY : H / 2;
      const rise = (1 - l.enter) * 80;
      if (canvasRef.current) {
        canvasRef.current.style.transform = `translate3d(${f.vw / 2 - cx * s}px, ${f.vh / 2 - cy * s + rise}px, 0) scale(${s})`;
      }
      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate3d(${l.x}px, ${l.y}px, 0) scale(${Math.min(2.4, 1 / s)})`;
      }
      if (chipRef.current && l.dragging) {
        chipRef.current.style.transform = `translate3d(${l.x - 460}px, ${l.y - 574}px, 0) rotate(-4deg) scale(1.04)`;
      }
    };
    const measure = () => {
      const rect = view.getBoundingClientRect();
      const f = fit.current;
      f.vw = rect.width;
      f.vh = rect.height;
      f.scale = Math.min(rect.width / W, rect.height / H);
      f.zoom = rect.width < 700 ? Math.min(2.6, rect.height / H / f.scale) : 1;
      apply();
    };
    const x = createSpring(1320, (v) => {
      live.current.x = v;
      apply();
    }, { stiffness: 140, damping: 19 });
    const y = createSpring(470, (v) => {
      live.current.y = v;
      apply();
    }, { stiffness: 140, damping: 19 });
    springs.current = { x, y };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    return () => {
      ro.disconnect();
      x.dispose();
      y.dispose();
    };
  }, []);

  useScene(sectionRef, ({ progress }) => {
    const u = progress * D;
    const l = live.current;
    const p = pathAt(u);
    springs.current?.x.set(p.x);
    springs.current?.y.set(p.y);

    l.enter = ease.out(seg(u, 0, 0.5));
    if (headRef.current) {
      headRef.current.style.transform = `translate3d(0, ${(1 - l.enter) * 60}px, 0)`;
      headRef.current.style.opacity = String(seg(u, 0, 0.35));
    }

    const stage = stageAt(u);
    if (stage !== l.stage && canvasRef.current) {
      l.stage = stage;
      canvasRef.current.dataset.stage = stage;
    }
    const n = Math.round(QUERY.length * seg(u, 0.95, 1.25));
    const q = QUERY.slice(0, n);
    if (q !== l.query && queryRef.current) {
      l.query = q;
      queryRef.current.textContent = q;
    }
    const dragging = u >= 2.36 && u < 2.8;
    if (dragging !== l.dragging && chipRef.current) {
      l.dragging = dragging;
      if (!dragging) chipRef.current.style.transform = "";
    }

    let ripple = 0;
    for (const click of CLICKS) {
      const d = u - click;
      if (d >= 0 && d < 0.12) ripple = d / 0.12;
    }
    if (rippleRef.current) {
      rippleRef.current.style.opacity = ripple > 0 ? String(1 - ripple) : "0";
      rippleRef.current.style.transform = `translate(-50%, -50%) scale(${0.3 + ripple * 1.4})`;
    }
    cursorRef.current?.setAttribute("data-press", ripple > 0 && ripple < 0.4 ? "1" : "0");
  });

  return (
    <section
      ref={sectionRef}
      className={c.act}
      style={{ height: `${(D + 1) * 100}svh` }}
      data-tone="light"
      data-bg="#ffffff"
      aria-labelledby="computer-title"
    >
      <div className={c.sticky}>
        <h2 ref={headRef} id="computer-title" className={c.title}>
          It uses your <span>computer.</span>
        </h2>
        <div ref={viewRef} className={c.view} aria-hidden="true">
          <div ref={canvasRef} className={c.canvas} data-stage="search">
            <div className={c.menubar}>
              <b>&#10035;</b>
              <span>Browser</span>
              <span>File</span>
              <span>Edit</span>
              <span>View</span>
              <em>Thu 9:41</em>
            </div>

            <div className={c.browser}>
              <div className={c.tabs}>
                <span className={c.lights}>
                  <i />
                  <i />
                  <i />
                </span>
                <span className={c.tab}>Skyway: cheap flights</span>
                <span className={c.tabGhost}>Inbox (3)</span>
              </div>
              <div className={c.urlbar}>
                <span className={c.navBtns}>&#8592; &#8594;</span>
                <span className={c.url}>
                  <span ref={queryRef} />
                  <i className={c.urlCaret} />
                </span>
              </div>
              <div className={c.page}>
                <div className={c.siteHead}>
                  <b>skyway</b>
                  <span>SFO &#8594; LIS</span>
                  <span>Thu, May 14</span>
                  <span>1 adult</span>
                </div>
                <div className={c.empty}>
                  <span className={c.globe} />
                </div>
                <div className={c.results}>
                  <div className={c.row} data-best="1">
                    <span className={c.air} style={{ background: "#e23c3c" }} />
                    <span className={c.times}>
                      <b>14:05 &#8594; 08:20</b>
                      <small>TAP · Nonstop · 10h 15m</small>
                    </span>
                    <span className={c.price}>$412</span>
                    <span className={c.select}>Select</span>
                  </div>
                  <div className={c.row}>
                    <span className={c.air} style={{ background: "#c8102e" }} />
                    <span className={c.times}>
                      <b>06:30 &#8594; 05:10</b>
                      <small>Iberia · 1 stop · 13h 40m</small>
                    </span>
                    <span className={c.price}>$467</span>
                    <span className={c.select}>Select</span>
                  </div>
                  <div className={c.row}>
                    <span className={c.air} style={{ background: "#1d4fd8" }} />
                    <span className={c.times}>
                      <b>09:10 &#8594; 11:55</b>
                      <small>United · 1 stop · 17h 45m</small>
                    </span>
                    <span className={c.price}>$538</span>
                    <span className={c.select}>Select</span>
                  </div>
                </div>
                <div className={c.seats}>
                  <p>Choose a seat</p>
                  <div className={c.seatGrid}>
                    {Array.from({ length: 36 }, (_, i) => {
                      const row = 12 + Math.floor(i / 6);
                      const col = i % 6;
                      const taken = [1, 4, 8, 9, 15, 20, 22, 27, 31, 34].includes(i);
                      return (
                        <span
                          key={i}
                          className={c.seat}
                          style={{ gridColumn: col < 3 ? col + 1 : col + 2 }}
                          data-taken={taken ? "1" : "0"}
                          data-pick={row === 14 && col === 0 ? "1" : "0"}
                        />
                      );
                    })}
                  </div>
                  <span className={c.confirm}>Confirm &amp; pay $412</span>
                </div>
                <div className={c.booked}>
                  <span className={c.tick} />
                  <b>You&apos;re going to Lisbon.</b>
                  <small>TAP 14:05 · Seat 14A · $412</small>
                </div>
              </div>
            </div>

            <div ref={chipRef} className={c.chip}>
              <b>TAP 14:05</b>
              <span>SFO &#8594; LIS · Seat 14A</span>
            </div>

            <div className={c.calendar}>
              <div className={c.calHead}>
                <span className={c.lights}>
                  <i />
                  <i />
                  <i />
                </span>
                <b>May</b>
              </div>
              <div className={c.week}>
                {["Mon 11", "Tue 12", "Wed 13", "Thu 14", "Fri 15"].map((d) => (
                  <span key={d} className={c.day}>
                    {d}
                  </span>
                ))}
                <span className={c.ev} style={{ gridColumn: 1, gridRow: "3 / span 2" }}>
                  Standup
                </span>
                <span className={c.ev} style={{ gridColumn: 2, gridRow: "6 / span 3" }} data-c="g">
                  Gym
                </span>
                <span className={c.ev} style={{ gridColumn: 3, gridRow: "2 / span 2" }} data-c="o">
                  Dentist
                </span>
                <span className={c.ev} style={{ gridColumn: 5, gridRow: "4 / span 2" }}>
                  Lunch w/ Jo
                </span>
                <span className={c.newEv}>
                  <b>Fly to Lisbon</b>
                  <small>14:05 · TAP · 14A</small>
                </span>
              </div>
            </div>

            <div className={c.toast}>
              <span className={c.toastMark} />
              <span>
                <b>Stella</b>
                Booked. Seat 14A, $412. It&apos;s in your calendar.
              </span>
            </div>

            <div ref={cursorRef} className={c.cursor}>
              <span ref={rippleRef} className={c.ripple} />
              <svg viewBox="0 0 28 32" width="28" height="32">
                <defs>
                  <linearGradient id="stella-cursor" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#00e5ff" />
                    <stop offset="0.45" stopColor="#5243ff" />
                    <stop offset="1" stopColor="#ff4ac0" />
                  </linearGradient>
                </defs>
                <path
                  d="M3 2 L3 25 L9.5 19.5 L14 29 L18.5 27 L14 17.8 L22.5 17.5 Z"
                  fill="url(#stella-cursor)"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
              <span className={c.cursorTag}>Stella</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
