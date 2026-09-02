// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StellaEmptyState } from "@/ui/stella-character/StellaEmptyState";

/**
 * The hero is the character rig dressed for an empty surface. These pin the
 * contract the surfaces rely on: it mounts the rig, carries the mood it was
 * given, and stops ticking when the window loses focus.
 */
describe("StellaEmptyState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let hasFocus: boolean;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    hasFocus = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(16);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts the character rig with the requested mood", async () => {
    await act(async () => {
      root.render(<StellaEmptyState mood="listening" size={64} />);
    });

    const hero = container.querySelector<HTMLElement>(".stella-empty-state");
    expect(hero).not.toBeNull();
    expect(hero?.dataset.mood).toBe("listening");
    expect(hero?.getAttribute("aria-hidden")).toBe("true");

    const svg = hero?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.style.width).toBe("64px");
    expect(svg?.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
  });

  it("stops scheduling frames once the window blurs", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });

    await act(async () => {
      root.render(<StellaEmptyState mood="idle" />);
    });
    expect(frames.length).toBeGreaterThan(0);

    hasFocus = false;
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    // Drain whatever was queued before the blur: a paused rig runs the frame
    // it already had and must not book another.
    const queued = frames.splice(0, frames.length);
    for (const cb of queued) cb(32);
    expect(frames.length).toBe(0);
  });
});
