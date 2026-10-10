"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";
import k from "./makes-act.module.css";

const CatViewer = lazy(() => import("./cat-viewer").then((m) => ({ default: m.CatViewer })));

const PEAKS = [0.097,0.118,0.183,0.099,0.068,0.12,0.066,0.17,0.951,0.743,0.856,0.98,0.976,0.5,0.447,0.957,0.661,0.398,0.305,0.23,0.689,0.962,0.454,0.339,0.998,0.805,0.66,0.463,0.453,0.577,0.979,0.539,0.808,0.303,0.283,0.734,0.299,0.378,0.493,0.978,0.708,0.399,0.515,0.969,0.871,0.532,0.964,0.683,0.951,0.967,0.428,0.416,0.963,0.729,0.383,0.388,0.535,0.605,0.964,0.419,0.403,0.962,0.792,0.738,0.511,0.398,0.708,1,0.705,0.95,0.389,0.319,0.825,0.266,0.314,0.47,0.985,0.955,0.378,0.575,0.937,0.732,0.387,0.289,0.287,0.225,0.607,0.274,0.201,0.383,0.246,0.097,0.064,0.058,0.046,0.041];

const WORDS = ["images.", "video.", "music.", "3D."];

function MusicCard({ active, onPlaying }: { active: boolean; onPlaying: (playing: boolean) => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!active && audioRef.current && !audioRef.current.paused) audioRef.current.pause();
  }, [active]);

  useEffect(() => {
    onPlaying(playing);
  }, [playing, onPlaying]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const a = audioRef.current;
      if (a && fillRef.current) {
        const t = a.duration ? a.currentTime / a.duration : 0;
        fillRef.current.style.transform = `scaleX(${t})`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return (
    <div className={k.music}>
      <img className={k.musicArt} src="/landing/record.webp" alt="" loading="lazy" decoding="async" />
      <div className={k.musicMeta}>
        <b>Something to code to</b>
        <span>Stella · 0:27</span>
      </div>
      <div className={k.wave}>
        <div className={k.waveBars}>
          {PEAKS.map((p, i) => (
            <i key={i} style={{ transform: `scaleY(${Math.max(0.06, p)})` }} />
          ))}
        </div>
        <div ref={fillRef} className={k.waveFill}>
          <div className={k.waveBars} data-lit="1">
            {PEAKS.map((p, i) => (
              <i key={i} style={{ transform: `scaleY(${Math.max(0.06, p)})` }} />
            ))}
          </div>
        </div>
      </div>
      <button
        type="button"
        className={k.play}
        data-playing={playing ? "1" : "0"}
        aria-label={playing ? "Pause the track Stella made" : "Play the track Stella made"}
        onClick={() => {
          const a = audioRef.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
      >
        <span />
      </button>
      <audio
        ref={audioRef}
        src="/landing/track.mp3"
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}

const CARDS = ["images", "video", "music", "three"] as const;
const ADVANCE_MS = 5200;

export function MakesAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(0);
  const [near, setNear] = useState(false);
  const [running, setRunning] = useState(false);
  const [hold, setHold] = useState(false);
  const [tick, setTick] = useState(0);
  const onPlaying = useCallback((p: boolean) => setHold(p), []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        near.disconnect();
        const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
        idle(() => setNear(true));
      },
      { rootMargin: "150% 0px" },
    );
    near.observe(el);
    const io = new IntersectionObserver(
      ([entry]) => {
        const on = entry?.isIntersecting ?? false;
        setRunning(on);
        if (on) el.dataset.in = "1";
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => {
      near.disconnect();
      io.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running || hold || prefersReducedMotion()) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % CARDS.length), ADVANCE_MS);
    return () => window.clearTimeout(id);
  }, [running, hold, active, tick]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active === 1 && running) void v.play().catch(() => {});
    else v.pause();
  }, [active, near, running]);

  const pos = (i: number) => (i === active ? "on" : i < active ? "past" : "next");
  const choose = (i: number) => {
    setActive(i);
    setTick((t) => t + 1);
  };

  return (
    <section ref={sectionRef} className={k.act} data-tone="light" data-bg="#ffffff" aria-labelledby="makes-title">
      <div className={k.side}>
        <h2 id="makes-title" className={k.words}>
          <span className={k.lead}>Makes</span>
          {WORDS.map((w, i) => (
            <button
              key={w}
              type="button"
              className={k.word}
              data-active={i === active ? "1" : "0"}
              aria-pressed={i === active}
              onClick={() => choose(i)}
            >
              {w}
            </button>
          ))}
        </h2>
      </div>

      <div className={k.stage}>
        <div className={`${k.card} ${k.images}`} data-pos={pos(0)}>
          <div className={k.frame}>
            <img className={k.cabin} src="/landing/cabin.webp" alt="Our cabin in winter, painted by Stella in gouache." loading="lazy" decoding="async" />
            <img className={k.record} src="/landing/record.webp" alt="An abstract mid-century jazz record cover made by Stella." loading="lazy" decoding="async" />
            <p className={k.ask}>“A cover for my jazz record”</p>
          </div>
        </div>
        <div className={`${k.card} ${k.video}`} data-pos={pos(1)}>
          <div className={k.frame}>
            <video
              ref={videoRef}
              className={k.clip}
              src={near ? "/landing/cabin.mp4" : undefined}
              poster="/landing/cabin-poster.webp"
              muted
              loop
              playsInline
              preload="none"
              aria-label="The cabin painting, animated by Stella with falling snow."
            />
            <p className={k.ask}>“Now make it snow”</p>
          </div>
        </div>
        <div className={`${k.card} ${k.musicCard}`} data-pos={pos(2)}>
          <div className={k.frame}>
            <MusicCard active={active === 2} onPlaying={onPlaying} />
            <p className={k.ask}>“Something to code to”</p>
          </div>
        </div>
        <div
          className={`${k.card} ${k.three}`}
          data-pos={pos(3)}
          onPointerDown={() => setTick((t) => t + 1)}
        >
          <div className={k.frame}>
            <img className={k.catPoster} src="/landing/cat-poster.webp" alt="" loading="lazy" decoding="async" />
            {near ? (
              <Suspense fallback={null}>
                <CatViewer active={active === 3} className={k.catCanvas} />
              </Suspense>
            ) : null}
            <p className={k.ask}>“A tiny ceramic version of my cat”</p>
            <span className={k.drag}>Drag to turn</span>
          </div>
        </div>
      </div>
    </section>
  );
}
