"use client";

import { useEffect, useRef } from "react";
import { DownloadButton } from "@/components/download-button";
import { AuroraField } from "./aurora-field";
import { ease, lerp, seg, useScene } from "./scroll-engine";
import { KidSkin, OrbitSkin, RetroSkin, StellaSkin, SynthSkin } from "./skins";
import m from "./metamorphosis.module.css";

const LINES = [
  "Stella rewrites itself.",
  "“Make it 1984.”",
  "“Make it for my kid.”",
  "“Put my week in orbit.”",
  "“Become a synth.”",
  "Anything you ask.",
];

const CODE = [
  "theme = { year: 1984, colors: 2, font: \"pixel\" }",
  "<KidMode buttons=\"huge\" talk=\"first\" reading={false} />",
  "<Orbit around={stella} planets={week.events} />",
  "<Synth bpm={118} steps={16} voice=\"stella\" />",
];

const CHANGES = [
  "Restyle Stella as a 1984 Macintosh",
  "A simple, talk-first Stella for Ada",
  "Show my week as an orbit",
  "Turn Stella into a step synth",
];

const SKINS = [StellaSkin, RetroSkin, KidSkin, OrbitSkin, SynthSkin];

const D = 7.3;
const STEP0 = 1.4;
const STEP = 1.2;

export function Metamorphosis() {
  const sectionRef = useRef<HTMLElement>(null);
  const nightRef = useRef<HTMLDivElement>(null);
  const auroraRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const liftRef = useRef(0);
  const geo = useRef({
    stageTop: 0,
    stageH: 0,
    stageW: 0,
    stageCx: 0,
    stageCy: 0,
  });
  const state = useRef({ text: "", code: -1, visible: "", change: "" });
  const changeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const measure = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const g = geo.current;
      g.stageTop = stage.offsetTop;
      g.stageH = stage.offsetHeight;
      g.stageW = stage.offsetWidth;
      g.stageCx = stage.offsetLeft + g.stageW / 2;
      g.stageCy = stage.offsetTop + g.stageH / 2;
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sectionRef.current) ro.observe(sectionRef.current);
    return () => ro.disconnect();
  }, []);

  useScene(sectionRef, ({ progress, viewportHeight: vh }) => {
    const u = progress * D;
    const g = geo.current;

    const rise = ease.inOut(seg(u, 0.05, 1.05));
    const dark = seg(u, 0.3, 0.95);
    if (nightRef.current) nightRef.current.style.opacity = String(dark);
    if (auroraRef.current) {
      auroraRef.current.style.opacity = String(lerp(1, 0.75, dark));
    }
    liftRef.current = rise;
    sectionRef.current?.setAttribute("data-tone", dark > 0.5 ? "dark" : "light");

    if (heroRef.current) {
      const out = seg(u, 0, 0.7);
      heroRef.current.style.transform = `translate3d(0, ${-out * vh * 0.32}px, 0)`;
      heroRef.current.style.opacity = String(1 - ease.in(out) * 1.1);
      heroRef.current.style.visibility = out >= 0.95 ? "hidden" : "visible";
    }

    const peekTop = vh * 0.72;
    const heroOffset = Math.max(0, peekTop - g.stageTop);
    const stageScale = lerp(0.9, 1, rise);
    const stageY = heroOffset * (1 - rise);
    if (stageRef.current) {
      stageRef.current.style.transform = `translate3d(0, ${stageY}px, 0) scale(${stageScale})`;
    }

    let text: string;
    if (u < STEP0) {
      const n = Math.round(LINES[0].length * seg(u, 0.55, 1.15));
      text = LINES[0].slice(0, n);
    } else {
      const k = Math.min(4, Math.floor((u - STEP0) / STEP));
      const local = u - (STEP0 + k * STEP);
      const prev = LINES[k];
      const next = LINES[k + 1];
      if (local < 0.16) {
        text = prev.slice(0, Math.round(prev.length * (1 - seg(local, 0, 0.16))));
      } else {
        text = next.slice(0, Math.round(next.length * seg(local, 0.16, 0.48)));
      }
    }
    if (text !== state.current.text && textRef.current) {
      state.current.text = text;
      textRef.current.textContent = text;
    }
    if (lineRef.current) {
      const lineIn = seg(u, 0.5, 0.75);
      lineRef.current.style.opacity = String(lineIn);
    }

    const H = g.stageH + 120;
    let visible = "0";
    let sweepY = -1;
    let codeIndex = -1;
    for (let i = 0; i < SKINS.length; i += 1) {
      const layer = layerRefs.current[i];
      const inner = innerRefs.current[i];
      if (!layer || !inner) continue;
      let top = 0;
      let bottom = H;
      let show = false;
      if (i === 0) {
        const s = seg(u, STEP0 + 0.72, STEP0 + 1.12);
        show = s < 1;
        top = s * H;
      } else {
        const sIn = seg(u, STEP0 + (i - 1) * STEP + 0.72, STEP0 + (i - 1) * STEP + 1.12);
        const sOut =
          i < SKINS.length - 1
            ? seg(u, STEP0 + i * STEP + 0.72, STEP0 + i * STEP + 1.12)
            : 0;
        show = sIn > 0 && sOut < 1;
        bottom = sIn * H;
        top = sOut * H;
        if (sIn > 0 && sIn < 1) {
          sweepY = sIn * H;
          codeIndex = i - 1;
        }
      }
      if (show) visible += `${i}`;
      layer.style.visibility = show ? "visible" : "hidden";
      layer.dataset.paused = show ? "0" : "1";
      if (show) {
        const offset = bottom < H ? bottom - H : top;
        layer.style.transform = `translate3d(0, ${offset}px, 0)`;
        inner.style.transform = `translate3d(0, ${-offset}px, 0)`;
      }
    }
    if (sweepRef.current) {
      sweepRef.current.style.opacity = sweepY >= 0 ? "1" : "0";
      if (sweepY >= 0) sweepRef.current.style.transform = `translate3d(0, ${sweepY}px, 0)`;
    }
    if (pillRef.current) {
      let card = "0";
      let pressed = "0";
      if (u >= STEP0) {
        const k = Math.floor((u - STEP0) / STEP);
        const local = u - (STEP0 + k * STEP);
        if (k < 4 && local > 0.5 && local < 0.8) {
          card = "1";
          if (local > 0.63) pressed = "1";
          const label = CHANGES[k];
          if (state.current.change !== label && changeRef.current) {
            state.current.change = label;
            changeRef.current.textContent = label;
          }
        }
      }
      pillRef.current.dataset.on = card;
      pillRef.current.dataset.pressed = pressed;
    }
    if (codeIndex !== state.current.code && codeRef.current) {
      state.current.code = codeIndex;
      if (codeIndex >= 0) codeRef.current.textContent = CODE[codeIndex];
    }

  });

  return (
    <section
      ref={sectionRef}
      className={m.act}
      style={{ height: `${(D + 1) * 100}svh` }}
      data-tone="light"
      data-bg="#060609"
      aria-labelledby="hero-title"
    >
      <div className={m.sticky}>
        <div ref={nightRef} className={m.night} />
        <div ref={auroraRef} className={m.aurora}>
          <AuroraField className={m.auroraCanvas} liftRef={liftRef} />
        </div>

        <div ref={heroRef} className={m.hero}>
          <h1 id="hero-title" className={m.title}>
            <span className={m.titleLine}>Ask for</span>
            <span className={m.titleLine}>anything.</span>
          </h1>
          <div className={m.cta}>
            <DownloadButton />
            <span className={m.free}>Free.</span>
          </div>
        </div>

        <p ref={lineRef} className={m.line} aria-hidden="true">
          <span ref={textRef} />
          <i className={m.caret} />
        </p>
        <h2 className="visually-hidden">
          Stella rewrites itself. Ask it to look like 1984, work for your kid, put
          your week in orbit or become a synth. Anything you ask.
        </h2>

        <div ref={stageRef} className={m.stage} aria-hidden="true">
          {SKINS.map((Skin, i) => (
            <div
              key={i}
              ref={(el) => {
                layerRefs.current[i] = el;
              }}
              className={m.layer}
              style={i === 0 ? undefined : { visibility: "hidden" }}
            >
              <div
                ref={(el) => {
                  innerRefs.current[i] = el;
                }}
                className={m.layerInner}
              >
                <div className={m.skinBox}>
                  <Skin />
                </div>
              </div>
            </div>
          ))}
          <div ref={sweepRef} className={m.sweep}>
            <span ref={codeRef} className={m.code} />
          </div>
          <div ref={pillRef} className={m.pill} data-on="0">
            <span className={m.pillText}>
              <b>A change ready to add</b>
              <span ref={changeRef} />
            </span>
            <span className={m.pillAdd}>Add</span>
          </div>
        </div>
      </div>
    </section>
  );
}
