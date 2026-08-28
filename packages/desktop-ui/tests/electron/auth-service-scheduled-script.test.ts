import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userData = vi.hoisted(() => ({ dir: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userData.dir),
    isReady: vi.fn(() => false),
    setAsDefaultProtocolClient: vi.fn(),
  },
  powerMonitor: { on: vi.fn() },
}));

import { setSafeStorageForTesting } from "@stella/runtime/kernel/shared/protected-storage";
import { AuthService } from "@stella/desktop/electron/services/auth-service.js";

const BEARER_STORAGE_KEY = "better-auth_session_token";

const createJwt = (expiresAtSeconds: number, subject = "user") =>
  [
    "header",
    Buffer.from(
      JSON.stringify({ exp: expiresAtSeconds, sub: subject }),
    ).toString("base64url"),
    "signature",
  ].join(".");

const futureJwt = (subject: string) =>
  createJwt(Math.floor(Date.now() / 1000) + 30 * 60, subject);

const createService = () => {
  const runner = {
    setAuthToken: vi.fn(),
    setHasConnectedAccount: vi.fn(),
    setConvexUrl: vi.fn(),
    setConvexSiteUrl: vi.fn(),
  };
  const service = new AuthService({
    authProtocol: "stella",
    isDev: false,
    projectDir: userData.dir,
    sessionPartition: "persist:stella",
    runnerTarget: { getRunner: () => runner },
    onAuthCallback: vi.fn(),
    onSecondInstanceFocus: vi.fn(),
  });
  service.configurePiRuntime({
    convexUrl: "https://example.convex.cloud",
    convexSiteUrl: "https://example.convex.site",
  });
  return { runner, service };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type FetchRoutes = {
  convexToken?: () => Response | Promise<Response>;
  session?: () => Response | Promise<Response>;
  signOut?: () => Response | Promise<Response>;
};

const stubFetch = (routes: FetchRoutes) => {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/convex/token")) {
      return await (routes.convexToken?.() ??
        jsonResponse({ error: "unhandled" }, 500));
    }
    if (url.endsWith("/get-session")) {
      return await (routes.session?.() ??
        jsonResponse({ error: "unhandled" }, 500));
    }
    if (url.endsWith("/sign-out")) {
      return await (routes.signOut?.() ?? jsonResponse({ ok: true }));
    }
    return jsonResponse({ error: "unhandled" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-auth-service-"));
  setSafeStorageForTesting({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(plaintext, "utf8"),
    decryptString: (ciphertext: Buffer) => ciphertext.toString("utf8"),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSafeStorageForTesting(null);
  fs.rmSync(userData.dir, { recursive: true, force: true });
});

describe("AuthService scheduled-script auth", () => {
  it("returns a token minted by the desktop-owned auth path", async () => {
    const { service } = createService();
    const freshToken = futureJwt("scheduled");
    vi.spyOn(service, "getAuthToken").mockResolvedValue(freshToken);

    await expect(service.getScheduleScriptAuth()).resolves.toEqual({
      baseUrl: "https://example.convex.site",
      authToken: freshToken,
    });
  });

  it("does not inject a stale fallback token when minting fails", async () => {
    const { service } = createService();
    vi.spyOn(service, "getAuthToken").mockResolvedValue(
      createJwt(Math.floor(Date.now() / 1000) - 60),
    );

    await expect(service.getScheduleScriptAuth()).resolves.toBeNull();
  });
});

describe("AuthService runtime auth ownership", () => {
  it("mints a new token after a credential change instead of serving the cached one", async () => {
    const { runner, service } = createService();
    const anonymousToken = futureJwt("anonymous");
    const connectedToken = futureJwt("connected");
    let nextConvexToken = anonymousToken;
    stubFetch({
      convexToken: () => jsonResponse({ token: nextConvexToken }),
      session: () => jsonResponse({ user: { id: "u1", isAnonymous: false } }),
    });

    service.setAuthStorageItem(BEARER_STORAGE_KEY, "anonymous-bearer");
    await expect(service.getAuthToken()).resolves.toBe(anonymousToken);

    nextConvexToken = connectedToken;
    await service.applySessionToken("connected-bearer");

    expect(runner.setAuthToken).toHaveBeenLastCalledWith(connectedToken);
    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: true,
      token: connectedToken,
      hasConnectedAccount: true,
    });
  });

  it("keeps the last known connected-account state across a transient session failure", async () => {
    const { runner, service } = createService();
    let sessionFails = false;
    stubFetch({
      convexToken: () => jsonResponse({ token: futureJwt("connected") }),
      session: () =>
        sessionFails
          ? jsonResponse({ error: "upstream" }, 500)
          : jsonResponse({ user: { id: "u1", isAnonymous: false } }),
    });

    service.setAuthStorageItem(BEARER_STORAGE_KEY, "connected-bearer");
    await service.getBetterAuthSession();
    expect(service.getHostHasConnectedAccount()).toBe(true);

    sessionFails = true;
    runner.setHasConnectedAccount.mockClear();
    await expect(service.getBetterAuthSession()).rejects.toThrow();

    expect(service.getHostHasConnectedAccount()).toBe(true);
    expect(runner.setHasConnectedAccount).not.toHaveBeenCalled();
  });

  it("reports an unauthenticated runtime state when no bearer token is stored", async () => {
    const { service } = createService();
    const fetchMock = stubFetch({});

    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: false,
      token: null,
      hasConnectedAccount: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps authenticated aligned with the token it returns", async () => {
    const { service } = createService();
    const token = futureJwt("connected");
    stubFetch({
      convexToken: () => jsonResponse({ token }),
      session: () => jsonResponse({ user: { id: "u1", isAnonymous: true } }),
    });

    service.setAuthStorageItem(BEARER_STORAGE_KEY, "anonymous-bearer");
    const result = await service.refreshRuntimeAuth();

    expect(result.authenticated).toBe(Boolean(result.token));
    expect(result.token).toBe(token);
  });
  it("discards a mint that resolves after the user signed out", async () => {
    const { runner, service } = createService();
    const pendingToken = deferred<Response>();
    stubFetch({
      convexToken: () => pendingToken.promise,
      session: () => jsonResponse({ user: { id: "u1", isAnonymous: true } }),
    });

    service.setAuthStorageItem(BEARER_STORAGE_KEY, "anonymous-bearer");
    const inflight = service.refreshRuntimeAuth();
    await service.signOut();
    runner.setAuthToken.mockClear();

    pendingToken.resolve(jsonResponse({ token: futureJwt("stale") }));
    await expect(inflight).resolves.toEqual({
      authenticated: false,
      token: null,
      hasConnectedAccount: false,
    });

    expect(runner.setAuthToken).not.toHaveBeenCalled();
    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: false,
      token: null,
      hasConnectedAccount: false,
    });
  });

  it("recovers from a transient mint failure right after a credential change", async () => {
    const { runner, service } = createService();
    const staleToken = futureJwt("anonymous");
    const connectedToken = futureJwt("connected");
    let convexTokenCalls = 0;
    stubFetch({
      convexToken: () => {
        convexTokenCalls += 1;
        if (convexTokenCalls === 1) {
          return jsonResponse({ token: staleToken });
        }
        if (convexTokenCalls <= 3) {
          return jsonResponse({ error: "upstream" }, 500);
        }
        return jsonResponse({ token: connectedToken });
      },
      session: () => jsonResponse({ user: { id: "u1", isAnonymous: false } }),
    });

    service.setAuthStorageItem(BEARER_STORAGE_KEY, "anonymous-bearer");
    await expect(service.getAuthToken()).resolves.toBe(staleToken);

    await service.applySessionToken("connected-bearer");
    runner.setAuthToken.mockClear();

    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: true,
      token: connectedToken,
      hasConnectedAccount: true,
    });
    expect(runner.setAuthToken).not.toHaveBeenCalledWith(staleToken);
  });
  it("chains a fresh resync when a credential change lands mid-resync", async () => {
    const { runner, service } = createService();
    const anonymousToken = futureJwt("anonymous");
    const connectedToken = futureJwt("connected");
    const heldMint = deferred<Response>();
    let convexTokenCalls = 0;
    stubFetch({
      convexToken: () => {
        convexTokenCalls += 1;
        return convexTokenCalls === 1
          ? heldMint.promise
          : jsonResponse({ token: connectedToken });
      },
      session: () => jsonResponse({ user: { id: "u1", isAnonymous: false } }),
    });

    const first = service.applySessionToken("anonymous-bearer");
    while (convexTokenCalls === 0) {
      await Promise.resolve();
    }

    const second = service.applySessionToken("connected-bearer");
    heldMint.resolve(jsonResponse({ token: anonymousToken }));
    await Promise.all([first, second]);

    expect(runner.setAuthToken).not.toHaveBeenCalledWith(anonymousToken);
    expect(runner.setAuthToken).toHaveBeenLastCalledWith(connectedToken);
    await expect(service.refreshRuntimeAuth()).resolves.toEqual({
      authenticated: true,
      token: connectedToken,
      hasConnectedAccount: true,
    });
  });
});
