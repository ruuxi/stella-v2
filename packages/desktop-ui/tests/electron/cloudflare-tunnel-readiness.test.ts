import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTunnelService } from "@stella/desktop/electron/services/mobile-bridge/tunnel-service.js";
import * as publicHealth from "@stella/desktop/electron/services/mobile-bridge/public-health.js";

const TUNNEL_URL = "https://desktop.example.com";

vi.mock(
  "@stella/desktop/electron/services/mobile-bridge/public-health.js",
  () => ({ probeBridgePublicHealth: vi.fn() }),
);

const createService = () => {
  const onTunnelUrl = vi.fn();
  const service = new CloudflareTunnelService({
    getAuthToken: async () => "desktop-token",
    getConvexSiteUrl: () => "https://example.convex.site",
    getDeviceId: () => "desktop-device",
    onTunnelUrl,
  });
  const anyService = service as any;
  anyService.started = true;
  anyService.process = {};
  anyService.readinessGeneration = 1;
  return { anyService, onTunnelUrl };
};

const probe = vi.mocked(publicHealth.probeBridgePublicHealth);

describe("CloudflareTunnelService readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    probe.mockReset();
  });

  it("advertises a publicly reachable tunnel as verified", async () => {
    const { anyService, onTunnelUrl } = createService();
    probe.mockResolvedValue(true);

    await anyService.announceWhenReachable(TUNNEL_URL, 1);

    expect(onTunnelUrl).toHaveBeenCalledWith(TUNNEL_URL, "verified");
    expect(anyService.tunnelUrl).toBe(TUNNEL_URL);
  });

  it("keeps probing without advertising while the URL is unreachable", async () => {
    vi.useFakeTimers();
    const { anyService, onTunnelUrl } = createService();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    probe.mockImplementation(async () => {
      calls += 1;
      return calls >= 4;
    });

    const pending = anyService.announceWhenReachable(TUNNEL_URL, 1);
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await pending;

    expect(onTunnelUrl).toHaveBeenCalledTimes(1);
    expect(onTunnelUrl).toHaveBeenCalledWith(TUNNEL_URL, "verified");
    expect(calls).toBe(4);
  });

  it("asks the backend to repair the tunnel after a sustained outage and restarts on re-provision", async () => {
    vi.useFakeTimers();
    const { anyService, onTunnelUrl } = createService();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    probe.mockResolvedValue(false);
    anyService.activeToken = { tunnelToken: "old", hostname: "desktop.example.com" };
    const fetchTunnelToken = vi
      .spyOn(anyService, "fetchTunnelToken")
      .mockResolvedValue({
        tunnelToken: "new",
        hostname: "desktop.example.com",
        repair: { dnsRepaired: true, reprovisioned: true },
      });
    const stop = vi.spyOn(anyService, "stop").mockImplementation(async () => {
      anyService.started = false;
      anyService.process = null;
      anyService.readinessGeneration += 1;
    });
    const start = vi.spyOn(anyService, "start").mockResolvedValue(undefined);

    const pending = anyService.announceWhenReachable(TUNNEL_URL, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(fetchTunnelToken).toHaveBeenCalledWith({ repair: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(onTunnelUrl).not.toHaveBeenCalled();
  });

  it("stops probing once the connector generation is superseded", async () => {
    vi.useFakeTimers();
    const { anyService, onTunnelUrl } = createService();
    probe.mockResolvedValue(false);

    const pending = anyService.announceWhenReachable(TUNNEL_URL, 1);
    anyService.readinessGeneration = 2;
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(onTunnelUrl).not.toHaveBeenCalled();
  });
});
