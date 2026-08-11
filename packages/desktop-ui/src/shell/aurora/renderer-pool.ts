import { initRenderer } from "./renderer";
import {
  resolveAuroraSpec,
  type AuroraSpec,
  type AuroraSpecOptions,
} from "./aurora-spec";
import type { AuroraVariant } from "./shader";

/**
 * Persistent pool of WebGL aurora renderers.
 *
 * Creating a renderer is expensive and synchronous on the main thread:
 * `getContext('webgl')` allocates a GPU context and `createProgram`
 * compiles + links the shaders — profiled at ~16-20ms per mount on an M4
 * (ANGLE/Metal), and ~200ms the very first time. The chat working
 * indicator mounts/unmounts that on every single message send, so the
 * cost lands as a dropped frame exactly when the indicator appears.
 *
 * This pool keeps the canvas + GL context + compiled program alive across
 * React mount/unmount cycles, keyed by `AuroraSpec.key` (cell metrics +
 * backing/display sizes). `StellaAnimation` borrows an entry on mount and
 * returns it on unmount instead of tearing the context down, so every
 * appearance after the first is effectively free. The component's lifecycle,
 * visuals, and animation are unchanged — only the GL spin-up is amortized.
 */
type GlRenderer = NonNullable<ReturnType<typeof initRenderer>>;

export type PooledAuroraRenderer = {
  key: string;
  variant: AuroraVariant;
  canvas: HTMLCanvasElement;
  renderer: GlRenderer;
};

const idleByKey = new Map<string, PooledAuroraRenderer[]>();
/** Keep at most this many warm renderers per key (covers a couple of
 *  surfaces showing the same-size aurora at once). */
const MAX_IDLE_PER_KEY = 2;

/** Neutral colors for a pre-warmed renderer; real colors are applied via
 *  `setColors` the moment it is acquired. */
const PREWARM_COLORS = new Float32Array([
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

function isContextLost(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
  return !gl || gl.isContextLost();
}

function disposeEntry(entry: PooledAuroraRenderer): void {
  entry.renderer.destroy();
  (entry.canvas.getContext("webgl") as WebGLRenderingContext | null)
    ?.getExtension("WEBGL_lose_context")
    ?.loseContext();
}

function createEntry(
  spec: AuroraSpec,
  colors: Float32Array,
  birth: number,
  flash: number,
): PooledAuroraRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.className = "aurora-canvas";
  canvas.style.width = `${spec.cssWidth}px`;
  canvas.style.height = `${spec.cssHeight}px`;
  canvas.width = spec.backingWidth;
  canvas.height = spec.backingHeight;
  const renderer = initRenderer(canvas, colors, birth, flash, spec.variant);
  if (!renderer) return null;
  return { key: spec.key, variant: spec.variant, canvas, renderer };
}

/**
 * Borrow a warm renderer for `spec` (reusing a pooled one when available,
 * else creating it). The caller owns attaching `entry.canvas` into the DOM
 * and must hand the entry back to `releaseAuroraRenderer` on unmount.
 */
export function acquireAuroraRenderer(
  spec: AuroraSpec,
  colors: Float32Array,
  birth: number,
  flash: number,
): PooledAuroraRenderer | null {
  const pool = idleByKey.get(spec.key);
  while (pool && pool.length > 0) {
    const entry = pool.pop()!;
    if (!isContextLost(entry.canvas)) {
      entry.renderer.setColors(colors);
      return entry;
    }
    // Context was reclaimed by the browser while idle — drop and try next.
    entry.renderer.destroy();
  }
  return createEntry(spec, colors, birth, flash);
}

/** Return a renderer to the pool (warm) instead of destroying its GL
 *  context. Detaches the canvas; over the per-key cap the entry is fully
 *  disposed so idle GPU memory stays bounded. */
export function releaseAuroraRenderer(entry: PooledAuroraRenderer): void {
  entry.canvas.parentNode?.removeChild(entry.canvas);
  if (isContextLost(entry.canvas)) {
    entry.renderer.destroy();
    return;
  }
  const pool = idleByKey.get(entry.key) ?? [];
  if (pool.length >= MAX_IDLE_PER_KEY) {
    disposeEntry(entry);
    return;
  }
  pool.push(entry);
  idleByKey.set(entry.key, pool);
}

/**
 * Drop the idle renderers for one surface geometry, freeing the GL context and
 * its backing store instead of holding them warm forever.
 *
 * Pooling pays for itself when a surface reappears — the chat working
 * indicator remounts on every message send. It is pure loss for a surface that
 * appears once per install: the onboarding creature's canvas is far larger than
 * any other, so once onboarding is over nothing can ever ask for that key again
 * and its entry would sit in `idleByKey` for the lifetime of the process.
 *
 * Keying on geometry rather than on variant is what makes this safe to call
 * from a surface whose variant another live consumer also renders — the
 * working indicator's pre-warmed context would otherwise be collateral. Pass
 * the same geometry props the retiring surface handed to `StellaAnimation`.
 *
 * Only idle entries are touched; anything currently borrowed is untouched and
 * still returns through `releaseAuroraRenderer` as usual. Returns the number
 * disposed.
 */
export function disposeIdleAuroraRenderersFor(
  options: AuroraSpecOptions,
): number {
  const spec = withDetachedContainer((container) =>
    resolveAuroraSpec(container, options),
  );
  if (!spec) return 0;
  const pool = idleByKey.get(spec.key);
  if (!pool) return 0;
  for (const entry of pool) disposeEntry(entry);
  idleByKey.delete(spec.key);
  return pool.length;
}

/** Create one warm renderer for `spec` ahead of first use (no-op if one is
 *  already pooled). */
export function prewarmAuroraRenderer(spec: AuroraSpec): void {
  const existing = idleByKey.get(spec.key);
  if (existing && existing.length > 0) return;
  const entry = createEntry(spec, PREWARM_COLORS, 1, 0);
  if (!entry) return;
  const pool = idleByKey.get(spec.key) ?? [];
  pool.push(entry);
  idleByKey.set(spec.key, pool);
}

/**
 * Run `read` against a throwaway hidden `.stella-animation-container` so the
 * aurora's cell metrics can be measured without a mounted surface. Callers
 * outside React's lifecycle (pre-warm, retire) both need this — the cell
 * metrics live in CSS custom properties, so a real element is the only way to
 * resolve a spec. Returns null if the DOM is unavailable or measuring throws.
 */
function withDetachedContainer<T>(
  read: (container: HTMLElement) => T,
): T | null {
  if (typeof document === "undefined" || !document.body) return null;
  let container: HTMLDivElement | null = null;
  try {
    container = document.createElement("div");
    container.className =
      "stella-animation-container stella-animation-container--paused";
    container.style.cssText =
      "position:absolute;left:-9999px;top:0;width:24px;height:24px;visibility:hidden;pointer-events:none";
    document.body.appendChild(container);
    return read(container);
  } catch {
    return null;
  } finally {
    container?.parentNode?.removeChild(container);
  }
}

/**
 * Best-effort idle pre-warm: measure the aurora geometry for `options`
 * against a throwaway hidden container and build one pooled renderer, so
 * the first real mount (e.g. the working indicator on the first message
 * send) reuses it instead of paying the cold ~200ms GL spin-up on the
 * main thread. Safe to call repeatedly; never throws into the caller.
 */
export function prewarmAurora(options: AuroraSpecOptions): void {
  withDetachedContainer((container) => {
    prewarmAuroraRenderer(resolveAuroraSpec(container, options));
  });
}
