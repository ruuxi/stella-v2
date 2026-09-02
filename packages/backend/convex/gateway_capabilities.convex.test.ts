/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
} from "@stella/contracts/gateway/capability";
import { internal } from "./_generated/api";
import { anonymousTrialDeviceId } from "./ai_proxy_data";
import { GATEWAY_ALLOWANCE_CAP_MICRO_CENTS } from "./gateway_capabilities";
import { dollarsToMicroCents } from "./lib/billing_money";
import { getPlanConfig } from "./lib/billing_plans";
import { base64UrlDecode } from "./lib/crypto_utils";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER_GENERATION = "gateway-generation";
const ANON_MAX_REQUESTS = 3;

let publicKey: CryptoKey;

const toPem = (pkcs8: Uint8Array) => {
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
};

beforeAll(async () => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "100",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "200",
    STELLA_FREE_MONTHLY_LIMIT_USD: "300",
    STELLA_FREE_LIFETIME_LIMIT_USD: "8",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: String(ANON_MAX_REQUESTS),
    ANON_DEVICE_ID_HASH_SALT: "gateway-test-salt",
    CAPABILITY_SIGNING_KID: "convex-test",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  publicKey = pair.publicKey;
  process.env.CAPABILITY_SIGNING_KEY = toPem(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
});

afterEach(() => {
  process.env.CAPABILITY_SIGNING_KID = "convex-test";
});

const createTest = async (ownerIds: string[]) => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const ownerId of ownerIds) {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  return t;
};

const allowance = (
  t: Awaited<ReturnType<typeof createTest>>,
  args: { ownerId: string; isAnonymous?: boolean; deviceId?: string },
) =>
  t.mutation(internal.gateway_capabilities.getOwnerModelAllowanceInternal, {
    ownerGeneration: OWNER_GENERATION,
    ...args,
  });

const peekAllowance = (
  t: Awaited<ReturnType<typeof createTest>>,
  args: { ownerId: string; isAnonymous?: boolean; deviceId?: string },
) =>
  t.query(internal.gateway_capabilities.peekOwnerModelAllowanceInternal, {
    ownerGeneration: OWNER_GENERATION,
    ...args,
  });

const freeRemainingMicroCents = () => {
  const plan = getPlanConfig("free");
  return dollarsToMicroCents(
    Math.min(
      plan.rollingLimitUsd,
      plan.weeklyLimitUsd,
      plan.monthlyLimitUsd,
      plan.lifetimeLimitUsd ?? Number.POSITIVE_INFINITY,
    ),
  );
};

const decodeToken = (token: string) => {
  const [header, payload] = token.split(".");
  const decoder = new TextDecoder();
  return {
    header: JSON.parse(decoder.decode(base64UrlDecode(header!))) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(decoder.decode(base64UrlDecode(payload!))) as Record<
      string,
      unknown
    >,
  };
};

const verifySignature = async (token: string) => {
  const [header, payload, signature] = token.split(".");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    new Uint8Array(base64UrlDecode(signature!)),
    new TextEncoder().encode(`${header}.${payload}`),
  );
};

describe("getOwnerModelAllowanceInternal", () => {
  it("caps a signed-in owner's budget at the allowance ceiling, then at what remains", async () => {
    const ownerId = "https://convex.test|capped-owner";
    const t = await createTest([ownerId]);
    expect(freeRemainingMicroCents()).toBeGreaterThan(
      GATEWAY_ALLOWANCE_CAP_MICRO_CENTS,
    );

    expect(await allowance(t, { ownerId })).toEqual({
      audience: "free",
      budgetMicroCents: GATEWAY_ALLOWANCE_CAP_MICRO_CENTS,
      unlimited: false,
    });

    const spentMicroCents = dollarsToMicroCents(6);
    await t.mutation(internal.billing.logManagedUsage, {
      ownerId,
      ownerGeneration: OWNER_GENERATION,
      agentType: "chat",
      model: "anthropic/claude-sonnet-4.6",
      durationMs: 10,
      success: true,
      costMicroCents: spentMicroCents,
    });

    expect(await allowance(t, { ownerId })).toEqual({
      audience: "free",
      budgetMicroCents: freeRemainingMicroCents() - spentMicroCents,
      unlimited: false,
    });
  });

  it("charges reservations against the budget and floors at zero", async () => {
    const ownerId = "https://convex.test|reserved-owner";
    const t = await createTest([ownerId]);
    await allowance(t, { ownerId });
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(usage!._id, {
        activeReservedMicroCents: freeRemainingMicroCents() + 1,
      });
    });
    expect(await allowance(t, { ownerId })).toMatchObject({
      budgetMicroCents: 0,
      unlimited: false,
    });
  });

  it("returns the unlimited sentinel for unlimited owners", async () => {
    const ownerId = "https://convex.test|unlimited-owner";
    const t = await createTest([ownerId]);
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_profiles", {
        ownerId,
        activePlan: "pro",
        subscriptionStatus: "active",
        usageMode: "unlimited",
        stripeCustomerId: "cus_unlimited",
        stripeSubscriptionId: "sub_unlimited",
        stripePriceId: "price_unlimited",
        defaultPaymentMethodId: "pm_unlimited",
        paymentMethodBrand: "visa",
        paymentMethodLast4: "4242",
        currentPeriodStart: 0,
        currentPeriodEnd: 1,
        cancelAtPeriodEnd: false,
        monthlyAnchorAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(await allowance(t, { ownerId })).toEqual({
      audience: "pro",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      unlimited: true,
    });
  });

  it("gives anonymous owners the request trial that is left on their device", async () => {
    const ownerId = "https://convex.test|anonymous-owner";
    const t = await createTest([ownerId]);
    expect(await allowance(t, { ownerId, isAnonymous: true })).toEqual({
      audience: "anonymous",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      maxRequests: ANON_MAX_REQUESTS,
      unlimited: false,
    });

    await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId: anonymousTrialDeviceId(ownerId),
      maxRequests: ANON_MAX_REQUESTS,
    });
    expect(await allowance(t, { ownerId, isAnonymous: true })).toMatchObject({
      maxRequests: ANON_MAX_REQUESTS - 1,
    });

    for (let i = 0; i < ANON_MAX_REQUESTS + 1; i += 1) {
      await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId: "device-exhausted",
        maxRequests: ANON_MAX_REQUESTS,
      });
    }
    expect(
      await allowance(t, {
        ownerId,
        isAnonymous: true,
        deviceId: "device-exhausted",
      }),
    ).toMatchObject({ maxRequests: 0 });
  });

  it("rejects a stale owner generation", async () => {
    const ownerId = "https://convex.test|stale-owner";
    const t = await createTest([ownerId]);
    await expect(
      t.mutation(internal.gateway_capabilities.getOwnerModelAllowanceInternal, {
        ownerId,
        ownerGeneration: "generation-before-reset",
      }),
    ).rejects.toThrow(/started before the account data was reset/u);
  });
});

describe("peekOwnerModelAllowanceInternal", () => {
  it("matches the mutation for an anonymous owner", async () => {
    const ownerId = "https://convex.test|peek-anonymous-owner";
    const t = await createTest([ownerId]);
    await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId: anonymousTrialDeviceId(ownerId),
      maxRequests: ANON_MAX_REQUESTS,
    });

    const peeked = await peekAllowance(t, { ownerId, isAnonymous: true });
    expect(await allowance(t, { ownerId, isAnonymous: true })).toEqual(peeked);
  });

  it("matches the mutation without normalizing stored billing windows", async () => {
    const ownerId = "https://convex.test|peek-profile-owner";
    const t = await createTest([ownerId]);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("billing_profiles", {
        ownerId,
        activePlan: "free",
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
        ownerId,
        rollingUsageMicroCents: dollarsToMicroCents(20),
        rollingWindowStartedAt: 1,
        weeklyUsageMicroCents: dollarsToMicroCents(20),
        weeklyWindowStartedAt: 1,
        monthlyUsageMicroCents: dollarsToMicroCents(20),
        monthlyWindowStartedAt: 1,
        totalUsageMicroCents: dollarsToMicroCents(4),
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("billing_usage_credits", {
        ownerId,
        balanceMicroCents: dollarsToMicroCents(0.5),
        totalPurchasedMicroCents: dollarsToMicroCents(0.5),
        totalConsumedMicroCents: 0,
        currency: "usd",
        createdAt: now,
        updatedAt: now,
      });
    });

    const peeked = await peekAllowance(t, { ownerId });
    const usageBeforeMutation = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
    );
    expect(usageBeforeMutation?.rollingWindowStartedAt).toBe(1);

    expect(await allowance(t, { ownerId })).toEqual(peeked);
    const usageAfterMutation = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
    );
    expect(usageAfterMutation?.rollingWindowStartedAt).toBeGreaterThan(1);
  });

  it("matches the mutation without creating missing billing rows", async () => {
    const ownerId = "https://convex.test|peek-new-owner";
    const t = await createTest([ownerId]);

    const peeked = await peekAllowance(t, { ownerId });
    const rowsAfterPeek = await t.run(
      async (ctx) =>
        await Promise.all([
          ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
            .unique(),
          ctx.db
            .query("billing_usage_windows")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
            .unique(),
        ]),
    );
    expect(rowsAfterPeek).toEqual([null, null]);

    expect(await allowance(t, { ownerId })).toEqual(peeked);
    const rowsAfterMutation = await t.run(
      async (ctx) =>
        await Promise.all([
          ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
            .unique(),
          ctx.db
            .query("billing_usage_windows")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
            .unique(),
        ]),
    );
    expect(rowsAfterMutation.every((row) => row !== null)).toBe(true);
  });
});

describe("signSessionCapabilityInternal", () => {
  it("mints an ES256 session capability carrying the owner's allowance and generation", async () => {
    const ownerId = "https://convex.test|signed-owner";
    const t = await createTest([ownerId]);
    const before = Date.now();
    const response = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      { ownerId, isAnonymous: false },
    );

    expect(response).toMatchObject({
      audience: "free",
      budgetMicroCents: GATEWAY_ALLOWANCE_CAP_MICRO_CENTS,
    });
    expect(response.maxRequests).toBeUndefined();
    expect(await verifySignature(response.capability)).toBe(true);

    const { header, claims } = decodeToken(response.capability);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: "convex-test" });
    expect(claims).toMatchObject({
      iss: GATEWAY_CAPABILITY_ISSUERS.convex,
      aud: GATEWAY_CAPABILITY_AUDIENCE,
      sub: ownerId,
      gen: OWNER_GENERATION,
      kind: "session",
      audience: "free",
      budgetMicroCents: GATEWAY_ALLOWANCE_CAP_MICRO_CENTS,
    });
    expect(typeof claims.jti).toBe("string");
    expect(claims.exp).toBe(
      (claims.iat as number) + GATEWAY_SESSION_CAPABILITY_TTL_MS / 1000,
    );
    expect(response.expiresAt).toBe((claims.exp as number) * 1000);
    expect((claims.iat as number) * 1000).toBeGreaterThanOrEqual(before - 1000);
  });

  it("carries the anonymous request ceiling and no monetary budget", async () => {
    const ownerId = "https://convex.test|signed-anon";
    const t = await createTest([ownerId]);
    const response = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      { ownerId, isAnonymous: true, deviceId: "device-a" },
    );
    expect(response).toMatchObject({
      audience: "anonymous",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      maxRequests: ANON_MAX_REQUESTS,
    });
    expect(decodeToken(response.capability).claims).toMatchObject({
      audience: "anonymous",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      maxRequests: ANON_MAX_REQUESTS,
    });
  });

  it("refuses to mint for an owner whose data is being purged", async () => {
    const ownerId = "https://convex.test|purging-owner";
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: OWNER_GENERATION,
        state: "deleting",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await expect(
      t.action(internal.gateway_capabilities.signSessionCapabilityInternal, {
        ownerId,
        isAnonymous: false,
      }),
    ).rejects.toThrow(/being deleted/u);
  });

  it("fails closed when the signing key is not configured", async () => {
    const ownerId = "https://convex.test|unsigned-owner";
    const t = await createTest([ownerId]);
    delete process.env.CAPABILITY_SIGNING_KID;
    await expect(
      t.action(internal.gateway_capabilities.signSessionCapabilityInternal, {
        ownerId,
        isAnonymous: false,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConvexError &&
        (error.data as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
  });
});
