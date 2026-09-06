/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_ANONYMOUS_REQUEST_CHUNK,
  GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS,
} from "@stella/contracts/gateway/api";
import {
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
} from "@stella/contracts/gateway/capability";
import { internal } from "./_generated/api";
import {
  anonymousIpBucketDeviceId,
  anonymousTrialOwnerKey,
} from "./ai_proxy_data";
import { dollarsToMicroCents } from "./lib/billing_money";
import { getPlanConfig } from "./lib/billing_plans";
import { base64UrlDecode } from "./lib/crypto_utils";
import { GATEWAY_GRANT_SETTLEMENT_GRACE_MS } from "./gateway_capabilities";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER_GENERATION = "gateway-generation";
const ANON_MAX_REQUESTS = 3;
const DEVICE_KEY_HASH = "A".repeat(43);

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
    STELLA_ANON_LIFETIME_LIMIT_USD: "0.10",
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
  vi.restoreAllMocks();
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
  args: { ownerId: string; isAnonymous?: boolean },
) =>
  t.mutation(internal.gateway_capabilities.getOwnerModelAllowanceInternal, {
    ownerGeneration: OWNER_GENERATION,
    ...args,
  });

const peekAllowance = (
  t: Awaited<ReturnType<typeof createTest>>,
  args: { ownerId: string; isAnonymous?: boolean; ipHash?: string },
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
      GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS.free,
    );

    expect(await allowance(t, { ownerId })).toEqual({
      audience: "free",
      budgetMicroCents: GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS.free,
      unlimited: false,
      identityLevel: 1,
    });

    const spentMicroCents = dollarsToMicroCents(7.5);
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
      identityLevel: 1,
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
      identityLevel: 3,
    });
  });

  it("gives anonymous owners finite money and owner/network request headroom", async () => {
    const ownerId = "https://convex.test|anonymous-owner";
    const t = await createTest([ownerId]);
    expect(await peekAllowance(t, { ownerId, isAnonymous: true })).toEqual({
      audience: "anonymous",
      budgetMicroCents: dollarsToMicroCents(0.1),
      maxRequests: Math.min(ANON_MAX_REQUESTS, GATEWAY_ANONYMOUS_REQUEST_CHUNK),
      unlimited: false,
      identityLevel: 0,
    });

    await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId: anonymousTrialOwnerKey(ownerId),
      maxRequests: ANON_MAX_REQUESTS,
    });
    expect(
      await peekAllowance(t, { ownerId, isAnonymous: true }),
    ).toMatchObject({
      maxRequests: ANON_MAX_REQUESTS - 1,
    });

    const ipHash = "network-a";
    for (let i = 0; i < ANON_MAX_REQUESTS * 10; i += 1) {
      await t.mutation(internal.ai_proxy_data.consumeDeviceAllowance, {
        deviceId: anonymousIpBucketDeviceId(ipHash),
        maxRequests: ANON_MAX_REQUESTS * 10,
      });
    }
    expect(
      await peekAllowance(t, {
        ownerId,
        isAnonymous: true,
        ipHash,
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
      deviceId: anonymousTrialOwnerKey(ownerId),
      maxRequests: ANON_MAX_REQUESTS,
    });

    const peeked = await peekAllowance(t, { ownerId, isAnonymous: true });
    expect(await allowance(t, { ownerId, isAnonymous: true })).toMatchObject({
      audience: peeked.audience,
      budgetMicroCents: peeked.budgetMicroCents,
      unlimited: peeked.unlimited,
    });
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
      { ownerId, isAnonymous: false, deviceKeyHash: DEVICE_KEY_HASH },
    );

    expect(response).toMatchObject({
      audience: "free",
      budgetMicroCents: GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS.free,
      identityLevel: 1,
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
      dpk: DEVICE_KEY_HASH,
      kind: "session",
      audience: "free",
      budgetMicroCents: GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS.free,
    });
    expect(typeof claims.jti).toBe("string");
    expect(claims.exp).toBe(
      (claims.iat as number) + GATEWAY_SESSION_CAPABILITY_TTL_MS / 1000,
    );
    expect(response.expiresAt).toBe((claims.exp as number) * 1000);
    expect((claims.iat as number) * 1000).toBeGreaterThanOrEqual(before - 1000);
  });

  it("reserves the anonymous request ceiling and a finite monetary grant", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const ownerId = "https://convex.test|signed-anon";
    const t = await createTest([ownerId]);
    const response = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      {
        ownerId,
        isAnonymous: true,
        ipHash: "network-a",
        deviceKeyHash: DEVICE_KEY_HASH,
      },
    );
    expect(response).toMatchObject({
      audience: "anonymous",
      budgetMicroCents: dollarsToMicroCents(0.1),
      maxRequests: ANON_MAX_REQUESTS,
      identityLevel: 0,
    });
    expect(decodeToken(response.capability).claims).toMatchObject({
      dpk: DEVICE_KEY_HASH,
      audience: "anonymous",
      budgetMicroCents: dollarsToMicroCents(0.1),
      maxRequests: ANON_MAX_REQUESTS,
    });
    const capabilityId = String(decodeToken(response.capability).claims.jti);
    const reserved = await t.run(async (ctx) => ({
      grant: await ctx.db
        .query("gateway_capability_grants")
        .withIndex("by_jti", (q) => q.eq("jti", capabilityId))
        .unique(),
      counters: await ctx.db.query("anon_device_usage").collect(),
    }));
    expect(reserved.grant).toMatchObject({
      ownerId,
      deviceKeyHash: DEVICE_KEY_HASH,
      audience: "anonymous",
      budgetMicroCents: dollarsToMicroCents(0.1),
      maxRequests: ANON_MAX_REQUESTS,
      settledMicroCents: 0,
      settledRequests: 0,
      released: false,
    });
    expect(reserved.counters).toHaveLength(1);
    expect(reserved.counters[0]?.requestCount).toBe(ANON_MAX_REQUESTS);

    // Mint across a second boundary so the grants have different expirations.
    clock.mockReturnValue(now + 1_000);
    const second = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      {
        ownerId,
        isAnonymous: true,
        ipHash: "network-a",
        deviceKeyHash: DEVICE_KEY_HASH,
      },
    );
    expect(second).toMatchObject({ maxRequests: 0, budgetMicroCents: 0 });
    expect(second.expiresAt).toBe(response.expiresAt + 1_000);

    const chargedMicroCents = dollarsToMicroCents(0.01);
    await t.mutation(internal.billing.ingestGatewayUsageBatchInternal, {
      now: Date.now(),
      events: [
        {
          requestId: "anonymous-grant-request",
          capabilityId,
          ownerId,
          ownerGeneration: OWNER_GENERATION,
          audience: "anonymous",
          agentType: "chat",
          resolvedModel: "anthropic/claude-sonnet-4.6",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            reported: true,
          },
          chargedMicroCents,
          outcome: "succeeded",
          startedAt: 1,
          finishedAt: 2,
          billable: true,
          deviceKeyHash: DEVICE_KEY_HASH,
          anonymous: { ipHash: "network-a" },
        },
      ],
    });
    const settled = await t.run(async (ctx) => ({
      grant: await ctx.db
        .query("gateway_capability_grants")
        .withIndex("by_jti", (q) => q.eq("jti", capabilityId))
        .unique(),
      window: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    }));
    expect(settled.grant).toMatchObject({
      settledMicroCents: chargedMicroCents,
      settledRequests: 1,
      released: false,
    });
    expect(settled.window).toMatchObject({
      totalUsageMicroCents: chargedMicroCents,
      totalRequestCount: 1,
    });

    const released = await t.mutation(
      internal.gateway_capabilities
        .releaseExpiredGatewayCapabilityGrantsInternal,
      {
        now:
          Math.max(response.expiresAt, second.expiresAt) +
          GATEWAY_GRANT_SETTLEMENT_GRACE_MS +
          1,
      },
    );
    expect(released).toMatchObject({ released: 2, refundedRequests: 2 });
    const afterRelease = await t.run(async (ctx) => ({
      grants: await ctx.db
        .query("gateway_capability_grants")
        .withIndex("by_owner_released", (q) =>
          q.eq("ownerId", ownerId).eq("released", false),
        )
        .collect(),
      counters: await ctx.db.query("anon_device_usage").collect(),
    }));
    expect(afterRelease.grants).toHaveLength(0);
    expect(afterRelease.counters.map((row) => row.requestCount).sort()).toEqual(
      [1, 1],
    );

    const reminted = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      {
        ownerId,
        isAnonymous: true,
        ipHash: "network-a",
        deviceKeyHash: DEVICE_KEY_HASH,
      },
    );
    expect(reminted).toMatchObject({
      budgetMicroCents: dollarsToMicroCents(0.09),
      maxRequests: ANON_MAX_REQUESTS - 1,
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
        deviceKeyHash: DEVICE_KEY_HASH,
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
        deviceKeyHash: DEVICE_KEY_HASH,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConvexError &&
        (error.data as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
  });
});
