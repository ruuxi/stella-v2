import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBridgeService } from "@stella/desktop/electron/services/mobile-bridge/service.js";

const TUNNEL_URL = "https://desktop.example.com";

const createService = () =>
  new MobileBridgeService({
    electronDir: "/tmp/stella-test/desktop/electron",
    isDev: false,
    getDevServerUrl: () => "http://127.0.0.1:5173",
  });

const configureReadyService = (service: MobileBridgeService) => {
  const anyService = service as any;
  anyService.port = 4318;
  anyService.convexDeploymentUrl = "https://example.convex.cloud";
  anyService.convexSiteUrl = "https://example.convex.site";
  anyService.hostAuthToken = "desktop-token";
  anyService.deviceId = "desktop-device";
  anyService.tunnelUrl = TUNNEL_URL;
  return anyService;
};

const mockBridgeCalls = (anyService: any) => {
  const counts = { register: 0, clear: 0 };
  anyService.registerDesktopBridge = vi.fn(async () => {
    counts.register += 1;
    return { ok: true, leaseExpiresAt: Date.now() + 15 * 60_000 };
  });
  anyService.postBridgeJson = vi.fn(
    async (_siteUrl: string, route: string) => {
      if (route.endsWith("/clear")) {
        counts.clear += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  );
  return counts;
};

const mockHealth = () => {
  const state = {
    healthy: true,
    probe: undefined as unknown as ReturnType<typeof vi.spyOn>,
  };
  state.probe = vi
    .spyOn(
      MobileBridgeService.prototype as unknown as {
        probePublicTunnelHealth: (url: string) => Promise<boolean>;
      },
      "probePublicTunnelHealth",
    )
    .mockImplementation(async () => state.healthy);
  return state;
};

describe("MobileBridgeService health-gated registration", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers only after the advertised public URL passes a health probe", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    mockHealth();

    await anyService.syncRegistration();

    expect(counts.register).toBe(1);
    expect(counts.clear).toBe(0);
    expect(anyService.registrationState).toBe("healthy");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("reuses the tunnel layer's verified result instead of probing twice", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();
    vi.spyOn(anyService, "scheduleRegistrationSync").mockImplementation(
      () => undefined,
    );

    anyService.tunnelUrl = null;
    service.setTunnelUrl(TUNNEL_URL, "verified");
    await anyService.syncRegistration();

    expect(health.probe).not.toHaveBeenCalled();
    expect(counts.register).toBe(1);
    expect(anyService.registrationState).toBe("healthy");

    anyService.clearRegistrationLeaseTimer();
  });

  it("registers and refreshes an unverified fallback until it becomes healthy", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();
    health.healthy = false;
    vi.spyOn(anyService, "scheduleRegistrationSync").mockImplementation(
      () => undefined,
    );

    anyService.tunnelUrl = null;
    service.setTunnelUrl(TUNNEL_URL, "fallback-unverified");
    await anyService.syncRegistration();

    expect(health.probe).not.toHaveBeenCalled();
    expect(counts.register).toBe(1);
    expect(counts.clear).toBe(0);
    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    await anyService.syncRegistration();
    await anyService.syncRegistration();
    expect(health.probe).toHaveBeenCalledTimes(2);
    expect(counts.register).toBe(3);
    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    health.healthy = true;
    await anyService.syncRegistration();
    expect(health.probe).toHaveBeenCalledTimes(3);
    expect(counts.register).toBe(4);
    expect(anyService.registrationState).toBe("healthy");

    anyService.clearRegistrationLeaseTimer();
  });

  it("keeps the lease on a single transient probe miss (no down-register)", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();

    await anyService.syncRegistration();
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    health.healthy = false;
    anyService.lastHealthyProbeAt = 0;
    await anyService.syncRegistration();

    expect(counts.clear).toBe(0);
    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("clears availability after sustained failures, then re-registers on recovery", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();

    await anyService.syncRegistration();
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
    const registersBeforeOutage = counts.register;

    anyService.clearRegistrationLeaseTimer();
    anyService.registrationLeaseExpiresAt = null;
    anyService.registrationState = "expired";
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    health.healthy = false;
    anyService.lastHealthyProbeAt = 0;
    await anyService.syncRegistration();
    await anyService.syncRegistration();
    expect(counts.clear).toBe(0);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    await anyService.syncRegistration();
    expect(counts.clear).toBe(1);
    expect(anyService.isBridgeAccessEnabled()).toBe(false);

    expect(counts.register).toBe(registersBeforeOutage);

    health.healthy = true;
    await anyService.syncRegistration();
    expect(counts.register).toBe(registersBeforeOutage + 1);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("coalesces overlapping sync calls so probes/registrations never stack", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    mockHealth();

    await anyService.syncRegistration();
    const registersBefore = counts.register;

    await Promise.all([
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
    ]);

    expect(counts.register - registersBefore).toBeLessThanOrEqual(2);
    expect(counts.register - registersBefore).toBeGreaterThanOrEqual(1);

    anyService.clearRegistrationLeaseTimer();
  });

  it("reuses a recent probe within the cache window, re-probes after it expires", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    mockBridgeCalls(anyService);
    const health = mockHealth();

    await anyService.syncRegistration();
    const probesAfterFirst = health.probe.mock.calls.length;
    expect(probesAfterFirst).toBe(1);

    await anyService.syncRegistration();
    expect(health.probe.mock.calls.length).toBe(probesAfterFirst);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.lastHealthyProbeAt = Date.now() - 60_000;
    await anyService.syncRegistration();
    expect(health.probe.mock.calls.length).toBe(probesAfterFirst + 1);

    anyService.clearRegistrationLeaseTimer();
  });
});
