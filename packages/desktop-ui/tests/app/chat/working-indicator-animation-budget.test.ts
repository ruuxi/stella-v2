import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStellaMark } from "@/ui/stella-character/rig.js";

type FrameFn = (t: number) => void;

const installFrameClock = () => {
  const queue: FrameFn[] = [];
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameFn) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    get pending() {
      return queue.length;
    },
    step(dtMs = 16) {
      now += dtMs;
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(now);
      return batch.length;
    },
  };
};

let viewportCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;

const installObservers = () => {
  viewportCallbacks = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        viewportCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
};

const setOnscreen = (isIntersecting: boolean) => {
  for (const cb of viewportCallbacks) cb([{ isIntersecting }]);
};

describe("working indicator mark animation budget", () => {
  let clock: ReturnType<typeof installFrameClock>;
  let host: HTMLElement;

  beforeEach(() => {
    clock = installFrameClock();
    installObservers();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    host.remove();
  });

  it("draws the mark and keeps ticking while working and visible", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });

    expect(clock.pending).toBe(1);
    clock.step();

    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.querySelector("path")?.getAttribute("d")).toMatch(/^M/);

    expect(clock.pending).toBe(1);

    mark.destroy();
  });

  it("still paints once when it mounts paused, then sleeps", () => {

    const mark = createStellaMark(host, { size: 30, state: "working", paused: true });

    expect(clock.pending).toBe(1);
    clock.step();
    expect(host.querySelector("path")?.getAttribute("d")).toMatch(/^M/);

    expect(clock.pending).toBe(0);

    mark.destroy();
  });

  it("still paints once when it mounts offscreen, then sleeps", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    setOnscreen(false);

    clock.step();
    expect(host.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
    expect(clock.pending).toBe(0);

    mark.destroy();
  });

  it("stops scheduling frames while paused, instead of ticking with no motion", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    clock.step();

    mark.pause();

    clock.step();
    expect(clock.pending).toBe(0);

    expect(clock.step()).toBe(0);

    mark.resume();
    expect(clock.pending).toBe(1);

    mark.destroy();
  });

  it("stops scheduling frames while scrolled out of view, and resumes on return", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    clock.step();

    setOnscreen(false);
    clock.step();
    expect(clock.pending).toBe(0);

    setOnscreen(true);
    expect(clock.pending).toBe(1);

    mark.destroy();
  });

  it("stays asleep when a paused mark changes state, and catches up on resume", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    clock.step();
    mark.pause();
    clock.step();

    mark.setState("searching");
    expect(clock.pending).toBe(0);

    mark.resume();
    expect(clock.pending).toBe(1);

    mark.destroy();
  });

  it("schedules no frames at all once destroyed", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    clock.step();
    mark.destroy();

    clock.step();
    expect(clock.pending).toBe(0);
  });

  it("keeps the per-frame work allocation-free and skips unchanged writes", () => {
    const source = createStellaMark.toString();

    expect(source).not.toContain("workRing[i] = [");
    expect(source).toContain("const workRing = Array.from");
    expect(source).toContain("const eyeBuf = [");

    expect(source).toContain("if (eyePath !== lastEyePath[i])");
    expect(source).toContain("if (bodyAlphaQ !== lastBodyAlpha)");
    expect(source).toContain("if (decorActive || !decorHidden)");
    expect(source).toContain("if (bodyTransform !== lastBodyTransform)");
    expect(source).toContain("if (hideEyes !== eyesHidden)");

    expect(source).toContain("if (!sizeObserver && now - measuredAt > 500)");
  });

  it("writes an eye path on the frames where the eye actually moves", () => {
    const mark = createStellaMark(host, { size: 30, state: "working" });
    clock.step();

    const eye = host.querySelector("g[clip-path] path") as SVGPathElement;
    expect(eye.getAttribute("d")).toMatch(/^M/);

    mark.destroy();
  });
});
