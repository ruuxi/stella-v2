// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendererMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  discard: vi.fn(),
  release: vi.fn(),
  renderers: [] as Array<{
    canvas: HTMLCanvasElement;
    render: ReturnType<typeof vi.fn>;
    setColors: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@/shell/ascii-creature/creature-spec", () => ({
  resolveCreatureSpec: () => ({
    key: "20x20",
    cssWidth: 20,
    cssHeight: 20,
    backingWidth: 20,
    backingHeight: 20,
    gridWidth: 1,
    gridHeight: 1,
    glyphAtlas: document.createElement("canvas"),
  }),
}));

vi.mock("@/shell/ascii-creature/renderer-pool", () => ({
  acquireCreatureRenderer: rendererMocks.acquire,
  discardCreatureRenderer: rendererMocks.discard,
  releaseCreatureRenderer: rendererMocks.release,
}));

import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";

describe("Stella WebGL animation demand", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibilityState: DocumentVisibilityState;
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;

  const nextRenderer = () => {
    const entry = {
      canvas: document.createElement("canvas"),
      render: vi.fn(),
      setColors: vi.fn(),
      destroy: vi.fn(),
    };
    rendererMocks.renderers.push(entry);
    return { key: "20x20", canvas: entry.canvas, renderer: entry };
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    vi.stubGlobal("IntersectionObserver", undefined);
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    rendererMocks.acquire.mockReset();
    rendererMocks.acquire.mockImplementation(nextRenderer);
    rendererMocks.discard.mockReset();
    rendererMocks.release.mockReset();
    rendererMocks.renderers.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const mount = async () => {
    await act(async () => {
      root.render(<StellaAnimation width={20} height={20} maxFps={15} />);
      await Promise.resolve();
    });
  };

  const runPendingFrame = async (atMs: number) => {
    const frame = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(frame).toBeDefined();
    if (!frame) return;
    frames.delete(frame[0]);
    await act(async () => frame[1](atMs));
  };

  it("renders once while idle and schedules work only on the 15fps loop", async () => {
    await mount();
    const renderer = rendererMocks.renderers[0];
    expect(renderer?.render).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);

    await runPendingFrame(16.667);
    expect(renderer?.render).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => vi.advanceTimersByTime(82));
    expect(frames.size).toBe(0);
    await act(async () => vi.advanceTimersByTime(2));
    expect(frames.size).toBe(1);
  });

  it("stops every pending handle while hidden and resumes on visibility", async () => {
    await mount();
    await runPendingFrame(16.667);
    expect(vi.getTimerCount()).toBe(1);

    visibilityState = "hidden";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    visibilityState = "visible";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(frames.size).toBe(1);
  });

  it("falls back on context loss and rebuilds only after restoration", async () => {
    await mount();
    const first = rendererMocks.renderers[0];
    expect(first).toBeDefined();
    const lost = new Event("webglcontextlost", { cancelable: true });
    await act(async () => first?.canvas.dispatchEvent(lost));

    expect(lost.defaultPrevented).toBe(true);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      container
        .querySelector(".stella-animation-container")
        ?.getAttribute("data-renderer-state"),
    ).toBe("fallback");

    await act(async () =>
      first?.canvas.dispatchEvent(new Event("webglcontextrestored")),
    );
    expect(rendererMocks.discard).toHaveBeenCalledTimes(1);
    expect(rendererMocks.acquire).toHaveBeenCalledTimes(2);
    expect(
      container
        .querySelector(".stella-animation-container")
        ?.getAttribute("data-renderer-state"),
    ).toBe("webgl");
  });

  it("uses a static fallback when WebGL allocation fails", async () => {
    rendererMocks.acquire.mockReturnValueOnce(null);
    await mount();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      container
        .querySelector(".stella-animation-container")
        ?.getAttribute("data-renderer-state"),
    ).toBe("fallback");
  });
});
