"use client";

import { useEffect, useRef } from "react";
import { DownloadButton } from "@/components/download-button";
import { AuroraField } from "./aurora-field";
import { clamp, ease, lerp, prefersReducedMotion, seg } from "./motion";
import { BlocksSkin } from "./skin-blocks";
import { KitchenSkin } from "./skin-kitchen";
import { OpsSkin } from "./skin-ops";
import { TraderSkin } from "./skin-trader";
import { StellaSkin } from "./skins";
import { StellaCharacter, useWanderingGaze, type StellaMarkHandle } from "./stella-character";
import o from "./opening.module.css";

type Palette = {
  bg: string;
  fg: string;
  sub: string;
  subStrong: string;
  her: string;
  me: string;
  meFg: string;
  line: string;
  composer: string;
  plus: string;
  send: string;
  blob1: string;
  blob2: string;
  blobA: number;
  edge: string;
};

const pearl: Palette = {
  bg: "#ffffff",
  fg: "#1d1d1f",
  sub: "#86868b",
  subStrong: "#4a4a4c",
  her: "#e9e9ee",
  me: "#2871c9",
  meFg: "#f2fbff",
  line: "#e2e2e6",
  composer: "#ffffff",
  plus: "#f4f4f4",
  send: "#8fb8f5",
  blob1: "#ffffff",
  blob2: "#ffffff",
  blobA: 0,
  edge: "#d9d9de",
};

const JOURNEY: Palette[] = [
  pearl,
  {
    bg: "#f4f7f1",
    fg: "#1f2a1f",
    sub: "#6d7a6a",
    subStrong: "#3f4a3d",
    her: "#e2eadb",
    me: "#4f7d4f",
    meFg: "#ffffff",
    line: "#d4ddcc",
    composer: "#fafcf7",
    plus: "#e9efe3",
    send: "#8fbf8a",
    blob1: "#8fbf8a",
    blob2: "#cdb98c",
    blobA: 0.55,
    edge: "#cfd9c6",
  },
  {
    bg: "#fbf1c7",
    fg: "#3c3836",
    sub: "#7c6f64",
    subStrong: "#504945",
    her: "#f0e2b4",
    me: "#d65d0e",
    meFg: "#ffffff",
    line: "#e6d59f",
    composer: "#fffbeb",
    plus: "#f2e5bc",
    send: "#fe8019",
    blob1: "#fe8019",
    blob2: "#b16286",
    blobA: 0.42,
    edge: "#e6d59f",
  },
  {
    bg: "#170c0c",
    fg: "#ecd9d9",
    sub: "#a08585",
    subStrong: "#c7a4a4",
    her: "#2c1717",
    me: "#ef4444",
    meFg: "#ffffff",
    line: "#3a2121",
    composer: "#1f1010",
    plus: "#2c1717",
    send: "#ef4444",
    blob1: "#ef4444",
    blob2: "#e8a87c",
    blobA: 0.34,
    edge: "#3a2121",
  },
  {
    bg: "#15141b",
    fg: "#edecee",
    sub: "#8f8c9c",
    subStrong: "#b9b6c6",
    her: "#25232f",
    me: "#a277ff",
    meFg: "#ffffff",
    line: "#2e2b3a",
    composer: "#1a1921",
    plus: "#25232f",
    send: "#a277ff",
    blob1: "#a277ff",
    blob2: "#6ecfef",
    blobA: 0.36,
    edge: "#2e2b3a",
  },
  {
    bg: "#011627",
    fg: "#d6deeb",
    sub: "#7d8ba3",
    subStrong: "#a9b6cc",
    her: "#0b2942",
    me: "#3d6fd6",
    meFg: "#ffffff",
    line: "#12304a",
    composer: "#021d32",
    plus: "#0b2942",
    send: "#82aaff",
    blob1: "#82aaff",
    blob2: "#7fdbca",
    blobA: 0.32,
    edge: "#12304a",
  },
  pearl,
];

const COLOR_KEYS = ["bg", "fg", "sub", "subStrong", "her", "me", "meFg", "line", "composer", "plus", "send", "edge"] as const;
const VAR_NAMES: Record<(typeof COLOR_KEYS)[number], string> = {
  bg: "--w-bg",
  fg: "--w-fg",
  sub: "--w-sub",
  subStrong: "--w-sub-strong",
  her: "--w-her",
  me: "--w-me",
  meFg: "--w-me-fg",
  line: "--w-line",
  composer: "--w-composer",
  plus: "--w-plus",
  send: "--w-send",
  edge: "--w-edge",
};

function rgb(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number) {
  const x = rgb(a);
  const y = rgb(b);
  return `rgb(${Math.round(lerp(x[0], y[0], t))}, ${Math.round(lerp(x[1], y[1], t))}, ${Math.round(lerp(x[2], y[2], t))})`;
}

function paletteAt(t: number) {
  const span = (JOURNEY.length - 1) * clamp(t);
  const i = Math.min(JOURNEY.length - 2, Math.floor(span));
  const k = ease.inOut(span - i);
  const a = JOURNEY[i];
  const b = JOURNEY[i + 1];
  const vars: Record<string, string> = {};
  for (const key of COLOR_KEYS) vars[VAR_NAMES[key]] = mix(a[key], b[key], k);
  const alpha = lerp(a.blobA, b.blobA, k);
  const b1 = rgb(a.blob1).map((v, j) => Math.round(lerp(v, rgb(b.blob1)[j], k)));
  const b2 = rgb(a.blob2).map((v, j) => Math.round(lerp(v, rgb(b.blob2)[j], k)));
  vars["--w-blob1"] = `rgba(${b1.join(", ")}, ${alpha.toFixed(3)})`;
  vars["--w-blob2"] = `rgba(${b2.join(", ")}, ${alpha.toFixed(3)})`;
  return vars;
}

const LINES = [
  "Stella rewrites itself.",
  "“Build it out of blocks.”",
  "“Go full 90s anime.”",
  "“I trade for a living.”",
  "“I cook every night.”",
  "Anything you ask.",
];

const SKINS = [StellaSkin, BlocksSkin, OpsSkin, TraderSkin, KitchenSkin];

type Wipe = "sweep" | "blocks" | "cut";

const SEQ: { wipe: Wipe; hold: number; change: string }[] = [
  { wipe: "blocks", hold: 2.7, change: "Rebuild Stella out of blocks" },
  { wipe: "cut", hold: 3.5, change: "A red-alert ops console" },
  { wipe: "sweep", hold: 3.1, change: "A trading desk around my watchlist" },
  { wipe: "sweep", hold: 3.0, change: "Hands-free cooking mode" },
];

const INTRO = 1.9;
const PILL_ON = 0.3;
const PRESS = 0.72;
const WIPE_AT = 0.92;
const WIPE_LEN = 0.62;
const FINAL = 2.1;
const SEG_LEN = SEQ.map((s) => WIPE_AT + WIPE_LEN + s.hold);
const SEQ_TOTAL = SEG_LEN.reduce((a, b) => a + b, 0);
const LOOP = SEQ_TOTAL + FINAL + INTRO;

type Frame = {
  line: number;
  base: number;
  next: number;
  wipe: Wipe;
  s: number;
  card: number;
  pressed: boolean;
};

function frameAt(t: number): Frame {
  const f: Frame = { line: 0, base: 0, next: -1, wipe: "sweep", s: 0, card: -1, pressed: false };
  if (t < INTRO) return f;
  let local = (t - INTRO) % LOOP;
  for (let k = 0; k < SEQ.length; k += 1) {
    if (local < SEG_LEN[k]) {
      f.line = k + 1;
      f.base = k;
      if (local > PILL_ON && local < WIPE_AT + 0.25) {
        f.card = k;
        f.pressed = local > PRESS;
      }
      if (local >= WIPE_AT) {
        const raw = SEQ[k].wipe === "cut" ? 1 : seg(local, WIPE_AT, WIPE_AT + WIPE_LEN);
        const s = SEQ[k].wipe === "blocks" ? raw : ease.inOut(raw);
        if (s >= 1) f.base = k + 1;
        else {
          f.next = k + 1;
          f.s = s;
          f.wipe = SEQ[k].wipe;
        }
      }
      return f;
    }
    local -= SEG_LEN[k];
  }
  f.base = SEQ.length;
  if (local < FINAL) {
    f.line = LINES.length - 1;
    return f;
  }
  const back = local - FINAL;
  f.line = 0;
  const s = ease.inOut(seg(back, 0.1, 0.1 + WIPE_LEN));
  if (s >= 1) f.base = 0;
  else if (s > 0) {
    f.next = 0;
    f.s = s;
  }
  return f;
}

const REDUCED_AT = INTRO + SEG_LEN[0] + SEG_LEN[1] + 2.4;

const NOISE = Array.from({ length: 24 }, (_, i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1);

function blocksClip(s: number, w: number, h: number) {
  const cols = NOISE.length;
  const cell = h / 14;
  const pts = [`0px 0px`, `${w}px 0px`];
  for (let c = cols - 1; c >= 0; c -= 1) {
    const y = Math.max(0, Math.min(h, Math.round(((s * 1.45 - NOISE[c] * 0.45) * h) / cell) * cell));
    pts.push(`${((c + 1) / cols) * w}px ${y}px`, `${(c / cols) * w}px ${y}px`);
  }
  return `polygon(${pts.join(", ")})`;
}

export function Opening() {
  const trackRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);
  const mascotHandle = useRef<StellaMarkHandle | null>(null);
  const heroAuroraRef = useRef<HTMLDivElement>(null);
  const darkAuroraRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLSpanElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const liftRef = useRef(0.55);

  useWanderingGaze(mascotHandle, mascotRef);

  useEffect(() => {
    const track = trackRef.current;
    const sticky = stickyRef.current;
    const stage = stageRef.current;
    if (!track || !sticky || !stage) return;
    const reduce = prefersReducedMotion();

    const m = { vh: 0, travel: 1, y0: 0, y1: 0, stageH: 0, stageW: 0 };
    const st = {
      p: -1,
      line: -2,
      demo: false,
      elapsed: 0,
      last: 0,
      raf: 0,
      scrollRaf: 0,
      visible: false,
      change: -1,
      clip: "",
    };

    const measure = () => {
      m.vh = sticky.offsetHeight;
      m.travel = Math.max(1, track.offsetHeight - m.vh);
      m.stageH = stage.offsetHeight;
      m.stageW = stage.offsetWidth;
      m.y1 = stage.offsetTop;
      m.y0 = m.vh * (m.vh < 700 || window.innerWidth < 700 ? 0.7 : 0.72);
    };

    const setLine = (n: number) => {
      if (n === st.line) return;
      st.line = n;
      lineRefs.current.forEach((el, i) => {
        if (el) el.dataset.on = i === n ? "1" : "0";
      });
    };

    const renderDemo = (f: Frame) => {
      setLine(f.line);
      const Hl = m.stageH + 120;
      const Wl = m.stageW + 120;
      for (let i = 0; i < SKINS.length; i += 1) {
        const layer = layerRefs.current[i];
        if (!layer) continue;
        const isBase = i === f.base;
        const isNext = i === f.next;
        const show = isBase || isNext;
        layer.style.visibility = show ? "visible" : "hidden";
        const live = show ? "1" : "0";
        if (layer.dataset.live !== live) layer.dataset.live = live;
        layer.style.zIndex = isNext ? "2" : "1";
        let clip = "none";
        if (isNext) {
          if (f.wipe === "blocks") clip = blocksClip(f.s, Wl, Hl);
          else clip = `inset(0px 0px ${Math.max(0, Hl - (60 + f.s * (m.stageH + 60)))}px 0px)`;
        }
        if (layer.style.clipPath !== clip) layer.style.clipPath = clip;
      }
      const sweep = sweepRef.current;
      if (sweep) {
        const on = f.next >= 0 && f.wipe === "sweep";
        sweep.style.opacity = on ? "1" : "0";
        if (on) sweep.style.transform = `translate3d(0, ${f.s * (m.stageH + 60)}px, 0)`;
      }
      const pill = pillRef.current;
      if (pill) {
        pill.dataset.on = f.card >= 0 ? "1" : "0";
        pill.dataset.pressed = f.pressed ? "1" : "0";
        if (f.card >= 0 && f.card !== st.change && changeRef.current) {
          st.change = f.card;
          changeRef.current.textContent = SEQ[f.card].change;
        }
      }
    };

    const loop = (now: number) => {
      st.raf = 0;
      if (!st.demo || !st.visible || document.hidden) {
        st.last = 0;
        return;
      }
      if (st.last) st.elapsed += Math.min(0.1, (now - st.last) / 1000);
      st.last = now;
      renderDemo(frameAt(st.elapsed));
      st.raf = requestAnimationFrame(loop);
    };

    const startDemo = () => {
      if (st.demo) return;
      st.demo = true;
      if (reduce) {
        renderDemo(frameAt(REDUCED_AT));
        return;
      }
      if (!st.raf) st.raf = requestAnimationFrame(loop);
    };

    const stopDemo = () => {
      if (!st.demo) return;
      st.demo = false;
      st.elapsed = 0;
      st.last = 0;
      cancelAnimationFrame(st.raf);
      st.raf = 0;
      renderDemo(frameAt(0));
    };

    const apply = () => {
      st.scrollRaf = 0;
      const rect = track.getBoundingClientRect();
      const p = clamp(-rect.top / m.travel);
      if (p === st.p && st.demo) return;
      st.p = p;
      const scrolled = p * m.travel;

      const heroFade = seg(p, 0.1, 0.36);
      if (heroRef.current) {
        heroRef.current.style.transform = `translate3d(0, ${-scrolled}px, 0)`;
        heroRef.current.style.opacity = String(1 - heroFade);
      }
      if (mascotRef.current) {
        mascotRef.current.style.transform = `translate3d(0, ${-scrolled * 0.7}px, 0) scale(${1 - 0.12 * seg(p, 0, 0.4)})`;
        mascotRef.current.style.opacity = String(1 - seg(p, 0.12, 0.4));
      }
      if (heroAuroraRef.current) heroAuroraRef.current.style.opacity = String(1 - seg(p, 0.05, 0.35));
      if (darkAuroraRef.current) darkAuroraRef.current.style.opacity = String(seg(p, 0.55, 0.95));

      const travelK = ease.inOut(seg(p, 0, 0.82));
      stage.style.transform = `translate3d(0, ${lerp(m.y0 - m.y1, 0, travelK)}px, 0)`;

      const tint = tintRef.current;
      if (tint) {
        const vars = paletteAt(seg(p, 0.04, 0.88));
        for (const [k, v] of Object.entries(vars)) tint.style.setProperty(k, v);
      }

      const dark = seg(p, 0.36, 0.6);
      sticky.style.backgroundColor = mix("#ffffff", "#060609", dark);
      const tone = dark > 0.5 ? "dark" : "light";
      if (track.dataset.tone !== tone) track.dataset.tone = tone;

      if (p >= 0.93) startDemo();
      else if (p < 0.85) stopDemo();
      if (!st.demo) setLine(p > 0.56 ? 0 : -1);
    };

    const onScroll = () => {
      if (!st.scrollRaf) st.scrollRaf = requestAnimationFrame(apply);
    };

    measure();
    renderDemo(frameAt(0));
    st.line = -2;
    apply();

    const ro = new ResizeObserver(() => {
      measure();
      st.p = -1;
      apply();
    });
    ro.observe(sticky);
    ro.observe(stage);
    const io = new IntersectionObserver(([entry]) => {
      st.visible = entry?.isIntersecting ?? false;
      if (st.visible && st.demo && !reduce && !st.raf) st.raf = requestAnimationFrame(loop);
    });
    io.observe(stage);
    const onVis = () => {
      if (!document.hidden && st.demo && st.visible && !reduce && !st.raf) st.raf = requestAnimationFrame(loop);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(st.raf);
      cancelAnimationFrame(st.scrollRaf);
    };
  }, []);

  return (
    <section
      ref={trackRef}
      className={o.track}
      data-tone="light"
      data-bg="#060609"
      aria-labelledby="hero-title"
    >
      <div ref={stickyRef} className={o.sticky}>
        <div ref={heroAuroraRef} className={o.aurora}>
          <AuroraField className={o.auroraCanvas} />
        </div>
        <div ref={darkAuroraRef} className={o.darkAurora}>
          <AuroraField className={o.auroraCanvas} liftRef={liftRef} dark />
        </div>

        <div ref={mascotRef} className={o.mascot} aria-hidden="true">
          <div className={o.mascotIn}>
            <StellaCharacter size={null} glow eyeColor="#ffffff" handleRef={mascotHandle} className={o.mascotMark} />
          </div>
        </div>

        <div ref={heroRef} className={o.hero}>
          <h1 id="hero-title" className={o.title}>
            <span className={o.titleLine}>Ask for</span>
            <span className={o.titleLine}>anything.</span>
          </h1>
          <div className={o.cta}>
            <DownloadButton />
            <span className={o.free}>Free.</span>
          </div>
        </div>

        <div ref={headRef} className={o.head} aria-hidden="true">
          {LINES.map((line, i) => (
            <span
              key={line}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={o.headLine}
              data-on="0"
            >
              {line.split(" ").map((word, w) => (
                <span key={w} className={o.word} style={{ ["--i" as string]: w }}>
                  {word}
                </span>
              ))}
            </span>
          ))}
        </div>
        <h2 className="visually-hidden">
          Stella rewrites itself. Ask it to be built out of blocks, to go full 90s anime, to become a
          trading desk or a hands-free kitchen. Anything you ask.
        </h2>

        <div ref={stageRef} className={o.stage} aria-hidden="true">
          {SKINS.map((Skin, i) => (
            <div
              key={i}
              ref={(el) => {
                layerRefs.current[i] = el;
              }}
              className={o.layer}
              data-live={i === 0 ? "1" : "0"}
              style={i === 0 ? undefined : { visibility: "hidden" }}
            >
              <div ref={i === 0 ? tintRef : undefined} className={o.skinBox}>
                <Skin />
              </div>
            </div>
          ))}
          <div ref={sweepRef} className={o.sweep} />
          <div ref={pillRef} className={o.pill} data-on="0">
            <span className={o.pillText}>
              <b>A change ready to add</b>
              <span ref={changeRef} />
            </span>
            <span className={o.pillAdd}>Add</span>
          </div>
        </div>
      </div>
    </section>
  );
}
