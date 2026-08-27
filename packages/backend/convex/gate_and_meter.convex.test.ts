import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { dollarsToMicroCents } from "./lib/billing_money";
import { meterManagedUsage } from "./lib/gate_and_meter";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const FREE_LIFETIME_LIMIT_USD = 0.5;

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
    STELLA_ANON_MAX_REQUESTS: "1",
    ANON_DEVICE_ID_HASH_SALT: "test-only-anon-device-salt",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  delete process.env.STELLA_ANON_MAX_REQUESTS_PER_IP;
});

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const seedLifetimeSpend = async (
  t: ReturnType<typeof convexTest>,
  args: { ownerId: string; plan?: "free" | "go"; spentUsd: number },
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
      totalRequestCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
};

const readTotalUsageMicroCents = async (
  t: ReturnType<typeof convexTest>,
  ownerId: string,
): Promise<number> =>
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("billing_usage_windows")
      .filter((q) => q.eq(q.field("ownerId"), ownerId))
      .first();
    return row?.totalUsageMicroCents ?? 0;
  });

const looseRate = (key: string) => ({
  scope: "test_gate",
  key,
  limit: 30,
  windowMs: 60_000,
  blockMs: 60_000,
});

describe("enforceManagedGate — combined pre-check gate", () => {
  it("passes an in-budget signed-in user through the usage + rate gates", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|dictation-ok";

    const result = await t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
      ownerId,
      order: ["usage", "rate"],
      usage: {},
      rateLimit: looseRate(ownerId),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an over-limit user on the usage gate before consuming a rate token", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|dictation-over-limit";

    await seedLifetimeSpend(t, { ownerId, spentUsd: 1.0 });

    const call = () =>
      t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
        ownerId,
        order: ["usage", "rate"],
        usage: {},
        rateLimit: { scope: "test_gate", key: ownerId, limit: 1, windowMs: 60_000, blockMs: 60_000 },
      });

    for (let i = 0; i < 3; i++) {
      const result = await call();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.gate).toBe("usage");
        if (result.gate === "usage") {
          expect(result.message.length).toBeGreaterThan(0);
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      }
    }
  });

  it("rejects on the rate gate once the bucket is exhausted (rate still enforced)", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|dictation-rate";

    const rateLimit = { scope: "test_gate", key: ownerId, limit: 3, windowMs: 60_000, blockMs: 60_000 };
    const call = () =>
      t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
        ownerId,
        order: ["usage", "rate"],
        usage: {},
        rateLimit,
      });

    expect((await call()).ok).toBe(true);
    expect((await call()).ok).toBe(true);
    expect((await call()).ok).toBe(true);

    const blocked = await call();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.gate).toBe("rate");
      if (blocked.gate === "rate") {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
      }
    }
  });

  it("rejects an off-plan user on the capability gate (voice ordering)", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|voice-free";

    const result = await t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
      ownerId,
      order: ["rate", "capability", "usage"],
      rateLimit: looseRate(ownerId),
      capability: "audio_generation",
      usage: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe("capability");
      if (result.gate === "capability") {
        expect(result.denial.capability).toBe("audio_generation");
        expect(result.denial.minimumPlan).toBe("pro");
      }
    }
  });

  it("keeps rate precedence over capability when the bucket is empty", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|voice-rate-first";
    const rateLimit = { scope: "test_gate", key: ownerId, limit: 1, windowMs: 60_000, blockMs: 60_000 };

    const first = await t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
      ownerId,
      order: ["rate", "capability", "usage"],
      rateLimit,
      capability: "audio_generation",
      usage: {},
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.gate).toBe("capability");

    const second = await t.mutation(internal.lib.gate_and_meter.enforceManagedGate, {
      ownerId,
      order: ["rate", "capability", "usage"],
      rateLimit,
      capability: "audio_generation",
      usage: {},
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.gate).toBe("rate");
  });
});

describe("meterManagedUsage — durable off-path accounting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the usage write via the scheduler (not dropped)", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const ownerId = "https://issuer.test|meter-user";

    expect(await readTotalUsageMicroCents(t, ownerId)).toBe(0);

    await t.run(async (ctx) => {
      await meterManagedUsage(ctx, {
        ownerId,
        agentType: "service:dictation",
        model: "grok-stt-1.0",
        durationMs: 1234,
        success: true,
        costMicroCents: dollarsToMicroCents(0.01),
      });
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await readTotalUsageMicroCents(t, ownerId)).toBeGreaterThan(0);
  });
});
