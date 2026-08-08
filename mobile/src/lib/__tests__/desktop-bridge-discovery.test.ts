import { describe, expect, test } from "bun:test";
import {
  probeDesktopBridgeStatus,
  readDesktopBridgeRegistrationDescriptor,
} from "../desktop-bridge-discovery";
import type { DesktopBridgeStatus } from "../../types";

const descriptor = {
  desktopDeviceId: "desktop-1",
  baseUrls: ["https://stable.example/"],
  platform: "macOS",
  desktopPublicKey: "desktop-public-key",
  updatedAt: 1_723_000_000_000,
};

const status = (
  overrides: Partial<DesktopBridgeStatus>,
): DesktopBridgeStatus => ({
  available: false,
  baseUrls: [],
  platform: null,
  updatedAt: null,
  lastKnownRegistration: descriptor,
  ...overrides,
});

describe("desktop bridge durable discovery", () => {
  test("accepts an expired registration only after its descriptor is healthy", async () => {
    const probed: string[] = [];
    const result = await probeDesktopBridgeStatus(
      status({}),
      "desktop-1",
      async (url) => {
        probed.push(url);
        return true;
      },
    );

    expect(probed).toEqual(["https://stable.example"]);
    expect(result).toEqual({
      reachableUrl: "https://stable.example",
      liveFallbackUrl: null,
    });
  });

  test("keeps an expired registration offline when direct health fails", async () => {
    const result = await probeDesktopBridgeStatus(
      status({}),
      "desktop-1",
      async () => false,
    );

    expect(result).toEqual({ reachableUrl: null, liveFallbackUrl: null });
  });

  test("preserves live registration behavior for older backends", async () => {
    const result = await probeDesktopBridgeStatus(
      status({
        available: true,
        baseUrls: ["https://live.example/"],
        lastKnownRegistration: null,
      }),
      "desktop-1",
      async () => false,
    );

    expect(result).toEqual({
      reachableUrl: null,
      liveFallbackUrl: "https://live.example",
    });
  });

  test("ignores a durable descriptor for a different desktop", async () => {
    let probes = 0;
    const result = await probeDesktopBridgeStatus(
      status({}),
      "desktop-2",
      async () => {
        probes += 1;
        return true;
      },
    );

    expect(probes).toBe(0);
    expect(result).toEqual({ reachableUrl: null, liveFallbackUrl: null });
  });

  test("ignores a malformed additive descriptor without changing live status", () => {
    expect(
      readDesktopBridgeRegistrationDescriptor({
        ...descriptor,
        baseUrls: [42],
      }),
    ).toBeNull();
  });
});
