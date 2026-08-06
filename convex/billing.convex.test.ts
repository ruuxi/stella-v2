/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: "100",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  delete process.env.STELLA_ANON_MAX_REQUESTS_PER_IP;
});

describe("billing subscription status", () => {
  it("reports anonymous request policy without dollar usage windows", async () => {
    const t = convexTest(schema, modules);

    const signedOut = await t.query(api.billing.getSubscriptionStatus, {});
    expect(signedOut).toMatchObject({
      authenticated: false,
      isAnonymous: true,
      usage: null,
      usagePolicy: {
        kind: "anonymous_requests",
        requestLimit: 100,
        perIpRequestLimit: 1000,
        resetAfterInactivityDays: 7,
      },
    });

    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "anonymous-user",
      tokenIdentifier: "https://issuer.test|anonymous-user",
      isAnonymous: true,
    });
    expect(await anonymous.query(api.billing.getSubscriptionStatus, {})).toMatchObject({
      authenticated: true,
      isAnonymous: true,
      usagePolicy: { kind: "anonymous_requests", requestLimit: 100 },
    });
  });

  it("reports the one-dollar cost windows for signed-in Free users", async () => {
    const t = convexTest(schema, modules);
    const signedIn = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "free-user",
      tokenIdentifier: "https://issuer.test|free-user",
    });

    expect(await signedIn.query(api.billing.getSubscriptionStatus, {})).toMatchObject({
      authenticated: true,
      isAnonymous: false,
      plan: "free",
      usage: {
        rollingLimitUsd: 1,
        weeklyLimitUsd: 1,
        monthlyLimitUsd: 1,
      },
      usagePolicy: { kind: "managed_cost" },
    });
  });
});

describe("managed model billing", () => {
  it("meters a dated route using the synced undated family price", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_model_prices", {
        model: "accounts/fireworks/models/deepseek-v4-flash",
        source: "models.dev",
        sourceProvider: "fireworks-ai",
        sourceModelId: "accounts/fireworks/models/deepseek-v4-flash",
        inputPerMillionUsd: 0.14,
        outputPerMillionUsd: 0.28,
        cacheReadPerMillionUsd: 0.028,
        cacheWritePerMillionUsd: 0,
        reasoningPerMillionUsd: 0,
        modalitiesInput: ["text"],
        modalitiesOutput: ["text"],
        sourceUpdatedAt: "2026-06-16",
        syncedAt: 1,
      });
    });

    const result = await t.mutation(internal.billing.logManagedUsage, {
      ownerId: "billing-test-owner",
      agentType: "proxy:orchestrator",
      model: "accounts/fireworks/models/deepseek-v4-flash-0731",
      durationMs: 100,
      success: true,
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    });

    // $0.07 uncached input + $0.014 cached input + $0.28 output.
    expect(result.costMicroCents).toBe(36_400_000);
  });

  it("persists resolved prices before reporting an incomplete sync", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const t = convexTest(schema, modules);

    try {
      await expect(
        t.action(internal.billing.syncManagedModelPricesFromModelsDev, {}),
      ).rejects.toThrow(/models\.dev is missing prices/u);
    } finally {
      fetchMock.mockRestore();
    }

    const staticRow = await t.run(async (ctx) =>
      ctx.db
        .query("billing_model_prices")
        .withIndex("by_model", (q) => q.eq("model", "openai/gpt-5.6-luna"))
        .unique(),
    );
    expect(staticRow).toMatchObject({
      model: "openai/gpt-5.6-luna",
      source: "static",
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 6,
    });
  });
});
