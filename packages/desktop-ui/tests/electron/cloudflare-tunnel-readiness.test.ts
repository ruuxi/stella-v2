import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTunnelService } from "@stella/desktop/electron/services/mobile-bridge/tunnel-service.js";

const TUNNEL_URL = "https://desktop.example.com";

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
  return { anyService, onTunnelUrl };
};

describe("CloudflareTunnelService readiness result", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises a publicly reachable tunnel as verified", async () => {
    const { anyService, onTunnelUrl } = createService();
    vi.spyOn(anyService, "waitForPublicReadiness").mockResolvedValue(true);

    await anyService.announceWhenReachable(TUNNEL_URL);

    expect(onTunnelUrl).toHaveBeenCalledWith(TUNNEL_URL, "verified");
  });

  it("labels the advertise-anyway path as unverified", async () => {
    const { anyService, onTunnelUrl } = createService();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(anyService, "waitForPublicReadiness").mockResolvedValue(false);

    await anyService.announceWhenReachable(TUNNEL_URL);

    expect(onTunnelUrl).toHaveBeenCalledWith(
      TUNNEL_URL,
      "fallback-unverified",
    );
  });
});
