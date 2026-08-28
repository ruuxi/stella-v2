import { TAU, clamp, toPath, polyPath, spanAt, profileMax } from "./geometry.js";
import { N, C, BLEED, VIEWBOX, SHAPES, SPARKLE_PATH } from "./shapes.js";
import { EYE_POSES, lerpPose } from "./eyes.js";

const SVGNS = "http://www.w3.org/2000/svg";

const spring = (v) => ({ x: v, v: 0, t: v });
const stepSpring = (s, w, z, dt) => {
  s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) { s.x = s.t; s.v = 0; }
};
const SUBSTEP = 1 / 120;

const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoothstep = (t) => t * t * (3 - 2 * t);
const rand = (a, b) => a + Math.random() * (b - a);

const ZOOM_SMALL_PX = 44, ZOOM_LARGE_PX = 134;

const ENV_W = 14, ENV_Z = 1;
const FADE_W = 11, FADE_Z = 1;

const SPIN_CELL = 100;
const SPIN_CX = 50, SPIN_TIP_Y = 92, SPIN_TOP_Y = 16;
const SPIN_MID_Y = (SPIN_TIP_Y + SPIN_TOP_Y) / 2;
const SPIN_HALF_H = (SPIN_TIP_Y - SPIN_TOP_Y) / 2;

const SPIN_SCALE = (C * 2 + BLEED * 2) / SPIN_CELL;
const SPIN_ZOOM_Y = 56;
const SPINNER_ZOOM = 1.22;

const SPIN_TILT = 12, SPIN_PRECESS_MS = 2100;
const SPIN_NUT_AMP = 0, SPIN_NUT_MS = 730;
const SPIN_SHEEN_MS = 200;
const SPIN_TRAVEL = 1, SPIN_TRAVEL_MS = 2100;
const SPIN_BANK = 0, SPIN_BOB = 1;
const SPIN_ASPECT = 0.68, SPIN_CONCAVITY = 0.6;

const SPIN_HALF_TRAVEL_FRAC = 0.53;

const SPIN_ORBIT_MS = 950;
const SPIN_DOT_STATIONS = [Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
const SPIN_PARK_Y = SPIN_MID_Y + 2;
const SPIN_DROP_W = 10.5, SPIN_DROP_Z = 0.88;
const SPIN_PICK_MS = 500;
const SPIN_DOT_SUBSTEP = 1 / 120;
const SPIN_DROP_ARM_MS = 650;
const SPIN_DROP_SPEED_CAP = 170;
const SPIN_DOT_R = 6.4;

const SPIN_INK = ["#ff4ac0", "#a141ff", "#5243ff", "#0e8aff", "#4ffff7"];
const SPIN_SHEEN = [
  ["#ffffff", 0, 0], ["#ffffff", 0.1, 0.12], ["#ffffff", 0.17, 0.22],
  ["#ffffff", 0.1, 0.32], ["#ffffff", 0, 0.46],
  ["#000000", 0, 0.54], ["#000000", 0.09, 0.66], ["#000000", 0.13, 0.76],
  ["#000000", 0.09, 0.86], ["#000000", 0, 0.97], ["#ffffff", 0, 1],
];

const SPIN_BLOB_MIN = 30 / 92;

function diamondPath(aspect, concavity) {
  const halfW = SPIN_HALF_H * aspect;
  const k = 1 - concavity;
  const wx = halfW * k, wy = SPIN_HALF_H * k;
  const pTop = [SPIN_CX, SPIN_MID_Y - SPIN_HALF_H], pRight = [SPIN_CX + halfW, SPIN_MID_Y];
  const pBot = [SPIN_CX, SPIN_MID_Y + SPIN_HALF_H], pLeft = [SPIN_CX - halfW, SPIN_MID_Y];
  const q = (ctrl, to) => `Q${ctrl[0].toFixed(2)} ${ctrl[1].toFixed(2)} ${to[0].toFixed(2)} ${to[1].toFixed(2)}`;
  return `M${pTop[0]} ${pTop[1].toFixed(2)} ` +
    q([SPIN_CX + wx * 0.55, SPIN_MID_Y - wy * 0.55], pRight) + " " +
    q([SPIN_CX + wx * 0.55, SPIN_MID_Y + wy * 0.55], pBot) + " " +
    q([SPIN_CX - wx * 0.55, SPIN_MID_Y + wy * 0.55], pLeft) + " " +
    q([SPIN_CX - wx * 0.55, SPIN_MID_Y - wy * 0.55], pTop) + "Z";
}

const SPIN_DIAMOND_PATH = diamondPath(SPIN_ASPECT, SPIN_CONCAVITY);

function stepDotSpring(st, txp, typ, w, z, dt) {
  const sub = Math.max(1, Math.ceil(dt / SPIN_DOT_SUBSTEP));
  const h = dt / sub;
  for (let k = 0; k < sub; k++) {
    st.vx += (-2 * z * w * st.vx - w * w * (st.x - txp)) * h;
    st.vy += (-2 * z * w * st.vy - w * w * (st.y - typ)) * h;
    st.x += st.vx * h;
    st.y += st.vy * h;
  }
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

export const ACTIVITIES = ["spinner", "twinkle", "orbit", "radar", "progress", "squeeze", "standby"];

const ACTIVITY_OF = {
  thinking: "spinner",
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
  spinner: C,
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

  const spinInkGrad = document.createElementNS(SVGNS, "linearGradient");
  spinInkGrad.id = `${id}-tink`;
  spinInkGrad.setAttribute("x1", "0"); spinInkGrad.setAttribute("y1", "0");
  spinInkGrad.setAttribute("x2", "0"); spinInkGrad.setAttribute("y2", "1");
  for (let i = 0; i < SPIN_INK.length; i++) {
    const st = document.createElementNS(SVGNS, "stop");
    st.setAttribute("offset", (i / (SPIN_INK.length - 1)).toFixed(3));
    st.setAttribute("stop-color", SPIN_INK[i]);
    spinInkGrad.appendChild(st);
  }
  defs.appendChild(spinInkGrad);

  const spinSheenGrad = document.createElementNS(SVGNS, "linearGradient");
  spinSheenGrad.id = `${id}-tspin`;
  spinSheenGrad.setAttribute("x1", "0"); spinSheenGrad.setAttribute("y1", "0");
  spinSheenGrad.setAttribute("x2", "1"); spinSheenGrad.setAttribute("y2", "0");
  spinSheenGrad.setAttribute("spreadMethod", "repeat");
  for (const [color, op, off] of SPIN_SHEEN) {
    const st = document.createElementNS(SVGNS, "stop");
    st.setAttribute("offset", off);
    st.setAttribute("stop-color", color);
    st.setAttribute("stop-opacity", op);
    spinSheenGrad.appendChild(st);
  }
  defs.appendChild(spinSheenGrad);

  const spinInk = `url(#${id}-tink)`;

  const spinnerRoot = document.createElementNS(SVGNS, "g");
  spinnerRoot.setAttribute("transform", `translate(${-BLEED} ${-BLEED}) scale(${SPIN_SCALE.toFixed(6)})`);
  spinnerRoot.style.display = "none";
  const spinZoomG = document.createElementNS(SVGNS, "g");
  spinnerRoot.appendChild(spinZoomG);
  const spinDotBackG = document.createElementNS(SVGNS, "g");
  spinZoomG.appendChild(spinDotBackG);
  const spinTravelG = document.createElementNS(SVGNS, "g");
  const spinLeanG = document.createElementNS(SVGNS, "g");
  const spinLens = document.createElementNS(SVGNS, "ellipse");
  spinLens.setAttribute("fill", spinInk);
  spinLeanG.appendChild(spinLens);
  const spinCore = document.createElementNS(SVGNS, "path");
  spinCore.setAttribute("d", SPIN_DIAMOND_PATH);
  spinCore.setAttribute("fill", spinInk);
  spinLeanG.appendChild(spinCore);
  const spinLight = document.createElementNS(SVGNS, "path");
  spinLight.setAttribute("d", SPIN_DIAMOND_PATH);
  spinLight.setAttribute("fill", `url(#${id}-tspin)`);
  spinLeanG.appendChild(spinLight);
  spinTravelG.appendChild(spinLeanG);
  spinZoomG.appendChild(spinTravelG);
  const spinDotFrontG = document.createElementNS(SVGNS, "g");
  spinZoomG.appendChild(spinDotFrontG);
  const spinDots = [0, 1, 2].map(() => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("fill", spinInk);
    spinDotFrontG.appendChild(c);
    return c;
  });
  zoomG.appendChild(spinnerRoot);

  const spinDotState = [0, 1, 2].map(() => ({
    mode: "orbit", armedAt: 0, x: 0, y: 0, vx: 0, vy: 0,
    px: null, py: null, pickAt: 0, fx: 0, fy: 0,
  }));
  const spinPhase = Math.random() * SPIN_TRAVEL_MS;
  let spinLastU = null, spinShown = false, spinLastZoom = "";

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
  let lastPath = "";
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
    const wSpinner = weightOf("spinner");
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
    let finalRing = ring;

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

    const spin = updateSpinner(wSpinner, t, dt);

    const bodyR = activity
      ? (BODY_R[activity] ?? C) * clamp(fade.x, 0, 1) +
        (prevActivity ? BODY_R[prevActivity] ?? C : BODY_R[activity] ?? C) * (1 - clamp(fade.x, 0, 1))
      : C;
    const rest = 1 - act;
    let scale = rest * breathe.x + (bodyR / C) * act;
    let scaleX = scale, scaleY = scale;
    let tx = C + bobX.x * rest;
    let ty = C + bobY.x * rest;
    let rot = 0;
    let bodyAlpha = 1;
    let shrink = 1;

    if (spin) {

      const grow = easeOutBack(clamp(1 - wSpinner, 0, 1));
      shrink = SPIN_BLOB_MIN + (1 - SPIN_BLOB_MIN) * grow;
      scaleX *= shrink; scaleY *= shrink;
      tx += (spin.x - C) * wSpinner;
      ty += (spin.y - C) * wSpinner;
      bodyAlpha *= clamp((0.75 - wSpinner) / 0.5, 0, 1);
    }

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
      const gl = (rest * breathe.x + act * (bodyR / C)) * shrink * (1 + 0.05 * Math.sin(t * 0.0011));
      glowEl.setAttribute("transform",
        `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${gl.toFixed(4)}) translate(${-C} ${-C})`);
      glowEl.style.opacity = ((0.55 + 0.45 * wTwinkle) * (1 - wSpinner)).toFixed(3);
    }

    const face = shape.face;
    const [fSize, fGap, fHeight] = FACE_TUNE[state] ?? FACE_DEFAULT;
    const hideEyes = wSpinner > 0.5;
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

    if (wOrbit > 0.004) drawOrbit(wOrbit, t);
    if (wRadar > 0.004) drawRadar(wRadar, t, (bodyR / C) * C);
    if (wProgress > 0.004) drawProgress(wProgress, t);

    stepParticles(dt);

    const settled = !particles.length &&
      Math.abs(env.x - env.t) < 0.001 && Math.abs(env.v) < 0.001 &&
      poseMix >= 1 && blink.t === 1 && Math.abs(blink.x - 1) < 0.002 &&
      shapeMix.x > 0.999;
    if (reduced && settled) { running = false; raf = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  const spinToRig = (x, y, zoom) => [
    -BLEED + (SPIN_CX + (x - SPIN_CX) * zoom) * SPIN_SCALE,
    -BLEED + (SPIN_ZOOM_Y + (y - SPIN_ZOOM_Y) * zoom) * SPIN_SCALE,
  ];

  function updateSpinner(w, t, dt) {
    if (w <= 0.004) {
      if (spinShown) {
        spinnerRoot.style.display = "none";
        spinShown = false;
        spinLastU = null;
        for (const st of spinDotState) { st.mode = "orbit"; st.px = null; st.py = null; }
      }
      return null;
    }
    if (!spinShown) { spinnerRoot.style.display = ""; spinShown = true; }

    const still = reduced;
    const small = 1 - smoothstep(clamp((boxW - ZOOM_SMALL_PX) / (ZOOM_LARGE_PX - ZOOM_SMALL_PX), 0, 1));
    const zoom = 1 + (SPINNER_ZOOM - 1) * small;
    const zt = `translate(${SPIN_CX} ${SPIN_ZOOM_Y}) scale(${zoom.toFixed(4)}) translate(${-SPIN_CX} ${-SPIN_ZOOM_Y})`;
    if (zt !== spinLastZoom) { spinZoomG.setAttribute("transform", zt); spinLastZoom = zt; }

    const tt = t + spinPhase;

    const u = (TAU * tt) / SPIN_TRAVEL_MS;
    const ampX = still ? 0 : ((SPIN_HALF_TRAVEL_FRAC * SPIN_CELL) / zoom) * SPIN_TRAVEL;
    const ampY = ampX * 0.14;
    const trX = -ampX * Math.sin(u) * w;
    const depth = -ampY * Math.sin(2 * u) * w;
    const hop = (still ? 0 : Math.max(0, SPIN_BOB * Math.sin((TAU * tt) / SPIN_NUT_MS + 1.3))) * w;
    const trY = depth - hop;
    const vx = -Math.cos(u);

    const bank = still ? 0 : SPIN_BANK * vx * SPIN_TRAVEL;
    const theta = still ? 0 : (SPIN_TILT + SPIN_NUT_AMP * Math.sin((TAU * tt) / SPIN_NUT_MS)) * (Math.PI / 180);
    const phi = (TAU * tt) / SPIN_PRECESS_MS;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    const precessLean = Math.atan2(sinT * Math.sin(phi), cosT) * (180 / Math.PI);
    const lean = (bank + precessLean) * w;
    const axisLen = Math.hypot(sinT * Math.sin(phi), cosT);
    const facing = sinT * Math.cos(phi);

    const leanRad = lean * (Math.PI / 180);
    const bodySy = 1 - (1 - axisLen) * w;
    const bodyD = (SPIN_MID_Y * 0.92 - SPIN_TIP_Y) * bodySy;
    const bodyX = SPIN_CX + trX - Math.sin(leanRad) * bodyD;
    const bodyY = SPIN_TIP_Y + trY + Math.cos(leanRad) * bodyD;

    const orbitRx = SPIN_HALF_H * SPIN_ASPECT * 1.75, orbitRy = SPIN_HALF_H * 0.34;
    const leanCos = Math.cos(leanRad), leanSin = Math.sin(leanRad);
    const orbitAngleOf = (i) => (TAU * tt) / SPIN_ORBIT_MS + (i * TAU) / 3;
    const orbitPos = (i) => {
      const a = orbitAngleOf(i);
      const ox = orbitRx * Math.sin(a), oy = -orbitRy * Math.cos(a);
      return [bodyX + ox * leanCos - oy * leanSin, bodyY + ox * leanSin + oy * leanCos];
    };

    const dotsOn = !still && w > 0.5;
    const dtSec = Math.min(dt, 0.05);
    if (dotsOn) {
      const lap = ((Math.floor(u / TAU) % 2) + 2) % 2;
      const wrapU = ((u % TAU) + TAU) % TAU;
      const prevU = spinLastU;
      const crossed = (a) => {
        if (prevU === null) return false;
        const d = wrapU - prevU;
        return d >= 0 && d < Math.PI && prevU < a && wrapU >= a;
      };
      for (let i = 0; i < 3; i++) {
        const st = spinDotState[i];
        if (!crossed(SPIN_DOT_STATIONS[i])) continue;
        if (lap === 0 && st.mode === "orbit") {
          st.mode = "armedDrop"; st.armedAt = t;
        } else if (lap === 1 && st.mode === "parked") {
          st.mode = "toOrbit"; st.vx = 0; st.vy = 0;
          st.pickAt = t; st.fx = st.x; st.fy = st.y;
        }
      }
      spinLastU = wrapU;
    }

    for (let i = 0; i < 3; i++) {
      const dot = spinDots[i];
      const st = spinDotState[i];
      if (!dotsOn) {
        st.mode = "orbit"; st.px = null; st.py = null;
        dot.style.display = "none";
        continue;
      }
      const stationX = SPIN_CX - Math.sin(SPIN_DOT_STATIONS[i]) * ampX;
      let front = true, park = 0;
      if (st.mode === "orbit" || st.mode === "armedDrop") {
        const [ox, oy] = orbitPos(i);
        front = Math.cos(orbitAngleOf(i)) >= 0;
        const vx0 = st.px === null ? 0 : (ox - st.px) / Math.max(dtSec, 1e-3);
        const vy0 = st.py === null ? 0 : (oy - st.py) / Math.max(dtSec, 1e-3);
        st.px = ox; st.py = oy;
        st.x = ox; st.y = oy;
        if (st.mode === "armedDrop") {
          const dx = stationX - ox, dy = SPIN_PARK_Y - oy;
          const dist = Math.hypot(dx, dy) || 1;
          const speed = Math.hypot(vx0, vy0) || 1;
          const aligned = (vx0 * dx + vy0 * dy) / (dist * speed);
          if (aligned > 0.55 || t - st.armedAt > SPIN_DROP_ARM_MS) {
            st.mode = "toPark";
            const kv = Math.min(1, SPIN_DROP_SPEED_CAP / speed);
            st.vx = vx0 * kv; st.vy = vy0 * kv;
          }
        }
      } else if (st.mode === "toPark") {
        stepDotSpring(st, stationX, SPIN_PARK_Y, SPIN_DROP_W, SPIN_DROP_Z, dtSec);
        if (Math.hypot(st.x - stationX, st.y - SPIN_PARK_Y) < 0.5 &&
            Math.hypot(st.vx, st.vy) < 6) {
          st.mode = "parked"; st.x = stationX; st.y = SPIN_PARK_Y;
        }
        park = 1;
      } else if (st.mode === "parked") {
        st.x = stationX; st.y = SPIN_PARK_Y;
        park = 1;
      } else if (st.mode === "toOrbit") {
        const [ox, oy] = orbitPos(i);
        const p = clamp((t - st.pickAt) / SPIN_PICK_MS, 0, 1);
        const e = easeInOutCubic(p);
        st.x = st.fx + (ox - st.fx) * e;
        st.y = st.fy + (oy - st.fy) * e;
        front = true;
        if (p >= 1) { st.mode = "orbit"; st.px = null; st.py = null; }
      }
      const wantParent = front || park ? spinDotFrontG : spinDotBackG;
      if (dot.parentNode !== wantParent) wantParent.appendChild(dot);
      const dep = front || park ? 1 : 0.72;
      dot.style.display = "";
      dot.setAttribute("cx", st.x.toFixed(1));
      dot.setAttribute("cy", st.y.toFixed(1));
      dot.setAttribute("r", (SPIN_DOT_R * (park ? 1.12 : dep)).toFixed(2));
      dot.setAttribute("opacity", ((park ? 0.9 : 0.85 * dep) * w).toFixed(3));
    }

    spinTravelG.setAttribute("transform", `translate(${trX.toFixed(2)} ${trY.toFixed(2)})`);
    spinLeanG.setAttribute("transform",
      `translate(${SPIN_CX} ${SPIN_TIP_Y}) rotate(${lean.toFixed(2)}) ` +
      `scale(1 ${bodySy.toFixed(4)}) translate(${-SPIN_CX} ${-SPIN_TIP_Y})`);

    const sheenPhase = still ? 0 : (((tt / SPIN_SHEEN_MS) % 1) + 1) % 1;
    spinSheenGrad.setAttribute("gradientTransform", `translate(${(-sheenPhase).toFixed(4)} 0)`);

    spinLeanG.style.opacity = clamp(1 - (1 - w) / 0.45, 0, 1).toFixed(3);

    const halfW = SPIN_HALF_H * SPIN_ASPECT;
    if (!still) {
      const open = Math.abs(facing);
      spinLens.style.display = "";
      spinLens.setAttribute("cx", SPIN_CX);
      spinLens.setAttribute("cy", SPIN_MID_Y);
      spinLens.setAttribute("rx", (halfW * (1.32 + 0.2 * open)).toFixed(2));
      spinLens.setAttribute("ry", (halfW * (0.16 + 0.55 * open)).toFixed(2));
      spinLens.setAttribute("opacity", (0.16 + 0.1 * open).toFixed(3));
    } else spinLens.style.display = "none";

    const [rx, ry] = spinToRig(bodyX, bodyY, zoom);
    return { x: rx, y: ry };
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
