/// <reference types="vite/client" />

import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { assertOwnerArtifactQuota } from "./lib/artifact_quota";
import { calculateRiskScore } from "./lib/risk";
import { evaluateSybilPressure } from "./lib/sybil";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY_MS = 24 * 60 * 60_000;
const OWNER_GENERATION = "abuse-test-generation";

const consumeTtsRef = makeFunctionReference<
  "mutation",
  { ownerId: string; characters: number; now: number },
  { allowed: boolean; count: number; limit: number; retryAt: number }
>("owner_daily_counters:consumeTtsDailyCharactersInternal");

const consumeCloudOperationRef = makeFunctionReference<
  "mutation",
  { ownerId: string; now: number },
  { allowed: boolean; count: number; limit: number; retryAt: number }
>("owner_daily_counters:consumeCloudAppOperationDailyInternal");

const consumeXBotRef = makeFunctionReference<
  "mutation",
  { authorId: string; now: number },
  { allowed: boolean; scope: "author" | "global" | null; retryAt: number }
>("owner_daily_counters:consumeXBotDailyAllowanceInternal");

const reserveTunnelRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    deviceId: string;
    tunnelName: string;
    hostname: string;
    now: number;
    leaseExpiresAt: number;
  },
  string
>("cloudflare_tunnels:reserveTunnelProvision");

const getOrProvisionTunnelRef = makeFunctionReference<
  "action",
  { ownerId: string; deviceId: string },
  { tunnelToken: string; hostname: string }
>("cloudflare_tunnels:getOrProvisionTunnel");

const recomputeRiskRef = makeFunctionReference<
  "mutation",
  { now?: number },
  { scored: number; deleted: number; enforced: number; hasMoreExpired: boolean }
>("risk:recomputeRiskScoresInternal");

const topRiskRef = makeFunctionReference<
  "query",
  {
    window: "1h" | "24h";
    by: "spend" | "requests" | "mints" | "score";
  },
  Array<{ ownerId: string; score: number; requests: number }>
>("risk:listTopOwnerRiskSignalsInternal");

const convexErrorCode = (error: unknown): string | null => {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown } | string | undefined;
  return typeof data === "object" && data && typeof data.code === "string"
    ? data.code
    : null;
};

afterEach(() => {
  delete process.env.STELLA_TTS_DAILY_CHARS_FREE;
  delete process.env.STELLA_APP_ARTIFACT_QUOTA_MB_FREE;
  delete process.env.STELLA_RISK_WEIGHTS_JSON;
});

describe("Sybil pressure", () => {
  const insertOrigin = async (
    t: ReturnType<typeof convexTest>,
    args: {
      ownerId: string;
      now: number;
      deviceKeyHash?: string;
      ipHash?: string;
      networkClass?: string;
      identityLevel?: 0 | 1 | 2 | 3;
    },
  ) =>
    await t.run(async (ctx) => {
      await ctx.db.insert("owner_origins", {
        ownerId: args.ownerId,
        ...(args.deviceKeyHash ? { deviceKeyHash: args.deviceKeyHash } : {}),
        ...(args.ipHash ? { ipHash: args.ipHash } : {}),
        ...(args.networkClass ? { networkClass: args.networkClass } : {}),
        identityLevel: args.identityLevel ?? 0,
        createdAt: args.now,
        updatedAt: args.now,
      });
    });

  it("challenges the second low-identity owner on one device and exempts level 2", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await insertOrigin(t, {
      ownerId: "owner-1",
      deviceKeyHash: "device-key",
      now,
    });
    const pressure = await t.run(
      async (ctx) =>
        await evaluateSybilPressure(ctx, {
          ownerId: "owner-2",
          deviceKeyHash: "device-key",
          identityLevel: 1,
          now,
        }),
    );
    expect(pressure).toEqual({ action: "challenge", reason: "device_key" });
    expect(
      await t.run(
        async (ctx) =>
          await evaluateSybilPressure(ctx, {
            ownerId: "owner-2",
            deviceKeyHash: "device-key",
            identityLevel: 2,
            now,
          }),
      ),
    ).toEqual({ action: "ok", reason: "none" });
  });

  it("challenges at five anonymous IP owners, requires sign-in at twenty, and challenges hosting at five", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    for (let index = 0; index < 19; index += 1) {
      await insertOrigin(t, {
        ownerId: `anonymous-${index}`,
        ipHash: "shared-ip",
        identityLevel: 0,
        now,
      });
      if (index < 4) {
        await insertOrigin(t, {
          ownerId: `hosting-${index}`,
          ipHash: "hosting-ip",
          networkClass: "hosting",
          identityLevel: 1,
          now,
        });
      }
    }
    expect(
      await t.run(
        async (ctx) =>
          await evaluateSybilPressure(ctx, {
            ownerId: "anonymous-new",
            ipHash: "shared-ip",
            identityLevel: 0,
            now,
          }),
      ),
    ).toEqual({ action: "sign_in_required", reason: "anonymous_ip" });
    expect(
      await t.run(
        async (ctx) =>
          await evaluateSybilPressure(ctx, {
            ownerId: "hosting-new",
            ipHash: "hosting-ip",
            networkClass: "hosting",
            identityLevel: 1,
            now,
          }),
      ),
    ).toEqual({ action: "challenge", reason: "hosting_network" });

    const challenge = convexTest(schema, modules);
    for (let index = 0; index < 4; index += 1) {
      await insertOrigin(challenge, {
        ownerId: `challenge-${index}`,
        ipHash: "challenge-ip",
        identityLevel: 0,
        now,
      });
    }
    expect(
      await challenge.run(
        async (ctx) =>
          await evaluateSybilPressure(ctx, {
            ownerId: "challenge-new",
            ipHash: "challenge-ip",
            identityLevel: 0,
            now,
          }),
      ),
    ).toEqual({ action: "challenge", reason: "anonymous_ip" });
  });
});

describe("daily cost counters", () => {
  it("enforces the TTS character quota and resets at UTC midnight", async () => {
    process.env.STELLA_TTS_DAILY_CHARS_FREE = "5";
    const t = convexTest(schema, modules);
    const now = Date.UTC(2026, 8, 2, 12);
    expect(
      await t.mutation(consumeTtsRef, {
        ownerId: "tts-owner",
        characters: 5,
        now,
      }),
    ).toMatchObject({ allowed: true, count: 5, limit: 5 });
    expect(
      await t.mutation(consumeTtsRef, {
        ownerId: "tts-owner",
        characters: 1,
        now,
      }),
    ).toEqual({
      allowed: false,
      count: 5,
      limit: 5,
      retryAt: Date.UTC(2026, 8, 3),
    });
  });

  it("caps cloud operations at 200 and X at 10 per author and 500 globally", async () => {
    const t = convexTest(schema, modules);
    const now = Date.UTC(2026, 8, 2, 12);
    const day = "20260902";
    await t.run(async (ctx) => {
      await ctx.db.insert("owner_daily_counters", {
        ownerId: "cloud-owner",
        kind: "cloud_app_operation_router",
        day,
        count: 199,
      });
      await ctx.db.insert("owner_daily_counters", {
        ownerId: "x-author:author-a",
        kind: "x_bot_mentions",
        day,
        count: 9,
      });
      await ctx.db.insert("owner_daily_counters", {
        ownerId: "x-global",
        kind: "x_bot_mentions",
        day,
        count: 498,
      });
    });
    expect(
      await t.mutation(consumeCloudOperationRef, {
        ownerId: "cloud-owner",
        now,
      }),
    ).toMatchObject({ allowed: true, count: 200 });
    expect(
      await t.mutation(consumeCloudOperationRef, {
        ownerId: "cloud-owner",
        now,
      }),
    ).toMatchObject({ allowed: false, count: 200 });
    expect(
      await t.mutation(consumeXBotRef, { authorId: "author-a", now }),
    ).toMatchObject({
      allowed: true,
    });
    expect(
      await t.mutation(consumeXBotRef, { authorId: "author-a", now }),
    ).toMatchObject({
      allowed: false,
      scope: "author",
    });
    expect(
      await t.mutation(consumeXBotRef, { authorId: "author-b", now }),
    ).toMatchObject({
      allowed: true,
    });
    expect(
      await t.mutation(consumeXBotRef, { authorId: "author-c", now }),
    ).toMatchObject({
      allowed: false,
      scope: "global",
    });
  });
});

describe("tunnel and artifact quotas", () => {
  it("requires identity level 2 before tunnel provider I/O", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "email-only-tunnel-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(
      t.action(getOrProvisionTunnelRef, { ownerId, deviceId: "device" }),
    ).rejects.toSatisfy(
      (error: unknown) => convexErrorCode(error) === "SIGN_IN_REQUIRED",
    );
  });

  it("allows three tunnel rows per owner and rejects the fourth", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "tunnel-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    });
    for (let index = 0; index < 3; index += 1) {
      await t.mutation(reserveTunnelRef, {
        ownerId,
        ownerGeneration: OWNER_GENERATION,
        deviceId: `device-${index}`,
        tunnelName: `tunnel-${index}`,
        hostname: `tunnel-${index}.example.test`,
        now,
        leaseExpiresAt: now + 60_000,
      });
    }
    await expect(
      t.mutation(reserveTunnelRef, {
        ownerId,
        ownerGeneration: OWNER_GENERATION,
        deviceId: "device-3",
        tunnelName: "tunnel-3",
        hostname: "tunnel-3.example.test",
        now,
        leaseExpiresAt: now + 60_000,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => convexErrorCode(error) === "TUNNEL_LIMIT",
    );
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("cloudflare_tunnels").collect()).every(
          (row) => row.lastUsedAt === now,
        ),
      ),
    ).toBe(true);
  });

  it("counts recorded mini-app bytes against the plan quota", async () => {
    process.env.STELLA_APP_ARTIFACT_QUOTA_MB_FREE = "1";
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_app_builds", {
        buildId: "mini-build",
        appId: "app",
        ownerId: "artifact-owner",
        status: "active",
        metricsJson: JSON.stringify({ uploadedBytes: 700_000 }),
        createdAt: 1,
        updatedAt: 1,
      });
      await expect(
        assertOwnerArtifactQuota(ctx, {
          ownerId: "artifact-owner",
          additionalBytes: 400_000,
        }),
      ).rejects.toSatisfy(
        (error: unknown) => convexErrorCode(error) === "ARTIFACT_QUOTA",
      );
    });
  });
});

describe("risk scoring", () => {
  it("uses the fixed weights and moves owners from challenged to throttled", async () => {
    expect(
      calculateRiskScore(
        {
          requests: 201,
          chargedMicroCents: 200_000_001,
          mints: 0,
          hostingRequests: 0,
          distinctIps: 0,
          failedRequests: 0,
          sybilFlags: 0,
        },
        "1h",
      ),
    ).toBe(60);

    const t = convexTest(schema, modules);
    const ownerId = "risk-owner";
    const now = Date.now();
    const rowId = await t.run(
      async (ctx) =>
        await ctx.db.insert("owner_risk_signals", {
          ownerId,
          window: "1h",
          requests: 201,
          chargedMicroCents: 200_000_001,
          mints: 0,
          hostingRequests: 0,
          distinctIps: 0,
          ipHashes: [],
          distinctConversations: 0,
          conversationIds: [],
          failedRequests: 0,
          sybilFlags: 0,
          score: 0,
          updatedAt: now,
        }),
    );
    expect(await t.mutation(recomputeRiskRef, { now })).toMatchObject({
      enforced: 1,
    });
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("owner_enforcement")
            .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
            .unique(),
      ),
    ).toMatchObject({ status: "challenged", actor: "risk-cron" });

    await t.run(async (ctx) => {
      await ctx.db.patch(rowId, { sybilFlags: 1, updatedAt: now + 1 });
    });
    expect(await t.mutation(recomputeRiskRef, { now: now + 1 })).toMatchObject({
      enforced: 1,
    });
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("owner_enforcement")
            .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
            .unique(),
      ),
    ).toMatchObject({ status: "throttled", actor: "risk-cron" });
  });

  it("returns the top twenty owners in the requested order", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 25; index += 1) {
        await ctx.db.insert("owner_risk_signals", {
          ownerId: `owner-${index}`,
          window: "24h",
          requests: index,
          chargedMicroCents: index,
          mints: index,
          hostingRequests: 0,
          distinctIps: 0,
          ipHashes: [],
          distinctConversations: 0,
          conversationIds: [],
          failedRequests: 0,
          sybilFlags: 0,
          score: index,
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("owner_risk_signals", {
        ownerId: "stale-owner",
        window: "24h",
        requests: 10_000,
        chargedMicroCents: 10_000,
        mints: 10_000,
        hostingRequests: 0,
        distinctIps: 0,
        ipHashes: [],
        distinctConversations: 0,
        conversationIds: [],
        failedRequests: 0,
        sybilFlags: 0,
        score: 100,
        updatedAt: Date.now() - DAY_MS - 1,
      });
    });
    const top = await t.query(topRiskRef, { window: "24h", by: "requests" });
    expect(top).toHaveLength(20);
    expect(top[0]).toMatchObject({ ownerId: "owner-24", requests: 24 });
    expect(top.some((row) => row.ownerId === "stale-owner")).toBe(false);
    expect(top[top.length - 1]).toMatchObject({
      ownerId: "owner-5",
      requests: 5,
    });
  });
});
