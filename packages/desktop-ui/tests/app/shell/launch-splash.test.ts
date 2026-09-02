// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_SPLASH_MAX_HOLD_MS,
  dismissLaunchSplash,
  holdLaunchSplashUntilLive,
  resetLaunchSplashForTests,
} from "@/shell/launch-splash";

const mountSplash = () => {
  const el = document.createElement("div");
  el.id = "stella-launch";
  el.className = "stella-launch";
  document.body.appendChild(el);
  return el;
};

describe("launch splash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLaunchSplashForTests();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays up while the shell is mounted but not yet live", () => {
    const el = mountSplash();
    holdLaunchSplashUntilLive();
    vi.advanceTimersByTime(LAUNCH_SPLASH_MAX_HOLD_MS - 1);
    expect(el.dataset.exiting).toBeUndefined();
    expect(document.getElementById("stella-launch")).toBe(el);
  });

  it("fades out as soon as the shell reports liveness", () => {
    const el = mountSplash();
    holdLaunchSplashUntilLive();
    vi.advanceTimersByTime(400);
    dismissLaunchSplash();
    expect(el.dataset.exiting).toBe("true");
    vi.advanceTimersByTime(260);
    expect(document.getElementById("stella-launch")).toBeNull();
  });

  it("drops the splash at the bounded hold even if liveness never arrives", () => {
    const el = mountSplash();
    holdLaunchSplashUntilLive();
    vi.advanceTimersByTime(LAUNCH_SPLASH_MAX_HOLD_MS);
    expect(el.dataset.exiting).toBe("true");
  });

  it("does not extend the deadline when the hold is requested again", () => {
    const el = mountSplash();
    holdLaunchSplashUntilLive();
    vi.advanceTimersByTime(LAUNCH_SPLASH_MAX_HOLD_MS - 100);
    holdLaunchSplashUntilLive();
    vi.advanceTimersByTime(100);
    expect(el.dataset.exiting).toBe("true");
  });

  it("is idempotent once dismissed", () => {
    mountSplash();
    dismissLaunchSplash();
    vi.advanceTimersByTime(260);
    expect(document.getElementById("stella-launch")).toBeNull();
    // A late hold after dismissal must not resurrect a timer or throw.
    holdLaunchSplashUntilLive();
    dismissLaunchSplash();
    expect(vi.getTimerCount()).toBe(0);
  });
});
