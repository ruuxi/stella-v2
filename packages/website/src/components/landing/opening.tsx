"use client";

import { useEffect, useRef } from "react";
import { DownloadButton } from "@/components/download-button";
import { AuroraField } from "./aurora-field";
import { clamp, ease, lerp, prefersReducedMotion, seg } from "./motion";
import { BlocksSkin } from "./skin-blocks";
import { EditorSkin } from "./skin-editor";
import { OpsSkin } from "./skin-ops";
import { TraderSkin } from "./skin-trader";
import { StellaSkin } from "./skins";
import { StellaCharacter, useWanderingGaze, type StellaMarkHandle } from "./stella-character";
import { mixWindowVars, ThemeGradient, type WindowThemeKey } from "./window-theme";
import o from "./opening.module.css";

const JOURNEY: WindowThemeKey[] = [
  { id: "default", dark: false },
  { id: "sage", dark: false },
  { id: "gruvbox", dark: false },
  { id: "catppuccin", dark: false },
  { id: "dracula", dark: false },
  { id: "nightowl", dark: false },
  { id: "default", dark: false },
];

function journeyAt(t: number) {
  const span = (JOURNEY.length - 1) * clamp(t);
  const i = Math.min(JOURNEY.length - 2, Math.floor(span));
  return { i, k: ease.inOut(span - i) };
}

function JourneyBackdrop() {
  return (
    <>
      {JOURNEY.map((theme, i) =>
        theme.id === "default" ? null : (
          <ThemeGradient key={i} theme={theme} style={{ opacity: 0 }} className={`journey-${i}`} />
        ),
      )}
    </>
  );
}

const LINES = [
  "Stella rewrites itself.",
  "“Build it out of blocks.”",
  "“Go full 90s anime.”",
  "“I trade for a living.”",
  "“I edit films.”",
  "Anything you ask.",
];

const SKINS = [StellaSkin, BlocksSkin, OpsSkin, TraderSkin, EditorSkin];
const HOLDS = [2.9, 3.6, 3.3, 3.6];

const INTRO = 1.9;
const FADE = 0.62;
const FINAL = 2.1;
const SEG_LEN = HOLDS.map((h) => FADE + h);
const SEQ_TOTAL = SEG_LEN.reduce((a, b) => a + b, 0);
const LOOP = SEQ_TOTAL + FINAL + FADE + INTRO;

type Frame = { line: number; base: number; next: number; s: number };

function frameAt(t: number): Frame {
  const f: Frame = { line: 0, base: 0, next: -1, s: 0 };
  if (t < INTRO) return f;
  let local = (t - INTRO) % LOOP;
  for (let k = 0; k < SEG_LEN.length; k += 1) {
    if (local < SEG_LEN[k]) {
      f.line = k + 1;
      if (local < FADE) {
        f.base = k;
        f.next = k + 1;
        f.s = ease.inOut(local / FADE);
      } else f.base = k + 1;
      return f;
    }
    local -= SEG_LEN[k];
  }
  f.base = SKINS.length - 1;
  if (local < FINAL) {
    f.line = LINES.length - 1;
    return f;
  }
  const back = local - FINAL;
  f.line = 0;
  if (back < FADE) {
    f.next = 0;
    f.s = ease.inOut(back / FADE);
  } else f.base = 0;
  return f;
}

const REDUCED_AT = INTRO + SEG_LEN[0] + SEG_LEN[1] + 2.4;

export function Opening() {
  const trackRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);
  const mascotHandle = useRef<StellaMarkHandle | null>(null);
  const heroAuroraRef = useRef<HTMLDivElement>(null);
  const darkAuroraRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
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

    const m = { vh: 0, travel: 1, y0: 0, y1: 0 };
    const st = {
      p: -1,
      line: -2,
      demo: false,
      elapsed: 0,
      last: 0,
      raf: 0,
      scrollRaf: 0,
      visible: false,
      journey: "",
    };

    const measure = () => {
      m.vh = sticky.offsetHeight;
      m.travel = Math.max(1, track.offsetHeight - m.vh);
      m.y1 = stage.offsetTop;
      m.y0 = m.vh * 0.72;
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
        let opacity = 1;
        let blur = 0;
        let scale = 1;
        if (f.next >= 0 && isBase) {
          opacity = 1 - f.s;
          blur = f.s * 10;
          scale = 1 - 0.02 * f.s;
        } else if (isNext) {
          opacity = f.s;
          blur = (1 - f.s) * 14;
          scale = 1.03 - 0.03 * f.s;
        }
        layer.style.opacity = opacity >= 1 ? "" : opacity.toFixed(3);
        layer.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
        layer.style.transform = scale !== 1 ? `scale(${scale.toFixed(4)})` : "";
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

    const tintJourney = (t: number) => {
      const win = tintRef.current?.firstElementChild as HTMLElement | null;
      if (!win) return;
      const { i, k } = journeyAt(t);
      const key = `${i}:${k.toFixed(3)}`;
      if (key === st.journey) return;
      st.journey = key;
      const vars = mixWindowVars(JOURNEY[i], JOURNEY[i + 1], k);
      for (const [name, v] of Object.entries(vars)) win.style.setProperty(name, v);
      win.querySelectorAll<HTMLCanvasElement>("canvas[class^='journey-']").forEach((c) => {
        const j = Number(c.className.slice(8));
        const op = j === i ? 1 - k : j === i + 1 ? k : 0;
        c.style.opacity = op.toFixed(3);
      });
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

      tintJourney(seg(p, 0.04, 0.88));

      const dark = seg(p, 0.36, 0.6);
      const c = Math.round(lerp(255, 6, dark));
      sticky.style.backgroundColor = `rgb(${c}, ${c}, ${Math.round(lerp(255, 9, dark))})`;
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
      data-bg="#ffffff"
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

        <div className={o.head} aria-hidden="true">
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
        <h2 id="rewrite-title" className="sr-only">
          Stella rewrites itself. Ask it to be built out of blocks, to go full 90s anime, to become a
          trading desk or a film editor&apos;s suite. Anything you ask.
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
                {i === 0 ? <StellaSkin backdrop={<JourneyBackdrop />} /> : <Skin />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
