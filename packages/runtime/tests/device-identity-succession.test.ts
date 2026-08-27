import { afterEach, describe, expect, it, vi } from "vitest";

import { StellaRuntimeHost } from "../host/index.js";

const createHost = (hostHandlers: Record<string, unknown> = {}) =>
  new StellaRuntimeHost({
    hostHandlers: {
      getDeviceIdentity: async () => ({
        deviceId: "device",
        publicKey: "public",
      }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
      ...hostHandlers,
    },
    initializeParams: {
      clientName: "test-client",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      stellaAppDir: "/tmp/stella-test",
      stellaDataDirPath: "/tmp/stella-test-home",
      stellaWorkspacePath: "/tmp/stella-test/workspace",
    },
  } as never);

describe("runtime host device identity succession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims a retired identity whenever authenticated host services synchronize", () => {
    const host = createHost() as any;
    const bridge = { start: vi.fn(), stop: vi.fn(), kick: vi.fn() };
    host.started = true;
    host.hostReady = true;
    host.configCache = { hasConnectedAccount: true };
    host.getConfiguredHostAuthToken = vi.fn(() => "token");
    host.getConfiguredHostConvexUrl = vi.fn(
      () => "https://example.convex.cloud",
    );
    host.ensureHostRemoteTurnBridge = vi.fn();
    host.hostRemoteTurnBridge = bridge;
    host.resetHostRemoteTurnAuthTracking = vi.fn();
    host.ensureHostRemoteTurnCancelSubscription = vi.fn();
    host.claimDeviceIdentitySuccession = vi.fn(async () => undefined);

    host.syncHostRemoteTurnBridge();

    expect(host.claimDeviceIdentitySuccession).toHaveBeenCalledTimes(1);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(bridge.kick).toHaveBeenCalledTimes(1);
  });

  it("clears the retired id only after the backend accepts the succession", async () => {
    const identity = {
      deviceId: "new-device",
      publicKey: "new-public",
      supersededDeviceId: "old-device",
    };
    const clearSupersededDeviceId = vi.fn().mockResolvedValue(undefined);
    const mutation = vi.fn().mockResolvedValue(null);
    const host = createHost({ clearSupersededDeviceId }) as any;
    host.deviceIdentity = identity;
    host.ensureHostConvexClient = vi.fn(() => ({ mutation }));

    await host.claimDeviceIdentitySuccession();

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      previousDeviceId: "old-device",
      deviceId: "new-device",
    });
    expect(clearSupersededDeviceId).toHaveBeenCalledTimes(1);
    expect(host.deviceIdentity.supersededDeviceId).toBeUndefined();
  });

  it("retains the retired id after a retryable failure", async () => {
    const identity = {
      deviceId: "new-device",
      publicKey: "new-public",
      supersededDeviceId: "old-device",
    };
    const clearSupersededDeviceId = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createHost({ clearSupersededDeviceId }) as any;
    host.deviceIdentity = identity;
    host.ensureHostConvexClient = vi.fn(() => ({
      mutation: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));

    await host.claimDeviceIdentitySuccession();

    expect(clearSupersededDeviceId).not.toHaveBeenCalled();
    expect(host.deviceIdentity.supersededDeviceId).toBe("old-device");
    expect(warn).toHaveBeenCalled();
  });
});
