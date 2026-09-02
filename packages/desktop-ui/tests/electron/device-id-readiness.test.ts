import { beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  getOrCreateDeviceIdentity: vi.fn(),
  getOrCreateDeviceSigner: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => "/tmp/stella"),
    getVersion: vi.fn(() => "0.0.0"),
    isPackaged: false,
  },
}));

vi.mock("@stella/runtime/kernel/home/device", () => ({
  clearSupersededDeviceId: vi.fn(),
  getOrCreateDeviceIdentity: device.getOrCreateDeviceIdentity,
  getOrCreateDeviceSigner: device.getOrCreateDeviceSigner,
}));

vi.mock("../../../desktop/electron/native-helper-path.js", () => ({
  resolveNativeHelperPath: vi.fn(() => null),
}));

vi.mock("../../../desktop/electron/stella-host-runner.js", () => ({
  createStellaHostRunner: vi.fn(),
}));

vi.mock("../../../desktop/electron/bootstrap/context.js", () => ({
  broadcastLocalChatUpdated: vi.fn(),
  broadcastScheduleUpdated: vi.fn(),
  broadcastThreadActivityUpdated: vi.fn(),
  broadcastToWindows: vi.fn(),
  broadcastUserAppsUpdated: vi.fn(),
}));

vi.mock("../../../desktop/electron/bootstrap/office-preview-bridge.js", () => ({
  startOfficePreviewBridge: vi.fn(),
}));

vi.mock("../../../desktop/electron/services/notification-service.js", () => ({
  showStellaNotification: vi.fn(),
}));

vi.mock("../../../desktop/electron/active-browser-tab.js", () => ({
  getActiveBrowserTabForBundleId: vi.fn(),
}));

vi.mock("../../../desktop/electron/recent-apps.js", () => ({
  listRecentApps: vi.fn(),
}));

vi.mock("../../../desktop/electron/utils/macos-permissions.js", () => ({
  requestMacPermission: vi.fn(),
}));

vi.mock("../../../desktop/electron/observability/main-logger.js", () => ({
  getMainLogger: vi.fn(() => null),
}));

const {
  loadStellaDeviceId,
  loadStellaDeviceIdentity,
  loadStellaDeviceSigner,
} = await import("../../../desktop/electron/bootstrap/host-runner.js");

const createContext = () => ({
  state: {
    deviceId: null as string | null,
    deviceIdentityPromise: null as Promise<unknown> | null,
    deviceSignerPromise: null as Promise<unknown> | null,
    stellaDataDirPath: "/tmp/stella-data",
  },
});

describe("desktop device identity readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares one in-flight identity load between concurrent callers", async () => {
    let resolveIdentity: ((identity: { deviceId: string }) => void) | null = null;
    device.getOrCreateDeviceIdentity.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const context = createContext();

    const first = loadStellaDeviceIdentity(context);
    const second = loadStellaDeviceIdentity(context);

    expect(device.getOrCreateDeviceIdentity).toHaveBeenCalledOnce();
    resolveIdentity?.({ deviceId: "device-1" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { deviceId: "device-1" },
      { deviceId: "device-1" },
    ]);
    expect(context.state.deviceId).toBe("device-1");
    expect(context.state.deviceIdentityPromise).toBeNull();
  });

  it("caches an on-demand device ID for later requests", async () => {
    device.getOrCreateDeviceIdentity.mockResolvedValue({
      deviceId: "device-2",
    });
    const context = createContext();

    await expect(loadStellaDeviceId(context)).resolves.toBe("device-2");
    await expect(loadStellaDeviceId(context)).resolves.toBe("device-2");

    expect(device.getOrCreateDeviceIdentity).toHaveBeenCalledOnce();
  });

  it("loads the protected device signer once for repeated proofs", async () => {
    const signer = { alg: "ed25519", rawPublicKey: new Uint8Array(32) };
    device.getOrCreateDeviceSigner.mockResolvedValue(signer);
    const context = createContext();

    await expect(loadStellaDeviceSigner(context)).resolves.toBe(signer);
    await expect(loadStellaDeviceSigner(context)).resolves.toBe(signer);

    expect(device.getOrCreateDeviceSigner).toHaveBeenCalledOnce();
  });

  it("keeps normal startup identity loading authoritative", async () => {
    device.getOrCreateDeviceIdentity.mockResolvedValue({
      deviceId: "device-current",
    });
    const context = createContext();
    context.state.deviceId = "device-cached";

    await expect(loadStellaDeviceIdentity(context)).resolves.toEqual({
      deviceId: "device-current",
    });

    expect(device.getOrCreateDeviceIdentity).toHaveBeenCalledWith(
      "/tmp/stella-data",
    );
    expect(context.state.deviceId).toBe("device-current");
  });
});
