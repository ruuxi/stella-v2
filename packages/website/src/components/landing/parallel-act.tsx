"use client";

import { useRef, useState } from "react";
import { usePlayOnce } from "./motion";
import { Composer, WindowBar } from "./skins";
import p from "./parallel-act.module.css";

const TASKS = [
  { ask: "Find me a cheaper phone plan", run: "Comparing phone plans", done: "Switched you to Mint. Saves $22 a month.", at: 5.4 },
  { ask: "Expense report from these receipts", run: "Reading 23 receipts", done: "Expense report is in Drive. $1,284.60 total.", at: 6.9 },
  { ask: "Haircut Thursday, after 5", run: "Booking a haircut", done: "Ruby's, Thursday at 5:30.", at: 4.9 },
  { ask: "Watch for Wainwright tickets", run: "Watching for tickets", done: null, at: 0 },
  { ask: "Turn my notes into a deck", run: "Building the deck", done: null, at: 0 },
  { ask: "Rename the Lisbon photos", run: "Renaming 1,204 photos", done: "Renamed 1,204 photos by place and day.", at: 6.2 },
  { ask: "Reply to the landlord", run: "Drafting a reply", done: "Sent. Firm, but polite.", at: 5.8 },
  { ask: "Sell my old bike", run: "Listing the bike", done: null, at: 0 },
  { ask: "Plan Mum's birthday", run: "Planning the birthday", done: "Booked Nopa for 8 on the 14th.", at: 7.4 },
  { ask: "Back up my laptop", run: "Backing up 140 GB", done: null, at: 0 },
];

const SPAWN0 = 0.35;
const SPAWN_GAP = 0.32;
const MENU_IN = 3.75;
const MENU_OUT = 6.6;
const TOTAL = 9;
const REPLIES = TASKS.map((task, i) => ({ ...task, i }))
  .filter((task) => task.done)
  .sort((a, b) => a.at - b.at)
  .map((task, rank) => ({ ...task, show: MENU_OUT + 0.15 + rank * 0.34 }));

export function ParallelAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const askRefs = useRef<(HTMLElement | null)[]>([]);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const replyRefs = useRef<(HTMLElement | null)[]>([]);
  const menuRowRefs = useRef<(HTMLElement | null)[]>([]);
  const [count, setCount] = useState(0);
  const last = useRef({ count: -1, menu: false });

  usePlayOnce(winRef, TOTAL * 1000, (u) => {
    const t = u * TOTAL;
    let running = 0;
    TASKS.forEach((task, i) => {
      const s = SPAWN0 + i * SPAWN_GAP;
      const ask = askRefs.current[i];
      const row = rowRefs.current[i];
      const reply = replyRefs.current[i];
      const menuRow = menuRowRefs.current[i];
      const askOn = t >= s;
      const rowOn = t >= s + 0.16;
      const done = task.done !== null && t >= task.at;
      if (ask) ask.dataset.on = askOn ? "1" : "0";
      if (row) {
        row.dataset.on = rowOn ? "1" : "0";
        row.dataset.done = done ? "1" : "0";
      }
      if (menuRow) menuRow.dataset.done = done ? "1" : "0";
      if (rowOn && !done) running += 1;
    });
    REPLIES.forEach((r) => {
      const el = replyRefs.current[r.i];
      if (el) el.dataset.on = t >= r.show ? "1" : "0";
    });
    const menu = t >= MENU_IN && t < MENU_OUT;
    if (menu !== last.current.menu && menuRef.current) {
      last.current.menu = menu;
      menuRef.current.dataset.on = menu ? "1" : "0";
    }
    if (running !== last.current.count) {
      last.current.count = running;
      setCount(running);
    }
  });

  const status = count > 0 ? `${count} ${count === 1 ? "task" : "tasks"} in progress` : null;

  return (
    <section ref={sectionRef} className={p.act} data-tone="light" data-bg="#f1f1f4" aria-labelledby="parallel-title">
      <div className={p.inner}>
        <h2 id="parallel-title" className={p.title}>
          Ten things <span>at once.</span>
        </h2>
        <div ref={winRef} className={p.stage} aria-hidden="true">
          <div className={p.window}>
            <WindowBar status={status ? <span className={p.shimmer} data-text={status}>{status}</span> : null} />
            <div className={p.column}>
              <div className={p.scroll}>
                <div className={p.list}>
                  {TASKS.map((task, i) => (
                    <div key={task.ask} className={p.pair}>
                      <p
                        ref={(el) => {
                          askRefs.current[i] = el;
                        }}
                        className={p.me}
                        data-on="0"
                      >
                        {task.ask}
                      </p>
                      <div
                        ref={(el) => {
                          rowRefs.current[i] = el;
                        }}
                        className={p.row}
                        data-on="0"
                        data-done="0"
                      >
                        <span className={p.glyph}>
                          <svg className={p.star} viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 2 C12.9 8.2 15.8 11.1 22 12 C15.8 12.9 12.9 15.8 12 22 C11.1 15.8 8.2 12.9 2 12 C8.2 11.1 11.1 8.2 12 2 Z" />
                          </svg>
                          <svg className={p.check} viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 12.5l4.5 4.5L19 7.5" />
                          </svg>
                        </span>
                        <span className={p.rowTitle}>
                          <span className={p.shimmer} data-text={task.run}>
                            {task.run}
                          </span>
                        </span>
                        <svg className={p.chev} viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </div>
                    </div>
                  ))}
                  {REPLIES.map((r) => (
                    <p
                      key={`r${r.i}`}
                      ref={(el) => {
                        replyRefs.current[r.i] = el;
                      }}
                      className={p.her}
                      data-on="0"
                    >
                      {r.done}
                    </p>
                  ))}
                </div>
              </div>
              <Composer />
            </div>
            <div ref={menuRef} className={p.menu} data-on="0">
              <p className={p.menuHead}>Activity</p>
              {TASKS.map((task, i) => (
                <div
                  key={task.run}
                  ref={(el) => {
                    menuRowRefs.current[i] = el;
                  }}
                  className={p.menuRow}
                  data-done="0"
                >
                  <span className={p.glyph}>
                    <svg className={p.star} viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 2 C12.9 8.2 15.8 11.1 22 12 C15.8 12.9 12.9 15.8 12 22 C11.1 15.8 8.2 12.9 2 12 C8.2 11.1 11.1 8.2 12 2 Z" />
                    </svg>
                    <svg className={p.check} viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                  <span className={p.rowTitle}>
                    <span className={p.shimmer} data-text={task.run}>
                      {task.run}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
