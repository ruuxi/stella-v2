"use client";

import { useEffect, useRef, type RefObject } from "react";

export type SceneMode = "pin" | "view";

export type SceneFrame = {
  progress: number;
  viewportHeight: number;
  viewportWidth: number;
};

type Scene = {
  el: HTMLElement;
  mode: SceneMode;
  top: number;
  height: number;
  last: number;
  update: (frame: SceneFrame) => void;
};

const scenes = new Set<Scene>();
let frame = 0;
let measured = false;
let vh = 0;
let vw = 0;
let listening = false;

function measure() {
  vh = window.innerHeight;
  vw = window.innerWidth;
  const scrollY = window.scrollY;
  for (const scene of scenes) {
    const rect = scene.el.getBoundingClientRect();
    scene.top = rect.top + scrollY;
    scene.height = rect.height;
    scene.last = Number.NaN;
  }
  measured = true;
}

function compute(scene: Scene, scrollY: number) {
  if (scene.mode === "pin") {
    const span = Math.max(1, scene.height - vh);
    return clamp((scrollY - scene.top) / span);
  }
  return clamp((scrollY + vh - scene.top) / (scene.height + vh));
}

function tick() {
  frame = 0;
  if (!measured) measure();
  const scrollY = window.scrollY;
  for (const scene of scenes) {
    const progress = compute(scene, scrollY);
    if (progress === scene.last) continue;
    const inRange =
      scrollY + vh > scene.top - vh * 0.5 &&
      scrollY < scene.top + scene.height + vh * 0.5;
    if (!inRange && !Number.isNaN(scene.last)) {
      const snapped = progress <= 0 ? 0 : 1;
      if (scene.last === snapped) continue;
    }
    scene.last = progress;
    scene.update({ progress, viewportHeight: vh, viewportWidth: vw });
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(tick);
}

function remeasure() {
  measured = false;
  schedule();
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", remeasure);
  window.addEventListener("load", remeasure);
  const ro = new ResizeObserver(remeasure);
  ro.observe(document.body);
  document.fonts?.ready.then(remeasure).catch(() => {});
}

export function useScene(
  ref: RefObject<HTMLElement | null>,
  update: (frame: SceneFrame) => void,
  mode: SceneMode = "pin",
) {
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scene: Scene = {
      el,
      mode,
      top: 0,
      height: 0,
      last: Number.NaN,
      update: (f) => updateRef.current(f),
    };
    scenes.add(scene);
    listen();
    remeasure();
    return () => {
      scenes.delete(scene);
    };
  }, [ref, mode]);
}

export function clamp(value: number, min = 0, max = 1) {
  return value < min ? min : value > max ? max : value;
}

export function seg(p: number, start: number, end: number) {
  return clamp((p - start) / (end - start));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export const ease = {
  inOut: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  in: (t: number) => t * t * t,
  outBack: (t: number) => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

type SpringTarget = {
  value: number;
  velocity: number;
  target: number;
  stiffness: number;
  damping: number;
  onChange: (value: number) => void;
};

const springs = new Set<SpringTarget>();
let springFrame = 0;
let springLast = 0;

function springTick(now: number) {
  springFrame = 0;
  const dt = Math.min(0.032, springLast ? (now - springLast) / 1000 : 0.016);
  springLast = now;
  let active = false;
  for (const s of springs) {
    const force = (s.target - s.value) * s.stiffness;
    s.velocity += (force - s.velocity * s.damping) * dt;
    s.value += s.velocity * dt;
    if (Math.abs(s.velocity) < 0.0005 && Math.abs(s.target - s.value) < 0.0005) {
      s.value = s.target;
      s.velocity = 0;
    } else {
      active = true;
    }
    s.onChange(s.value);
  }
  if (active) springFrame = requestAnimationFrame(springTick);
  else springLast = 0;
}

export type Spring = {
  set: (target: number) => void;
  jump: (value: number) => void;
  dispose: () => void;
  get: () => number;
};

export function createSpring(
  initial: number,
  onChange: (value: number) => void,
  { stiffness = 170, damping = 22 }: { stiffness?: number; damping?: number } = {},
): Spring {
  const s: SpringTarget = {
    value: initial,
    velocity: 0,
    target: initial,
    stiffness,
    damping,
    onChange,
  };
  springs.add(s);
  return {
    set(target) {
      s.target = target;
      if (!springFrame) springFrame = requestAnimationFrame(springTick);
    },
    jump(value) {
      s.value = value;
      s.target = value;
      s.velocity = 0;
      onChange(value);
    },
    dispose() {
      springs.delete(s);
    },
    get: () => s.value,
  };
}

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function usePlayOnce(
  ref: RefObject<HTMLElement | null>,
  duration: number,
  onFrame: (t: number) => void,
  threshold = 0.3,
) {
  const frameRef = useRef(onFrame);
  useEffect(() => {
    frameRef.current = onFrame;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let start = 0;
    frameRef.current(0);
    const run = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / duration);
      frameRef.current(t);
      if (t < 1) raf = requestAnimationFrame(run);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        if (prefersReducedMotion()) frameRef.current(1);
        else raf = requestAnimationFrame(run);
      },
      { threshold },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, duration, threshold]);
}
