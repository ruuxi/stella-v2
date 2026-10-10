"use client";

import { useEffect, useRef } from "react";
import { AuroraField } from "./aurora-field";
import { ease, seg, useTimeline } from "./motion";
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

const INTRO = 2.4;
const SEG = 6.2;
const FINAL = 4.6;
const RETURN = INTRO;
const LOOP = SEG * 4 + FINAL + RETURN;

type Frame = {
  text: string;
  base: number;
  next: number;
  sweep: number;
  code: number;
  card: number;
  pressed: boolean;
};

function typed(line: string, t: number, start: number, end: number) {
  return line.slice(0, Math.round(line.length * seg(t, start, end)));
}

function erased(line: string, t: number, end: number) {
  return line.slice(0, Math.round(line.length * (1 - seg(t, 0, end))));
}

function frameAt(seconds: number): Frame {
  const f: Frame = { text: "", base: 0, next: -1, sweep: 0, code: -1, card: -1, pressed: false };
  if (seconds < INTRO) {
    f.text = typed(LINES[0], seconds, 0.2, 1.4);
    return f;
  }
  const t = (seconds - INTRO) % LOOP;
  const k = Math.floor(t / SEG);
  if (k < 4) {
    const local = t - k * SEG;
    f.base = k;
    f.text = local < 0.5 ? erased(LINES[k], local, 0.5) : typed(LINES[k + 1], local, 0.5, 1.8);
    if (local > 1.9 && local < 3.1) {
      f.card = k;
      f.pressed = local > 2.5;
    }
    if (local >= 2.8) {
      const s = ease.inOut(seg(local, 2.8, 4.1));
      if (s >= 1) f.base = k + 1;
      else {
        f.next = k + 1;
        f.sweep = s;
        f.code = k;
      }
    }
    return f;
  }
  const local = t - 4 * SEG;
  f.base = 4;
  if (local < FINAL) {
    f.text = local < 0.5 ? erased(LINES[4], local, 0.5) : typed(LINES[5], local, 0.5, 1.7);
    return f;
  }
  const back = local - FINAL;
  f.text = back < 0.5 ? erased(LINES[5], back, 0.5) : typed(LINES[0], back, 0.5, 1.7);
  const s = ease.inOut(seg(back, 0.4, 1.7));
  if (s >= 1) f.base = 0;
  else if (s > 0) {
    f.next = 0;
    f.sweep = s;
  }
  return f;
}

export function Metamorphosis() {
  const sectionRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLSpanElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const liftRef = useRef(0.55);
  const stageH = useRef(600);
  const state = useRef({ text: "", code: -1, change: -1 });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      stageH.current = stage.offsetHeight;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  useTimeline(
    sectionRef,
    (seconds) => {
      const f = frameAt(seconds);
      if (f.text !== state.current.text && textRef.current) {
        state.current.text = f.text;
        textRef.current.textContent = f.text;
      }

      const H = stageH.current + 120;
      const y = f.sweep * H;
      for (let i = 0; i < SKINS.length; i += 1) {
        const layer = layerRefs.current[i];
        const inner = innerRefs.current[i];
        if (!layer || !inner) continue;
        let offset: number | null = null;
        if (i === f.next) offset = y - H;
        else if (i === f.base) offset = f.next >= 0 ? y : 0;
        const show = offset !== null;
        layer.style.visibility = show ? "visible" : "hidden";
        layer.dataset.paused = show ? "0" : "1";
        if (offset !== null) {
          layer.style.transform = `translate3d(0, ${offset}px, 0)`;
          inner.style.transform = `translate3d(0, ${-offset}px, 0)`;
        }
      }
      if (sweepRef.current) {
        const on = f.next >= 0;
        sweepRef.current.style.opacity = on ? "1" : "0";
        if (on) sweepRef.current.style.transform = `translate3d(0, ${y}px, 0)`;
      }
      if (f.code !== state.current.code && codeRef.current) {
        state.current.code = f.code;
        codeRef.current.textContent = f.code >= 0 ? CODE[f.code] : "";
        codeRef.current.style.display = f.code >= 0 ? "" : "none";
      }
      if (pillRef.current) {
        pillRef.current.dataset.on = f.card >= 0 ? "1" : "0";
        pillRef.current.dataset.pressed = f.pressed ? "1" : "0";
        if (f.card >= 0 && f.card !== state.current.change && changeRef.current) {
          state.current.change = f.card;
          changeRef.current.textContent = CHANGES[f.card];
        }
      }
    },
    { reducedAt: INTRO + SEG * 3 + 4.5 },
  );

  return (
    <section
      ref={sectionRef}
      className={m.act}
      data-tone="dark"
      data-bg="#060609"
      aria-labelledby="rewrite-title"
    >
      <div className={m.sticky}>
        <div className={m.aurora}>
          <AuroraField className={m.auroraCanvas} liftRef={liftRef} dark />
        </div>

        <p ref={lineRef} className={m.line} aria-hidden="true">
          <span ref={textRef}>{LINES[0]}</span>
          <i className={m.caret} />
        </p>
        <h2 id="rewrite-title" className="visually-hidden">
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
