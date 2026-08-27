import { TAU, clamp, toPath, polyPath, lerpRing, spanAt, profileMax } from "./geometry.js";
import { N, C, BLEED, VIEWBOX, VIEW_CENTER, SHAPES, ORB_RING, SPARKLE_PATH } from "./shapes.js";
import { EYE_POSES, lerpPose } from "./eyes.js";

const SVGNS = "http://www.w3.org/2000/svg";

const spring = (v) => ({ x: v, v: 0, t: v });
const stepSpring = (s, w, z, dt) => {
  s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) { s.x = s.t; s.v = 0; }
};
const SUBSTEP = 1 / 120;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoothstep = (t) => t * t * (3 - 2 * t);
const rand = (a, b) => a + Math.random() * (b - a);

const CYCLE = 1400, PHASE0 = 0.119, SIGMA = 0.15;
const LIFT = 9, POP_LO = 0.84, POP_K = 0.22;
const DOT_R = 22, DOT_X = 62, DOT_FUDGE = 1.02, DOT_STAGGER = 0.12;
const DOTS_ZOOM = 1.5;

const ZOOM_SMALL_PX = 44, ZOOM_LARGE_PX = 134;

const MORPH_END = 0.62;

const ENV_W = 14, ENV_Z = 1;
const FADE_W = 11, FADE_Z = 1;

function wave(now, slot, amount, t0) {
  let p = (((now - t0) / CYCLE + PHASE0) % 1 + 1) % 1;
  let d = Math.abs(p - slot / 3);
  d = Math.min(d, 1 - d);
  const g = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
  return { g, lift: g * LIFT * amount, pop: POP_LO + POP_K * g, tone: 1 - 0.5 * (1 - g) };
}

const SQ_CYCLE = 1500;
const SQ_SIGMA = 0.30;
const SQ_PINCH = 0.34;
const SQ_BULGE = 0.16;
const SQ_LEAD = 0.62;
const SQ_LIFT = 0.052;
const SQ_TRAVEL = 1.78;
const SQ_TIP_RELIEF = 0.55;
const SQ_FACE_GIVE = 0.62;

function squeezeBand(now, startedAt) {
  const p = (((now - startedAt) / SQ_CYCLE) % 1 + 1) % 1;
  return SQ_TRAVEL - 2 * SQ_TRAVEL * p;
}

function squeezeWarp(band, amount, scale = 1) {
  const lead = band - SQ_LEAD;
  return (px, py) => {
    const ny = (py - C) / C;
    const a = (ny - band) / SQ_SIGMA;
    const b = (ny - lead) / SQ_SIGMA;
    const pinch = Math.exp(-a * a);
    const swell = Math.exp(-b * b);

    const ease = 1 - SQ_TIP_RELIEF * ny * ny * ny * ny;
    const k = amount * scale;
    const sx = 1 - (SQ_PINCH * pinch * ease - SQ_BULGE * swell) * k;
    return [C + (px - C) * sx, py - SQ_LIFT * C * swell * k];
  };
}

export const ACTIVITIES = ["dots", "twinkle", "orbit", "radar", "progress", "squeeze", "standby"];

const ACTIVITY_OF = {
  thinking: "dots",
  working: "twinkle",
  writing: "twinkle",
  searching: "orbit",
  reading: "orbit",
  listening: "radar",
  speaking: "radar",
  loading: "squeeze",
  generating: "squeeze",
  uploading: "progress",
  downloading: "progress",
  sleeping: "standby",
  "powering-down": "standby",
};

const BODY_R = {
  dots: DOT_R,
  twinkle: C,
  orbit: C * 0.9,
  radar: C * 0.94,
  progress: C * 0.78,
  squeeze: C,
  standby: C,
};

const POSES = {
  idle: ["neutral", "open", "neutral", "curious"],
  listening: ["wide", "open", "neutral"],
  thinking: ["squint", "focus", "curious", "neutral"],
  working: ["focus", "squint", "neutral"],
  writing: ["focus", "neutral"],
  searching: ["focus", "curious", "wide", "neutral"],
  reading: ["focus", "squint"],
  loading: ["neutral", "open"],
  generating: ["neutral", "focus"],
  speaking: ["open", "happy", "neutral"],
  uploading: ["focus", "neutral"],
  downloading: ["focus", "neutral"],
  happy: ["happy", "open", "happy", "neutral"],
  celebrate: ["star", "happy", "star"],
  confused: ["curious", "squint", "wide"],
  sad: ["sad", "sleepy", "sad"],
  sleeping: ["sleepy"],
  waking: ["sleepy", "open", "neutral"],
  "powering-down": ["sleepy"],
};

const POSE_EVERY = {
  idle: [9000, 16000], listening: [2800, 5000], thinking: [2000, 3600],
  working: [1800, 3200], writing: [2400, 4200], searching: [1000, 1800],
  reading: [2200, 3800], loading: [4000, 8000], generating: [3000, 6000],
  speaking: [1400, 2600], uploading: [3000, 6000], downloading: [3000, 6000],
  happy: [2500, 4500], celebrate: [1200, 2400], confused: [2200, 3800],
  sad: [4000, 7000], sleeping: [6000, 10000], waking: [800, 1400],
  "powering-down": [6000, 9000],
};

const BLINK_EVERY = {
  idle: [6000, 14000], listening: [3000, 7000], thinking: [3500, 7000],
  working: [2800, 5500], writing: [3000, 6000], searching: [1600, 4000],
  reading: [3000, 6000], loading: [5000, 9000], generating: [4000, 8000],
  speaking: [2500, 5000], uploading: [4000, 8000], downloading: [4000, 8000],
  happy: [2500, 5000], celebrate: [2200, 4500], confused: [2800, 5500],
  sad: [4000, 8000], sleeping: null, waking: [900, 1600], "powering-down": null,
};

const FACE_TUNE = {
  idle: [1, 1, 1],
  listening: [1.08, 1.03, 1.06],
  thinking: [0.97, 0.98, 0.94],
  working: [0.98, 1, 0.96],
  writing: [0.96, 0.98, 0.95],
  searching: [1.02, 1.02, 1],
  reading: [0.96, 0.96, 0.98],
  speaking: [1.04, 1.02, 1.02],
  happy: [1.05, 1.02, 1],
  celebrate: [1.12, 1.04, 1.08],
  confused: [1.03, 1.05, 1],
  sad: [0.94, 0.98, 0.92],
  sleeping: [0.9, 0.98, 0.85],
  "powering-down": [0.9, 0.98, 0.85],
};
const FACE_DEFAULT = [1, 1, 1];

const INKS = {

  aurora: [["#00aad8", 0], ["#3493d9", 0.25], ["#4878db", 0.5], ["#7449c5", 0.75], ["#be57a4", 1]],

  vivid: [["#4ffff7", 0], ["#00b5ff", 0.22], ["#3164ff", 0.45], ["#703cff", 0.68], ["#ff45c3", 1]],
};

let uid = 0;

export function createStellaMark(host, opts = {}) {
  const o = {
    size: null,
    state: "idle",
    shape: "star",
    ink: "aurora",
    flat: null,
    eyeColor: "var(--stella-mark-bg, #101014)",
    glow: true,
    core: true,
    followPointer: false,
    interactive: false,
    paused: false,
    ...opts,
  };
  const id = `sm${++uid}`;
  const reduced = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", VIEWBOX);
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "display:block;width:100%;height:auto;overflow:visible;user-select:none";
  if (o.size) { svg.style.width = `${o.size}px`; svg.style.height = `${o.size}px`; }

  const defs = document.createElementNS(SVGNS, "defs");
  const clip = document.createElementNS(SVGNS, "clipPath");
  clip.id = `${id}-clip`;
  const clipPath = document.createElementNS(SVGNS, "path");
  clip.appendChild(clipPath);
  defs.appendChild(clip);

  const stops = INKS[o.ink] ?? null;
  if (stops && !o.flat) {
    const g = document.createElementNS(SVGNS, "linearGradient");
    g.id = `${id}-ink`;
    g.setAttribute("gradientUnits", "userSpaceOnUse");
    g.setAttribute("x1", C); g.setAttribute("y1", C * 1.86);
    g.setAttribute("x2", C); g.setAttribute("y2", C * 0.14);
    for (const [color, offset] of stops) {
      const s = document.createElementNS(SVGNS, "stop");
      s.setAttribute("offset", offset); s.setAttribute("stop-color", color);
      g.appendChild(s);
    }
    defs.appendChild(g);
  }
  if (o.core) {
    const g = document.createElementNS(SVGNS, "radialGradient");
    g.id = `${id}-core`;
    g.setAttribute("gradientUnits", "userSpaceOnUse");
    g.setAttribute("cx", C); g.setAttribute("cy", C); g.setAttribute("r", C * 0.92);
    for (const [op, off] of [[0.26, 0], [0.09, 0.32], [0, 1]]) {
      const s = document.createElementNS(SVGNS, "stop");
      s.setAttribute("offset", off);
      s.setAttribute("stop-color", "#ffffff");
      s.setAttribute("stop-opacity", op);
      g.appendChild(s);
    }
    defs.appendChild(g);
  }
  if (o.glow) {
    const g = document.createElementNS(SVGNS, "radialGradient");
    g.id = `${id}-glow`;
    for (const [color, op, off] of [["#4878db", 0.26, 0], ["#00aad8", 0.1, 0.55], ["#00aad8", 0, 1]]) {
      const s = document.createElementNS(SVGNS, "stop");
      s.setAttribute("offset", off);
      s.setAttribute("stop-color", o.flat ? "var(--fg)" : color);
      s.setAttribute("stop-opacity", op);
      g.appendChild(s);
    }
    defs.appendChild(g);
  }
  svg.appendChild(defs);

  const hit = document.createElementNS(SVGNS, "rect");
  hit.setAttribute("x", -BLEED); hit.setAttribute("y", -BLEED);
  hit.setAttribute("width", C * 2 + BLEED * 2); hit.setAttribute("height", C * 2 + BLEED * 2);
  hit.setAttribute("fill", "none");
  hit.setAttribute("pointer-events", o.interactive ? "all" : "none");
  svg.appendChild(hit);

  const zoomG = document.createElementNS(SVGNS, "g");
  svg.appendChild(zoomG);

  let glowEl = null;
  if (o.glow) {
    glowEl = document.createElementNS(SVGNS, "circle");
    glowEl.setAttribute("cx", C); glowEl.setAttribute("cy", C);
    glowEl.setAttribute("r", C * 1.02);
    glowEl.setAttribute("fill", `url(#${id}-glow)`);
    zoomG.appendChild(glowEl);
  }

  const inkFill = o.flat ? "var(--fg)" : stops ? `url(#${id}-ink)` : "var(--fg)";

  const dots = [0, 1].map(() => {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", toPath(ORB_RING));
    p.setAttribute("fill", inkFill);
    p.style.display = "none";
    zoomG.appendChild(p);
    return p;
  });

  const sparks = Array.from({ length: 5 }, () => {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", SPARKLE_PATH);
    p.setAttribute("fill", inkFill);
    p.style.display = "none";
    zoomG.appendChild(p);
    return p;
  });
  const rings = Array.from({ length: 4 }, () => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", C); c.setAttribute("cy", C); c.setAttribute("r", 0);
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", o.flat || !stops ? "var(--fg)" : stops[2][0]);
    c.style.display = "none";
    zoomG.appendChild(c);
    return c;
  });

  const bodyG = document.createElementNS(SVGNS, "g");
  const body = document.createElementNS(SVGNS, "path");
  body.setAttribute("fill", inkFill);
  bodyG.appendChild(body);
  let coreEl = null;
  if (o.core) {
    coreEl = document.createElementNS(SVGNS, "path");
    coreEl.setAttribute("fill", `url(#${id}-core)`);
    bodyG.appendChild(coreEl);
  }

  const sweepGrad = document.createElementNS(SVGNS, "linearGradient");
  sweepGrad.id = `${id}-sweep`;
  sweepGrad.setAttribute("gradientUnits", "userSpaceOnUse");
  sweepGrad.setAttribute("x1", C); sweepGrad.setAttribute("x2", C);
  for (const [op, off] of [[0, 0], [0.4, 0.5], [0, 1]]) {
    const st = document.createElementNS(SVGNS, "stop");
    st.setAttribute("offset", off);
    st.setAttribute("stop-color", "#ffffff");
    st.setAttribute("stop-opacity", op);
    sweepGrad.appendChild(st);
  }
  defs.appendChild(sweepGrad);
  const sweepG = document.createElementNS(SVGNS, "g");
  sweepG.setAttribute("clip-path", `url(#${id}-clip)`);
  sweepG.style.display = "none";
  const sweepRect = document.createElementNS(SVGNS, "rect");
  sweepRect.setAttribute("x", -BLEED); sweepRect.setAttribute("y", -BLEED);
  sweepRect.setAttribute("width", C * 2 + BLEED * 2);
  sweepRect.setAttribute("height", C * 2 + BLEED * 2);
  sweepRect.setAttribute("fill", `url(#${id}-sweep)`);
  sweepG.appendChild(sweepRect);
  bodyG.appendChild(sweepG);

  const eyeG = document.createElementNS(SVGNS, "g");
  eyeG.setAttribute("clip-path", `url(#${id}-clip)`);
  const eyes = [0, 1].map(() => {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("fill", o.eyeColor);
    eyeG.appendChild(p);
    return p;
  });
  bodyG.appendChild(eyeG);
  zoomG.appendChild(bodyG);

  const burstG = document.createElementNS(SVGNS, "g");
  zoomG.appendChild(burstG);

  host.appendChild(svg);

  let state = o.state;
  let shapeName = o.shape;
  let shape = SHAPES[shapeName] ?? SHAPES.star;
  let shapeFrom = shape, shapeMix = spring(1);

  const env = spring(0);
  const fade = spring(1);
  const blink = spring(1);
  const eyeSize = spring(1);
  const gazeX = spring(0), gazeY = spring(0);
  const bobX = spring(0), bobY = spring(0);
  const breathe = spring(1);

  let activity = ACTIVITY_OF[state] ?? null;
  let prevActivity = null;
  let activityStart = 0;

  let poseCur = EYE_POSES.neutral, poseFrom = EYE_POSES.neutral;
  let poseMix = 1, poseDur = 160, poseAt = 0, poseIdx = 0;
  let nextPoseAt = 0, nextBlinkAt = 0;

  let pointer = null;
  let paused = o.paused;
  let running = false, raf = 0, last = 0, clock = 0;
  let boxW = o.size ?? 28, measuredAt = -1e9;
  let lastPath = "", lastZoom = "";
  let squeezeStart = 0;
  let particles = [];
  let destroyed = false;

  const weightOf = (name) => {
    const e = clamp(env.x, 0, 1);
    if (name === activity) return e * clamp(fade.x, 0, 1);
    if (name === prevActivity) return e * (1 - clamp(fade.x, 0, 1));
    return 0;
  };

  function setPose(name, dur = 160) {
    const next = EYE_POSES[name] ?? EYE_POSES.neutral;
    if (next === poseCur && poseMix >= 1) return;
    poseFrom = currentPosePoints();
    poseCur = next;
    poseMix = 0; poseDur = dur; poseAt = clock;
  }
  const currentPosePoints = () =>
    poseMix >= 1 ? poseCur : lerpPose(poseFrom, poseCur, easeInOutCubic(poseMix));

  function pickPose() {
    const pool = POSES[state] ?? POSES.idle;
    poseIdx = (poseIdx + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
    setPose(pool[poseIdx], state === "searching" || state === "celebrate" ? 110 : 170);
  }

  function scheduleFace(now) {
    const every = POSE_EVERY[state] ?? POSE_EVERY.idle;
    nextPoseAt = now + rand(every[0], every[1]);
    const b = BLINK_EVERY[state];
    nextBlinkAt = b ? now + rand(b[0], b[1]) : Infinity;
  }

  function applyState(next) {
    if (next === state) return;
    state = next;
    const nextActivity = ACTIVITY_OF[state] ?? null;
    if (nextActivity !== activity) {
      if (activity && env.x > 0.02) { prevActivity = activity; fade.x = 0; fade.v = 0; fade.t = 1; }
      else { prevActivity = null; fade.x = 1; fade.v = 0; fade.t = 1; }
      activity = nextActivity;
      activityStart = clock;
      if (nextActivity === "squeeze") squeezeStart = clock;
    }
    const pool = POSES[state] ?? POSES.idle;
    poseIdx = 0;
    setPose(pool[0], 200);
    scheduleFace(clock);
    if (state === "celebrate") burst(18);
    wake();
  }

  function burst(count = 16) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU), sp = rand(70, 210);
      particles.push({
        x: C, y: C, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        life: 0, max: rand(0.5, 1.05), r: rand(5, 13), rot: rand(0, 360),
        vr: rand(-260, 260), el: null,
      });
    }
    wake();
  }

  function stepParticles(dt) {
    if (!particles.length) return;
    const next = [];
    for (const p of particles) {
      p.life += dt;
      if (p.life >= p.max) { p.el?.remove(); continue; }
      p.vx *= 1 - 1.6 * dt;
      p.vy = p.vy * (1 - 1.6 * dt) + 150 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const u = p.life / p.max;
      const alpha = u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 1.7);
      const size = p.r * (1 - u * 0.45);
      if (!p.el) {
        p.el = document.createElementNS(SVGNS, "path");
        p.el.setAttribute("d", SPARKLE_PATH);
        p.el.setAttribute("fill", inkFill);
        burstG.appendChild(p.el);
      }
      p.el.setAttribute("opacity", alpha.toFixed(3));
      p.el.setAttribute("transform",
        `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.rot.toFixed(1)}) scale(${size.toFixed(2)})`);
      next.push(p);
    }
    particles = next;
  }

  const workProfile = new Float64Array(N);
  const workRing = new Array(N);
  let ringCache = null;

  function buildRing(now, twinkleW) {
    const base = shape.profile;
    const from = shapeFrom.profile;
    const mixing = shapeMix.x < 0.999;
    const m = easeInOutCubic(clamp(shapeMix.x, 0, 1));

    const shimmerAmp = paused || reduced ? 0 : 0.012 * (1 - twinkleW);
    const shimmerPhase = now * 0.0009;

    const sweep = ((now - activityStart) / 1900) * TAU;

    for (let i = 0; i < N; i++) {
      let r = mixing ? from[i] + (base[i] - from[i]) * m : base[i];
      const th = (i / N) * TAU;
      if (shimmerAmp) r *= 1 + shimmerAmp * Math.sin(th * 3 + shimmerPhase);
      if (twinkleW > 0.004) {
        let d = Math.abs(((th - sweep) % TAU + TAU) % TAU - Math.PI);
        d = Math.PI - d;
        const g = Math.exp(-(d * d) / (2 * 0.55 * 0.55));
        r *= 1 + 0.17 * twinkleW * g;
      }
      workProfile[i] = r;
    }
    const max = profileMax(workProfile) || 1;
    const k = C / max;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      const r = workProfile[i] * k;
      workRing[i] = [C + Math.cos(th) * r, C + Math.sin(th) * r];
    }
    return workRing;
  }

  function frame(now) {
    if (destroyed) return;
    const dtReal = Math.min((now - (last || now)) / 1000, 0.1);
    last = now;
    const dt = paused ? 0 : dtReal;
    clock += dt * 1000;
    const t = clock;

    if (now - measuredAt > 500) {
      measuredAt = now;
      const w = svg.getBoundingClientRect().width;
      if (w > 0) boxW = w;
    }

    env.t = activity ? 1 : 0;
    if (reduced) {
      env.x = env.t; fade.x = 1; shapeMix.x = 1;
      blink.x = 1; eyeSize.x = 1; gazeX.x = gazeX.t; gazeY.x = gazeY.t;
      bobX.x = 0; bobY.x = 0; breathe.x = 1;
    } else {
      const sub = Math.max(1, Math.ceil(dt / SUBSTEP)), h = dt / sub;
      for (let i = 0; i < sub; i++) {
        stepSpring(env, ENV_W, ENV_Z, h);
        stepSpring(fade, FADE_W, FADE_Z, h);
        stepSpring(shapeMix, 10, 1, h);
        stepSpring(blink, 26, 1, h);
        stepSpring(eyeSize, 9, 0.85, h);
        stepSpring(gazeX, 13, 1, h);
        stepSpring(gazeY, 13, 1, h);
        stepSpring(bobX, 3.5, 1, h);
        stepSpring(bobY, 4, 1, h);
        stepSpring(breathe, 6, 0.9, h);
      }
    }
    if (fade.x > 0.996) prevActivity = null;
    if (poseMix < 1) poseMix = reduced ? 1 : clamp((t - poseAt) / poseDur, 0, 1);

    if (!paused && !reduced) {
      if (t >= nextPoseAt) { pickPose(); const e = POSE_EVERY[state] ?? POSE_EVERY.idle; nextPoseAt = t + rand(e[0], e[1]); }
      if (t >= nextBlinkAt) {
        blink.x = 1; blink.t = 0.06;
        setTimeout(() => { blink.t = 1; }, 78);
        const b = BLINK_EVERY[state];
        nextBlinkAt = b ? t + rand(b[0], b[1]) : Infinity;
      }

      bobX.t = Math.sin(t * 0.00042) * 2.6 + Math.sin(t * 0.001) * 0.9;
      bobY.t = Math.sin(t * 0.00058) * 2.0 + Math.sin(t * 0.0013) * 0.7;
      breathe.t = 1 + 0.013 * Math.sin(t * 0.0016);
    }

    if (pointer) {
      const r = svg.getBoundingClientRect();
      if (r.width > 0) {
        const nx = clamp((pointer.x - (r.left + r.width / 2)) / r.width, -0.9, 0.9);
        const ny = clamp((pointer.y - (r.top + r.height / 2)) / r.height, -0.9, 0.9);
        const reach = Math.min(1, Math.hypot(nx, ny));
        const ang = Math.atan2(ny, nx);
        gazeX.t = Math.cos(ang) * reach * C * 0.085;
        gazeY.t = Math.sin(ang) * reach * C * 0.06;
      }
    } else { gazeX.t = 0; gazeY.t = 0; }

    const act = clamp(env.x, 0, 1);
    const wDots = weightOf("dots");
    const wTwinkle = weightOf("twinkle");
    const wOrbit = weightOf("orbit");
    const wRadar = weightOf("radar");
    const wProgress = weightOf("progress");
    const wSqueeze = weightOf("squeeze");
    const wStandby = weightOf("standby");

    let band = 0, warp = null, faceWarp = null;
    if (wSqueeze > 0.004) {
      band = squeezeBand(t, squeezeStart);
      warp = squeezeWarp(band, wSqueeze);
      faceWarp = squeezeWarp(band, wSqueeze, SQ_FACE_GIVE);
    }

    const ring = buildRing(t, wTwinkle);
    const morph = clamp(wDots / MORPH_END, 0, 1);
    let finalRing = morph <= 0 ? ring
      : morph >= 1 ? ORB_RING
      : lerpRing(ring, ORB_RING, easeInOutCubic(morph));

    const layoutRing = finalRing;
    if (warp) finalRing = finalRing.map(([x, y]) => warp(x, y));
    const d = toPath(finalRing);
    if (d !== lastPath) {
      body.setAttribute("d", d);
      clipPath.setAttribute("d", d);
      coreEl?.setAttribute("d", d);
      lastPath = d;
    }
    if (warp) {

      const y = C + (band - SQ_LEAD * 0.5) * C;
      const h = SQ_SIGMA * C * 1.5;
      sweepG.style.display = "";
      sweepG.style.opacity = wSqueeze.toFixed(3);
      sweepGrad.setAttribute("y1", (y - h).toFixed(1));
      sweepGrad.setAttribute("y2", (y + h).toFixed(1));
    } else {
      sweepG.style.display = "none";
    }

    const w1 = wave(t, 1, act, activityStart);
    const bodyR = activity
      ? (BODY_R[activity] ?? C) * clamp(fade.x, 0, 1) +
        (prevActivity ? BODY_R[prevActivity] ?? C : BODY_R[activity] ?? C) * (1 - clamp(fade.x, 0, 1))
      : C;
    const pop = 1 + (w1.pop - 1) * (wDots / Math.max(act, 0.001));
    const rest = 1 - act;
    let scale = rest * breathe.x + (bodyR / C) * act * pop;
    let scaleX = scale, scaleY = scale;
    let tx = C + bobX.x * rest;
    let ty = C + bobY.x * rest - w1.lift * wDots;
    let rot = 0;
    let bodyAlpha = 1 - (1 - w1.tone) * wDots;

    if (wSqueeze > 0.004) {

      const inside = Math.exp(-(band * band) / (2 * 0.72 * 0.72));
      scaleY *= 1 + 0.04 * inside * wSqueeze;
      scaleX *= 1 - 0.014 * inside * wSqueeze;
      ty -= C * 0.01 * inside * wSqueeze;
    }
    if (wStandby > 0.004) bodyAlpha *= 1 - (0.3 + 0.18 * Math.sin(t * 0.0016)) * wStandby;
    if (wProgress > 0.004 || wOrbit > 0.004) rot += Math.sin(t * 0.0009) * 3 * (wProgress + wOrbit);

    bodyG.setAttribute("transform",
      `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot.toFixed(2)}) ` +
      `scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${-C} ${-C})`);
    bodyG.style.opacity = bodyAlpha.toFixed(3);

    if (glowEl) {
      const gl = (rest * breathe.x + act * (bodyR / C)) * (1 + 0.05 * Math.sin(t * 0.0011));
      glowEl.setAttribute("transform",
        `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${gl.toFixed(4)}) translate(${-C} ${-C})`);
      glowEl.style.opacity = (0.55 + 0.45 * wTwinkle).toFixed(3);
    }

    const face = shape.face;
    const [fSize, fGap, fHeight] = FACE_TUNE[state] ?? FACE_DEFAULT;
    const hideEyes = wDots > 0.5;
    eyeG.style.display = hideEyes ? "none" : "";
    if (!hideEyes) {
      const pts = currentPosePoints();
      const socketX = C + face.dx;
      const socketY = C + face.dy - face.ry * 0.05;

      const half = face.rx * 0.42 * fGap;
      const ew = face.rx * 0.78 * fSize * eyeSize.x;
      const eh = face.ry * 0.62 * fSize * fHeight * eyeSize.x * Math.max(blink.x, 0.04);
      const [l, r] = spanAt(layoutRing, socketY + gazeY.x, [C, C]);
      for (let i = 0; i < 2; i++) {
        const dir = i === 0 ? -1 : 1;
        let cx = socketX + dir * half + gazeX.x;
        const cy = socketY + gazeY.x + bobY.x * 0.25;

        cx = clamp(cx, l + ew * 0.8, r - ew * 0.8);
        let placed = pts.map(([x, y]) => [cx + x * ew, cy + y * eh]);
        if (faceWarp) placed = placed.map(([x, y]) => faceWarp(x, y));
        eyes[i].setAttribute("d", polyPath(placed));
      }
    }

    for (const s of sparks) s.style.display = "none";
    for (const r of rings) r.style.display = "none";
    for (const p of dots) p.style.display = "none";

    if (wDots > 0.004) drawDots(wDots, t);
    if (wOrbit > 0.004) drawOrbit(wOrbit, t);
    if (wRadar > 0.004) drawRadar(wRadar, t, (bodyR / C) * C);
    if (wProgress > 0.004) drawProgress(wProgress, t);

    stepParticles(dt);

    const small = 1 - smoothstep(clamp((boxW - ZOOM_SMALL_PX) / (ZOOM_LARGE_PX - ZOOM_SMALL_PX), 0, 1));
    const z = 1 + (DOTS_ZOOM - 1) * wDots * small;
    const zt = z === 1 ? "" :
      `translate(${VIEW_CENTER} ${VIEW_CENTER}) scale(${z.toFixed(4)}) translate(${-VIEW_CENTER} ${-VIEW_CENTER})`;
    if (zt !== lastZoom) { zoomG.setAttribute("transform", zt); lastZoom = zt; }

    const settled = !particles.length &&
      Math.abs(env.x - env.t) < 0.001 && Math.abs(env.v) < 0.001 &&
      poseMix >= 1 && blink.t === 1 && Math.abs(blink.x - 1) < 0.002 &&
      shapeMix.x > 0.999;
    if (reduced && settled) { running = false; raf = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  function drawDots(w, t) {
    const xs = [C - DOT_X, C + DOT_X];
    for (let i = 0; i < 2; i++) {
      const k = clamp((w - i * DOT_STAGGER) / (1 - i * DOT_STAGGER), 0, 1);
      if (k <= 0.004) continue;
      const app = easeOutCubic(k), spread = easeOutBack(k);
      const wv = wave(t, i === 0 ? 0 : 2, w, activityStart);
      const s = (DOT_R * app * wv.pop * DOT_FUDGE) / C;
      const x = C + (xs[i] - C) * spread, y = C - wv.lift;
      dots[i].style.display = "";
      dots[i].setAttribute("transform",
        `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(4)}) translate(${-C} ${-C})`);
      dots[i].setAttribute("opacity", (app * wv.tone).toFixed(3));
    }
  }

  function drawOrbit(w, t) {
    const a0 = t * 0.0016;
    const rx = C * 1.02, ry = C * 0.42;
    for (let i = 0; i < sparks.length; i++) {
      const a = a0 + (i * TAU) / sparks.length;
      const front = 0.5 + 0.5 * clamp(Math.cos(a), 0, 1);
      const el = sparks[i];
      el.style.display = "";
      el.setAttribute("opacity", (clamp((Math.cos(a) + 0.5) / 0.7, 0.2, 1) * w).toFixed(3));
      el.setAttribute("transform",
        `translate(${(C + rx * Math.sin(a)).toFixed(1)} ${(C - ry * Math.cos(a)).toFixed(1)}) ` +
        `rotate(${((a * 40) % 360).toFixed(1)}) scale(${(17 * front * w).toFixed(2)})`);
    }
  }

  function drawRadar(w, t, from) {
    for (let i = 0; i < 3; i++) {
      const p = ((t / 1500 + i / 3) % 1 + 1) % 1;
      const el = rings[i];
      el.style.display = "";
      el.setAttribute("r", (from * 0.72 + (C * 1.2 - from * 0.72) * p).toFixed(1));
      el.setAttribute("stroke-width", (4.2 * (1 - p * 0.55)).toFixed(2));
      el.removeAttribute("stroke-dasharray");
      el.setAttribute("opacity", (w * (1 - p) * 0.75).toFixed(3));
    }
  }

  function drawProgress(w, t) {
    const r = C * 1.06;
    const track = rings[3];
    const circ = TAU * r;
    const p = clamp(((t - activityStart) / 2600) % 1, 0, 1);
    track.style.display = "";
    track.setAttribute("r", r.toFixed(1));
    track.setAttribute("stroke-width", "5");
    track.setAttribute("stroke-dasharray", `${(circ * 0.28).toFixed(1)} ${(circ * 0.72).toFixed(1)}`);
    track.setAttribute("stroke-dashoffset", (-circ * p).toFixed(1));
    track.setAttribute("stroke-linecap", "round");
    track.setAttribute("opacity", (w * 0.9).toFixed(3));
  }

  function wake() {
    if (destroyed || running) return;
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }

  const onPointerMove = (e) => { pointer = { x: e.clientX, y: e.clientY }; wake(); };
  const onPointerLeave = () => { pointer = null; };
  if (o.followPointer && !reduced) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
  }

  applyStateInitial();
  function applyStateInitial() {
    const pool = POSES[state] ?? POSES.idle;
    poseCur = poseFrom = EYE_POSES[pool[0]] ?? EYE_POSES.neutral;
    scheduleFace(0);
    if (activity === "squeeze") squeezeStart = 0;
    env.x = 0; env.t = activity ? 1 : 0;
  }
  wake();

  return {
    el: svg,
    get state() { return state; },
    setState: (s) => applyState(s),
    setShape(name) {
      const next = SHAPES[name];
      if (!next || next === shape) return;
      shapeFrom = shape; shape = next; shapeName = name;
      shapeMix.x = 0; shapeMix.v = 0; shapeMix.t = 1;
      wake();
    },
    get shape() { return shapeName; },
    setGaze(p) { pointer = p; wake(); },
    sparkle: (n) => burst(n),
    pause() { paused = true; },
    resume() { paused = false; last = 0; wake(); },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      svg.remove();
    },
  };
}

export { SHAPES, C, VIEWBOX, squeezeBand, squeezeWarp, SQ_CYCLE };
