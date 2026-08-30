import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../helpers/protected-storage.js";

const electronMocks = vi.hoisted(() => ({
  userDataPath: "",
  powerResumeListeners: [] as (() => void)[],
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => electronMocks.userDataPath),
    getAppPath: vi.fn(() => "/tmp/stella-auth-service-test/app"),
    isReady: vi.fn(() => false),
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "resume") {
        electronMocks.powerResumeListeners.push(listener);
      }
    }),
  },
}));

import { AuthService } from "@stella/desktop/electron/services/auth-service.js";

const SITE_URL = "https://example.convex.site";
const BEARER_KEY = "better-auth_session_token";
const SESSION_KEY = "better-auth_session_data";
const IDENTITY_INTENT_KEY = "auth_identity_intent";

const createJwt = (expiresAtSeconds: number, label = "signature") =>
  [
    "header",
    Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString(
      "base64url",
    ),
    label,
  ].join(".");

const futureJwt = (label?: string) =>
  createJwt(Math.floor(Date.now() / 1000) + 30 * 60, label);

const nearlyExpiredJwt = (label?: string) =>
  createJwt(Math.floor(Date.now() / 1000) + 30, label);

type AuthRoute = (request: Request) => Response | Promise<Response>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const connectedSession = () =>
  json({ user: { id: "u1" }, session: { id: "s1" } });

const createService = () => {
  const runner = {
    setAuthToken: vi.fn(),
    setHasConnectedAccount: vi.fn(),
    setConvexUrl: vi.fn(),
    setConvexSiteUrl: vi.fn(),
  };
  const onSessionInvalidated = vi.fn();
  const service = new AuthService({
    authProtocol: "stella",
    isDev: false,
    projectDir: electronMocks.userDataPath,
    sessionPartition: "persist:stella",
    runnerTarget: { getRunner: () => runner },
    onAuthCallback: vi.fn(),
    onSecondInstanceFocus: vi.fn(),
    onSessionInvalidated,
  });
  return { onSessionInvalidated, runner, service };
};

const configure = (service: AuthService) => {
  service.configurePiRuntime({
    convexUrl: "https://example.convex.cloud",
    convexSiteUrl: `${SITE_URL}/`,
  });
};

/**
 * Route `/api/auth/*` by pathname. Anything unrouted answers 500 so an
 * unexpected call surfaces as a failure instead of a silent default.
 */
const installAuthRoutes = (routes: Record<string, AuthRoute>) => {
  const calls: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      const pathname = new URL(request.url).pathname.replace("/api/auth", "");
      calls.push(pathname);
      const route = routes[pathname];
      if (!route) {
        return new Response("unrouted", { status: 500 });
      }
      return await route(request);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
};

describe("AuthService main-process token authority", () => {
  beforeEach(() => {
    electronMocks.userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-auth-service-"),
    );
    electronMocks.powerResumeListeners.length = 0;
    installTestSafeStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTestSafeStorage();
    fs.rmSync(electronMocks.userDataPath, { force: true, recursive: true });
  });

  it("returns a token minted by the desktop-owned auth path", async () => {
    const { service } = createService();
    const freshToken = futureJwt();
    configure(service);
    vi.spyOn(service, "getAuthToken").mockResolvedValue(freshToken);

    await expect(service.getScheduleScriptAuth()).resolves.toEqual({
      baseUrl: SITE_URL,
      authToken: freshToken,
    });
  });

  it("does not inject a stale fallback token when minting fails", async () => {
    const { service } = createService();
    configure(service);
    vi.spyOn(service, "getAuthToken").mockResolvedValue(
      createJwt(Math.floor(Date.now() / 1000) - 60),
    );

    await expect(service.getScheduleScriptAuth()).resolves.toBeNull();
  });

  it("mints the Convex JWT in main and hands it straight to the runner", async () => {
    const { runner, service } = createService();
    const token = futureJwt();
    installAuthRoutes({
      "/convex/token": () => json({ token }),
      "/get-session": connectedSession,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");

    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: true,
      token,
      hasConnectedAccount: true,
    });
    expect(runner.setAuthToken).toHaveBeenCalledWith(token);
  });

  it("sends the stored bearer as an Authorization header and never a cookie", async () => {
    const { service } = createService();
    const seen: Headers[] = [];
    const capture: AuthRoute = (request) => {
      seen.push(request.headers);
      return json({ token: futureJwt() });
    };
    installAuthRoutes({
      "/convex/token": capture,
      "/get-session": (request) => {
        seen.push(request.headers);
        return connectedSession();
      },
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");

    await service.refreshRuntimeAuth();

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.get("authorization")).toBe("Bearer bearer-1");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("better-auth-cookie")).toBeNull();
    }
  });

  it("persists the rotated bearer returned in set-auth-token", async () => {
    const { service } = createService();
    installAuthRoutes({
      "/convex/token": () =>
        json(
          { token: futureJwt() },
          { headers: { "set-auth-token": "bearer-rotated" } },
        ),
      "/get-session": connectedSession,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    await service.refreshRuntimeAuth();

    // A second service reads the same on-disk storage, so what it presents is
    // what a restarted app would present.
    const { service: reopened } = createService();
    const seen: (string | null)[] = [];
    installAuthRoutes({
      "/convex/token": (request) => {
        seen.push(request.headers.get("authorization"));
        return json({ token: futureJwt() });
      },
      "/get-session": connectedSession,
    });
    configure(reopened);
    await reopened.refreshRuntimeAuth();

    expect(seen).toContain("Bearer bearer-rotated");
  });

  it("reports an anonymous session as authenticated without a connected account", async () => {
    const { runner, service } = createService();
    installAuthRoutes({
      "/convex/token": () => json({ token: futureJwt() }),
      "/get-session": () =>
        json({
          user: { id: "anon", isAnonymous: true },
          session: { id: "s1" },
        }),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-anon");

    const state = await service.refreshRuntimeAuth();

    expect(state.authenticated).toBe(true);
    expect(state.hasConnectedAccount).toBe(false);
    expect(runner.setHasConnectedAccount).not.toHaveBeenCalledWith(true);
  });

  it("upgrades anonymous to connected in one pass when a claimed token is applied", async () => {
    const { runner, service } = createService();
    const anonymousToken = futureJwt("anon");
    const connectedToken = futureJwt("connected");
    let bearer = "bearer-anon";
    installAuthRoutes({
      "/convex/token": () =>
        json({
          token: bearer === "bearer-anon" ? anonymousToken : connectedToken,
        }),
      "/get-session": () =>
        json(
          bearer === "bearer-anon"
            ? { user: { id: "anon", isAnonymous: true }, session: { id: "s1" } }
            : { user: { id: "u1" }, session: { id: "s2" } },
        ),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, bearer);
    await service.refreshRuntimeAuth();
    expect(service.getHostHasConnectedAccount()).toBe(false);

    bearer = "bearer-connected";
    await service.applySessionToken(bearer);

    expect(await service.getAuthToken()).toBe(connectedToken);
    expect(service.getHostHasConnectedAccount()).toBe(true);
    expect(runner.setAuthToken).toHaveBeenLastCalledWith(connectedToken);
  });

  it("requires reauthentication and pushes an invalidation when a connected bearer is rejected", async () => {
    const { onSessionInvalidated, runner, service } = createService();
    installAuthRoutes({
      "/convex/token": () =>
        json(
          { code: "UNAUTHORIZED", message: "Session expired" },
          { status: 401 },
        ),
      "/get-session": connectedSession,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-revoked");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "connected");
    service.setAuthStorageItem(
      SESSION_KEY,
      JSON.stringify({ user: { id: "u1" }, session: { id: "s1" } }),
    );

    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: false,
      token: null,
      hasConnectedAccount: false,
    });
    expect(onSessionInvalidated).toHaveBeenCalledTimes(1);
    expect(await service.getAuthToken()).toBeNull();
    expect(runner.setAuthToken).toHaveBeenLastCalledWith(null);
  });

  it("keeps the credential when the mint fails for network reasons", async () => {
    const { onSessionInvalidated, service } = createService();
    const cachedToken = futureJwt();
    installAuthRoutes({
      "/convex/token": () => json({ token: cachedToken }),
      "/get-session": connectedSession,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    await service.refreshRuntimeAuth();

    installAuthRoutes({
      "/convex/token": () => {
        throw new TypeError("fetch failed");
      },
      "/get-session": connectedSession,
    });

    await expect(service.getConvexAuthTokenResult()).resolves.toEqual({
      ok: false,
      reason: "network",
    });
    expect(onSessionInvalidated).not.toHaveBeenCalled();
    expect(await service.getAuthToken()).toBe(cachedToken);
  });

  it("discards a mint that resolves after sign-out", async () => {
    const { runner, service } = createService();
    const gate: { release: (() => void) | null } = { release: null };
    installAuthRoutes({
      "/convex/token": async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return json({ token: futureJwt("late") });
      },
      "/get-session": connectedSession,
      "/sign-out": () => json({ ok: true }),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");

    const inflight = service.getAuthToken();
    await vi.waitFor(() => expect(gate.release).not.toBeNull());
    await service.signOut();
    gate.release?.();

    await expect(inflight).resolves.toBeNull();
    const handedToRunner = runner.setAuthToken.mock.calls.map(
      ([token]) => token,
    );
    expect(handedToRunner.filter(Boolean)).toEqual([]);
  });

  it("does not let a late session verdict overwrite a newer sign-out", async () => {
    const { service } = createService();
    const gate: { release: (() => void) | null } = { release: null };
    installAuthRoutes({
      "/get-session": async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return connectedSession();
      },
      "/sign-out": () => json({ ok: true }),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "connected");

    const inflight = service.getAuthSessionSnapshot();
    await vi.waitFor(() => expect(gate.release).not.toBeNull());
    await service.signOut();
    gate.release?.();

    await expect(inflight).resolves.toMatchObject({
      status: "anonymous_required",
      reason: "explicit_sign_out",
    });
  });

  it("remints on power resume when the cached token has gone stale", async () => {
    const { service } = createService();
    const minted: string[] = [];
    installAuthRoutes({
      "/convex/token": () => {
        const token =
          minted.length === 0 ? nearlyExpiredJwt("first") : futureJwt("second");
        minted.push(token);
        return json({ token });
      },
      "/get-session": connectedSession,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    await service.refreshRuntimeAuth();
    expect(minted).toHaveLength(1);
    expect(electronMocks.powerResumeListeners).toHaveLength(1);

    for (const listener of electronMocks.powerResumeListeners) listener();

    await vi.waitFor(() => expect(minted).toHaveLength(2));
    expect(await service.getAuthToken()).toBe(minted[1]);
  });

  it("reports unauthenticated without touching the network when no bearer is stored", async () => {
    const { service } = createService();
    const { fetchMock } = installAuthRoutes({});
    configure(service);

    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: false,
      token: null,
      hasConnectedAccount: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["http 500", () => json({ code: "UPSTREAM_FAILURE" }, { status: 500 })],
    ["route 404", () => json({ code: "NOT_FOUND" }, { status: 404 })],
    [
      "malformed 200",
      () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
  ])("keeps a connected cached identity stale on %s", async (_label, route) => {
    const { onSessionInvalidated, service } = createService();
    installAuthRoutes({ "/get-session": route });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "connected");
    service.setAuthStorageItem(
      SESSION_KEY,
      JSON.stringify({ user: { id: "u1" }, session: { id: "s1" } }),
    );

    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "unknown",
      identityIntent: "connected",
      staleSession: { user: { id: "u1" } },
    });
    expect(onSessionInvalidated).not.toHaveBeenCalled();
    await expect(service.signInAnonymous()).rejects.toThrow(
      "Anonymous sign-in is not allowed",
    );
    service.stopAuthRefreshLoop();
  });

  it("turns a recognized connected-session rejection into reauth, never anonymous", async () => {
    const { service } = createService();
    const anonymousSignIns = vi.fn();
    installAuthRoutes({
      "/get-session": () => json({ code: "SESSION_EXPIRED" }, { status: 401 }),
      "/sign-in/anonymous": anonymousSignIns,
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-1");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "connected");
    service.setAuthStorageItem(
      SESSION_KEY,
      JSON.stringify({ user: { id: "u1" }, session: { id: "s1" } }),
    );

    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "reauth_required",
      identityIntent: "connected",
      staleSession: { user: { id: "u1" } },
    });
    await expect(service.signInAnonymous()).rejects.toThrow(
      "Anonymous sign-in is not allowed",
    );
    expect(anonymousSignIns).not.toHaveBeenCalled();
  });

  it("replaces a definitively dead anonymous identity exactly once", async () => {
    const { service } = createService();
    let replacementCreated = false;
    const anonymousSignIn = vi.fn(() => {
      replacementCreated = true;
      return json(
        { ok: true },
        { headers: { "set-auth-token": "bearer-anon-2" } },
      );
    });
    installAuthRoutes({
      "/get-session": () =>
        replacementCreated
          ? json({
              user: { id: "anon-2", isAnonymous: true },
              session: { id: "s2" },
            })
          : json({ code: "INVALID_SESSION" }, { status: 401 }),
      "/sign-in/anonymous": anonymousSignIn,
      "/convex/token": () => json({ token: futureJwt("anon-2") }),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-anon-1");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "anonymous");
    service.setAuthStorageItem(
      SESSION_KEY,
      JSON.stringify({
        user: { id: "anon-1", isAnonymous: true },
        session: { id: "s1" },
      }),
    );

    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "anonymous_required",
      reason: "anonymous_rejected",
    });
    await service.signInAnonymous();
    expect(anonymousSignIn).toHaveBeenCalledTimes(1);
    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "authenticated",
      identityIntent: "anonymous",
    });
  });

  it("allows first install to create exactly one anonymous identity", async () => {
    const { service } = createService();
    const anonymousSignIn = vi.fn(() =>
      json({ ok: true }, { headers: { "set-auth-token": "bearer-anon" } }),
    );
    installAuthRoutes({
      "/sign-in/anonymous": anonymousSignIn,
      "/convex/token": () => json({ token: futureJwt("anon") }),
      "/get-session": () =>
        json({
          user: { id: "anon", isAnonymous: true },
          session: { id: "s1" },
        }),
    });
    configure(service);

    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "anonymous_required",
      reason: "first_install",
    });
    await service.signInAnonymous();
    expect(anonymousSignIn).toHaveBeenCalledTimes(1);
  });

  it("allows explicit sign-out to create exactly one anonymous identity", async () => {
    const { service } = createService();
    const anonymousSignIn = vi.fn(() =>
      json({ ok: true }, { headers: { "set-auth-token": "bearer-anon" } }),
    );
    installAuthRoutes({
      "/sign-out": () => json({ ok: true }),
      "/sign-in/anonymous": anonymousSignIn,
      "/convex/token": () => json({ token: futureJwt("anon") }),
      "/get-session": () =>
        json({
          user: { id: "anon", isAnonymous: true },
          session: { id: "s-anon" },
        }),
    });
    configure(service);
    service.setAuthStorageItem(BEARER_KEY, "bearer-connected");
    service.setAuthStorageItem(IDENTITY_INTENT_KEY, "connected");

    await service.signOut();
    await expect(service.getAuthSessionSnapshot()).resolves.toMatchObject({
      status: "anonymous_required",
      reason: "explicit_sign_out",
    });
    await service.signInAnonymous();
    expect(anonymousSignIn).toHaveBeenCalledTimes(1);
  });
});
