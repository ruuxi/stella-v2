import { describe, expect, test } from "bun:test";
import {
  CARPLAY_APPEARANCE_GRACE_MS,
  shouldDeferColorScheme,
} from "../carplay-appearance-policy";

describe("shouldDeferColorScheme (CarPlay Appearance crash guard)", () => {
  test("defers while CarPlay is confirmed connected", () => {
    expect(
      shouldDeferColorScheme({
        connected: true,
        persistedConnected: false,
        msSinceJsStart: 60_000,
      }),
    ).toBe(true);
  });

  test("defers during the launch grace window when last session was in the car (crash-relaunch loop)", () => {
    expect(
      shouldDeferColorScheme({
        connected: false,
        persistedConnected: true,
        msSinceJsStart: 2_000,
      }),
    ).toBe(true);
  });

  test("stale persisted flag stops deferring after the grace window", () => {
    expect(
      shouldDeferColorScheme({
        connected: false,
        persistedConnected: true,
        msSinceJsStart: CARPLAY_APPEARANCE_GRACE_MS + 1,
      }),
    ).toBe(false);
  });

  test("applies immediately when nothing suggests a car", () => {
    expect(
      shouldDeferColorScheme({
        connected: false,
        persistedConnected: false,
        msSinceJsStart: 0,
      }),
    ).toBe(false);
  });
});
