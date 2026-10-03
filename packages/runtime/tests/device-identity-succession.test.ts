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
    host.started = true;
    host.hostReady = true;
    host.configCache = { hasConnectedAccount: true };
    host.getConfiguredHostAuthToken = vi.fn(() => "token");
    host.getConfiguredHostBackendUrl = vi.fn(() => "https://backend.example");
    host.claimDeviceIdentitySuccession = vi.fn(async () => undefined);

    host.syncHostAccountServices();
    host.syncHostAccountServices();

    expect(host.claimDeviceIdentitySuccession).toHaveBeenCalledTimes(2);
  });

  it("clears the retired id only after the backend accepts the succession", async () => {
    const identity = {
      deviceId: "new-device",
      publicKey: "new-public",
      supersededDeviceId: "old-device",
    };
    const clearSupersededDeviceId = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn().mockResolvedValue(null);
    const host = createHost({ clearSupersededDeviceId }) as any;
    host.deviceIdentity = identity;
    host.getConfiguredHostAuthToken = vi.fn(() => "token");
    host.ensureHostBackendClient = vi.fn(() => ({ call }));

    await host.claimDeviceIdentitySuccession();

    expect(call).toHaveBeenCalledWith("devices.adoptSuccession", {
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
    host.getConfiguredHostAuthToken = vi.fn(() => "token");
    host.ensureHostBackendClient = vi.fn(() => ({
      call: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));

    await host.claimDeviceIdentitySuccession();

    expect(clearSupersededDeviceId).not.toHaveBeenCalled();
    expect(host.deviceIdentity.supersededDeviceId).toBe("old-device");
    expect(warn).toHaveBeenCalled();
  });
});
