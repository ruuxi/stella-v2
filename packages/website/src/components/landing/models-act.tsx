"use client";

import { useEffect, useRef } from "react";
import f from "./models-act.module.css";

const MODELS = [
  "CLAUDE CODE",
  "CODEX",
  "CHATGPT",
  "GEMINI",
  "PI",
  "CLAUDE",
  "OPENROUTER",
  "DEEPSEEK",
  "KIMI",
  "GROK",
  "QWEN",
  "MISTRAL",
  "LLAMA",
  "GLM",
];

const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
const NAME_LEN = 11;
const STATUS_LEN = 6;
const ROWS = 6;

type Cell = {
  el: HTMLElement;
  top: HTMLElement;
  bottom: HTMLElement;
  flapTop: HTMLElement;
  flapBottom: HTMLElement;
  current: string;
  target: string;
  timer: number;
};

function pad(text: string, len: number) {
  return text.padEnd(len, " ").slice(0, len);
}

function buildCell(): Cell {
  const el = document.createElement("span");
  el.className = f.cell;
  const make = (cls: string) => {
    const part = document.createElement("span");
    part.className = cls;
    const glyph = document.createElement("b");
    part.appendChild(glyph);
    el.appendChild(part);
    return part;
  };
  const top = make(f.top);
  const bottom = make(f.bottom);
  const flapTop = make(f.flapTop);
  const flapBottom = make(f.flapBottom);
  return { el, top, bottom, flapTop, flapBottom, current: " ", target: " ", timer: 0 };
}

function setGlyph(part: HTMLElement, ch: string) {
  const b = part.firstChild as HTMLElement;
  if (b.textContent !== ch) b.textContent = ch;
}

function step(cell: Cell, delay: number, reduce: boolean) {
  window.clearTimeout(cell.timer);
  if (cell.current === cell.target) return;
  let flips = reduce ? 0 : 2 + Math.floor(Math.random() * 4);
  const advance = () => {
    const next =
      flips > 0 ? CHARS[1 + Math.floor(Math.random() * (CHARS.length - 1))] : cell.target;
    flips -= 1;
    setGlyph(cell.top, next);
    setGlyph(cell.bottom, cell.current);
    setGlyph(cell.flapTop, cell.current);
    setGlyph(cell.flapBottom, next);
    const a = cell.el.classList.contains(f.flipA);
    cell.el.classList.toggle(f.flipA, !a);
    cell.el.classList.toggle(f.flipB, a);
    cell.current = next;
    window.setTimeout(() => setGlyph(cell.bottom, next), 110);
    if (cell.current !== cell.target || flips >= 0) {
      if (flips < 0 && cell.current === cell.target) return;
      cell.timer = window.setTimeout(advance, 75);
    }
  };
  cell.timer = window.setTimeout(advance, delay);
}

export function ModelsAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rows: { name: Cell[]; status: Cell[]; light: HTMLElement }[] = [];
    board.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
      const nameHost = row.querySelector<HTMLElement>("[data-name]");
      const statusHost = row.querySelector<HTMLElement>("[data-status]");
      const light = row.querySelector<HTMLElement>("[data-light]");
      if (!nameHost || !statusHost || !light) return;
      const name = Array.from({ length: NAME_LEN }, () => {
        const c = buildCell();
        nameHost.appendChild(c.el);
        return c;
      });
      const status = Array.from({ length: STATUS_LEN }, () => {
        const c = buildCell();
        statusHost.appendChild(c.el);
        return c;
      });
      rows.push({ name, status, light });
    });

    let offset = 0;
    let interval = 0;
    let visible = false;

    const show = (first: boolean) => {
      rows.forEach((row, r) => {
        const model = MODELS[(offset + r) % MODELS.length];
        const active = r === 1;
        const text = pad(model, NAME_LEN);
        const status = pad(active ? "IN USE" : "READY", STATUS_LEN);
        row.light.dataset.active = active ? "1" : "0";
        row.name.forEach((cell, i) => {
          cell.target = text[i];
          step(cell, (first ? 200 : 0) + r * 70 + i * 28, reduce);
        });
        row.status.forEach((cell, i) => {
          cell.target = status[i];
          step(cell, (first ? 200 : 0) + r * 70 + (NAME_LEN + i) * 28, reduce);
        });
      });
    };

    const start = () => {
      if (interval) return;
      show(offset === 0);
      interval = window.setInterval(() => {
        offset = (offset + 1) % MODELS.length;
        show(false);
      }, 3400);
    };
    const stop = () => {
      window.clearInterval(interval);
      interval = 0;
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? false;
        if (visible && !document.hidden) start();
        else stop();
      },
      { threshold: 0.2 },
    );
    io.observe(board);
    const onVis = () => (document.hidden || !visible ? stop() : start());
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      rows.forEach((row) => [...row.name, ...row.status].forEach((c) => window.clearTimeout(c.timer)));
      board.querySelectorAll(`.${f.cell}`).forEach((el) => el.remove());
    };
  }, []);

  return (
    <section ref={sectionRef} className={f.act} data-tone="dark" data-bg="#000000" aria-labelledby="models-title">
      <h2 id="models-title" className={f.title}>
        Any <span>model.</span>
      </h2>
      <p className="visually-hidden">
        Claude Code, Codex, ChatGPT, Gemini, Pi, OpenRouter and any other provider.
      </p>
      <div ref={boardRef} className={f.board} aria-hidden="true">
        <div className={f.head}>
          <span>Model</span>
          <span>Status</span>
        </div>
        {Array.from({ length: ROWS }, (_, r) => (
          <div key={r} className={f.row} data-row={r}>
            <span className={f.light} data-light="" />
            <span className={f.name} data-name="" />
            <span className={f.status} data-status="" />
          </div>
        ))}
      </div>
    </section>
  );
}
