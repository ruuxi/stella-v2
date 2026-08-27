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

const googleSse = [
  `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text: '<!doctype html><html><body><button data-stella-compose="hello">Hello</button></body></html>',
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 12,
      totalTokenCount: 22,
    },
    modelVersion: "gemini-3.6-flash",
  })}\n\n`,
].join("");

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

  it("keeps an authenticated anonymous principal generation-fenced and lease-backed", async () => {
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
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(googleSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await anonymous.fetch(
      "/api/synthesize/welcome-html",
      welcomeRequest({ "X-Device-ID": "telemetry-only-device" }),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const leases = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_managed_dispatch_leases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
    );
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      state: "terminal",
      outcome: "succeeded",
      billing: {
        kind: "managed_usage",
        agentType: "service:synthesis:welcome_html",
        model: "google/gemini-3.6-flash",
        providerState: "may_have_dispatched",
        billingState: "billed",
        capturedUsage: {
          inputTokens: 10,
          outputTokens: 12,
          totalTokens: 22,
          success: true,
        },
      },
    });
    const usage = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
          .unique(),
    );
    expect(usage?.totalRequestCount).toBe(1);
    expect(usage?.totalUsageMicroCents).toBeGreaterThan(0);
  });
});
