"use client";

import { useEffect, useRef } from "react";
import { ease, lerp, seg, usePlayOnce } from "./motion";
import p from "./parallel-act.module.css";

const TASKS = [
  { ask: "Find me a cheaper phone plan", title: "Phone plans", kind: "bars", status: "Comparing 14 plans", hue: "#2e6bff", speed: 7, done: "Switched to Mint. Saves $22 a month." },
  { ask: "Expense report from these receipts", title: "Expenses", kind: "lines", status: "Reading 23 receipts", hue: "#0fbf6a", speed: 5 },
  { ask: "Haircut Thursday, after 5", title: "Haircut", kind: "grid", status: "Calling Ruby's", hue: "#ff6a2b", speed: 9, done: "Ruby's, Thursday 5:30." },
  { ask: "Watch for Wainwright tickets", title: "Tickets", kind: "radar", status: "Checking every 10 min", hue: "#ff4ac0", speed: 12 },
  { ask: "Turn my notes into a deck", title: "Deck", kind: "slides", status: "Slide 4 of 12", hue: "#703cff", speed: 6 },
  { ask: "Rename the Lisbon photos", title: "Photos", kind: "grid", status: "418 of 1,204", hue: "#00b8d9", speed: 4 },
  { ask: "Reply to the landlord", title: "Landlord", kind: "lines", status: "Drafting, firm but nice", hue: "#e8a400", speed: 8, done: "Sent. Kept it polite." },
  { ask: "Sell my old bike", title: "Bike", kind: "radar", status: "Listed on 3 sites", hue: "#e23c3c", speed: 10 },
  { ask: "Plan Mum's birthday", title: "Birthday", kind: "slides", status: "Asking your sister", hue: "#c04aff", speed: 11 },
  { ask: "Back up my laptop", title: "Backup", kind: "bars", status: "62 GB of 140 GB", hue: "#1d4fd8", speed: 6 },
];

const D = 2.9;
const START = 0.35;
const GAP = 0.15;

function Preview({ kind }: { kind: string }) {
  if (kind === "bars") {
    return (
      <span className={p.preview} data-kind="bars">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <i key={i} style={{ ["--i" as string]: i }} />
        ))}
      </span>
    );
  }
  if (kind === "lines") {
    return (
      <span className={p.preview} data-kind="lines">
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (kind === "grid") {
    return (
      <span className={p.preview} data-kind="grid">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <i key={i} style={{ ["--i" as string]: i }} />
        ))}
      </span>
    );
  }
  if (kind === "radar") {
    return (
      <span className={p.preview} data-kind="radar">
        <i />
        <i />
        <b />
      </span>
    );
  }
  return (
    <span className={p.preview} data-kind="slides">
      <i />
      <i />
      <i />
    </span>
  );
}

export function ParallelAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const bubbleRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const replyRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const offsets = useRef<{ dx: number; dy: number }[]>([]);
  const last = useRef({ count: -1 });
  const visible = useRef(6);

  useEffect(() => {
    const measure = () => {
      const chat = listRef.current?.parentElement;
      if (!chat) return;
      const chatRect = chat.getBoundingClientRect();
      const win = listRef.current?.parentElement;
      if (win) visible.current = Math.max(1, Math.round(win.clientHeight / 46));
      offsets.current = cardRefs.current.map((card) => {
        if (!card) return { dx: 0, dy: 0 };
        const prev = card.style.transform;
        card.style.transform = "none";
        const r = card.getBoundingClientRect();
        card.style.transform = prev;
        return {
          dx: chatRect.left + chatRect.width * 0.55 - (r.left + r.width / 2),
          dy: chatRect.bottom - 90 - (r.top + r.height / 2),
        };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sectionRef.current) ro.observe(sectionRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  usePlayOnce(bodyRef, 6200, (time) => {
    const u = START - 0.1 + time * (D - START + 0.1);

    let count = 0;
    let shown = 0;
    TASKS.forEach((task, i) => {
      const s = START + i * GAP;
      const b = bubbleRefs.current[i];
      const bubbleIn = seg(u, s - 0.06, s);
      if (bubbleIn > 0) shown += 1;
      if (b) {
        b.style.opacity = String(bubbleIn);
        b.style.transform = `translate3d(0, ${(1 - ease.out(bubbleIn)) * 16}px, 0)`;
      }
      const card = cardRefs.current[i];
      const o = offsets.current[i];
      if (!card || !o) return;
      const t = seg(u, s, s + 0.3);
      if (t > 0) count += 1;
      const e = ease.outBack(t);
      const k = 1 - e;
      card.style.opacity = String(seg(t, 0, 0.12));
      card.style.transform = `translate3d(${o.dx * k}px, ${o.dy * k}px, 0) scale(${lerp(0.25, 1, e)}) rotate(${k * (i % 2 ? 8 : -8)}deg)`;
      const done = task.done && u > 2.2 + (i % 3) * 0.12;
      card.dataset.done = done ? "1" : "0";
    });

    let replies = 0;
    TASKS.forEach((task, i) => {
      const r = replyRefs.current[i];
      if (!r || !task.done) return;
      const on = seg(u, 2.25 + (i % 3) * 0.12, 2.32 + (i % 3) * 0.12);
      if (on > 0) replies += 1;
      r.style.opacity = String(on);
      r.style.transform = `translate3d(0, ${(1 - on) * 16}px, 0)`;
      r.style.display = on > 0 ? "" : "none";
    });

    if (listRef.current) {
      const total = shown + replies;
      const overflow = Math.max(0, total - visible.current);
      listRef.current.style.transform = `translate3d(0, ${-overflow * 46}px, 0)`;
    }

    const running = count - replies;
    if (running !== last.current.count && countRef.current) {
      last.current.count = running;
      countRef.current.textContent = String(Math.max(0, running));
    }
  });

  const items: { kind: "ask" | "reply"; i: number }[] = [];
  TASKS.forEach((_, i) => items.push({ kind: "ask", i }));
  TASKS.forEach((t, i) => {
    if (t.done) items.push({ kind: "reply", i });
  });

  return (
    <section
      ref={sectionRef}
      className={p.act}
      data-tone="light"
      data-bg="#f1f1f4"
      aria-labelledby="parallel-title"
    >
      <div className={p.sticky}>
        <h2 id="parallel-title" className={p.title}>
          Ten things <span>at once.</span>
        </h2>
        <div ref={bodyRef} className={p.body} aria-hidden="true">
          <div className={p.chat}>
            <div className={p.chatTop}>
              <span className={p.dot} />
              <span>
                <span ref={countRef}>0</span> running
              </span>
            </div>
            <div className={p.window}>
              <div ref={listRef} className={p.list}>
                {items.map(({ kind, i }) =>
                  kind === "ask" ? (
                    <p
                      key={`a${i}`}
                      ref={(el) => {
                        bubbleRefs.current[i] = el;
                      }}
                      className={p.me}
                    >
                      {TASKS[i].ask}
                    </p>
                  ) : (
                    <p
                      key={`r${i}`}
                      ref={(el) => {
                        replyRefs.current[i] = el;
                      }}
                      className={p.her}
                      style={{ display: "none" }}
                    >
                      {TASKS[i].done}
                    </p>
                  ),
                )}
              </div>
            </div>
            <div className={p.composer}>
              Do anything
              <i />
            </div>
          </div>
          <div className={p.cards}>
            {TASKS.map((task, i) => (
              <div
                key={task.title}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                className={p.card}
                style={{
                  ["--hue" as string]: task.hue,
                  ["--speed" as string]: `${task.speed}s`,
                  ["--delay" as string]: `${-i * 0.7}s`,
                }}
              >
                <div className={p.cardTop}>
                  <span className={p.icon} />
                  <span className={p.state}>
                    <i />
                  </span>
                </div>
                <Preview kind={task.kind} />
                <b>{task.title}</b>
                <small>{task.status}</small>
                <span className={p.bar}>
                  <i />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
