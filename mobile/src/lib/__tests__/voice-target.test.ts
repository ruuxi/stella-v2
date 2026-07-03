import { describe, expect, test } from "bun:test";

// AsyncStorage's non-native fallback talks to `window.localStorage`; give the
// bun test runtime an in-memory one before the storage module is exercised.
const memoryStore = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  },
};

import {
  loadVoiceTargetPreference,
  reachabilityFromProbe,
  resolveVoiceTarget,
  setVoiceTargetPreference,
} from "../voice-target";

describe("reachabilityFromProbe", () => {
  test("a completed probe yields its confirmed availability", () => {
    expect(reachabilityFromProbe({ available: true })).toBe(true);
    expect(reachabilityFromProbe({ available: false })).toBe(false);
  });

  test("a failed probe is unknown (null), never 'unreachable'", () => {
    expect(reachabilityFromProbe(null)).toBe(null);
  });

  test("a failed probe therefore keeps Auto on the computer target", () => {
    expect(
      resolveVoiceTarget({
        preference: "auto",
        paired: true,
        lastMainTab: "computer",
        computerReachable: reachabilityFromProbe(null),
      }),
    ).toBe("computer");
  });
});

describe("resolveVoiceTarget", () => {
  test("no paired computer always routes to the phone", () => {
    expect(
      resolveVoiceTarget({
        preference: "computer",
        paired: false,
        lastMainTab: "computer",
        computerReachable: true,
      }),
    ).toBe("phone");
  });

  test("explicit phone preference wins even mid-computer-session", () => {
    expect(
      resolveVoiceTarget({
        preference: "phone",
        paired: true,
        lastMainTab: "computer",
        computerReachable: true,
      }),
    ).toBe("phone");
  });

  test("explicit computer preference holds even when it looks offline (wake + spoken offline reply cover it)", () => {
    expect(
      resolveVoiceTarget({
        preference: "computer",
        paired: true,
        lastMainTab: "chat",
        computerReachable: false,
      }),
    ).toBe("computer");
  });

  test("auto follows the computer chat the user was last in when reachable", () => {
    expect(
      resolveVoiceTarget({
        preference: "auto",
        paired: true,
        lastMainTab: "computer",
        computerReachable: true,
      }),
    ).toBe("computer");
  });

  test("auto treats unknown reachability as reachable (send path handles the miss)", () => {
    expect(
      resolveVoiceTarget({
        preference: "auto",
        paired: true,
        lastMainTab: "computer",
        computerReachable: null,
      }),
    ).toBe("computer");
  });

  test("auto falls back to the phone when the computer is unreachable", () => {
    expect(
      resolveVoiceTarget({
        preference: "auto",
        paired: true,
        lastMainTab: "computer",
        computerReachable: false,
      }),
    ).toBe("phone");
  });

  test("auto stays on the phone when the user was last in the local chat", () => {
    expect(
      resolveVoiceTarget({
        preference: "auto",
        paired: true,
        lastMainTab: "chat",
        computerReachable: true,
      }),
    ).toBe("phone");
  });
});

describe("preference persistence", () => {
  test("round-trips explicit choices and resets to auto", async () => {
    await setVoiceTargetPreference("computer");
    expect(await loadVoiceTargetPreference()).toBe("computer");

    await setVoiceTargetPreference("auto");
    expect(await loadVoiceTargetPreference()).toBe("auto");
  });

  test("ignores corrupt stored values", async () => {
    memoryStore.set("stella-mobile_voice-target.preference", "carrier-pigeon");
    expect(await loadVoiceTargetPreference()).toBe("auto");
  });
});
