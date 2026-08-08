import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridgeOptions: null as Record<string, unknown> | null,
  bridgeStart: vi.fn(),
  bridgeStop: vi.fn(),
  bridgeSetConvexDeploymentUrl: vi.fn(),
  tunnelStart: vi.fn(),
  tunnelStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@stella/desktop/electron/services/mobile-bridge/service.js",
  () => ({
    MobileBridgeService: class {
      constructor(options: Record<string, unknown>) {
        mocks.bridgeOptions = options;
      }

      setBootstrapPayloadGetter() {}
      start() {
        mocks.bridgeStart();
      }
      stop() {
        mocks.bridgeStop();
      }
      getPort() {
        return 4318;
      }
      setDeviceId() {}
      setHostAuthToken() {}
      setConvexDeploymentUrl(value: string | null) {
        mocks.bridgeSetConvexDeploymentUrl(value);
      }
      setConvexSiteUrl() {}
      setTunnelUrl() {}
      broadcastToMobile() {}
    },
  }),
);

vi.mock(
  "@stella/desktop/electron/process-resources/cloudflare-tunnel-resource.js",
  () => ({
    createCloudflareTunnelResource: () => ({
      setBridgePort: vi.fn(),
      start: mocks.tunnelStart,
      stop: mocks.tunnelStop,
    }),
  }),
);

import { createMobileBridgeResource } from "@stella/desktop/electron/process-resources/mobile-bridge-resource.js";

describe("mobile bridge resource lifecycle", () => {
  beforeEach(() => {
    mocks.bridgeOptions = null;
    mocks.bridgeStart.mockClear();
    mocks.bridgeStop.mockClear();
    mocks.bridgeSetConvexDeploymentUrl.mockClear();
    mocks.tunnelStart.mockClear();
    mocks.tunnelStop.mockClear();
  });

  it("stays running without scheduling or rearming an activity idle stop", async () => {
    const setManagedTimeout = vi.fn(() => vi.fn());
    const stopAuthSync = vi.fn();
    const resource = createMobileBridgeResource({
      processRuntime: {
        isShuttingDown: () => false,
        setManagedTimeout,
        setManagedInterval: vi.fn(() => stopAuthSync),
      },
      electronDir: "/tmp/stella-test/desktop/electron",
      isDev: false,
      getDevServerUrl: () => "http://127.0.0.1:5173",
      getAuthToken: async () => "token",
      getConvexUrl: () => "https://example.convex.cloud",
      getConvexSiteUrl: () => "https://example.convex.site",
      getDeviceId: () => "desktop-1",
      getBootstrapPayload: () => ({}),
      getFullWindow: () => ({
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
        once: vi.fn(),
      }),
    });

    resource.start();

    expect(mocks.bridgeStart).toHaveBeenCalledOnce();
    expect(mocks.tunnelStart).toHaveBeenCalledOnce();
    expect(setManagedTimeout).not.toHaveBeenCalled();
    expect(mocks.bridgeOptions).not.toHaveProperty("onClientActivity");
    await vi.waitFor(() => {
      expect(mocks.bridgeSetConvexDeploymentUrl).toHaveBeenCalledWith(
        "https://example.convex.cloud",
      );
    });

    await resource.stop();
    expect(mocks.tunnelStop).toHaveBeenCalledOnce();
    expect(mocks.bridgeStop).toHaveBeenCalledOnce();
    expect(stopAuthSync).toHaveBeenCalledOnce();
  });
});
