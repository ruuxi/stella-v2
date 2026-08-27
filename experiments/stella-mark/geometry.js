// Shared geometry helpers for the Stella character mark.
// No dependencies. Everything works on closed rings of N points.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Flatten an SVG path string into a polyline of roughly `step`-spaced points.
 * Handles M/L/C/Q/Z, absolute and relative. Ported in spirit from the same
 * trick Grok Bot uses: sample once at build time, then only ever lerp rings.
 */
export function flattenPath(d, step = 1.2) {
  const tk = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0, cmd = "", rel = false, x = 0, y = 0, sx = 0, sy = 0;
  const num = () => parseFloat(tk[i++]);
  const emit = (fn, len) => {
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) out.push(fn(k / n));
  };
  while (i < tk.length) {
    if (/[a-z]/i.test(tk[i])) { rel = tk[i] === tk[i].toLowerCase(); cmd = tk[i++].toUpperCase(); }
    if (cmd === "Z") {
      if (Math.hypot(sx - x, sy - y) > 0.01) {
        const ax = x, ay = y;
        emit((t) => [ax + (sx - ax) * t, ay + (sy - ay) * t], Math.hypot(sx - ax, sy - ay));
      }
      x = sx; y = sy; continue;
    }
    if (i >= tk.length) break;
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (cmd === "M") { x = num() + ox; y = num() + oy; sx = x; sy = y; out.push([x, y]); cmd = "L"; }
    else if (cmd === "L") {
      const nx = num() + ox, ny = num() + oy, ax = x, ay = y;
      emit((t) => [ax + (nx - ax) * t, ay + (ny - ay) * t], Math.hypot(nx - ax, ny - ay));
      x = nx; y = ny;
    } else if (cmd === "Q") {
      const cx = num() + ox, cy = num() + oy, nx = num() + ox, ny = num() + oy, ax = x, ay = y;
      emit((t) => { const u = 1 - t; return [u*u*ax + 2*u*t*cx + t*t*nx, u*u*ay + 2*u*t*cy + t*t*ny]; },
        Math.hypot(cx-ax, cy-ay) + Math.hypot(nx-cx, ny-cy));
      x = nx; y = ny;
    } else if (cmd === "C") {
      const c1x = num()+ox, c1y = num()+oy, c2x = num()+ox, c2y = num()+oy,
            nx = num()+ox, ny = num()+oy, ax = x, ay = y;
      emit((t) => { const u = 1 - t; return [
        u*u*u*ax + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*nx,
        u*u*u*ay + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*ny]; },
        Math.hypot(c1x-ax,c1y-ay) + Math.hypot(c2x-c1x,c2y-c1y) + Math.hypot(nx-c2x,ny-c2y));
      x = nx; y = ny;
    } else break;
  }
  return out;
}

/** Centroid-ish center: the midpoint of the bounding box, which is what a mark wants. */
export function boundsCenter(pts) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Cast N rays from `center` and keep the farthest boundary hit on each.
 * Valid for star-shaped outlines (every boundary point visible from the
 * center) — which is exactly what a star is.
 */
export function radialProfile(pts, center, N) {
  const [cx, cy] = center;
  const prof = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    let best = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const ux = p[0] - cx, uy = p[1] - cy, vx = q[0] - cx, vy = q[1] - cy;
      const den = (vx - ux) * sa - (vy - uy) * ca;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ux * sa - uy * ca) / -den;
      if (t < 0 || t > 1) continue;
      const r = (ux + (vx - ux) * t) * ca + (uy + (vy - uy) * t) * sa;
      if (r > best) best = r;
    }
    prof[k] = best;
  }
  return prof;
}

/** Circular box-blur, repeated 3x — a cheap Gaussian. `sigma` is in samples. */
export function smoothProfile(prof, sigma) {
  const N = prof.length;
  const half = Math.max(0, Math.round(sigma));
  if (half === 0) return Float64Array.from(prof);
  let cur = Float64Array.from(prof);
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) sum += cur[(i + k + N * 4) % N];
      next[i] = sum / (half * 2 + 1);
    }
    cur = next;
  }
  return cur;
}

export const profileMax = (prof) => { let m = 0; for (const v of prof) if (v > m) m = v; return m; };

/** Profile → ring of [x,y] points on a circle of radius `radius` around `center`. */
export function profileToRing(prof, radius, center) {
  const N = prof.length, [cx, cy] = center;
  const max = profileMax(prof) || 1;
  return Array.from({ length: N }, (_, k) => {
    const a = (k / N) * TAU, r = (prof[k] / max) * radius;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

/** Closed Catmull-Rom through every point, emitted as cubic Béziers. */
export function toPath(p) {
  const n = p.length;
  let d = `M${r2(p[0][0])} ${r2(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], e = p[(i + 2) % n];
    d += `C${r2(b[0] + (c[0] - a[0]) / 6)} ${r2(b[1] + (c[1] - a[1]) / 6)} ` +
         `${r2(c[0] - (e[0] - b[0]) / 6)} ${r2(c[1] - (e[1] - b[1]) / 6)} ` +
         `${r2(c[0])} ${r2(c[1])}`;
  }
  return d + "Z";
}

export const lerpRing = (a, b, t) =>
  a.map(([x, y], i) => [x + (b[i][0] - x) * t, y + (b[i][1] - y) * t]);

/** Polygon path with straight segments — used for eyes, which want crisp corners. */
export const polyPath = (p) => "M" + p.map((q) => `${r2(q[0])} ${r2(q[1])}`).join("L") + "Z";

/**
 * Largest inscribed axis-aligned ellipse, found by coarse-then-fine search.
 * This is how the rig decides where a face fits: on a six-ray star the answer
 * is a wide, slightly squat ellipse sitting in the central mass, well clear of
 * the rays. Ported from the same approach Grok Bot uses for its blob shapes.
 */
export function fitFace(ring, center, radius) {
  const [cx, cy] = center;
  const sample = [];
  const stride = Math.max(1, Math.round(ring.length / 110));
  for (let i = 0; i < ring.length; i += stride) sample.push(ring[i]);
  const ratios = [1 / 1.45, 1 / 1.25, 1 / 1.12, 1, 1.12, 1.25, 1.45];
  let best = { score: -1, x: cx, y: cy, a: 1, b: 1 };
  const probe = (x, y, k) => {
    let d2 = Infinity;
    for (const p of sample) {
      const dx = p[0] - x, dy = (p[1] - y) * k;
      const q = dx * dx + dy * dy;
      if (q < d2) d2 = q;
    }
    const d = Math.sqrt(d2), b = d / k;
    // Prefer big, and prefer centred — the two penalty terms keep the face from
    // sliding off into one of the rays when a ray happens to be fat.
    const score = d * b * (1 - 0.0018 * Math.abs(y - cy) - 0.004 * Math.abs(x - cx));
    if (score > best.score) best = { score, x, y, a: d, b };
  };
  const span = radius * 0.5;
  for (let y = cy - span; y <= cy + span; y += 8)
    for (let x = cx - span * 0.3; x <= cx + span * 0.3; x += 8)
      for (const k of ratios) probe(x, y, k);
  for (let y = best.y - 8; y <= best.y + 8; y += 2)
    for (let x = best.x - 8; x <= best.x + 8; x += 2)
      for (const k of ratios) probe(x, y, k);
  return {
    dx: best.x - cx,
    dy: best.y - cy,
    rx: best.a,
    ry: best.b,
  };
}

/** Horizontal span of the ring at height y — used to keep eyes inside the silhouette. */
export function spanAt(ring, y, center) {
  let left = -Infinity, right = Infinity;
  const cx = center[0];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    if ((p[1] <= y) === (q[1] <= y)) continue;
    const x = p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]);
    if (x <= cx) { if (x > left) left = x; }
    else if (x < right) right = x;
  }
  return [Number.isFinite(left) ? left : cx, Number.isFinite(right) ? right : cx];
}
