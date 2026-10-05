import { beforeEach, describe, expect, mock, test } from "bun:test";

// Expo's module setup runs on import and expects the RN global.
(globalThis as Record<string, unknown>).__DEV__ = false;

let backendCalls: { name: string; args: unknown }[] = [];
// Process-global in bun: keep every real export so later files still link.
const realBackend = await import("../../../lib/backend");
mock.module("../../../lib/backend", () => ({
  ...realBackend,
  getBackendClient: () => ({
    call: async (name: string, args: unknown) => {
      backendCalls.push({ name, args });
      return {
        deviceId: "desktop-1",
        remoteExecution: "enabled",
        changed: true,
      };
    },
  }),
}));

const { applyRemoteExecution, enableRemoteExecution } = await import(
  "../computer-actions"
);
type Destinations = Parameters<typeof applyRemoteExecution>[0];

beforeEach(() => {
  backendCalls = [];
});

describe("enabling a computer from this phone", () => {
  test("tapping Enable issues devices.setRemoteExecution for that device", async () => {
    const result = await enableRemoteExecution("desktop-1");
    expect(backendCalls).toEqual([
      {
        name: "devices.setRemoteExecution",
        args: { deviceId: "desktop-1", enabled: true },
      },
    ]);
    expect(result.remoteExecution).toBe("enabled");
  });

  test("the answer moves consent and nothing else", () => {
    const devices = [
      {
        deviceId: "desktop-1",
        label: "Studio iMac",
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
        online: true,
        availability: { ready: false, capabilities: [] },
      },
      {
        deviceId: "desktop-2",
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
        online: true,
      },
    ] as NonNullable<Destinations>;

    const next = applyRemoteExecution(devices, "desktop-1", "enabled");
    expect(next?.[0]).toEqual({
      deviceId: "desktop-1",
      label: "Studio iMac",
      remoteExecutionEnabled: true,
      remoteExecution: "enabled",
      online: true,
      // Readiness is the device's own report: agreeing does not make it ready,
      // so the row stays unselectable until the device says otherwise.
      availability: { ready: false, capabilities: [] },
    });
    // Consent is per device; the others are untouched.
    expect(next?.[1]).toBe(devices[1]);
  });

  test("a declined answer is recorded as declined, not as enabled", () => {
    const next = applyRemoteExecution(
      [
        {
          deviceId: "desktop-1",
          remoteExecutionEnabled: true,
          remoteExecution: "enabled",
          online: true,
        },
      ] as NonNullable<Destinations>,
      "desktop-1",
      "declined",
    );
    expect(next?.[0]?.remoteExecution).toBe("declined");
    expect(next?.[0]?.remoteExecutionEnabled).toBe(false);
  });
});
