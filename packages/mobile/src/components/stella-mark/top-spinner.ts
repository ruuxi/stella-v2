const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const CELL = 100;
export const CX = 50;
export const TIP_Y = 92;
export const TOP_Y = 16;
export const MID_Y = (TIP_Y + TOP_Y) / 2;
export const HALF_H = (TIP_Y - TOP_Y) / 2;

export const ASPECT = 0.68;
export const CONCAVITY = 0.6;
export const HALF_W = HALF_H * ASPECT;

export const INK_RAMP = [
  "#ff4ac0",
  "#a141ff",
  "#5243ff",
  "#0e8aff",
  "#4ffff7",
];

export const TILT_DEG = 12;
export const PRECESS_MS = 2100;
export const NUT_AMP_DEG = 0;
export const NUT_MS = 730;
export const SPIN_MS = 200;
export const TRAVEL = 1;
export const TRAVEL_MS = 2100;
export const BANK_DEG = 0;
export const BOB = 1.0;

export const SPIN_ZOOM = 1.2;
export const ZOOM_PIVOT_Y = 56;

export const TRAVEL_HALF_RATIO = 18 / 34;
export const AMP_X = ((TRAVEL_HALF_RATIO * CELL) / SPIN_ZOOM) * TRAVEL;
export const AMP_Y = AMP_X * 0.14;

export const ORBIT_MS = 950;
export const ORBIT_RX = HALF_H * ASPECT * 1.75;
export const ORBIT_RY = HALF_H * 0.34;
export const DOT_STATIONS = [Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
export const PARK_Y = MID_Y + 2;
export const DROP_W = 10.5;
export const DROP_Z = 0.88;
export const DROP_SPEED_CAP = 170;
export const DROP_ALIGNMENT = 0.55;
export const DROP_ARM_TIMEOUT_MS = 650;
export const DOT_SUBSTEP = 1 / 120;
export const PICK_MS = 500;
export const DOT_BASE_R = 6.4;

export const MORPH_MS = 480;

export const DOT_EXTRA = 60;
export const DOT_VIEW_SPAN = CELL + DOT_EXTRA * 2;

export const MODE_ORBIT = 0;
export const MODE_ARMED = 1;
export const MODE_TO_PARK = 2;
export const MODE_PARKED = 3;
export const MODE_TO_ORBIT = 4;

const S_MODE = 0;
const S_ARMED_AT = 1;
const S_X = 2;
const S_Y = 3;
const S_VX = 4;
const S_VY = 5;
const S_PX = 6;
const S_PY = 7;
const S_HAS_PREV = 8;
const S_PICK_AT = 9;
const S_FX = 10;
const S_FY = 11;
const S_STRIDE = 12;
const S_LAST_U = 36;
export const DOT_STATE_LENGTH = 37;

export function makeDotState(): number[] {
  "worklet";
  const state: number[] = [];
  for (let i = 0; i < DOT_STATE_LENGTH; i += 1) state.push(0);
  return state;
}

export function clamp(v: number, a: number, b: number): number {
  "worklet";
  return v < a ? a : v > b ? b : v;
}

export function easeInOutCubic(t: number): number {
  "worklet";
  const c = clamp(t, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function easeOutBack(t: number): number {
  "worklet";
  const c = clamp(t, 0, 1);
  const inv = c - 1;
  return 1 + 2.70158 * inv * inv * inv + 1.70158 * inv * inv;
}

export function diamondPath(aspect: number, concavity: number): string {
  "worklet";
  const halfW = HALF_H * aspect;
  const k = 1 - concavity;
  const wx = halfW * k;
  const wy = HALF_H * k;
  const q = (cxp: number, cyp: number, xp: number, yp: number) =>
    `Q${cxp.toFixed(2)} ${cyp.toFixed(2)} ${xp.toFixed(2)} ${yp.toFixed(2)}`;
  return (
    `M${CX} ${(MID_Y - HALF_H).toFixed(2)} ` +
    q(CX + wx * 0.55, MID_Y - wy * 0.55, CX + halfW, MID_Y) +
    " " +
    q(CX + wx * 0.55, MID_Y + wy * 0.55, CX, MID_Y + HALF_H) +
    " " +
    q(CX - wx * 0.55, MID_Y + wy * 0.55, CX - halfW, MID_Y) +
    " " +
    q(CX - wx * 0.55, MID_Y - wy * 0.55, CX, MID_Y - HALF_H) +
    "Z"
  );
}

export const DIAMOND_PATH = diamondPath(ASPECT, CONCAVITY);

export const SHEEN_PERIOD = HALF_W * 2;
export const SHEEN_PERIODS = 4;
export const SHEEN_WIDTH = SHEEN_PERIOD * SHEEN_PERIODS;
export const SHEEN_X0 = CX - HALF_W - SHEEN_PERIOD;

const SHEEN_BAND: [number, string, number][] = [
  [0, "#ffffff", 0],
  [0.12, "#ffffff", 0.1],
  [0.22, "#ffffff", 0.17],
  [0.32, "#ffffff", 0.1],
  [0.46, "#ffffff", 0],
  [0.54, "#000000", 0],
  [0.66, "#000000", 0.09],
  [0.76, "#000000", 0.13],
  [0.86, "#000000", 0.09],
  [0.97, "#000000", 0],
  [1, "#ffffff", 0],
];

export const SHEEN_STOPS: { offset: number; color: string; opacity: number }[] =
  (() => {
    const out: { offset: number; color: string; opacity: number }[] = [];
    for (let p = 0; p < SHEEN_PERIODS; p += 1) {
      const last = p === SHEEN_PERIODS - 1;
      for (let i = 0; i < SHEEN_BAND.length; i += 1) {
        if (!last && i === SHEEN_BAND.length - 1) continue;
        const band = SHEEN_BAND[i];
        out.push({
          offset: (p + band[0]) / SHEEN_PERIODS,
          color: band[1],
          opacity: band[2],
        });
      }
    }
    return out;
  })();

export interface SpinnerFrame {
  tx: number;
  ty: number;
  lean: number;
  bodySy: number;
  bodyOpacity: number;
  zoom: number;
  sheenX: number;
  lensRx: number;
  lensRy: number;
  lensOpacity: number;
  blobScale: number;
  blobY: number;
  blobOpacity: number;
  dotX: number[];
  dotY: number[];
  dotR: number[];
  dotFront: number[];
  dotBack: number[];
}

function stepDotSpring(
  state: number[],
  base: number,
  targetX: number,
  targetY: number,
  w: number,
  z: number,
  dt: number,
): void {
  "worklet";
  const sub = Math.max(1, Math.ceil(dt / DOT_SUBSTEP));
  const h = dt / sub;
  for (let k = 0; k < sub; k += 1) {
    state[base + S_VX] +=
      (-2 * z * w * state[base + S_VX] -
        w * w * (state[base + S_X] - targetX)) *
      h;
    state[base + S_VY] +=
      (-2 * z * w * state[base + S_VY] -
        w * w * (state[base + S_Y] - targetY)) *
      h;
    state[base + S_X] += state[base + S_VX] * h;
    state[base + S_Y] += state[base + S_VY] * h;
  }
}

export function computeSpinnerFrame(
  now: number,
  dtSec: number,
  morph: number,
  still: boolean,
  state: number[],
): SpinnerFrame {
  "worklet";
  const mo = clamp(morph, 0, 1);
  const spinnerW = 1 - mo;
  const t = now;

  const u = (TAU * t) / TRAVEL_MS;
  const ampX = still ? 0 : AMP_X;
  const ampY = still ? 0 : AMP_Y;
  const tx = -ampX * Math.sin(u) * spinnerW;
  const depth = -ampY * Math.sin(2 * u) * spinnerW;
  const hop =
    (still ? 0 : Math.max(0, BOB * Math.sin((TAU * t) / NUT_MS + 1.3))) *
    spinnerW;
  const ty = depth - hop;
  const vxDir = -Math.cos(u);

  const bank = still ? 0 : BANK_DEG * vxDir * TRAVEL;
  const theta = still
    ? 0
    : (TILT_DEG + NUT_AMP_DEG * Math.sin((TAU * t) / NUT_MS)) * DEG;
  const phi = (TAU * t) / PRECESS_MS;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const precessLean = Math.atan2(sinT * Math.sin(phi), cosT) * RAD;
  const lean = (bank + precessLean) * spinnerW;
  const axisLen = Math.hypot(sinT * Math.sin(phi), cosT);
  const facing = sinT * Math.cos(phi);

  const leanRad = lean * DEG;
  const bodySy = 1 - (1 - axisLen) * spinnerW;
  const bodyD = (MID_Y * 0.92 - TIP_Y) * bodySy;
  const bodyX = CX + tx - Math.sin(leanRad) * bodyD;
  const bodyY = TIP_Y + ty + Math.cos(leanRad) * bodyD;
  const leanCos = Math.cos(leanRad);
  const leanSin = Math.sin(leanRad);

  const dotsOn = !still && spinnerW > 0.5;

  if (dotsOn) {
    const lap = ((Math.floor(u / TAU) % 2) + 2) % 2;
    const wrapU = ((u % TAU) + TAU) % TAU;
    const prevU = state[S_LAST_U];
    const delta = wrapU - prevU;
    const sweeping = delta >= 0 && delta < Math.PI;
    for (let i = 0; i < 3; i += 1) {
      const station = DOT_STATIONS[i];
      if (!(sweeping && prevU < station && wrapU >= station)) continue;
      const base = i * S_STRIDE;
      if (lap === 0 && state[base + S_MODE] === MODE_ORBIT) {
        state[base + S_MODE] = MODE_ARMED;
        state[base + S_ARMED_AT] = now;
      } else if (lap === 1 && state[base + S_MODE] === MODE_PARKED) {
        state[base + S_MODE] = MODE_TO_ORBIT;
        state[base + S_VX] = 0;
        state[base + S_VY] = 0;
        state[base + S_PICK_AT] = now;
        state[base + S_FX] = state[base + S_X];
        state[base + S_FY] = state[base + S_Y];
      }
    }
    state[S_LAST_U] = wrapU;
  }

  const dotX = [0, 0, 0];
  const dotY = [0, 0, 0];
  const dotR = [0, 0, 0];
  const dotFront = [0, 0, 0];
  const dotBack = [0, 0, 0];

  for (let i = 0; i < 3; i += 1) {
    const base = i * S_STRIDE;
    if (!dotsOn) {
      state[base + S_MODE] = MODE_ORBIT;
      state[base + S_HAS_PREV] = 0;
      continue;
    }
    const stationX = CX - Math.sin(DOT_STATIONS[i]) * ampX;
    const angle = (TAU * t) / ORBIT_MS + (i * TAU) / 3;
    const rx = ORBIT_RX * Math.sin(angle);
    const ry = -ORBIT_RY * Math.cos(angle);
    const ox = bodyX + rx * leanCos - ry * leanSin;
    const oy = bodyY + rx * leanSin + ry * leanCos;

    let front = true;
    let park = false;
    const mode = state[base + S_MODE];

    if (mode === MODE_ORBIT || mode === MODE_ARMED) {
      front = Math.cos(angle) >= 0;
      const hasPrev = state[base + S_HAS_PREV] === 1;
      const step = Math.max(dtSec, 1e-3);
      const vx0 = hasPrev ? (ox - state[base + S_PX]) / step : 0;
      const vy0 = hasPrev ? (oy - state[base + S_PY]) / step : 0;
      state[base + S_PX] = ox;
      state[base + S_PY] = oy;
      state[base + S_HAS_PREV] = 1;
      state[base + S_X] = ox;
      state[base + S_Y] = oy;
      if (mode === MODE_ARMED) {
        const dx = stationX - ox;
        const dy = PARK_Y - oy;
        const dist = Math.hypot(dx, dy) || 1;
        const speed = Math.hypot(vx0, vy0) || 1;
        const aligned = (vx0 * dx + vy0 * dy) / (dist * speed);
        if (
          aligned > DROP_ALIGNMENT ||
          now - state[base + S_ARMED_AT] > DROP_ARM_TIMEOUT_MS
        ) {
          state[base + S_MODE] = MODE_TO_PARK;
          const kv = Math.min(1, DROP_SPEED_CAP / speed);
          state[base + S_VX] = vx0 * kv;
          state[base + S_VY] = vy0 * kv;
        }
      }
    } else if (mode === MODE_TO_PARK) {
      stepDotSpring(state, base, stationX, PARK_Y, DROP_W, DROP_Z, dtSec);
      if (
        Math.hypot(state[base + S_X] - stationX, state[base + S_Y] - PARK_Y) <
          0.5 &&
        Math.hypot(state[base + S_VX], state[base + S_VY]) < 6
      ) {
        state[base + S_MODE] = MODE_PARKED;
        state[base + S_X] = stationX;
        state[base + S_Y] = PARK_Y;
      }
      park = true;
    } else if (mode === MODE_PARKED) {
      state[base + S_X] = stationX;
      state[base + S_Y] = PARK_Y;
      park = true;
    } else if (mode === MODE_TO_ORBIT) {
      const p = clamp((now - state[base + S_PICK_AT]) / PICK_MS, 0, 1);
      const e = easeInOutCubic(p);
      state[base + S_X] = state[base + S_FX] + (ox - state[base + S_FX]) * e;
      state[base + S_Y] = state[base + S_FY] + (oy - state[base + S_FY]) * e;
      front = true;
      if (p >= 1) {
        state[base + S_MODE] = MODE_ORBIT;
        state[base + S_HAS_PREV] = 0;
      }
    }

    const near = front || park;
    const depthScale = near ? 1 : 0.72;
    const opacity = (park ? 0.9 : 0.85 * depthScale) * spinnerW;
    dotX[i] = state[base + S_X];
    dotY[i] = state[base + S_Y];
    dotR[i] = DOT_BASE_R * (park ? 1.12 : depthScale);
    dotFront[i] = near ? opacity : 0;
    dotBack[i] = near ? 0 : opacity;
  }

  const spinPhase = still ? 0 : (((t / SPIN_MS) % 1) + 1) % 1;
  const open = Math.abs(facing);
  const lensOn = !still && mo < 0.999;
  const grow = easeOutBack(mo);

  return {
    tx,
    ty,
    lean,
    bodySy,
    bodyOpacity: clamp(1 - mo / 0.45, 0, 1),
    zoom: 1 + (SPIN_ZOOM - 1) * spinnerW,
    sheenX: SHEEN_X0 - spinPhase * SHEEN_PERIOD,
    lensRx: HALF_W * (1.32 + 0.2 * open),
    lensRy: HALF_W * (0.16 + 0.55 * open),
    lensOpacity: lensOn ? 0.16 + 0.1 * open : 0,
    blobScale: (30 + 70 * grow) / CELL,
    blobY: (TIP_Y - CELL / 2) * (1 - mo) * 0.4,
    blobOpacity: clamp((mo - 0.25) / 0.5, 0, 1),
    dotX,
    dotY,
    dotR,
    dotFront,
    dotBack,
  };
}
