import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { shouldRunContinuousAnimation } from "@/shared/hooks/use-continuous-animation-gate";
import { selectExclusiveAnimationOwner } from "@/shared/hooks/use-exclusive-animation";
import { createDemandDrivenAnimationLoop } from "@/shared/lib/demand-driven-animation-loop";

describe("continuous animation hygiene", () => {
  it("requires live state, visible pixels, a visible app, and allowed motion", () => {
    const base = {
      documentVisible: true,
      elementVisible: true,
      logicalActive: true,
      reducedMotion: false,
      windowFocused: true,
    };
    expect(shouldRunContinuousAnimation(base)).toBe(true);
    expect(
      shouldRunContinuousAnimation({ ...base, logicalActive: false }),
    ).toBe(false);
    expect(
      shouldRunContinuousAnimation({ ...base, elementVisible: false }),
    ).toBe(false);
    expect(
      shouldRunContinuousAnimation({ ...base, documentVisible: false }),
    ).toBe(false);
    expect(shouldRunContinuousAnimation({ ...base, reducedMotion: true })).toBe(
      false,
    );
    expect(
      shouldRunContinuousAnimation({
        ...base,
        requireWindowFocus: true,
        windowFocused: false,
      }),
    ).toBe(false);
  });

  it("holds a demand-driven indicator to at most 15 callbacks per second", () => {
    let now = 0;
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, { at: number; callback: () => void }>();
    const onFrame = vi.fn();
    const loop = createDemandDrivenAnimationLoop({
      maxFramesPerSecond: 15,
      now: () => now,
      onFrame,
      requestFrame: (callback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => frames.delete(id),
      setTimer: (callback, delayMs) => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });

    loop.start();
    loop.start();
    while (now < 1_000) {
      const frame = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (frame) {
        frames.delete(frame[0]);
        now = Math.min(1_000, now + 1000 / 60);
        frame[1](now);
        continue;
      }
      const timer = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!timer || timer[1].at > 1_000) break;
      timers.delete(timer[0]);
      now = timer[1].at;
      timer[1].callback();
    }

    // Timer-to-rAF handoff can cost one display frame; the hard invariant is
    // that it never exceeds 15 callbacks in the one-second window.
    expect(onFrame.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(onFrame.mock.calls.length).toBeLessThanOrEqual(15);
    loop.stop();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  it("elects one newest or highest-priority candidate", () => {
    expect(
      selectExclusiveAnimationOwner([
        { id: "older-card", order: 3, priority: 50 },
        { id: "newest-card", order: 8, priority: 50 },
        { id: "working-label", order: 1, priority: 100 },
      ]),
    ).toBe("working-label");
    expect(selectExclusiveAnimationOwner([])).toBeNull();
  });

  it("keeps persistent chat motion compositor-only and row-bounded", () => {
    const shimmerCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/chat/text-shimmer.css"),
      "utf8",
    );
    const activityCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/chat/chat-workspace-strip.css"),
      "utf8",
    );
    const indicatorCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/chat/indicators.css"),
      "utf8",
    );
    const stella = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/shell/ascii-creature/StellaAnimation.tsx",
      ),
      "utf8",
    );

    expect(shimmerCss).not.toContain("background-position");
    expect(shimmerCss).not.toContain("animation:");
    expect(shimmerCss).toContain("--text-shimmer-window: 44%");
    expect(shimmerCss).toContain("#000 50%");
    expect(activityCss).toContain('data-continuous-animation="true"');
    expect(activityCss).toMatch(
      /@keyframes chat-workspace-strip__compact-pulse[\s\S]*opacity:[\s\S]*opacity:/,
    );
    const pulseKeyframes = activityCss.slice(
      activityCss.indexOf("@keyframes chat-workspace-strip__compact-pulse"),
      activityCss.indexOf("@keyframes chat-workspace-strip__compact-cell-in"),
    );
    expect(pulseKeyframes).not.toContain("transform:");
    expect(indicatorCss).toContain(
      ".indicator-stella .stella-animation-container",
    );
    expect(stella).toContain("createDemandDrivenAnimationLoop");
    expect(stella).toContain("renderStatic();");
    expect(stella).not.toContain("requestAnimationFrame(animate)");
  });
});
