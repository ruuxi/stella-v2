/// <reference types="vite/client" />

import { GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS } from "@stella/contracts/gateway/api";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONVEX_OWNER_SNAPSHOT_PATH,
  type OwnerSnapshot,
} from "@stella/contracts/turn-plane/owner-snapshot";
import { components, internal } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import { dollarsToMicroCents } from "./lib/billing_money";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const SECRET = "snapshot-builder-secret";
const GENERATION = "generation-snapshot";

beforeAll(() => {
  const values: Record<string, string> = {
    BUILDER_SERVICE_SECRET: SECRET,
    CLOUD_BUILDER_URL: "https://builder.test",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "100",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "200",
    STELLA_FREE_MONTHLY_LIMIT_USD: "300",
    STELLA_FREE_LIFETIME_LIMIT_USD: "8",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: "3",
    STELLA_ANON_LIFETIME_LIMIT_USD: "0.10",
    ANON_DEVICE_ID_HASH_SALT: "snapshot-test-salt",
    CONVEX_SITE_URL: "https://snapshot.test",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  process.env.BUILDER_SERVICE_SECRET = SECRET;
  process.env.CLOUD_BUILDER_URL = "https://builder.test";
  vi.restoreAllMocks();
});

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(t);
  return t;
};
type Harness = ReturnType<typeof createTest>;

const seedUser = async (t: Harness, key: string, isAnonymous: boolean) => {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: key,
        email: `${key}@stella.test`,
        emailVerified: !isAnonymous,
        isAnonymous,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  })) as { _id: string };
  const ownerId = tokenIdentifierForBetterAuthUserId(user._id);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return ownerId;
};

const fetchSnapshot = (t: Harness, ownerId: string, secret = SECRET) =>
  t.fetch(
    `${CONVEX_OWNER_SNAPSHOT_PATH}?ownerId=${encodeURIComponent(ownerId)}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
    },
  );

describe("GET /api/gateway/owner-snapshot", () => {
  it("requires the builder service secret", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-auth", false);
    expect((await fetchSnapshot(t, ownerId, "wrong")).status).toBe(401);
    delete process.env.BUILDER_SERVICE_SECRET;
    expect((await fetchSnapshot(t, ownerId)).status).toBe(503);
  });

  it("serves the contract shape for a signed-in free owner with pairings and engines", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-owner", false);
    await t.run(async (ctx) => {
      await ctx.db.insert("paired_mobile_devices", {
        ownerId,
        desktopDeviceId: "desktop-1",
        mobileDeviceId: "phone-1",
        pairSecretHash: "hash",
        approvedAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("paired_mobile_devices", {
        ownerId,
        desktopDeviceId: "desktop-1",
        mobileDeviceId: "phone-revoked",
        pairSecretHash: "hash",
        approvedAt: 1,
        lastSeenAt: 1,
        revokedAt: 2,
      });
      await ctx.db.insert("cloud_llm_credentials", {
        ownerId,
        provider: "anthropic",
        payloadEncrypted: "opaque",
        label: "Claude",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("devices", {
        ownerId,
        ownerGeneration: GENERATION,
        deviceId: "desktop-1",
        deviceName: "Studio",
        devicePublicKey: "device-public-key",
        executionCapabilities: ["chat", "local-files"],
      });
      await ctx.db.insert("devices", {
        ownerId,
        ownerGeneration: GENERATION,
        deviceId: "desktop-off",
        devicePublicKey: "other-public-key",
        remoteExecutionEnabled: false,
      });
      // A phone/bridge row with no execution key: never an execution device.
      await ctx.db.insert("devices", {
        ownerId,
        deviceId: "keyless",
        platform: "ios",
      });
    });
    const response = await fetchSnapshot(t, ownerId);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as OwnerSnapshot;
    expect(snapshot).toMatchObject({
      v: 1,
      ownerId,
      ownerGeneration: GENERATION,
      isAnonymous: false,
      identityLevel: 1,
      writable: true,
      plan: "free",
      allowance: {
        audience: "free",
        budgetMicroCents: GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS.free,
      },
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      },
      pairedDevices: [
        {
          mobileDeviceId: "phone-1",
          desktopDeviceId: "desktop-1",
          // The pairing proof's HMAC key, so the worker verifies mobile
          // submits without calling back into Convex.
          mobilePublicKey: "hash",
        },
      ],
      devices: [
        {
          deviceId: "desktop-1",
          publicKey: "device-public-key",
          remoteExecutionEnabled: true,
          label: "Studio",
          capabilities: ["chat", "local-files"],
        },
        {
          deviceId: "desktop-off",
          publicKey: "other-public-key",
          remoteExecutionEnabled: false,
        },
      ],
      connectedEngines: ["anthropic"],
      ttlMs: 300_000,
    });
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.devices?.[1]?.label).toBeUndefined();
    expect(snapshot.fetchedAt).toBeGreaterThan(0);
    expect(snapshot.allowance.maxRequests).toBeUndefined();
    const billingRows = await t.run(
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
    expect(billingRows).toEqual([null, null]);
  });

  it("marks purged or fenced owners unwritable and 404s unknown owners", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-purged", false);
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, { state: "resetting" });
    });
    const response = await fetchSnapshot(t, ownerId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isAnonymous: false,
      writable: false,
      allowance: { audience: "free", budgetMicroCents: 0, maxRequests: 0 },
    });
    expect((await fetchSnapshot(t, "https://convex.test|nobody")).status).toBe(
      404,
    );
  });

  it("gives anonymous owners the request-count trial allowance", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-anon", true);
    const response = await fetchSnapshot(t, ownerId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isAnonymous: true,
      identityLevel: 0,
      writable: true,
      allowance: {
        audience: "anonymous",
        budgetMicroCents: dollarsToMicroCents(0.1),
        maxRequests: 3,
      },
    });
  });

  it("makes suspended owners unwritable, refuses minting, and schedules gateway push", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-suspended", false);
    await t.mutation(internal.owner_enforcement.setOwnerEnforcementInternal, {
      ownerId,
      status: "suspended",
      reason: "abuse review",
      actor: "test-admin",
    });

    const response = await fetchSnapshot(t, ownerId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isAnonymous: false,
      identityLevel: 1,
      writable: false,
      enforcement: { status: "suspended", reason: "abuse review" },
      allowance: { budgetMicroCents: 0, maxRequests: 0 },
    });
    await expect(
      t.mutation(internal.gateway_capabilities.getOwnerModelAllowanceInternal, {
        ownerId,
        ownerGeneration: GENERATION,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConvexError &&
        (error.data as { code?: string }).code === "OWNER_SUSPENDED",
    );

    const scheduledNames = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map(
        (entry) => entry.name,
      ),
    );
    expect(
      scheduledNames.some((name) =>
        name.includes("notifyOwnerSnapshotChanged"),
      ),
    ).toBe(true);
    expect(
      scheduledNames.some((name) =>
        name.includes("pushOwnerEnforcementToGateway"),
      ),
    ).toBe(true);
    expect(
      scheduledNames.some((name) => name.includes("postAlertInternal")),
    ).toBe(true);
  });
});

describe("owner snapshot change push", () => {
  it("posts a fresh snapshot, falls back to a stale marker, and swallows failures", async () => {
    const t = createTest();
    const ownerId = await seedUser(t, "snapshot-push", false);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response("nope", { status: 500 });
      });
    await t.action(internal.owner_snapshot.notifyOwnerSnapshotChanged, {
      ownerId,
      reason: "billing",
    });
    const billingCall = calls.find(
      (call) =>
        (JSON.parse(String(call.init.body)) as { reason?: string }).reason ===
        "billing",
    );
    expect(billingCall?.url).toBe(
      "https://builder.test/internal/owners/snapshot-changed",
    );
    expect(JSON.parse(String(billingCall?.init.body))).toMatchObject({
      ownerId,
      reason: "billing",
      snapshot: {
        ownerId,
        ownerGeneration: GENERATION,
        writable: true,
        ttlMs: 300_000,
      },
    });
    expect(
      (billingCall?.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${SECRET}`);

    const unknownOwnerId = "https://issuer.test|unknown-owner";
    await t.action(internal.owner_snapshot.notifyOwnerSnapshotChanged, {
      ownerId: unknownOwnerId,
      reason: "manual",
    });
    const manualCall = calls.find(
      (call) =>
        (JSON.parse(String(call.init.body)) as { reason?: string }).reason ===
        "manual",
    );
    expect(JSON.parse(String(manualCall?.init.body))).toEqual({
      ownerId: unknownOwnerId,
      reason: "manual",
    });

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(
      t.action(internal.owner_snapshot.notifyOwnerSnapshotChanged, {
        ownerId: unknownOwnerId,
        reason: "engine",
      }),
    ).resolves.toBeNull();
  });

  it("is scheduled by plan, engine, pairing, and generation writers", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|snapshot-writers";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId,
      plan: "go",
    });
    await t.mutation(internal.cloud_engines.storeCredentialInternal, {
      ownerId,
      ownerGeneration: GENERATION,
      provider: "anthropic",
      payloadEncrypted: "opaque",
      label: "Claude",
      now: 5,
    });
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId,
      operationId: "op-1",
      mode: "reset",
      now: 6,
    });
    const reasons = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((entry) => entry.name.includes("notifyOwnerSnapshotChanged"))
        .map((entry) => (entry.args[0] as { reason: string }).reason)
        .sort(),
    );
    expect(reasons).toEqual(["billing", "engine", "generation"]);
  });
});
