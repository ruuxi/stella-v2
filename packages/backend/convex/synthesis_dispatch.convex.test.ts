/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "https://issuer.test|anonymous-synthesis-owner";
const OWNER_GENERATION = "anonymous-synthesis-generation";

beforeAll(() => {
  const values: Record<string, string> = {
    GOOGLE_AI_API_KEY: "test-google-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    ANON_DEVICE_ID_HASH_SALT: "test-anon-salt",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "10",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const welcomeRequest = (headers?: Record<string, string>) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...headers,
  },
  body: JSON.stringify({ coreMemory: "The user likes calm interfaces." }),
});

describe("synthesis managed-provider owner authority", () => {
  it("rejects a legacy device-header-only caller before provider I/O", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("an unowned synthesis must not dispatch"));

    const response = await t.fetch(
      "/api/synthesize/welcome-html",
      welcomeRequest({ "X-Device-ID": "legacy-device-only" }),
    );

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db.query("billing_managed_dispatch_leases").collect(),
      ),
    ).toEqual([]);
  });

  it("requires a connected identity for welcome HTML before provider I/O", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    });
    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "anonymous-synthesis-owner",
      tokenIdentifier: OWNER_ID,
      isAnonymous: true,
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("anonymous welcome synthesis must not dispatch"),
      );

    const response = await anonymous.fetch(
      "/api/synthesize/welcome-html",
      welcomeRequest({ "X-Device-ID": "telemetry-only-device" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "sign_in_required",
    });
    expect(upstream).not.toHaveBeenCalled();
    const plain = await anonymous.fetch(
      "/api/synthesize",
      welcomeRequest({ "X-Device-ID": "telemetry-only-device" }),
    );
    expect(plain.status).toBe(400);
    await expect(plain.json()).resolves.toEqual({
      error: "formattedSections or formattedSignals is required",
    });
    expect(upstream).not.toHaveBeenCalled();
    const leases = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_managed_dispatch_leases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
    );
    expect(leases).toEqual([]);
  });
});
