/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const ADMIN_SECRET = "test-admin-secret";
const TEST_SITE_URL = "https://test-accounts.convex.site";
const TEST_PATH = "/api/admin/test-accounts/session";

beforeEach(() => {
  vi.stubEnv("STELLA_ADMIN_API_SECRET", ADMIN_SECRET);
  vi.stubEnv("STELLA_TEST_ACCOUNTS", "1");
  vi.stubEnv("SITE_URL", TEST_SITE_URL);
  vi.stubEnv("CONVEX_SITE_URL", TEST_SITE_URL);
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "test-only-better-auth-secret-at-least-32-bytes",
  );
  vi.stubEnv("RESEND_FROM", "Stella Test <test@stella.test>");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};

type Harness = ReturnType<typeof createTest>;

const post = (
  t: Harness,
  body: unknown,
  authorization = `Bearer ${ADMIN_SECRET}`,
) =>
  t.fetch(TEST_PATH, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("POST /api/admin/test-accounts/session", () => {
  it("returns 503 when the admin API secret is unset", async () => {
    vi.stubEnv("STELLA_ADMIN_API_SECRET", "");
    const response = await post(createTest(), {});

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Admin API disabled.",
      env: "STELLA_ADMIN_API_SECRET",
    });
  });

  it("returns 401 for the wrong admin bearer", async () => {
    const response = await post(createTest(), {}, "Bearer wrong-secret");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid admin credentials.",
    });
  });

  it("returns 404 when test accounts are disabled", async () => {
    vi.stubEnv("STELLA_TEST_ACCOUNTS", "");
    const response = await post(createTest(), {});

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Test accounts disabled.",
      env: "STELLA_TEST_ACCOUNTS",
    });
  });

  it("rejects a non-test email address", async () => {
    const response = await post(createTest(), { email: "user@example.com" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "email must end with @test.stella.local.",
    });
  });

  it("mints fresh sessions for one test user and applies the requested plan", async () => {
    const t = createTest();
    const email = "agent-fixed@test.stella.local";
    const first = await post(t, {
      email: email.toUpperCase(),
      plan: "pro",
      usageMode: "unlimited",
    });

    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ownerId: string;
      userId: string;
      email: string;
      sessionToken: string;
      plan: string;
      siteUrl: string;
    };
    expect(firstBody).toMatchObject({
      email,
      plan: "pro",
      siteUrl: TEST_SITE_URL,
    });
    expect(firstBody.ownerId).toBe(`${TEST_SITE_URL}|${firstBody.userId}`);
    expect(firstBody.sessionToken).not.toBe("");

    const second = await post(t, { email, plan: "pro" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.userId).toBe(firstBody.userId);
    expect(secondBody.ownerId).toBe(firstBody.ownerId);
    expect(secondBody.sessionToken).not.toBe(firstBody.sessionToken);

    const billing = await t.run(async (ctx) =>
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", firstBody.ownerId))
        .unique(),
    );
    expect(billing).toMatchObject({
      activePlan: "pro",
      usageMode: "unlimited",
    });
  });
});
