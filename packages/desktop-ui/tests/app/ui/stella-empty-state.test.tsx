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
  // The rig books its next frame from inside the current one, so frames are
  // queued and stepped by hand rather than run synchronously.
  let frames: FrameRequestCallback[];
  const stepFrames = (now: number) => {
    const batch = frames.splice(0, frames.length);
    for (const cb of batch) cb(now);
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    hasFocus = true;
    frames = [];
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
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

  it("stops scheduling frames once the window blurs", async () => {
    await act(async () => {
      root.render(<StellaEmptyState mood="idle" />);
    });
    stepFrames(16);
    expect(frames.length).toBe(1);

    hasFocus = false;
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    // A paused rig runs the frame it already had and must not book another.
    stepFrames(32);
    expect(frames.length).toBe(0);
  });
});
