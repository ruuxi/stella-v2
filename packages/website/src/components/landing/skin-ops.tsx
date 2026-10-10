"use client";

import { useRef } from "react";
import { prefersReducedMotion, useLayerLive } from "./motion";
import o from "./skin-ops.module.css";

const HEX = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

const GRID: [number, number][] = [];
for (let row = 0; row < 9; row += 1) {
  for (let col = 0; col < 7; col += 1) {
    GRID.push([col * 45 + (row % 2 ? 22.5 : 0), row * 39]);
  }
}

const NODES = [
  { id: "FILES-02", x: 70, y: 70, state: "ok" },
  { id: "TABLE-03", x: 236, y: 92, state: "run" },
  { id: "CAL-04", x: 62, y: 262, state: "ok" },
  { id: "MAIL-05", x: 228, y: 280, state: "wait" },
];

const TICKER =
  "[DIR0417]RightGauge=389139452456bg=bg|ROUTE=files.sort;lvl=3|LeftToyBox=48395127454|zone=Downloads;n=214;dst=9|[DIR0418]resv.query=party:4;t=FRI2000;r=1.2km|agent.spawn=TABLE-03|sync.cal=OK|[DIR0419]notify=SAM,PRIYA|STELLA-01 >> ALL SYSTEMS NOMINAL //";

const BARS = [
  { label: "MAIL", d: "1.3s" },
  { label: "CAL", d: "0.9s" },
  { label: "WEB", d: "1.7s" },
  { label: "FILES", d: "1.1s" },
  { label: "VOICE", d: "1.5s" },
];

export function OpsSkin() {
  const rootRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLElement>(null);
  const numRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useLayerLive(rootRef, (live) => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.play = live ? "1" : "0";
    if (!live) return;
    const reduce = prefersReducedMotion();
    const start = performance.now();
    let lastNum = 0;
    const tick = (now: number) => {
      if (root.dataset.play !== "1") return;
      const t = (now - start) / 1000;
      const remain = reduce ? 0 : Math.max(0, 4.27 - Math.max(0, t - 1.1) * 1.4);
      if (clockRef.current) clockRef.current.textContent = remain.toFixed(2).padStart(6, "0");
      if (now - lastNum > 70) {
        lastNum = now;
        numRefs.current.forEach((el, i) => {
          if (!el) return;
          const v = Math.floor(Math.random() * 99999999);
          el.textContent = `${i % 2 ? "-" : "+"} ${String(v).padStart(8, "0")}`;
        });
      }
      if (!reduce) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return (
    <div ref={rootRef} className={o.ops} data-play="0">
      <div className={o.console}>
        <header className={o.top}>
          <span className={o.tag}>
            <b>STELLA</b> // SYSTEM OPERATIONS
          </span>
          <span className={o.pattern}>
            PATTERN <b>ORANGE</b>
          </span>
          <span className={o.kanji}>指令</span>
          <div className={o.clock}>
            <small>TIME REMAINING TO COMPLETION</small>
            <span>
              <b ref={clockRef}>004.27</b>
              <em>sec</em>
            </span>
          </div>
        </header>

        <section className={o.net}>
          <span className={o.panelTag}>AGENT NETWORK // LIVE</span>
          <svg viewBox="0 0 300 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <g className={o.grid}>
              {GRID.map(([x, y], i) => (
                <polygon key={i} points={HEX(x, y, 26)} />
              ))}
            </g>
            {NODES.map((n) => (
              <line key={`l${n.id}`} className={o.link} x1="150" y1="172" x2={n.x} y2={n.y} />
            ))}
            {NODES.map((n) => (
              <line key={`p${n.id}`} className={o.pulse} x1="150" y1="172" x2={n.x} y2={n.y} />
            ))}
            <polygon className={o.core} points={HEX(150, 172, 44)} />
            <polygon className={o.coreRing} points={HEX(150, 172, 56)} />
            <text className={o.coreText} x="150" y="168">STELLA</text>
            <text className={o.coreSub} x="150" y="186">01 // MAIN</text>
            {NODES.map((n) => (
              <g key={n.id} className={o.node} data-state={n.state}>
                <polygon points={HEX(n.x, n.y, 22)} />
                <text x={n.x} y={n.y + 4}>{n.id}</text>
              </g>
            ))}
            <g className={o.tri}>
              <polygon points="150,96 162,116 138,116" />
              <polygon points="150,248 162,228 138,228" />
            </g>
          </svg>
          <span className={o.num} ref={(el) => { numRefs.current[0] = el; }}>+ 00312794</span>
          <span className={o.num} data-b="1" ref={(el) => { numRefs.current[1] = el; }}>- 00819652</span>
        </section>

        <section className={o.log}>
          <div className={o.directive}>
            <span className={o.tab}>DIRECTIVE 0417 // INPUT</span>
            <p>CLEAN UP MY DOWNLOADS FOLDER.</p>
          </div>
          <div className={o.result}>
            <span className={o.tab} data-c="ok">RESULT // COMPLETE</span>
            <p>
              <span>FILES SORTED</span>
              <b>214</b>
              <i style={{ ["--w" as string]: "92%" }} />
            </p>
            <p>
              <span>FOLDERS</span>
              <b>009</b>
              <i style={{ ["--w" as string]: "38%" }} />
            </p>
            <p>
              <span>RECLAIMED</span>
              <b>3.2 GB</b>
              <i style={{ ["--w" as string]: "71%" }} />
            </p>
          </div>
          <div className={o.directive}>
            <span className={o.tab}>DIRECTIVE 0418 // INPUT</span>
            <p>TABLE FOR FOUR. FRIDAY. 2000.</p>
          </div>
          <div className={o.exec}>
            <span className={o.execRun}>EXECUTING</span>
            <span className={o.execDone}>CONFIRMED // LUCIA 20:00 FRI</span>
          </div>
        </section>

        <section className={o.gauges}>
          <span className={o.panelTag}>SUBSYSTEM LOAD</span>
          <div className={o.bars}>
            {BARS.map((bar, i) => (
              <span key={bar.label} className={o.barCol} style={{ ["--d" as string]: bar.d, ["--i" as string]: i }}>
                <i />
                <small>{bar.label}</small>
                <em>0{i + 1}</em>
              </span>
            ))}
            <span className={o.redline} />
          </div>
          <svg className={o.contour} viewBox="0 0 200 120" preserveAspectRatio="none" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              <path
                key={i}
                d={`M0 ${12 + i * 12} C 50 ${12 + i * 12 - 18 + i * 2}, 70 ${30 + i * 9}, 100 ${60} S 160 ${110 - i * 11}, 200 ${10 + i * 12}`}
              />
            ))}
          </svg>
          <span className={o.num} data-c="1" ref={(el) => { numRefs.current[2] = el; }}>+ 00000894</span>
          <span className={o.num} data-c="1" data-b="1" ref={(el) => { numRefs.current[3] = el; }}>- 00000258</span>
        </section>

        <div className={o.warn}>
          <b>WARNING</b>
          <span>危険</span>
        </div>

        <footer className={o.ticker}>
          <span>
            {TICKER}
            {TICKER}
          </span>
        </footer>
        <div className={o.input}>
          INPUT&gt; <span>DO ANYTHING</span>
          <i />
        </div>
      </div>

      <div className={o.intro} aria-hidden="true">
        <div className={o.alert}>
          <span className={o.stripes} />
          <b>ALERT</b>
          <span className={o.stripes} data-b="1" />
          <span className={o.alertTag}>警告</span>
          <span className={o.alertTag} data-b="1">警告</span>
        </div>
        <div className={o.emergency}>
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i}>
              <i />
              EMERGENCY
            </span>
          ))}
        </div>
      </div>
      <div className={o.scan} />
    </div>
  );
}
