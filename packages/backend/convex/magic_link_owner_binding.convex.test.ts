/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import { authUserIdFromVerificationPayload } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const createTestWithBetterAuth = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};

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

describe("Better Auth verification user lookup", () => {
  it("rejects opaque and wrong-table ids without throwing", async () => {
    const t = createTestWithBetterAuth();
    const now = Date.now();
    const user = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Existing User",
          email: "existing@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };
    const session = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          userId: user._id,
          token: "session-token",
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };

    await expect(
      t.query(components.betterAuth.adapter.findUserIdSafely, {
        value: JSON.stringify({ email: "existing@example.com" }),
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(components.betterAuth.adapter.findUserIdSafely, {
        value: "opaque-cross-domain-session-token",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(components.betterAuth.adapter.findUserIdSafely, {
        value: session._id,
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(components.betterAuth.adapter.findUserIdSafely, {
        value: user._id,
      }),
    ).resolves.toBe(user._id);
  });

  it("attributes a magic-link JSON payload through its email", async () => {
    const userId = "existing-better-auth-user-id";
    const identifier = "opaque-magic-link-token";
    const value = JSON.stringify({
      email: "existing@example.com",
      name: "Existing User",
    });
    const queryCalls: Array<Record<string, unknown>> = [];
    const authUserId = await authUserIdFromVerificationPayload(
      {
        runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
          queryCalls.push(args);
          if ("value" in args && !("model" in args)) {
            expect(args).toEqual({ value });
            return null;
          }
          if (args.model === "user") {
            const where = args.where as Array<{
              field: string;
              value: unknown;
            }>;
            expect(where[0]?.field).toBe("email");
            return where[0]?.value === "existing@example.com"
              ? { _id: userId }
              : null;
          }
          throw new Error("Unexpected verification lookup");
        },
      } as never,
      { identifier, value },
    );

    expect(authUserId).toBe(userId);
    expect(queryCalls).not.toContainEqual({
      model: "user",
      where: [{ field: "_id", value }],
    });
    expect(queryCalls).toContainEqual({
      model: "user",
      where: [{ field: "email", value: "existing@example.com" }],
    });
  });
});
