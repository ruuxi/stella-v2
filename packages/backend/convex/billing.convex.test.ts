/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { dollarsToMicroCents } from "./lib/billing_money";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const FREE_LIFETIME_LIMIT_USD = 0.5;
const ANON_MAX_REQUESTS = 1;

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_FREE_LIFETIME_LIMIT_USD: String(FREE_LIFETIME_LIMIT_USD),
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: String(ANON_MAX_REQUESTS),
    ANON_DEVICE_ID_HASH_SALT: "test-only-anon-device-salt",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  delete process.env.STELLA_ANON_MAX_REQUESTS_PER_IP;
});

/**
 * Seeds a usage row directly so a test can start from "this account has
 * already spent X" without replaying hundreds of relay calls. The windows are
 * left at zero and un-started, so only the lifetime total is in play.
 */
const seedLifetimeSpend = async (
  t: ReturnType<typeof convexTest>,
  args: { ownerId: string; plan?: "free" | "go"; spentUsd: number; requests?: number },
) => {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("billing_profiles", {
      ownerId: args.ownerId,
      activePlan: args.plan ?? "free",
      subscriptionStatus: "none",
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      stripePriceId: "",
      defaultPaymentMethodId: "",
      paymentMethodBrand: "",
      paymentMethodLast4: "",
      currentPeriodStart: 0,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      monthlyAnchorAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("billing_usage_windows", {
      ownerId: args.ownerId,
      rollingUsageMicroCents: 0,
      rollingWindowStartedAt: 0,
      weeklyUsageMicroCents: 0,
      weeklyWindowStartedAt: 0,
      monthlyUsageMicroCents: 0,
      monthlyWindowStartedAt: 0,
      totalUsageMicroCents: dollarsToMicroCents(args.spentUsd),
      totalRequestCount: args.requests ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  });
};

describe("billing subscription status", () => {
  it("reports the anonymous request policy without dollar usage windows", async () => {
    const t = convexTest(schema, modules);

    const signedOut = await t.query(api.billing.getSubscriptionStatus, {});
    expect(signedOut).toMatchObject({
      authenticated: false,
      isAnonymous: true,
      usage: null,
      usagePolicy: {
        kind: "anonymous_requests",
        requestLimit: ANON_MAX_REQUESTS,
        // Defaults to 10x the device cap when the IP env is unset.
        perIpRequestLimit: ANON_MAX_REQUESTS * 10,
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
      usagePolicy: {
        kind: "anonymous_requests",
        requestLimit: ANON_MAX_REQUESTS,
      },
    });
  });

  it("reports the one-dollar cost windows and the lifetime allowance for Free users", async () => {
    const t = convexTest(schema, modules);
    await seedLifetimeSpend(t, {
      ownerId: "https://issuer.test|free-user",
      spentUsd: 0.2,
      requests: 12,
    });
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
        lifetimeUsedUsd: 0.2,
        lifetimeLimitUsd: FREE_LIFETIME_LIMIT_USD,
      },
      usagePolicy: { kind: "managed_cost" },
    });

    // The windowed snapshot path (`now` supplied) must agree with the
    // stored-value path above.
    expect(
      await signedIn.query(api.billing.getSubscriptionStatus, { now: Date.now() }),
    ).toMatchObject({
      usage: { lifetimeUsedUsd: 0.2, lifetimeLimitUsd: FREE_LIFETIME_LIMIT_USD },
    });
  });

  it("reports no lifetime allowance on paid plans", async () => {
    const t = convexTest(schema, modules);
    await seedLifetimeSpend(t, {
      ownerId: "https://issuer.test|go-user",
      plan: "go",
      spentUsd: 40,
    });
    const signedIn = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "go-user",
      tokenIdentifier: "https://issuer.test|go-user",
    });

    expect(await signedIn.query(api.billing.getSubscriptionStatus, {})).toMatchObject({
      plan: "go",
      usage: { lifetimeUsedUsd: 40, lifetimeLimitUsd: null },
    });
  });
});

describe("free lifetime allowance", () => {
  it("blocks a Free account once cumulative spend reaches the allowance", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "lifetime-exhausted-owner";
    await seedLifetimeSpend(t, { ownerId, spentUsd: FREE_LIFETIME_LIMIT_USD });

    const limit = await t.mutation(internal.billing.enforceManagedUsageLimit, {
      ownerId,
    });
    expect(limit).toMatchObject({
      allowed: false,
      plan: "free",
      message: "You've used your free Stella allowance. Upgrade to keep going.",
    });
    // Nothing resets, so the advertised retry is a back-off hint, not a reset.
    expect(limit.retryAfterMs).toBeGreaterThan(60 * 60 * 1000);

    const access = await t.mutation(internal.billing.resolveManagedModelAccess, {
      ownerId,
    });
    expect(access).toMatchObject({ allowed: false, plan: "free", downgraded: false });
  });

  it("keeps serving a Free account below the allowance", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "lifetime-remaining-owner";
    await seedLifetimeSpend(t, { ownerId, spentUsd: FREE_LIFETIME_LIMIT_USD / 2 });

    expect(
      await t.mutation(internal.billing.enforceManagedUsageLimit, { ownerId }),
    ).toMatchObject({ allowed: true, plan: "free" });
  });

  it("never refreshes: a spent allowance stays spent across months", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "lifetime-stale-owner";
    await seedLifetimeSpend(t, { ownerId, spentUsd: FREE_LIFETIME_LIMIT_USD });

    // Roll every window start far into the past — the monthly reset that
    // would revive a windowed limit must not revive this one.
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(usage!._id, {
        rollingWindowStartedAt: 1,
        weeklyWindowStartedAt: 1,
        monthlyWindowStartedAt: 1,
      });
    });

    expect(
      await t.mutation(internal.billing.enforceManagedUsageLimit, { ownerId }),
    ).toMatchObject({ allowed: false });
  });

  it("leaves paid plans unaffected by the lifetime allowance", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "go-lifetime-owner";
    // Far past the Free allowance; Go sets no lifetime limit, so the windows
    // (all empty here) are the only thing that can block.
    await seedLifetimeSpend(t, { ownerId, plan: "go", spentUsd: 100 });

    expect(
      await t.mutation(internal.billing.enforceManagedUsageLimit, { ownerId }),
    ).toMatchObject({ allowed: true, plan: "go" });
  });

  it("lets purchased credits keep a Free account running past the allowance", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "lifetime-credited-owner";
    await seedLifetimeSpend(t, { ownerId, spentUsd: FREE_LIFETIME_LIMIT_USD });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("billing_usage_credits", {
        ownerId,
        balanceMicroCents: dollarsToMicroCents(5),
        totalPurchasedMicroCents: dollarsToMicroCents(5),
        totalConsumedMicroCents: 0,
        currency: "usd",
        createdAt: now,
        updatedAt: now,
      });
    });

    expect(
      await t.mutation(internal.billing.enforceManagedUsageLimit, { ownerId }),
    ).toMatchObject({ allowed: true, plan: "free" });
  });

  it("counts requests as well as dollars so the budget can be measured", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "request-count-owner";

    for (let i = 0; i < 3; i += 1) {
      await t.mutation(internal.billing.logManagedUsage, {
        ownerId,
        agentType: "orchestrator",
        model: "deepseek/deepseek-v4-flash",
        durationMs: 10,
        success: true,
        costMicroCents: dollarsToMicroCents(0.01),
      });
    }

    const usage = await t.run(async (ctx) =>
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    );
    expect(usage).toMatchObject({
      totalRequestCount: 3,
      totalUsageMicroCents: dollarsToMicroCents(0.03),
    });
  });
});

describe("anonymous request allowance", () => {
  it("allows the capped number of requests and then stops", async () => {
    const t = convexTest(schema, modules);
    const consume = () =>
      t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId: "anon-jwt:device-a",
        maxRequests: ANON_MAX_REQUESTS,
      });

    const first = await consume();
    expect(first).toMatchObject({ allowed: true, requestCount: 1, remaining: 0 });

    const second = await consume();
    expect(second).toMatchObject({ allowed: false, requestCount: 2 });
  });

  it("keeps a separate, larger allowance for the per-IP bucket", async () => {
    const t = convexTest(schema, modules);
    const clientAddressKey = "203.0.113.7";
    const consumeIp = () =>
      t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId: "anon-ip",
        maxRequests: ANON_MAX_REQUESTS * 10,
        clientAddressKey,
      });

    // The device cap is 1, but the network ceiling must outlast it so a
    // shared address is not starved by one install's trial.
    for (let i = 0; i < ANON_MAX_REQUESTS * 10; i += 1) {
      expect((await consumeIp()).allowed).toBe(true);
    }
    expect((await consumeIp()).allowed).toBe(false);
  });

  it("resets the count after the inactivity window", async () => {
    const t = convexTest(schema, modules);
    const deviceId = "anon-jwt:device-stale";
    await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId,
      maxRequests: ANON_MAX_REQUESTS,
    });
    expect(
      await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId,
        maxRequests: ANON_MAX_REQUESTS,
      }),
    ).toMatchObject({ allowed: false });

    // Backdate past the 7-day retention window.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("anon_device_usage").first();
      await ctx.db.patch(row!._id, {
        lastRequestAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
    });

    expect(
      await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId,
        maxRequests: ANON_MAX_REQUESTS,
      }),
    ).toMatchObject({ allowed: true, requestCount: 1 });
  });

  it("records no cost against anonymous rows", async () => {
    const t = convexTest(schema, modules);
    const deviceId = "anon-jwt:https://issuer.test|anon-user";

    await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId,
      maxRequests: ANON_MAX_REQUESTS,
    });
    await t.mutation(internal.billing.logManagedUsage, {
      ownerId: "https://issuer.test|anon-user",
      agentType: "orchestrator",
      model: "deepseek/deepseek-v4-flash",
      durationMs: 10,
      success: true,
      costMicroCents: dollarsToMicroCents(0.04),
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("anon_device_usage").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestCount: 1 });
  });
});

describe("trial budget measurement", () => {
  it("reports requests-per-dollar and exhaustion for the Free cohort", async () => {
    const t = convexTest(schema, modules);

    // Two Free accounts: one exhausted at 20 requests, one halfway at 10.
    await seedLifetimeSpend(t, {
      ownerId: "measured-exhausted",
      spentUsd: FREE_LIFETIME_LIMIT_USD,
      requests: 20,
    });
    await seedLifetimeSpend(t, {
      ownerId: "measured-partial",
      spentUsd: FREE_LIFETIME_LIMIT_USD / 2,
      requests: 10,
    });

    const report = await t.query(
      internal.billing_measurement.getTrialBudgetDistribution,
      {},
    );

    expect(report.free).toMatchObject({
      limitUsd: FREE_LIFETIME_LIMIT_USD,
      sampleSize: 2,
      activeSampleSize: 2,
      totalRequests: 30,
      totalUsd: 0.75,
      // 20 requests per $0.50 and 10 per $0.25 are both 40/dollar.
      requestsPerDollar: 40,
      medianRequestsPerDollar: 40,
      exhaustedCount: 1,
      exhaustedPct: 50,
      medianRequestsBeforeExhaustion: 20,
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
        .withIndex("by_model", (q) =>
          q.eq("model", "crof/deepseek-v4-flash-0731"),
        )
        .unique(),
    );
    expect(staticRow).toMatchObject({
      model: "crof/deepseek-v4-flash-0731",
      source: "static",
      inputPerMillionUsd: 0.12,
      outputPerMillionUsd: 0.21,
    });

    // The Wafer-hosted Fast variant persists the same way.
    const waferRow = await t.run(async (ctx) =>
      ctx.db
        .query("billing_model_prices")
        .withIndex("by_model", (q) =>
          q.eq("model", "wafer/deepseek-v4-flash-0731-fast"),
        )
        .unique(),
    );
    expect(waferRow).toMatchObject({
      model: "wafer/deepseek-v4-flash-0731-fast",
      source: "static",
      sourceProvider: "wafer",
      inputPerMillionUsd: 0.28,
      outputPerMillionUsd: 0.56,
      cacheReadPerMillionUsd: 0.07,
    });

    // The new default is not on models.dev yet; its static override must
    // persist the same way so billing never falls back to $0.
    const museRow = await t.run(async (ctx) =>
      ctx.db
        .query("billing_model_prices")
        .withIndex("by_model", (q) =>
          q.eq("model", "meta/muse-spark-1.2-contributor"),
        )
        .unique(),
    );
    expect(museRow).toMatchObject({
      model: "meta/muse-spark-1.2-contributor",
      source: "static",
      sourceProvider: "openrouter",
      inputPerMillionUsd: 0.1,
      outputPerMillionUsd: 0.2,
    });
  });
});
