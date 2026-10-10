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
  "Design your Stella.",
  "“Build it out of blocks.”",
  "“Go full 90s anime.”",
  "“I trade for a living.”",
  "“I edit films.”",
  "Anything you ask.",
];

const SKINS = [StellaSkin, BlocksSkin, OpsSkin, TraderSkin, EditorSkin];
const HOLDS = [2.9, 3.6, 3.3, 3.6];

const INTRO = 0;
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

const SETTLE_VH = 52;
const CENTER_VH = 40;
const CENTER_MS = 950;
const UP_MS = 440;
const REST: Frame = { line: -1, base: 0, next: -1, s: 0 };

const HOP_MS = 6600;
const HOP_FRAMES: Keyframe[] = [
  { offset: 0, transform: "translateY(0) rotate(0deg) scale(1, 1)" },
  { offset: 0.05, transform: "translateY(0) rotate(0deg) scale(1.09, 0.88)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.11, transform: "translateY(-8%) rotate(-5deg) scale(0.94, 1.07)", easing: "cubic-bezier(0.3, 0, 0.6, 1)" },
  { offset: 0.17, transform: "translateY(-10%) rotate(-7deg) scale(1, 1)", easing: "cubic-bezier(0.5, 0, 0.9, 0.5)" },
  { offset: 0.23, transform: "translateY(0) rotate(0deg) scale(1.08, 0.9)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.28, transform: "translateY(0) rotate(0deg) scale(0.97, 1.03)" },
  { offset: 0.33, transform: "translateY(0) rotate(0deg) scale(1, 1)" },
  { offset: 0.38, transform: "translateY(0) rotate(0deg) scale(1.09, 0.88)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.44, transform: "translateY(-8%) rotate(5deg) scale(0.94, 1.07)", easing: "cubic-bezier(0.3, 0, 0.6, 1)" },
  { offset: 0.5, transform: "translateY(-10%) rotate(7deg) scale(1, 1)", easing: "cubic-bezier(0.5, 0, 0.9, 0.5)" },
  { offset: 0.56, transform: "translateY(0) rotate(0deg) scale(1.08, 0.9)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.61, transform: "translateY(0) rotate(0deg) scale(0.97, 1.03)" },
  { offset: 0.66, transform: "translateY(0) rotate(0deg) scale(1, 1)" },
  { offset: 0.71, transform: "translateY(0) rotate(0deg) scale(1.12, 0.84)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.77, transform: "translateY(-13%) rotate(140deg) scale(0.92, 1.08)", easing: "cubic-bezier(0.25, 0, 0.5, 1)" },
  { offset: 0.83, transform: "translateY(-15%) rotate(300deg) scale(1, 1)", easing: "cubic-bezier(0.5, 0, 0.9, 0.5)" },
  { offset: 0.89, transform: "translateY(0) rotate(360deg) scale(1.1, 0.88)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  { offset: 0.94, transform: "translateY(0) rotate(360deg) scale(0.96, 1.04)" },
  { offset: 1, transform: "translateY(0) rotate(360deg) scale(1, 1)" },
];
const SPARKLE_AT = 0.83;

const REDUCED_AT = INTRO + SEG_LEN[0] + SEG_LEN[1] + 2.4;

export function Opening() {
  const trackRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);
  const mascotHandle = useRef<StellaMarkHandle | null>(null);
  const mascotMoveRef = useRef<HTMLDivElement>(null);
  const heroAuroraRef = useRef<HTMLDivElement>(null);
  const darkAuroraRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLSpanElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const liftRef = useRef(0.55);

  useWanderingGaze(mascotHandle, mascotRef);

  useEffect(() => {
    const el = mascotMoveRef.current;
    if (!el || prefersReducedMotion()) return;
    const anim = el.animate(HOP_FRAMES, { duration: HOP_MS, iterations: Infinity, delay: 1400 });
    let raf = 0;
    let lastLoop = -1;
    const watch = () => {
      raf = requestAnimationFrame(watch);
      const t = Number(anim.currentTime ?? 0) - 1400;
      if (t < 0) return;
      const loop = Math.floor(t / HOP_MS);
      if (loop !== lastLoop && (t % HOP_MS) / HOP_MS >= SPARKLE_AT) {
        lastLoop = loop;
        mascotHandle.current?.sparkle(16);
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        anim.play();
        if (!raf) raf = requestAnimationFrame(watch);
      } else {
        anim.pause();
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      anim.cancel();
    };
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    const sticky = stickyRef.current;
    const stage = stageRef.current;
    if (!track || !sticky || !stage) return;
    const reduce = prefersReducedMotion();

    const m = { vh: 0, travel: 1, y0: 0, y1: 0, unit: 0.01 };
    const intro = introRef.current;
    let introState = "off";
    let centerAt = 0;
    let timer = 0;
    const setIntro = (state: string) => {
      introState = state;
      if (intro) intro.dataset.state = state;
    };
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
      m.y0 = peekRef.current?.offsetTop ?? m.vh * 0.72;
      m.unit = window.innerHeight / 100 / m.travel;
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
      renderDemo(REST);
    };

    const runIntro = (p: number) => {
      const settle = SETTLE_VH * m.unit;
      if (p < CENTER_VH * m.unit - 0.06) {
        window.clearTimeout(timer);
        timer = 0;
        stopDemo();
        if (introState !== "off") setIntro("off");
        return;
      }
      if (introState === "off" && p >= CENTER_VH * m.unit) {
        setIntro("center");
        centerAt = performance.now();
      }
      if (introState === "center" && p >= settle && !timer) {
        if (reduce) {
          setIntro("gone");
          startDemo();
          return;
        }
        const wait = Math.max(0, centerAt + CENTER_MS - performance.now());
        timer = window.setTimeout(() => {
          setIntro("up");
          timer = window.setTimeout(() => {
            timer = 0;
            setIntro("gone");
            startDemo();
          }, UP_MS);
        }, wait);
      }
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

      const u = m.unit;
      const heroFade = seg(p, 8 * u, 28 * u);
      if (heroRef.current) {
        heroRef.current.style.transform = `translate3d(0, ${-scrolled}px, 0)`;
        heroRef.current.style.opacity = String(1 - heroFade);
      }
      if (mascotRef.current) {
        mascotRef.current.style.transform = `translate3d(0, ${-scrolled * 0.7}px, 0) scale(${1 - 0.12 * seg(p, 0, 32 * u)})`;
        mascotRef.current.style.opacity = String(1 - seg(p, 10 * u, 32 * u));
      }
      if (heroAuroraRef.current) heroAuroraRef.current.style.opacity = String(1 - seg(p, 4 * u, 28 * u));
      if (darkAuroraRef.current) darkAuroraRef.current.style.opacity = String(seg(p, 36 * u, 64 * u));

      const travelK = ease.inOut(seg(p, 0, SETTLE_VH * u));
      stage.style.transform = `translate3d(0, ${lerp(m.y0 - m.y1, 0, travelK)}px, 0)`;

      tintJourney(seg(p, 2 * u, (SETTLE_VH - 6) * u));

      const dark = seg(p, 24 * u, 44 * u);
      const c = Math.round(lerp(255, 6, dark));
      sticky.style.backgroundColor = `rgb(${c}, ${c}, ${Math.round(lerp(255, 9, dark))})`;
      const tone = dark > 0.5 ? "dark" : "light";
      if (track.dataset.tone !== tone) track.dataset.tone = tone;

      runIntro(p);
    };

    const onScroll = () => {
      if (!st.scrollRaf) st.scrollRaf = requestAnimationFrame(apply);
    };

    measure();
    renderDemo(REST);
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
      window.clearTimeout(timer);
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
            <div ref={mascotMoveRef} className={o.mascotMove}>
              <StellaCharacter size={null} glow eyeColor="#ffffff" handleRef={mascotHandle} className={o.mascotMark} />
            </div>
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

        <div ref={introRef} className={o.intro} data-state="off" aria-hidden="true">
          {LINES[0].split(" ").map((word, w) => (
            <span key={w} className={o.introWord} style={{ ["--i" as string]: w }}>
              {word}
            </span>
          ))}
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
          Design your Stella. Ask it to be built out of blocks, to go full 90s anime, to become a
          trading desk or a film editor&apos;s suite. Anything you ask.
        </h2>

        <span ref={peekRef} className={o.peekMark} aria-hidden="true" />
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
