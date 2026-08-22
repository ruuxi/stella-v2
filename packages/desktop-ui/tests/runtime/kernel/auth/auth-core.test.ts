import { describe, expect, it, vi } from "vitest";

import {
  BETTER_AUTH_COOKIE_STORAGE_KEY,
  BETTER_AUTH_SESSION_DATA_STORAGE_KEY,
  createAuthCore,
  getAuthTokenExpiryMs,
  isAuthTokenFresh,
  type AuthCoreStorage,
} from "@stella/runtime/kernel/auth/auth-core";

const createMemoryStorage = (
  initial: Record<string, string> = {},
): AuthCoreStorage & { values: Record<string, string> } => {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      if (typeof value === "string") {
        values[key] = value;
      } else {
        delete values[key];
      }
    },
  };
};

const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const makeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const cookieValue = (name: string, value: string) =>
  JSON.stringify({ [name]: { value } });

describe("auth-core JWT freshness math", () => {
  it("reads expiry from the token payload", () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(getAuthTokenExpiryMs(makeJwt({ exp }))).toBe(exp * 1000);
  });

  it("treats unreadable tokens as fresh (server is the judge)", () => {
    expect(isAuthTokenFresh("not-a-jwt", 60_000)).toBe(true);
  });

  it("applies the refresh margin", () => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    expect(isAuthTokenFresh(makeJwt({ exp: soon }), 60_000)).toBe(false);
    const later = Math.floor(Date.now() / 1000) + 600;
    expect(isAuthTokenFresh(makeJwt({ exp: later }), 60_000)).toBe(true);
  });
});

describe("auth-core cookie fold-in", () => {
  it("folds Set-Cookie response headers into the stored cookie map", async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: true },
        { headers: { "set-cookie": "better-auth.session_token=abc123; Path=/" } },
      ),
    );
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.authFetch("/anything");
    const stored = storage.values[BETTER_AUTH_COOKIE_STORAGE_KEY];
    expect(stored).toBeTruthy();
    expect(stored).toContain("session_token");
    expect(core.getCookieHeader()).toContain("abc123");
  });

  it("sends the stored cookie and synthetic origin on auth fetches", async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    core.applySessionCookie("better-auth.session_token=tok; Path=/");
    await core.authFetch("/get-session");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://example.convex.site/api/auth/get-session");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toContain("tok");
    expect(headers.get("origin")).toBe("http://127.0.0.1:57314");
  });

  it("falls back to the stored JWT issuer when no base URL is configured", async () => {
    const jwt = makeJwt({ iss: "https://issuer.convex.site" });
    const storage = createMemoryStorage({
      [BETTER_AUTH_COOKIE_STORAGE_KEY]: cookieValue(
        "better-auth.convex_jwt",
        jwt,
      ),
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(core.getIssuerUrlFromStoredCookie()).toBe(
      "https://issuer.convex.site",
    );
    await core.authFetch("/get-session");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "https://issuer.convex.site",
    );
  });
});

describe("auth-core optimistic session hydration latches", () => {
  const session = { user: { id: "u1" } };
  const freshSession = { user: { id: "u1" }, fresh: true };

  it("serves the persisted blob once, then the authoritative revalidation", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: JSON.stringify(session),
    });
    const fetchImpl = vi.fn(async () => jsonResponse(freshSession));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // First read: optimistic cache hit, background revalidation fired.
    const first = await core.getSession();
    expect(first).toEqual(session);

    // Follow-up read joins/consumes the revalidation and gets the
    // authoritative result — with only one network round-trip.
    const second = await core.getSession();
    expect(second).toEqual(freshSession);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The revalidation's own bookkeeping write must not have reset the
    // latch: the persisted blob now holds the fresh session.
    expect(storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY]).toBe(
      JSON.stringify(freshSession),
    );

    // Third read starts a new cycle (serves updated cache, revalidates).
    const third = await core.getSession();
    expect(third).toEqual(freshSession);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("clears the persisted session on an auth-error downgrade", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: JSON.stringify(session),
    });
    const fetchImpl = vi.fn(async () => jsonResponse(null, { status: 401 }));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await core.getSession();
    expect(first).toEqual(session); // optimistic
    const second = await core.getSession();
    expect(second).toBeNull(); // authoritative downgrade
    expect(
      storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY],
    ).toBeUndefined();
  });

  it("keeps the last-known session on transient network failure", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: JSON.stringify(session),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await core.getSession();
    expect(first).toEqual(session);
    const second = await core.getSession();
    expect(second).toEqual(session);
    expect(storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY]).toBe(
      JSON.stringify(session),
    );
  });

  it("resets the latch on external mutations so the next read is authoritative", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: JSON.stringify(session),
    });
    const fetchImpl = vi.fn(async () => jsonResponse(freshSession));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await core.getSession(); // optimistic, revalidation in flight
    await core.getSession(); // consume authoritative result

    // External mutation (e.g. magic-link cookie apply) invalidates latches.
    core.applySessionCookie("better-auth.session_token=next; Path=/");

    const next = await core.getSession();
    // Serves the (revalidated) persisted blob optimistically again — a new
    // cycle, with a new revalidation fired.
    expect(next).toEqual(freshSession);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops a corrupt persisted blob and reads from the network", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: "{not json",
    });
    const fetchImpl = vi.fn(async () => jsonResponse(freshSession));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await core.getSession();
    expect(result).toEqual(freshSession);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("auth-core sign-out / token mint", () => {
  it("reports failure and preserves storage when the sign-out request fails", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_COOKIE_STORAGE_KEY]: cookieValue(
        "better-auth.session_token",
        "tok",
      ),
      [BETTER_AUTH_SESSION_DATA_STORAGE_KEY]: JSON.stringify({
        user: { id: "u1" },
      }),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await core.signOut();
    // Network error: the server session may still be alive. We must report
    // failure and preserve the local cookie/session so the UI doesn't present a
    // false signed-out state.
    expect(result.ok).toBe(false);
    expect(storage.values[BETTER_AUTH_COOKIE_STORAGE_KEY]).toBeDefined();
    expect(
      storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY],
    ).toBeDefined();
  });

  it("mints a trimmed Convex token and returns null on HTTP failure", async () => {
    const storage = createMemoryStorage();
    let status = 200;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "  jwt-token  " }, { status }),
    );
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await core.mintConvexToken()).toBe("jwt-token");
    status = 401;
    expect(await core.mintConvexToken()).toBeNull();
  });

  it("rejects malformed one-time tokens without a network call", async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(core.verifyOneTimeToken("bad token!")).rejects.toThrow(
      "Invalid auth callback token.",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("auth-core identity-epoch fencing (regression)", () => {
  it("does not persist a get-session blob whose body resolves AFTER a sign-out", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_COOKIE_STORAGE_KEY]: cookieValue(
        "better-auth.session_token",
        "tokA",
      ),
    });
    let releaseBody = () => {};
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/get-session")) {
        const resp = jsonResponse({ user: { id: "A" } });
        const originalJson = resp.json.bind(resp);
        // Delay ONLY the body read, not the fetch, to hit the post-json() window.
        (resp as unknown as { json: () => Promise<unknown> }).json =
          async () => {
            await bodyGate;
            return originalJson();
          };
        return resp;
      }
      return jsonResponse({});
    });
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const sessionPromise = core.getSession();
    // Sign out while the get-session body is still pending.
    const signOut = await core.signOut();
    expect(signOut.ok).toBe(true);
    releaseBody();
    const session = await sessionPromise;

    // The stale get-session must NOT resurrect the session blob.
    expect(session).toBeNull();
    expect(
      storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY],
    ).toBeUndefined();
  });

  it("does not persist account-A's session over an account-B switch", async () => {
    const storage = createMemoryStorage({
      [BETTER_AUTH_COOKIE_STORAGE_KEY]: cookieValue(
        "better-auth.session_token",
        "tokA",
      ),
    });
    let releaseBody = () => {};
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/get-session")) {
        const resp = jsonResponse({ user: { id: "A" } });
        const originalJson = resp.json.bind(resp);
        (resp as unknown as { json: () => Promise<unknown> }).json =
          async () => {
            await bodyGate;
            return originalJson();
          };
        return resp;
      }
      return jsonResponse({});
    });
    const core = createAuthCore({
      storage,
      getBaseUrl: () => "https://example.convex.site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const sessionPromise = core.getSession();
    // Switch to account B (local cookie apply → identity change) mid-flight.
    core.applySessionCookie("better-auth.session_token=tokB; Path=/");
    releaseBody();
    const session = await sessionPromise;

    // Account A's late response must NOT overwrite account B.
    expect(session).toBeNull();
    expect(
      storage.values[BETTER_AUTH_SESSION_DATA_STORAGE_KEY],
    ).toBeUndefined();
    expect(storage.values[BETTER_AUTH_COOKIE_STORAGE_KEY]).toContain("tokB");
  });
});
