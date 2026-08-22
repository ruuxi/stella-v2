import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthSessionStore } from "@stella/runtime/kernel/auth/store";
import { createAuthOwner } from "@stella/runtime/kernel/auth/auth-owner";
import {
  BETTER_AUTH_COOKIE_STORAGE_KEY,
  BETTER_AUTH_SESSION_DATA_STORAGE_KEY,
} from "@stella/runtime/kernel/auth/auth-core";

const makeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const sessionCookie = JSON.stringify({
  "better-auth.session_token": { value: "cookie-token" },
});

let tmpDir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Keep DEK custody on the 0600 key file so tests never touch the user's
  // OS keychain.
  process.env.STELLA_AUTH_DEK_DISABLE_KEYCHAIN = "1";
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "stella-auth-owner-"));
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth session store (DEK envelope)", () => {
  it("round-trips values and never writes plaintext to disk", () => {
    const store = createAuthSessionStore({ stellaDataDir: tmpDir });
    store.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, sessionCookie);
    store.setItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY, '{"user":{"id":"u1"}}');

    const sessionPath = path.join(tmpDir, "auth", "session.json");
    expect(fs.existsSync(sessionPath)).toBe(true);
    const raw = fs.readFileSync(sessionPath, "utf8");
    expect(raw).not.toContain("cookie-token");
    expect(raw).not.toContain("session_token");
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.alg).toBe("aes-256-gcm");

    // A second store instance over the same dir decrypts the same values.
    const reopened = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(reopened.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY)).toBe(
      sessionCookie,
    );
    expect(reopened.getItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY)).toBe(
      '{"user":{"id":"u1"}}',
    );
  });

  it("deleting keys and clearing removes persisted state", () => {
    const store = createAuthSessionStore({ stellaDataDir: tmpDir });
    store.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, sessionCookie);
    store.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, null);
    expect(store.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY)).toBeNull();
    store.clear();
    expect(store.exists()).toBe(false);
  });
});

describe("auth owner", () => {
  it("imports session material, mints a token, and reports connected state", async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ token: jwt }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const changes: string[] = [];
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
      onAuthChanged: (event) => changes.push(event.reason),
    });

    expect(owner.hasSession()).toBe(false);
    const result = await owner.importSession({
      cookie: sessionCookie,
      sessionData: JSON.stringify({ user: { id: "u1", isAnonymous: false } }),
    });
    expect(result.ok).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.hasConnectedAccount).toBe(true);
    expect(owner.hasSession()).toBe(true);
    expect(changes).toContain("import");

    // Cached token is served without another mint.
    const before = fetchSpy.mock.calls.length;
    const token = await owner.getConvexToken();
    expect(token.token).toBe(jwt);
    expect(fetchSpy.mock.calls.length).toBe(before);
    owner.stop();
  });

  it("treats anonymous users as not having a connected account", async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ token: jwt }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
    });
    const result = await owner.importSession({
      cookie: sessionCookie,
      sessionData: JSON.stringify({ user: { id: "anon", isAnonymous: true } }),
    });
    expect(result.hasConnectedAccount).toBe(false);
    owner.stop();
  });

  it("mirrors a sign-out (null cookie) by dropping the token", async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ token: jwt }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const changes: string[] = [];
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
      onAuthChanged: (event) => changes.push(event.reason),
    });
    await owner.importSession({
      cookie: sessionCookie,
      sessionData: JSON.stringify({ user: { id: "u1" } }),
    });
    const signedOut = await owner.importSession({
      cookie: null,
      sessionData: null,
    });
    expect(signedOut.authenticated).toBe(false);
    expect(changes).toContain("signed-out");
    const token = await owner.getConvexToken();
    expect(token.token).toBeNull();
    owner.stop();
  });

  it("rejects untrusted deep links and exchanges trusted OTTs (P3)", async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    const calls: string[] = [];
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify(
            String(input).includes("/convex/token")
              ? { token: jwt }
              : { ok: true },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
    });
    await expect(
      owner.handleAuthCallback({
        url: "https://evil.example/auth?ott=abcdefgh1234",
        protocol: "stella",
      }),
    ).rejects.toThrow("Blocked untrusted auth callback URL.");
    expect(calls).toHaveLength(0);

    const result = await owner.handleAuthCallback({
      url: "stella://auth?ott=abcdefgh1234",
      protocol: "stella",
    });
    expect(result.ok).toBe(true);
    expect(
      calls.some((url) => url.includes("/cross-domain/one-time-token/verify")),
    ).toBe(true);
    owner.stop();
  });

  it("magic-link status applies the session cookie inside the runtime (P3)", async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/link/send")) {
          return new Response(JSON.stringify({ requestId: "req-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/link/status")) {
          return new Response(
            JSON.stringify({
              status: "completed",
              sessionCookie: "better-auth.session_token=magic; Path=/",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify(
            url.includes("/convex/token") ? { token: jwt } : { user: { id: "u2" } },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
    });
    const send = await owner.magicLinkSend({ email: "user@example.com" });
    expect(send).toEqual({ ok: true, requestId: "req-1" });
    const status = await owner.magicLinkStatus({ requestId: "req-1" });
    expect(status).toEqual({ status: "completed", applied: true });
    // The cookie landed in the owner's store and a token was minted.
    expect(owner.hasSession()).toBe(true);
    const token = await owner.getConvexToken();
    expect(token.token).toBe(jwt);
    owner.stop();
  });

  it("force-refresh mints a fresh token (local 401 recovery)", async () => {
    let counter = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      counter += 1;
      return new Response(
        JSON.stringify({
          token: makeJwt({
            exp: Math.floor(Date.now() / 1000) + 1800,
            n: counter,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const owner = createAuthOwner({
      stellaDataDir: tmpDir,
      getBaseUrl: () => "https://example.convex.site",
    });
    await owner.importSession({
      cookie: sessionCookie,
      sessionData: JSON.stringify({ user: { id: "u1" } }),
    });
    const first = await owner.getConvexToken();
    const second = await owner.getConvexToken({ forceRefresh: true });
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(first.token);
    owner.stop();
  });
});
