import { describe, expect, test } from "bun:test";
import { resolveRealtimeVoiceRoute } from "../realtime-voice-routing";
import type { StoredPhoneAccess } from "../phone-access";

const access = (desktopDeviceId: string): StoredPhoneAccess =>
  ({
    desktopDeviceId,
    approvedAt: 1,
    pairSecret: `secret-${desktopDeviceId}`,
  }) as StoredPhoneAccess;

const laptop = access("laptop");
const studio = access("studio");

describe("realtime voice routing", () => {
  test("cloud selection stays on the phone even with paired computers", () => {
    expect(
      resolveRealtimeVoiceRoute({
        executionTarget: { mode: "cloud" },
        preferredAccess: laptop,
        pairedDesktops: [laptop, studio],
      }),
    ).toEqual({ execution: "phone", desktopAccess: null });
  });

  test("a selected computer wins over the preferred pairing", () => {
    expect(
      resolveRealtimeVoiceRoute({
        executionTarget: { mode: "device", deviceId: "studio" },
        preferredAccess: laptop,
        pairedDesktops: [laptop, studio],
      }),
    ).toEqual({ execution: "computer", desktopAccess: studio });
  });

  test("a selected computer that is no longer paired falls back to the phone", () => {
    expect(
      resolveRealtimeVoiceRoute({
        executionTarget: { mode: "device", deviceId: "gone" },
        preferredAccess: laptop,
        pairedDesktops: [laptop],
      }),
    ).toEqual({ execution: "phone", desktopAccess: null });
  });

  test("automatic uses the preferred computer when one is paired", () => {
    expect(
      resolveRealtimeVoiceRoute({
        executionTarget: { mode: "automatic" },
        preferredAccess: laptop,
        pairedDesktops: [laptop],
      }),
    ).toEqual({ execution: "computer", desktopAccess: laptop });
    expect(
      resolveRealtimeVoiceRoute({
        executionTarget: { mode: "automatic" },
        preferredAccess: null,
        pairedDesktops: [],
      }),
    ).toEqual({ execution: "phone", desktopAccess: null });
  });
});
