import { initRenderer } from "./renderer";
import {
  resolveAuroraSpec,
  type AuroraSpec,
  type AuroraSpecOptions,
} from "./aurora-spec";
import type { AuroraVariant } from "./shader";

type GlRenderer = NonNullable<ReturnType<typeof initRenderer>>;

export type PooledAuroraRenderer = {
  key: string;
  variant: AuroraVariant;
  canvas: HTMLCanvasElement;
  renderer: GlRenderer;
};

const idleByKey = new Map<string, PooledAuroraRenderer[]>();

const MAX_IDLE_PER_KEY = 2;

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

    entry.renderer.destroy();
  }
  return createEntry(spec, colors, birth, flash);
}

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

export function prewarmAuroraRenderer(spec: AuroraSpec): void {
  const existing = idleByKey.get(spec.key);
  if (existing && existing.length > 0) return;
  const entry = createEntry(spec, PREWARM_COLORS, 1, 0);
  if (!entry) return;
  const pool = idleByKey.get(spec.key) ?? [];
  pool.push(entry);
  idleByKey.set(spec.key, pool);
}

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

export function prewarmAurora(options: AuroraSpecOptions): void {
  withDetachedContainer((container) => {
    prewarmAuroraRenderer(resolveAuroraSpec(container, options));
  });
}
