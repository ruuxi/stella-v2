/**
 * SkSL port of the desktop WebGL "star-spin" working-indicator shader.
 *
 * Provenance: this is a line-for-line translation of the GLSL `STAR_FRAGMENT`
 * (with the `STAR_SPIN` define active) from
 * `packages/desktop-ui/src/shell/aurora/shader.ts`, so the mobile indicator gets
 * the desktop shader's actual glow / bloom / pseudo-3D turn rather than the flat
 * SVG silhouette the previous `WorkingStar` could produce.
 *
 * What changed in the GLSL -> SkSL port:
 *  - No C preprocessor in SkSL, so every `#define`/`#ifdef` is resolved by hand
 *    to the STAR_SPIN branch: STAR_SCALE 0.42, STAR_GIRTH 1.55,
 *    STAR_FIELD_RATE 1.0, 5 blur taps (step 0.25, norm 0.2), FRAME_MARGIN 0.03.
 *  - `gl_FragCoord` -> the `float2 fragCoord` SkSL passes to `main`. WebGL's
 *    `uv = (x/w, 1 - y/h)` bottom-left flip already lands on Skia's top-left,
 *    y-down origin, so `uv = fragCoord / uResolution` reproduces it exactly.
 *  - `vec*`/`mat2` -> `float*`/`float2x2`; `gl_FragColor = vec4(col, alpha)`
 *    (straight alpha, blended SRC_ALPHA/ONE_MINUS_SRC_ALPHA on desktop) ->
 *    `return half4(col * alpha, alpha)` because Skia shaders emit premultiplied
 *    color. `col` is clamped to [0,1] before the premultiply to match the WebGL
 *    UNORM framebuffer, which clamps the fragment before the blend multiply.
 *  - The five CSS-driven `u_colors` stops become the compile-time `RAMP_*`
 *    constants below — the approved mobile gradient
 *    (#00aad8 / #3493d9 / #4878db / #7449c5 / #be57a4), matching
 *    `WorkingStar.tsx` and the approved preview.
 *  - The working indicator never runs birth/flash/voice, so `u_birth` is baked
 *    to 1 (grow = 1) and the voice/flash overlays are dropped from the epilogue.
 *    Only `uTime` and `uResolution` remain as uniforms.
 *
 * `t` is fed in seconds, so one staged revolution takes STAR_CYCLE = 3.2 s —
 * the same 3.2 s drift -> wind-up -> whip -> spring cadence as the approved SVG
 * and preview (the desktop clock's 0.96 rate makes its cycle ~3.33 s; we match
 * the approved 3.2 s instead). `starTurn`'s internal `fract(t / 3.2)` keeps the
 * turn periodic, so the driving clock can climb monotonically and only wraps on
 * an exact cycle boundary.
 */

/** One staged revolution, in seconds (matches the approved SVG cadence). */
export const STAR_CYCLE_SECONDS = 3.2;

/** Resting pose lives at t = 0 (turns = 0 -> the symmetric eighth-turn pose). */
export const STAR_REST_TIME = 0;

export const WORKING_STAR_SKSL = `
uniform float uTime;
uniform float2 uResolution;

// Approved mobile gradient stops (sRGB 0..1), mixed raw like the WebGL ramp.
const float3 RAMP_0 = float3(0.000000, 0.666667, 0.847059); // #00aad8
const float3 RAMP_1 = float3(0.203922, 0.576471, 0.850980); // #3493d9
const float3 RAMP_2 = float3(0.282353, 0.470588, 0.858824); // #4878db
const float3 RAMP_3 = float3(0.454902, 0.286275, 0.772549); // #7449c5
const float3 RAMP_4 = float3(0.745098, 0.341176, 0.643137); // #be57a4

float hash(float2 p) {
  p = fract(p * float2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + float2(1.0, 0.0));
  float c = hash(i + float2(0.0, 1.0));
  float d = hash(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Three-octave fbm (the STAR variant's fbmCoarse), with the 1.14 amplitude
// restore that stood in for the dropped fourth octave on desktop.
float fbmCoarse(float2 p) {
  float v = 0.0;
  float a = 0.5;
  float2x2 m = float2x2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return v * 1.14;
}

float3 ramp(float t) {
  float pos = clamp(t, 0.0, 1.0) * 4.0;
  float ci = floor(min(pos, 3.0));
  float cf = smoothstep(0.0, 1.0, pos - ci);
  float3 color;
  if (ci < 1.0) {
    color = mix(RAMP_0, RAMP_1, cf);
  } else if (ci < 2.0) {
    color = mix(RAMP_1, RAMP_2, cf);
  } else if (ci < 3.0) {
    color = mix(RAMP_2, RAMP_3, cf);
  } else {
    color = mix(RAMP_3, RAMP_4, cf);
  }
  return color;
}

// The staged turn, in radians at time t (seconds). One revolution per 3.2 s.
float starTurn(float t) {
  float u = fract(t / 3.2);
  float laps = floor(t / 3.2);

  float driftTurn = 0.125;
  float windTurn = 0.114;
  float KNEE = 0.28;
  float TAIL = 0.34;
  float peakRate = 2.0 / (KNEE + (1.0 - KNEE) * (1.0 + TAIL));
  float exitRate = peakRate * TAIL;

  float turns;
  if (u < 0.50) {
    float w = u / 0.50;
    turns = driftTurn * smoothstep(0.0, 1.0, w);
  } else if (u < 0.57) {
    float w = (u - 0.50) / (0.57 - 0.50);
    turns = mix(driftTurn, windTurn, 1.0 - (1.0 - w) * (1.0 - w));
  } else if (u < 0.88) {
    float w = (u - 0.57) / (0.88 - 0.57);
    float e = w < KNEE
      ? peakRate * w * w / (2.0 * KNEE)
      : peakRate * KNEE * 0.5 + peakRate * (w - KNEE)
        - peakRate * (1.0 - TAIL) * (w - KNEE) * (w - KNEE) / (2.0 * (1.0 - KNEE));
    turns = mix(windTurn, 1.0, e);
  } else {
    float w = (u - 0.88) / (1.0 - 0.88);
    float handoff = (1.0 - windTurn) * exitRate
      / (0.88 - 0.57) * (1.0 - 0.88);
    float omega = 6.5;
    float zeta = 2.0;
    turns = 1.0 + (handoff / omega) * exp(-zeta * w) * sin(omega * w);
  }
  return (laps + turns) * 6.2832 + 0.7854;
}

// One tapered star arm: flat coverage inside, ~1.5px falloff at the drawn edge.
float starArm(float2 p, float2 dir, float len, float w) {
  float along = dot(p, dir);
  if (along < 0.0 || along > len) return 0.0;
  float across = abs(dot(p, float2(-dir.y, dir.x)));
  if (across > w + 0.012) return 0.0;
  float t = clamp(along / max(len, 0.001), 0.0, 1.0);
  float halfWidth = w * pow(1.0 - t, 1.7);
  float within = step(0.0, along) * (1.0 - smoothstep(len - 0.012, len, along));
  return within * (1.0 - smoothstep(halfWidth - 0.012, halfWidth + 0.012, across));
}

half4 main(float2 fragCoord) {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float2 uv = fragCoord / uResolution;
  float2 c = float2((uv.x - 0.5) * aspect, 0.5 - uv.y);

  float t = uTime;

  // Birth is always complete for the indicator, so grow is fixed at 1.
  float2 s = c / 0.42;
  float dist = length(s);
  if (dist > 1.9) return half4(0.0);

  float2 p = s;
  float rad = length(p);

  float spin = starTurn(t);
  float sweep = starTurn(t + 0.032) - spin;
  float energy = clamp(abs(sweep) / 0.36, 0.0, 1.0);

  float u = fract(t / 3.2);
  float coil = smoothstep(0.50 - 0.06, 0.57, u)
             * (1.0 - smoothstep(0.57, 0.57 + 0.04, u));
  float breath = 1.0 + 0.035 * sin(t * 1.9) * (1.0 - energy);
  float squash = 1.0 - 0.07 * coil;
  float bulge = 1.0 + 0.12 * coil;

  float sinElev = 0.30;

  float stretchLen = 0.95 * (1.0 + 0.12 * energy) * breath * squash;
  float taperW = 0.20 * 1.55 * (1.0 - 0.18 * energy) * bulge;
  float horiz = 0.0;
  for (int k = 0; k < 5; k++) {
    float a = spin + sweep * (float(k) * 0.25 - 0.5);
    float ca = cos(a);
    float sa = sin(a);
    float2 va = float2(ca, sa * sinElev);
    float2 vb = float2(-sa, ca * sinElev);
    float la = length(va);
    float lb = length(vb);
    horiz += max(
      starArm(p, (dot(p, va) < 0.0 ? -va : va) / max(la, 0.001),
              la * stretchLen, taperW * (0.55 + 0.45 * la)),
      starArm(p, (dot(p, vb) < 0.0 ? -vb : vb) / max(lb, 0.001),
              lb * stretchLen, taperW * (0.55 + 0.45 * lb)));
  }
  float shape = horiz * 0.2;

  float stretch = (1.0 + 0.05 * energy) * breath * squash;
  shape = max(shape,
    starArm(p, float2(0.0, 1.0), 1.0 * stretch, 0.19 * 1.55 * bulge));
  shape = max(shape,
    starArm(p, float2(0.0, -1.0), 0.95 * stretch, 0.17 * 1.55 * bulge));
  shape = max(shape, 1.0 - smoothstep(0.105 * 1.55, 0.125 * 1.55, rad));

  float core = exp(-(rad * rad) / 0.040);

  float2 cp = p * 2.2;
  float2 drift = float2(-t * 0.09, t * 0.05);
  float2 q = float2(fbmCoarse(cp + drift), fbmCoarse(cp + drift + float2(5.2, 1.3)));
  float2 r = float2(
    fbmCoarse(cp + 2.0 * q + float2(1.7, 9.2) + drift * 2.6),
    fbmCoarse(cp + 2.0 * q + float2(8.3, 2.8) - drift * 2.1)
  );
  float f = fbmCoarse(cp + 2.5 * r);
  float curtains = smoothstep(0.28, 0.72, f);

  float intensity = shape * (0.82 + 0.18 * curtains);
  float trail = clamp(abs(spin - starTurn(t - 0.14)) / 0.9, 0.0, 1.0);
  intensity *= 1.0 + 0.12 * energy;
  intensity += exp(-rad * 2.4) * (0.11 + 0.09 * trail) * curtains;

  float3 coreLift = float3(0.16) * curtains * shape
                  + float3(0.22 + 0.12 * trail) * core;

  float height = 0.5 + p.y * 0.5;
  float hueAxis = clamp(height / 0.68 + (q.x - 0.5) * 0.38, 0.0, 1.0);

  intensity = clamp(intensity, 0.0, 1.0);

  float hue = clamp(hueAxis * 0.92 + 0.04 + 0.28 * (r.y - 0.5), 0.0, 1.0);
  float3 col = ramp(hue);
  col += coreLift;

  // Soft frame fade (FRAME_MARGIN 0.03) so no arm clips the canvas rectangle.
  float fm = 0.03;
  float frame = smoothstep(0.0, fm, uv.x)
              * smoothstep(1.0, 1.0 - fm, uv.x)
              * smoothstep(0.0, fm, uv.y)
              * smoothstep(1.0, 1.0 - fm, uv.y);

  float alpha = clamp(intensity * 1.35 * frame, 0.0, 0.96);
  col = clamp(col, 0.0, 1.0);
  return half4(col * alpha, alpha);
}
`;

/**
 * JS mirror of the SkSL `starTurn`, returning the fractional turn (0..1) the way
 * the SVG `WorkingStar` and the approved preview express it. Kept for parity
 * tests against the desktop cadence; the shipping animation runs entirely in the
 * shader above.
 */
export function starTurnFraction(progress: number): number {
  if (progress >= 1) return 1;
  const driftEnd = 0.5;
  const windEnd = 0.57;
  const whipEnd = 0.88;
  const driftTurn = 0.125;
  const windTurn = 0.114;
  const knee = 0.28;
  const tail = 0.34;
  const peakRate = 2 / (knee + (1 - knee) * (1 + tail));
  const exitRate = peakRate * tail;

  if (progress < driftEnd) {
    const w = progress / driftEnd;
    return driftTurn * w * w * (3 - 2 * w);
  }
  if (progress < windEnd) {
    const w = (progress - driftEnd) / (windEnd - driftEnd);
    return driftTurn + (windTurn - driftTurn) * (1 - (1 - w) * (1 - w));
  }
  if (progress < whipEnd) {
    const w = (progress - windEnd) / (whipEnd - windEnd);
    const eased =
      w < knee
        ? (peakRate * w * w) / (2 * knee)
        : peakRate * knee * 0.5 +
          peakRate * (w - knee) -
          (peakRate * (1 - tail) * (w - knee) * (w - knee)) / (2 * (1 - knee));
    return windTurn + (1 - windTurn) * eased;
  }
  const w = (progress - whipEnd) / (1 - whipEnd);
  const handoff =
    (((1 - windTurn) * exitRate) / (whipEnd - windEnd)) * (1 - whipEnd);
  return 1 + (handoff / 6.5) * Math.exp(-2 * w) * Math.sin(6.5 * w);
}
