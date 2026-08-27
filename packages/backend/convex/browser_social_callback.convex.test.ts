/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|anonymous-owner";
const createBrowserSocialHandoff = (
  internal as unknown as {
    mobile_auth: {
      createBrowserSocialHandoff: FunctionReference<
        "mutation",
        "internal",
        {
          requestId: string;
          provider: "google";
          fromOwnerId: string;
          returnOrigin: string;
          returnTo: string;
          expiresAt: number;
          createdAt: number;
        },
        { ok: true } | { ok: false; reason: "owner_fenced" }
      >;
    };
  }
).mobile_auth.createBrowserSocialHandoff;

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
const asAnonymousOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "anonymous-owner",
    tokenIdentifier: ownerId,
    isAnonymous: true,
  });

const startRequest = (returnTo: string): RequestInit => ({
  method: "POST",
  headers: {
    Origin: "https://stella.sh",
    Authorization: "Bearer validated-by-convex",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ returnTo }),
});

describe("browser social callback bridge", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_SITE_URL", "https://auth.example");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an open-redirect target before persisting a handoff", async () => {
    const t = createTest();
    const response = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://attacker.example/steal"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid browser auth return target.",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("auth_browser_handoffs").take(1),
    );
    expect(rows).toEqual([]);
  });

  it("requires the current anonymous owner before registering a callback", async () => {
    const t = createTest();
    const response = await t.fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );

    expect(response.status).toBe(401);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("auth_browser_handoffs").take(1),
    );
    expect(rows).toEqual([]);
  });

  it("consumes the provider query before redirecting once with a fragment", async () => {
    const t = createTest();
    const started = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as { callbackURL: string };
    const callback = new URL(startBody.callbackURL);
    expect(callback.origin).toBe("https://auth.example");
    expect(callback.pathname).toBe("/api/auth/browser-social/verify");
    expect(callback.searchParams.has("ott")).toBe(false);
    expect(callback.hash).toBe("");
    const requestId = callback.searchParams.get("requestId");
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{32,64}$/);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId!))
        .unique(),
    );
    expect(stored).toMatchObject({
      requestId,
      fromOwnerId: ownerId,
      fromOwnerGeneration: "legacy",
      returnOrigin: "https://stella.sh",
      returnTo: "https://stella.sh/cloud",
      status: "pending",
    });
    expect(stored).not.toHaveProperty("ott");

    const providerCallback =
      `/api/auth/browser-social/verify?requestId=${encodeURIComponent(requestId!)}` +
      "&ott=valid_token-123";
    const bridged = await t.fetch(providerCallback);

    expect(bridged.status).toBe(302);
    expect(bridged.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(bridged.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(bridged.headers.get("location")!);
    expect(location.origin).toBe("https://stella.sh");
    expect(location.pathname).toBe("/cloud");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#ott=valid_token-123");

    const replay = await t.fetch(providerCallback);
    expect(replay.status).toBe(410);
    expect(replay.headers.get("location")).toBeNull();
  });

  it("rejects a malformed provider credential without redirecting", async () => {
    const t = createTest();
    const started = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );
    const callback = new URL(
      ((await started.json()) as { callbackURL: string }).callbackURL,
    );
    callback.searchParams.set("ott", "has/slash");

    const response = await t.fetch(`${callback.pathname}${callback.search}`);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();

    callback.searchParams.delete("ott");
    callback.searchParams.append("ott", "valid_token-123");
    callback.searchParams.append("ott", "another_valid-token");
    const duplicate = await t.fetch(`${callback.pathname}${callback.search}`);
    expect(duplicate.status).toBe(400);
    expect(duplicate.headers.get("location")).toBeNull();
  });

  it("expires an unused callback without forwarding its credential", async () => {
    const t = createTest();
    const started = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );
    const callback = new URL(
      ((await started.json()) as { callbackURL: string }).callbackURL,
    );
    const requestId = callback.searchParams.get("requestId")!;
    await t.run(async (ctx) => {
      const handoff = await ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique();
      if (!handoff) throw new Error("Expected browser handoff");
      await ctx.db.patch(handoff._id, { expiresAt: 0 });
    });
    callback.searchParams.set("ott", "valid_token-123");

    const response = await t.fetch(`${callback.pathname}${callback.search}`);

    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects a pre-reset callback after the owner generation changes", async () => {
    const t = createTest();
    const started = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );
    const callback = new URL(
      ((await started.json()) as { callbackURL: string }).callbackURL,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: "generation-after-reset",
        state: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    callback.searchParams.set("ott", "valid_token-123");

    const response = await t.fetch(`${callback.pathname}${callback.search}`);

    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_requestId", (q) =>
          q.eq("requestId", callback.searchParams.get("requestId")!),
        )
        .unique(),
    );
    expect(stored?.status).toBe("pending");
  });

  it("refuses to create a callback while the owner is being reset", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: "reset-generation",
        state: "resetting",
        operationId: "reset-operation",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(createBrowserSocialHandoff, {
        requestId: "00000000-0000-4000-8000-000000000000",
        provider: "google",
        fromOwnerId: ownerId,
        returnOrigin: "https://stella.sh",
        returnTo: "https://stella.sh/cloud",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      }),
    ).resolves.toEqual({ ok: false, reason: "owner_fenced" });

    const response = await asAnonymousOwner(t).fetch(
      "/api/auth/browser-social/start",
      startRequest("https://stella.sh/cloud"),
    );

    expect(response.status).toBe(401);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("auth_browser_handoffs").take(1),
    );
    expect(rows).toEqual([]);
  });

  it("fails closed for a legacy callback without an owner generation", async () => {
    const t = createTest();
    const requestId = "00000000-0000-4000-8000-000000000000";
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_browser_handoffs", {
        requestId,
        provider: "google",
        fromOwnerId: ownerId,
        returnOrigin: "https://stella.sh",
        returnTo: "https://stella.sh/cloud",
        status: "pending",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    });

    const response = await t.fetch(
      `/api/auth/browser-social/verify?requestId=${requestId}&ott=valid_token-123`,
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
  });
});
