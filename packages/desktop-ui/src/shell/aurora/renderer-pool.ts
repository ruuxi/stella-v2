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
 * backing size). `StellaAnimation` borrows an entry on mount and returns
 * it on unmount instead of tearing the context down, so every appearance
 * after the first is effectively free. The component's lifecycle,
 * visuals, and animation are unchanged — only the GL spin-up is
 * amortized.
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
 * Drop idle renderers whose surface is gone for good, freeing the GL context
 * and its backing store instead of holding them warm forever.
 *
 * Pooling pays for itself when a surface reappears — the chat working
 * indicator remounts on every message send. It is pure loss for a surface
 * that appears once per install: the onboarding creature's 875x682 canvas is
 * the only `waves` consumer in the app, so once onboarding is over nothing
 * can ever ask for that key again and its entry would sit in `idleByKey` for
 * the lifetime of the process.
 *
 * Only idle entries are touched; anything currently borrowed is untouched and
 * still returns through `releaseAuroraRenderer` as usual. Returns the number
 * disposed.
 */
export function disposeIdleAuroraRenderers(filter?: {
  variant?: AuroraVariant;
}): number {
  let disposed = 0;
  for (const [key, pool] of idleByKey) {
    const kept = filter?.variant
      ? pool.filter((entry) => entry.variant !== filter.variant)
      : [];
    for (const entry of pool) {
      if (kept.includes(entry)) continue;
      disposeEntry(entry);
      disposed += 1;
    }
    if (kept.length > 0) idleByKey.set(key, kept);
    else idleByKey.delete(key);
  }
  return disposed;
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
 * Best-effort idle pre-warm: measure the aurora geometry for `options`
 * against a throwaway hidden container and build one pooled renderer, so
 * the first real mount (e.g. the working indicator on the first message
 * send) reuses it instead of paying the cold ~200ms GL spin-up on the
 * main thread. Safe to call repeatedly; never throws into the caller.
 */
export function prewarmAurora(options: AuroraSpecOptions): void {
  if (typeof document === "undefined" || !document.body) return;
  let container: HTMLDivElement | null = null;
  try {
    container = document.createElement("div");
    container.className =
      "stella-animation-container stella-animation-container--paused";
    container.style.cssText =
      "position:absolute;left:-9999px;top:0;width:24px;height:24px;visibility:hidden;pointer-events:none";
    document.body.appendChild(container);
    const spec = resolveAuroraSpec(container, options);
    if (spec) prewarmAuroraRenderer(spec);
  } catch {
    // Pre-warming is a pure optimization — swallow any failure.
  } finally {
    container?.parentNode?.removeChild(container);
  }
}
