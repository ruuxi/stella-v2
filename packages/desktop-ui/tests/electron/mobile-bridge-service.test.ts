import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  MOBILE_BRIDGE_REGISTRATION_REFRESH_MS,
  MobileBridgeService,
} from "@stella/desktop/electron/services/mobile-bridge/service.js";
import {
  BRIDGE_FEATURE_DEFLATE,
  decryptBridgePayload,
  type BridgeCryptoSession,
} from "@stella/desktop/electron/services/mobile-bridge/crypto.js";
import { randomBytes } from "crypto";

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
  anyService.tunnelUrl = "https://desktop.example.com";
  return anyService;
};

describe("MobileBridgeService registration lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00Z"));
    // syncRegistration now probes the advertised tunnel's /bridge/health before
    // registering; default it to reachable so these tests exercise the
    // registration-response handling. The health-gate behavior itself is
    // covered in mobile-bridge-health-gate.test.ts.
    vi.spyOn(
      MobileBridgeService.prototype as unknown as {
        probePublicTunnelHealth: (url: string) => Promise<boolean>;
      },
      "probePublicTunnelHealth",
    ).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes desktop registration every five minutes", () => {
    expect(MOBILE_BRIDGE_REGISTRATION_REFRESH_MS).toBe(5 * 60_000);
  });

  it("keeps a never-registered bridge disabled even when configuration is present", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.setRegistrationLease(Date.now() + 15 * 60_000);

    expect(anyService.hasRegisteredBridge).toBe(false);
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
  });

  it("stores the server-provided lease expiry after successful registration", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const leaseExpiresAt = Date.now() + 120_000;
    anyService.registerDesktopBridge = vi
      .fn()
      .mockResolvedValue({ ok: true, leaseExpiresAt });

    await anyService.syncRegistration();

    expect(anyService.registrationState).toBe("healthy");
    expect(anyService.registrationLeaseExpiresAt).toBe(leaseExpiresAt);
    expect(anyService.hasRegisteredBridge).toBe(true);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("registers through one authenticated Convex mutation instead of the HTTP route", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const setAuth = vi.fn();
    const mutation = vi.fn().mockResolvedValue({
      ok: true,
      leaseExpiresAt: Date.now() + 15 * 60_000,
    });
    anyService.convexHttpClient = { setAuth, mutation };
    anyService.convexHttpClientUrl = anyService.convexDeploymentUrl;
    anyService.convexHttpClientAuthToken = null;
    anyService.postBridgeJson = vi.fn();

    await anyService.syncRegistration();

    expect(setAuth).toHaveBeenCalledOnce();
    expect(setAuth).toHaveBeenCalledWith("desktop-token");
    expect(mutation).toHaveBeenCalledOnce();
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      deviceId: "desktop-device",
      baseUrls: ["https://desktop.example.com"],
    });
    expect(anyService.postBridgeJson).not.toHaveBeenCalled();
  });

  it("reuses the registration client while updating rotated auth and deployment URLs", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const client = {
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      mutation: vi.fn(),
    };
    anyService.convexHttpClient = client;
    anyService.convexHttpClientUrl = anyService.convexDeploymentUrl;
    anyService.convexHttpClientAuthToken = "desktop-token";
    anyService.hasRegisteredBridge = true;
    const scheduleRegistrationSync = vi
      .spyOn(anyService, "scheduleRegistrationSync")
      .mockImplementation(() => undefined);

    service.setHostAuthToken("rotated-token");

    expect(client.setAuth).toHaveBeenCalledWith("rotated-token");
    expect(anyService.convexHttpClient).toBe(client);
    expect(scheduleRegistrationSync).not.toHaveBeenCalled();

    service.setConvexDeploymentUrl(" https://next.convex.cloud/ ");

    expect(anyService.convexDeploymentUrl).toBe("https://next.convex.cloud");
    expect(anyService.convexHttpClient).toBeNull();
    expect(anyService.convexHttpClientAuthToken).toBeNull();
    expect(scheduleRegistrationSync).toHaveBeenCalledOnce();
  });

  it("schedules registration when auth first becomes available", () => {
    const service = createService();
    const anyService = service as any;
    const scheduleRegistrationSync = vi
      .spyOn(anyService, "scheduleRegistrationSync")
      .mockImplementation(() => undefined);

    service.setHostAuthToken("first-token");

    expect(scheduleRegistrationSync).toHaveBeenCalledOnce();
  });

  it("keeps the existing lease during transient registration failures", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;
    anyService.registerDesktopBridge = vi
      .fn()
      .mockRejectedValue(new Error("temporary network issue"));
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("keeps the existing lease during non-auth registration rejections", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;
    anyService.registerDesktopBridge = vi
      .fn()
      .mockRejectedValue(new Error("server error"));
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("expires bridge access when a successful response omits lease details", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registerDesktopBridge = vi
      .fn()
      .mockResolvedValue({ ok: true });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("expired");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
  });

  it("expires backend presence without disabling challenges or sessions", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;

    anyService.wsClients.set(ws, {
      authenticated: true,
      subscriptions: new Set(["display:update"]),
    });
    anyService.sessions.set("session-1", {
      expiresAt: Date.now() + 60_000,
    });
    anyService.setRegistrationLease(Date.now() + 1_000);
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;

    await vi.advanceTimersByTimeAsync(1_001);

    expect(anyService.registrationState).toBe("expired");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
    expect(anyService.wsClients.size).toBe(1);
    expect(anyService.sessions.size).toBe(1);

    const response = {
      statusCode: 0,
      body: "",
      writeHead(statusCode: number) {
        this.statusCode = statusCode;
      },
      end(chunk?: unknown) {
        this.body = chunk == null ? "" : String(chunk);
      },
    };
    await anyService.handleRequest(
      {
        url: "/bridge/challenge?d=desktop-device",
        method: "GET",
        headers: {},
      },
      response,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).desktopDeviceId).toBe("desktop-device");
  });

  it("revokes bridge access when registration is rejected for auth", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;
    const ws = { close: vi.fn() };
    anyService.wsClients.set(ws, { authenticated: true, subscriptions: new Set() });
    anyService.sessions.set("session-1", { expiresAt: Date.now() + 60_000 });
    anyService.registerDesktopBridge = vi.fn().mockRejectedValue({
      data: { code: "FORBIDDEN" },
    });

    await anyService.syncRegistration();

    expect(anyService.registrationState).toBe("revoked");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.hasRegisteredBridge).toBe(false);
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(
      4001,
      "Desktop bridge authorization expired",
    );
    expect(anyService.sessions.size).toBe(0);
  });

  it("explicit clear disables the bridge and closes clients", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const ws = { close: vi.fn() };
    anyService.hasRegisteredBridge = true;
    anyService.registrationState = "expired";
    anyService.registrationLeaseExpiresAt = null;
    anyService.wsClients.set(ws, { authenticated: true, subscriptions: new Set() });
    anyService.sessions.set("session-1", { expiresAt: Date.now() + 60_000 });
    anyService.postBridgeJson = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await anyService.clearRegistration();

    expect(anyService.postBridgeJson).toHaveBeenCalledWith(
      "https://example.convex.site",
      "/api/mobile/desktop-bridge/clear",
      "Bearer desktop-token",
      { deviceId: "desktop-device" },
    );
    expect(anyService.registrationState).toBe("inactive");
    expect(anyService.hasRegisteredBridge).toBe(false);
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(4001, "Desktop bridge unavailable");
    expect(anyService.sessions.size).toBe(0);
  });

  it("prefers explicit session headers over a stale cookie", async () => {
    // Regression: a request carrying a previous send's session cookie plus the
    // current send's session headers must authorize the *header* session. The
    // cookie used to win, so the desktop decrypted the new payload with the old
    // session's keys and the phone saw a spurious "session expired".
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;

    const staleSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret-old",
      mobileDeviceId: "old",
      crypto: { marker: "old" },
    };
    const freshSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret-new",
      mobileDeviceId: "new",
      crypto: { marker: "new" },
    };
    anyService.sessions.set("cookie-old", staleSession);
    anyService.sessions.set("session-new", freshSession);

    const req = {
      headers: {
        cookie: "stella_mobile_bridge=cookie-old",
        "x-stella-bridge-session-id": "session-new",
        "x-stella-bridge-session-secret": "secret-new",
        "x-stella-bridge-challenge-id": "challenge-new",
      },
    };
    const res = { setHeader: vi.fn() };

    const resolved = await anyService.ensureAuthorized(req, res, null);

    expect(resolved).toBe(freshSession);
    expect(resolved).not.toBe(staleSession);
  });

  it("falls back to the cookie when no session headers are present", async () => {
    // WebView sub-resources (scripts, images) can't set custom headers, so the
    // cookie path must still authorize them.
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;

    const cookieSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret",
      mobileDeviceId: "web",
      crypto: { marker: "web" },
    };
    anyService.sessions.set("cookie-web", cookieSession);

    const req = { headers: { cookie: "stella_mobile_bridge=cookie-web" } };
    const res = { setHeader: vi.fn() };

    const resolved = await anyService.ensureAuthorized(req, res, null);

    expect(resolved).toBe(cookieSession);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("filters source-diff display updates unless developer previews are enabled", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.hasRegisteredBridge = true;
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
    anyService.wsClients.set(ws, {
      authenticated: true,
      subscriptions: new Set(["display:update"]),
    });

    service.broadcastToMobile("display:update", {
      kind: "source-diff",
      filePath: "/repo/src/app.tsx",
    });
    expect(ws.send).not.toHaveBeenCalled();

    anyService.lastBootstrapPayload = {
      localStorage: { "stella-developer-resource-previews": "true" },
      mobileBridgeCapabilities: { version: 1, capabilities: [] },
    };
    service.broadcastToMobile("display:update", {
      kind: "source-diff",
      filePath: "/repo/src/app.tsx",
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("compresses WebSocket responses only for peers that negotiated deflate", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const key = new Uint8Array(randomBytes(32));
    const makeClient = (features: Set<string>) => ({
      encrypted: true,
      session: {
        peerFeatures: features,
        crypto: {
          sessionId: "ws-session",
          key,
          txSeq: 0,
        } satisfies BridgeCryptoSession,
      },
    });
    const payload = {
      type: "response",
      id: "resume",
      result: {
        events: Array.from({ length: 100 }, () => ({ chunk: "x".repeat(200) })),
      },
    };

    const legacy = JSON.parse(
      anyService.serializeWsMessage(makeClient(new Set()), payload),
    );
    expect(legacy.envelope.z).toBeUndefined();

    const modern = JSON.parse(
      anyService.serializeWsMessage(
        makeClient(new Set([BRIDGE_FEATURE_DEFLATE])),
        payload,
      ),
    );
    expect(modern.envelope.z).toBe(1);
    expect(modern.envelope.ct.length).toBeLessThan(legacy.envelope.ct.length);
    expect(
      decryptBridgePayload(
        { sessionId: "ws-session", key, txSeq: 0 },
        "d2m",
        modern.envelope,
      ),
    ).toEqual(payload);
  });

  it("does not schedule registration when auth endpoints are unchanged", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const schedule = vi
      .spyOn(anyService, "scheduleRegistrationSync")
      .mockImplementation(() => undefined);

    service.setDeviceId("desktop-device");
    service.setHostAuthToken("desktop-token");
    service.setConvexSiteUrl("https://example.convex.site");
    service.setTunnelUrl("https://desktop.example.com");
    expect(schedule).not.toHaveBeenCalled();

    service.setDeviceId("desktop-device-2");
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
