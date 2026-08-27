/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const linkRequest = (authorization?: string) =>
  ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      email: "owner@example.com",
      requireAnonymousOwner: true,
    }),
  }) satisfies RequestInit;

const expectNoPendingLink = async (
  t: ReturnType<typeof convexTest>,
): Promise<void> => {
  const rows = await t.run(async (ctx) =>
    ctx.db.query("auth_link_requests").take(1),
  );
  expect(rows).toEqual([]);
};

describe("POST /api/auth/link/send owner proof", () => {
  it("rejects a missing anonymous-owner JWT before creating a link", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/api/auth/link/send", linkRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error:
        "An authenticated anonymous session is required to preserve this conversation.",
    });
    await expectNoPendingLink(t);
  });

  it("rejects malformed and unverifiable Authorization values", async () => {
    for (const authorization of ["Basic opaque", "Bearer invalid.jwt"]) {
      const t = convexTest(schema, modules);

      const response = await t.fetch(
        "/api/auth/link/send",
        linkRequest(authorization),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "The anonymous session could not be verified.",
      });
      await expectNoPendingLink(t);
    }
  });

  it("rejects a valid connected-account identity as the anonymous source", async () => {
    const t = convexTest(schema, modules);
    const connected = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "connected-owner",
      tokenIdentifier: "https://issuer.test|connected-owner",
      isAnonymous: false,
    });

    const response = await connected.fetch(
      "/api/auth/link/send",
      linkRequest("Bearer validated-by-convex"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error:
        "An authenticated anonymous session is required to preserve this conversation.",
    });
    await expectNoPendingLink(t);
  });

  it("marks session-cookie polling responses as non-cacheable", async () => {
    const t = convexTest(schema, modules);
    registerRateLimiter(t);
    const requestId = "00000000-0000-4000-8000-000000000000";
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_link_requests", {
        email: "owner@example.com",
        requestId,
        status: "completed",
        toOwnerId: "https://issuer.test|connected-owner",
        toOwnerGeneration: "legacy",
        sessionCookie: "better-auth.session_token=connected",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    });

    const response = await t.fetch(
      `/api/auth/link/status?requestId=${requestId}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
