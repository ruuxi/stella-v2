import { describe, expect, test } from "bun:test";
import {
  isAppVisible,
  shouldRunContinuousAnimation,
} from "../continuous-animation";

const gate = (
  overrides: Partial<Parameters<typeof shouldRunContinuousAnimation>[0]> = {},
) =>
  shouldRunContinuousAnimation({
    logicalActive: true,
    appVisible: true,
    reducedMotion: false,
    ...overrides,
  });

describe("app visibility for looping animations", () => {
  test("a backgrounded app is the only state treated as off screen", () => {
    expect(isAppVisible("background")).toBe(false);
  });

  test("keeps animating through states where the app can still be seen", () => {
    expect(isAppVisible("active")).toBe(true);

    expect(isAppVisible("inactive")).toBe(true);
  });

  test("an unknown platform state is treated as visible rather than frozen", () => {
    expect(isAppVisible("extension")).toBe(true);
    expect(isAppVisible("unknown")).toBe(true);
  });
});

describe("continuous animation gate", () => {
  test("runs only when there is work to show and the app can be seen", () => {
    expect(gate()).toBe(true);
  });

  test("stops when the work it represents is over", () => {
    expect(gate({ logicalActive: false })).toBe(false);
  });

  test("stops while the app is backgrounded, so a phone is not animating in a pocket", () => {
    expect(gate({ appVisible: false })).toBe(false);
  });

  test("stops when the user asked for reduced motion", () => {
    expect(gate({ reducedMotion: true })).toBe(false);
  });

  test("every reason to stop wins over being active", () => {
    expect(gate({ appVisible: false, reducedMotion: true })).toBe(false);
    expect(
      gate({ logicalActive: false, appVisible: false, reducedMotion: true }),
    ).toBe(false);
  });
});
