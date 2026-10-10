"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion, useLayerLive } from "./motion";
import b from "./skin-blocks.module.css";

const BLOCK = 8;
const COLS = 34;
const ROWS = 18;

type Kind =
  | "grass"
  | "dirt"
  | "stone"
  | "sand"
  | "water"
  | "log"
  | "leaves"
  | "planks"
  | "glass"
  | "cobble"
  | "door"
  | "coal";

const PALETTE: Record<Kind, string[]> = {
  grass: ["#7cbd3f", "#6fae37", "#86c94a", "#5f9c2e"],
  dirt: ["#866043", "#79553a", "#95694a", "#6c4a32"],
  stone: ["#7f7f7f", "#747474", "#8c8c8c", "#6a6a6a"],
  sand: ["#dbd3a0", "#d1c88f", "#e3dbb0", "#c9bf86"],
  water: ["#3f76e4", "#3a6dd6", "#4a82ee", "#3567cc"],
  log: ["#6b5130", "#5a4227", "#7a5d39", "#4e3921"],
  leaves: ["#3f8a2d", "#4a9a33", "#2f6e22", "#367c27"],
  planks: ["#b08a55", "#a2824e", "#9a7a47", "#8c6d3c"],
  glass: ["#d8f0fa", "#c3e4f2", "#e9f8fd", "#b5dcec"],
  cobble: ["#7a7a7a", "#8a8a8a", "#636363", "#565656"],
  door: ["#8a6a3a", "#7a5c30", "#6b4f28", "#9a7744"],
  coal: ["#7f7f7f", "#747474", "#2b2b2b", "#1f1f1f"],
};

function seeded(seed: number) {
  let h = seed >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function paintBlock(ctx: CanvasRenderingContext2D, kind: Kind, bx: number, by: number, seed: number) {
  const rand = seeded(seed * 7919 + bx * 131 + by * 31);
  const pal = PALETTE[kind];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  for (let y = 0; y < BLOCK; y += 1) {
    for (let x = 0; x < BLOCK; x += 1) {
      let c = pal[Math.floor(rand() * pal.length)];
      if (kind === "grass") {
        const drip = y < 2 || (y === 2 && rand() < 0.55) || (y === 3 && rand() < 0.18);
        c = drip ? PALETTE.grass[Math.floor(rand() * 4)] : PALETTE.dirt[Math.floor(rand() * 4)];
      } else if (kind === "planks") {
        c = y % 4 === 3 ? "#7a5c33" : pal[Math.floor(rand() * 3)];
        if ((y < 4 && x === 7) || (y >= 4 && x === 3)) c = "#7a5c33";
      } else if (kind === "log") {
        c = x % 3 === 0 ? pal[1] : x % 3 === 1 ? pal[0] : pal[Math.floor(rand() * 4)];
      } else if (kind === "glass") {
        const edge = x === 0 || y === 0 || x === 7 || y === 7;
        c = edge ? "#f4fbff" : (x + y) % 5 === 0 && x > 1 && x < 5 ? "#ffffff" : "#bfe2f1";
      } else if (kind === "cobble") {
        c = rand() < 0.2 ? "#4f4f4f" : pal[Math.floor(rand() * 2)];
      } else if (kind === "door") {
        c = x === 0 || x === 7 || y === 0 ? "#5a4224" : pal[Math.floor(rand() * 4)];
        if (x === 5 && y === 4) c = "#3a3a3a";
      } else if (kind === "coal") {
        c = rand() < 0.16 ? pal[2 + Math.floor(rand() * 2)] : pal[Math.floor(rand() * 2)];
      } else if (kind === "water") {
        c = y === 0 ? "#6f9cf5" : pal[Math.floor(rand() * 4)];
      }
      ctx.fillStyle = c;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
  if (kind !== "water" && kind !== "glass") {
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(x0, y0 + BLOCK - 1, BLOCK, 1);
    ctx.fillRect(x0 + BLOCK - 1, y0, 1, BLOCK);
  }
}

const SURFACE = [11, 11, 12, 13, 13, 13, 13, 13, 12, 11, 11, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10, 10, 9, 9, 10, 10, 11, 11, 12];
const SEA = 12;

function world() {
  const cells: (Kind | null)[][] = Array.from({ length: ROWS }, () => Array<Kind | null>(COLS).fill(null));
  for (let x = 0; x < COLS; x += 1) {
    const top = SURFACE[x];
    for (let y = top; y < ROWS; y += 1) {
      const depth = y - top;
      let k: Kind = depth === 0 ? "grass" : depth < 3 ? "dirt" : "stone";
      if (k === "stone" && (x * 7 + y * 3) % 11 === 0) k = "coal";
      if (top >= SEA && depth < 2) k = "sand";
      cells[y][x] = k;
    }
    if (top > SEA) for (let y = SEA; y < top; y += 1) cells[y][x] = "water";
  }
  const tree = (x: number) => {
    const top = SURFACE[x];
    for (let i = 1; i <= 4; i += 1) cells[top - i][x] = "log";
    for (let dy = -6; dy <= -4; dy += 1)
      for (let dx = -2; dx <= 2; dx += 1) {
        if (Math.abs(dx) === 2 && dy === -6) continue;
        cells[top + dy][x + dx] = "leaves";
      }
    cells[top - 7][x] = "leaves";
    cells[top - 7][x - 1] = "leaves";
    cells[top - 7][x + 1] = "leaves";
  };
  tree(12);
  tree(30);
  return cells;
}

function cabin(): [number, number, Kind][] {
  const out: [number, number, Kind][] = [];
  const ground = 11;
  const left = 17;
  const right = 23;
  for (let y = ground - 1; y >= ground - 4; y -= 1) {
    for (let x = left; x <= right; x += 1) {
      const corner = x === left || x === right;
      let k: Kind = corner ? "log" : "planks";
      if (x === left + 2 && y <= ground - 1 && y >= ground - 2) k = "door";
      if ((x === left + 4 || x === left + 5) && y === ground - 3) k = "glass";
      out.push([x, y, k]);
    }
  }
  for (let i = 0; i <= 3; i += 1) {
    for (let x = left - 1 + i; x <= right + 1 - i; x += 1) out.push([x, ground - 5 - i, "cobble"]);
  }
  out.push([right - 1, ground - 9, "cobble"]);
  out.push([right - 1, ground - 10, "cobble"]);
  return out;
}

const WORLD = world();
const CABIN = cabin();
const BUILD_MS = 1500;

const ICONS: { p: string; m: string[] }[] = [
  { p: "a#fff7d1,b#e0c36a,c#6b5130", m: ["........", ".bbbbbb.", ".baaaab.", ".abaaba.", ".aabbaa.", ".aaaaaa.", ".bbbbbb.", "........"] },
  { p: "a#ffffff,b#e23c3c,c#3a3a3a", m: ["........", ".bbbbbb.", ".bbbbbb.", ".aaaaaa.", ".acacaa.", ".aacaca.", ".aaaaaa.", "........"] },
  { p: "a#f5c542,b#d99a1e", m: ["........", ".bbb....", ".abbbbb.", ".aaaaaa.", ".aaaaaa.", ".aaaaaa.", ".bbbbbb.", "........"] },
  { p: "a#ff4ac0,b#703cff", m: ["........", "....bbb.", "....b.b.", "....b...", "..aab...", ".aaaa...", "..aa....", "........"] },
  { p: "a#3a3a3a,b#8fd3ff,c#ffffff", m: ["........", "..aaa...", ".aaaaaa.", ".abbbba.", ".abccba.", ".abbbba.", ".aaaaaa.", "........"] },
  { p: "a#3f76e4,b#7cbd3f", m: ["........", "..aaaa..", ".abbaaa.", ".abbbaa.", ".aabbba.", ".aaabba.", "..aaaa..", "........"] },
  { p: "a#ffffff,b#bcbcbc", m: ["........", ".aaaaaa.", ".abbbba.", ".aaaaaa.", ".abbaaa.", ".aaaaaa.", "..a.....", "........"] },
  { p: "a#ffd966,b#c48a1a", m: ["...a....", "...a....", "..aaa...", "aaaaaaa.", ".aaaaa..", ".aa.aa..", ".a...a..", "........"] },
  { p: "a#00eeff,b#5243ff", m: ["........", "...aa...", "..abba..", ".abbbba.", ".abbbba.", "..abba..", "...aa...", "........"] },
];

function PixelIcon({ icon }: { icon: (typeof ICONS)[number] }) {
  const colors = Object.fromEntries(icon.p.split(",").map((e) => [e[0], e.slice(1)]));
  return (
    <svg viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      {icon.m.flatMap((row, y) =>
        row.split("").map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={colors[ch]} />)),
      )}
    </svg>
  );
}

const MARK = [
  "...####...",
  "..######..",
  ".########.",
  "##########",
  "###w##w###",
  "###w##w###",
  "##########",
  ".########.",
  "..######..",
  "...#..#...",
];
const MARK_ROWS = ["#ff4ac0", "#ff4ac0", "#a141ff", "#703cff", "#5243ff", "#3164ff", "#0e8aff", "#00b5ff", "#00d5ff", "#00eeff"];

function PixelMark() {
  return (
    <svg className={b.pmark} viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
      {MARK.flatMap((row, y) =>
        row.split("").map((ch, x) =>
          ch === "." ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={ch === "w" ? "#1b1b1b" : MARK_ROWS[y]} />
          ),
        ),
      )}
    </svg>
  );
}

function Heart() {
  return (
    <svg viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M1 1h3v1h1V1h3v1h1v3H8v1H7v1H6v1H5v1H4V8H3V7H2V6H1V5H0V2h1z" fill="#1b1b1b" />
      <path d="M1 2h3v1h1V2h3v3H7v1H6v1H5v1H4V7H3V6H2V5H1z" fill="#e81515" />
      <path d="M2 2h1v1H2z" fill="#ffb3b3" />
    </svg>
  );
}

export function BlocksSkin() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const built = useRef(-1);

  const draw = (count: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || built.current === count) return;
    built.current = count;
    const W = COLS * BLOCK;
    const H = ROWS * BLOCK;
    const bands = ["#6c9bff", "#74a2ff", "#7ca9ff", "#85b0ff", "#8db7ff", "#97beff", "#a1c6ff", "#abcdff", "#b5d3ff", "#bed9ff", "#c6deff", "#cee3ff"];
    for (let i = 0; i < bands.length; i += 1) {
      ctx.fillStyle = bands[i];
      ctx.fillRect(0, Math.floor((i * H) / bands.length), W, Math.ceil(H / bands.length) + 1);
    }
    ctx.fillStyle = "#fffbe0";
    ctx.fillRect(27 * BLOCK, 1 * BLOCK, BLOCK * 2, BLOCK * 2);
    ctx.fillStyle = "#fff3a8";
    ctx.fillRect(27 * BLOCK + 3, 1 * BLOCK + 3, BLOCK * 2 - 6, BLOCK * 2 - 6);
    for (let y = 0; y < ROWS; y += 1)
      for (let x = 0; x < COLS; x += 1) {
        const k = WORLD[y][x];
        if (k) paintBlock(ctx, k, x, y, 3);
      }
    for (let i = 0; i < count && i < CABIN.length; i += 1) {
      const [x, y, k] = CABIN[i];
      paintBlock(ctx, k, x, y, 5);
    }
  };

  useEffect(() => {
    draw(0);
  });

  useLayerLive(rootRef, (live) => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.play = live ? "1" : "0";
    if (!live) {
      draw(0);
      return;
    }
    if (prefersReducedMotion()) {
      draw(CABIN.length);
      return;
    }
    const start = performance.now() + 900;
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - start) / BUILD_MS));
      draw(Math.round(t * CABIN.length));
      if (t < 1 && root.dataset.play === "1") requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return (
    <div ref={rootRef} className={b.blocks} data-play="0">
      <canvas ref={canvasRef} className={b.world} width={COLS * BLOCK} height={ROWS * BLOCK} />
      <div className={b.clouds}>
        <i style={{ left: "6%", top: "9%", width: "14%" }} />
        <i style={{ left: "40%", top: "5%", width: "10%" }} />
        <i style={{ left: "62%", top: "15%", width: "16%" }} />
        <i style={{ left: "88%", top: "7%", width: "11%" }} />
      </div>
      <div className={b.bar}>
        <span className={b.lights}>
          <i />
          <i />
          <i />
        </span>
        <PixelMark />
        <span className={b.account}>Account</span>
      </div>
      <span className={b.cross} />
      <div className={b.chat}>
        <p>
          <span className={b.you}>&lt;Maya&gt;</span> Clean up my Downloads folder?
        </p>
        <p>
          <span className={b.her}>&lt;Stella&gt;</span> Done. 214 files sorted into 9 chests.
        </p>
        <p>
          <span className={b.you}>&lt;Maya&gt;</span> Build us a cabin by the lake
        </p>
        <p className={b.late}>
          <span className={b.her}>&lt;Stella&gt;</span> Placing 1,204 blocks. Fireplace is lit.
        </p>
      </div>
      <div className={b.hud}>
        <div className={b.hearts}>
          {Array.from({ length: 10 }, (_, i) => (
            <Heart key={i} />
          ))}
        </div>
        <div className={b.xp}>
          <span>12</span>
          <i />
        </div>
        <div className={b.hotbar}>
          {ICONS.map((icon, i) => (
            <span key={i} className={b.slot} data-on={i === 0 ? "1" : "0"}>
              <PixelIcon icon={icon} />
            </span>
          ))}
        </div>
      </div>
      <div className={b.input}>
        <span>&gt;</span> Do anything<i />
      </div>
    </div>
  );
}
