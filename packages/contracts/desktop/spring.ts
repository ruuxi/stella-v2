/**
 * A physical spring sampled into a CSS `linear()` easing, for animations that
 * run where no animation library is available (the update-transition page).
 * Parameters match SwiftUI and `motion`: perceptual duration in seconds and
 * bounce (0 is critically damped). Returns the easing and the time the
 * spring takes to settle, which is the animation's duration.
 */
export type SpringEasing = { easing: string; ms: number };

const cache = new Map<string, SpringEasing>();

export const springEasing = (duration: number, bounce = 0): SpringEasing => {
  const key = `${duration}:${bounce}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const w0 = (2 * Math.PI) / duration;
  const zeta = 1 - bounce;
  let position: (t: number) => number;
  if (zeta >= 1) {
    position = (t) => 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  } else {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    position = (t) =>
      1 -
      Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  // Settled: within 0.2% of rest for 30 ms.
  let settle = 3;
  let calm = 0;
  for (let t = 0.001; t < 3; t += 0.001) {
    if (Math.abs(1 - position(t)) < 0.002) {
      calm += 0.001;
      if (calm > 0.03) {
        settle = t;
        break;
      }
    } else {
      calm = 0;
    }
  }
  const samples = 64;
  const points: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(i === samples ? "1" : position((settle * i) / samples).toFixed(4));
  }
  const result = { easing: `linear(${points.join(", ")})`, ms: Math.round(settle * 1000) };
  cache.set(key, result);
  return result;
};
