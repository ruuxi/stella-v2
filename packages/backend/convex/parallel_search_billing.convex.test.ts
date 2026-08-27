/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import {
  MANAGED_PROVIDER_DISPATCH_LEASE_MS,
  MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS,
} from "./billing";
import {
  MANAGED_USAGE_BILLING_KIND,
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
} from "./lib/managed_dispatch";
import { executeWebSearch } from "./tools/backend";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
const originalParallelApiKey = process.env.PARALLEL_API_KEY;

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_FREE_LIFETIME_LIMIT_USD: "0.5",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

beforeEach(() => {
  process.env.PARALLEL_API_KEY = "parallel-billing-test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalParallelApiKey === undefined) {
    delete process.env.PARALLEL_API_KEY;
  } else {
    process.env.PARALLEL_API_KEY = originalParallelApiKey;
  }
});

const billingEnvelope = (fingerprint = "parallel-fingerprint-a") =>
  ({
    kind: PARALLEL_SEARCH_FAST_BILLING_KIND,
    requestFingerprint: fingerprint,
    chargeMicroCents: PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
  }) as const;

const attemptArgs = (
  ownerId: string,
  suffix: string,
  now = 100,
  fingerprint?: string,
) => ({
  ownerId,
  ownerGeneration: "legacy",
  executionId: `parallel-execution-${suffix}`,
  attemptId: `parallel-attempt-${suffix}`,
  leaseId: `parallel-lease-${suffix}`,
  billing: billingEnvelope(fingerprint),
  now,
});

const managedUsageEnvelope = (
  fingerprint = "managed-usage-fingerprint-a",
  fallbackCostMicroCents = 750,
) =>
  ({
    kind: MANAGED_USAGE_BILLING_KIND,
    requestFingerprint: fingerprint,
    agentType: "service:test-provider",
    model: "anthropic/claude-haiku-4.5",
    fallbackCostMicroCents,
  }) as const;

const managedUsageAttemptArgs = (
  ownerId: string,
  suffix: string,
  now = 100,
) => ({
  ownerId,
  ownerGeneration: "legacy",
  executionId: `managed-execution-${suffix}`,
  attemptId: `managed-attempt-${suffix}`,
  leaseId: `managed-lease-${suffix}`,
  billing: managedUsageEnvelope(),
  now,
});

const captureManagedUsage = async (
  t: ReturnType<typeof createTest>,
  args: ReturnType<typeof managedUsageAttemptArgs>,
  usage = {
    durationMs: 25,
    success: true,
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    costMicroCents: 425,
  },
  overrides?: Record<string, unknown>,
) =>
  await t.mutation(
    internal.billing.captureManagedProviderDispatchUsageInternal,
    { ...args, usage, now: args.now + 2, ...overrides },
  );

const markAttempt = async (
  t: ReturnType<typeof createTest>,
  args:
    | ReturnType<typeof attemptArgs>
    | ReturnType<typeof managedUsageAttemptArgs>,
  now = args.now + 1,
) =>
  await t.mutation(
    internal.billing.markManagedProviderDispatchMayHaveStartedInternal,
    { ...args, now },
  );

const settleAttempt = async (
  t: ReturnType<typeof createTest>,
  args:
    | ReturnType<typeof attemptArgs>
    | ReturnType<typeof managedUsageAttemptArgs>,
  outcome: "succeeded" | "failed" | "aborted" | "timed_out" | "outcome_unknown",
  now: number,
) =>
  await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    executionId: args.executionId,
    attemptId: args.attemptId,
    leaseId: args.leaseId,
    outcome,
    now,
  });

const billingSnapshot = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) =>
  await t.run(async (ctx) => {
    const [dispatches, usage, logs] = await Promise.all([
      ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    ]);
    return { dispatches, usage, logs };
  });

const beginPurge = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  mode: "reset" | "delete",
) => {
  const operationId = `parallel-${mode}-${ownerId}`;
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode, now: 10_000 },
  );
  const leaseId = `parallel-purge-lease-${mode}-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId,
    now: 10_001,
  });
  return {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
    mode,
  };
};

const executeForOwner = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) =>
  await executeWebSearch(
    {
      runMutation: async (
        reference: FunctionReference<"mutation", "internal">,
        args: Record<string, unknown>,
      ) => await t.mutation(reference, args),
    } as never,
    "durable parallel billing",
    {
      ownerId,
      ownerGeneration: "legacy",
      signal: new AbortController().signal,
    },
  );

describe("Parallel Search Fast exact-attempt billing", () => {
  it("charges a successful physical attempt exactly once across settlement replay", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-success";
    const args = attemptArgs(ownerId, "success");
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args);
    expect(await settleAttempt(t, args, "succeeded", 200)).toBe(true);
    expect(await settleAttempt(t, args, "succeeded", 200)).toBe(true);

    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "succeeded",
      billing: {
        ...billingEnvelope(),
        providerState: "may_have_dispatched",
        billingState: "billed",
      },
    });
  });

  it.each(["failed", "aborted", "timed_out", "outcome_unknown"] as const)(
    "charges a %s attempt whenever the provider may have received it",
    async (outcome) => {
      const t = createTest();
      const ownerId = `parallel-billing-${outcome}`;
      const args = attemptArgs(ownerId, outcome);
      await t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        args,
      );
      await markAttempt(t, args);
      await settleAttempt(t, args, outcome, 200);
      const snapshot = await billingSnapshot(t, ownerId);
      expect(snapshot.usage?.totalRequestCount).toBe(1);
      expect(snapshot.usage?.totalUsageMicroCents).toBe(
        PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
      );
      expect(snapshot.dispatches[0]?.billing?.billingState).toBe("billed");
    },
  );

  it("does not charge a definitively pre-dispatch abort", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-pre-dispatch-abort";
    const args = attemptArgs(ownerId, "pre-dispatch-abort");
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await settleAttempt(t, args, "aborted", 200);
    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
    expect(snapshot.usage?.totalUsageMicroCents ?? 0).toBe(0);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches[0]?.billing?.billingState).toBe(
      "not_chargeable",
    );
  });

  it("rejects an attempt-id fingerprint mismatch without changing its receipt", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-fingerprint-conflict";
    const args = attemptArgs(ownerId, "fingerprint-conflict");
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await expect(
      t.mutation(internal.billing.acquireManagedProviderDispatchInternal, {
        ...args,
        billing: billingEnvelope("parallel-fingerprint-b"),
      }),
    ).rejects.toThrow(/reused|fingerprint|billing/iu);
    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]?.billing?.requestFingerprint).toBe(
      "parallel-fingerprint-a",
    );
    expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
  });

  it("crash-finalizes a marked attempt as unknown and never double-charges", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-crash";
    const oldNow =
      Date.now() -
      MANAGED_PROVIDER_DISPATCH_LEASE_MS -
      MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS -
      1_000;
    const args = attemptArgs(ownerId, "crash", oldNow);
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args, oldNow + 1);
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );

    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "outcome_unknown",
      billing: { billingState: "billed" },
    });
  });

  it("performs zero provider I/O and no charge when fixed-cost admission fails", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-admission-denied";
    await t.mutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration: "legacy",
    });
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (!usage) throw new Error("missing usage window");
      await ctx.db.patch(usage._id, {
        rollingUsageMicroCents: 1_000_000_000_000,
        weeklyUsageMicroCents: 1_000_000_000_000,
        monthlyUsageMicroCents: 1_000_000_000_000,
        totalUsageMicroCents: 1_000_000_000_000,
        totalRequestCount: 7,
      });
    });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Parallel must not be called"));

    await expect(executeForOwner(t, ownerId)).rejects.toThrow(
      /usage|limit|allowance/iu,
    );
    expect(providerFetch).not.toHaveBeenCalled();
    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(7);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(1_000_000_000_000);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]?.billing).toMatchObject({
      providerState: "reserved",
      billingState: "not_chargeable",
    });
  });

  it("settles and bills from exact receipt authority after reset fences writes", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-reset";
    const args = attemptArgs(ownerId, "reset", Date.now());
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args);
    const purge = await beginPurge(t, ownerId, "reset");
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_002 },
      ),
    ).toMatchObject({ ready: false });

    await settleAttempt(t, args, "succeeded", 10_003);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_004 },
      ),
    ).toEqual({ ready: true, pending: [] });
    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
  });

  it("delete quiescence bills a crashed marked attempt before deleting its receipt", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-delete";
    const args = attemptArgs(ownerId, "delete", Date.now());
    const timing = await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args);
    const purge = await beginPurge(t, ownerId, "delete");
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: timing.quiescentAfterAt - 1 },
      ),
    ).toMatchObject({ ready: false });
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: timing.quiescentAfterAt },
      ),
    ).toEqual({ ready: true, pending: [] });

    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
  });

  it("atomically admits only one concurrent attempt when the budget exactly fits one reservation", async () => {
    const t = createTest();
    const ownerId = "parallel-billing-concurrent-reservation";
    await t.mutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration: "legacy",
    });
    const lifetimeLimitMicroCents = 50_000_000;
    const usedMicroCents =
      lifetimeLimitMicroCents - PARALLEL_SEARCH_FAST_COST_MICRO_CENTS;
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (!usage) throw new Error("missing usage window");
      const now = Date.now();
      await ctx.db.patch(usage._id, {
        activeReservedMicroCents: 0,
        rollingUsageMicroCents: usedMicroCents,
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: usedMicroCents,
        weeklyWindowStartedAt: now,
        monthlyUsageMicroCents: usedMicroCents,
        monthlyWindowStartedAt: now,
        totalUsageMicroCents: usedMicroCents,
      });
    });
    const first = attemptArgs(ownerId, "concurrent-a", Date.now());
    const second = attemptArgs(ownerId, "concurrent-b", Date.now());
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      first,
    );
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      second,
    );

    const results = await Promise.allSettled([
      markAttempt(t, first),
      markAttempt(t, second),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    const marked = results[0]?.status === "fulfilled" ? first : second;
    let snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.activeReservedMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(
      snapshot.dispatches.filter(
        (row) => row.billing?.providerState === "may_have_dispatched",
      ),
    ).toHaveLength(1);

    await settleAttempt(t, marked, "succeeded", Date.now() + 100);
    snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      lifetimeLimitMicroCents,
    );
  });

  it.each(["reset", "delete"] as const)(
    "blocks %s quiescence on nonzero aggregate drift after exact rows are gone",
    async (mode) => {
    const t = createTest();
    const ownerId = `parallel-billing-reservation-readback-${mode}`;
    await t.mutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration: "legacy",
    });
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (!usage) throw new Error("missing usage window");
      await ctx.db.patch(usage._id, { activeReservedMicroCents: 1 });
    });
    const purge = await beginPurge(t, ownerId, mode);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_002 },
      ),
    ).toEqual({ ready: false, pending: ["billing_usage_reservations"] });

    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (!usage) throw new Error("missing usage window");
      await ctx.db.patch(usage._id, { activeReservedMicroCents: 0 });
    });
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_003 },
      ),
    ).toEqual({ ready: true, pending: [] });
    },
  );
});

describe("generic managed-usage exact-attempt receipts", () => {
  it.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid fallback %s before provider admission",
    async (fallbackCostMicroCents) => {
    const t = createTest();
    const args = managedUsageAttemptArgs("managed-zero-fallback", "zero");
    await expect(
      t.mutation(internal.billing.acquireManagedProviderDispatchInternal, {
        ...args,
        billing: managedUsageEnvelope(
          "managed-zero-fingerprint",
          fallbackCostMicroCents,
        ),
      }),
    ).rejects.toThrow(/fallback.*positive/iu);
    expect((await billingSnapshot(t, args.ownerId)).dispatches).toEqual([]);
    },
  );

  it("marks a reserved pre-dispatch crash not chargeable", async () => {
    const t = createTest();
    const args = managedUsageAttemptArgs(
      "managed-pre-marker-crash",
      "pre-marker",
    );
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await settleAttempt(t, args, "aborted", 200);
    const snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
    expect(snapshot.usage?.totalUsageMicroCents ?? 0).toBe(0);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches[0]?.billing?.billingState).toBe(
      "not_chargeable",
    );
  });

  it("captures exact usage once after a reset fence and rejects every replay mismatch", async () => {
    const t = createTest();
    const args = managedUsageAttemptArgs(
      "managed-reset-capture",
      "reset-capture",
      Date.now(),
    );
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args);
    const purge = await beginPurge(t, args.ownerId, "reset");
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_002 },
      ),
    ).toMatchObject({ ready: false });

    expect(await captureManagedUsage(t, args)).toBe(true);
    expect(await captureManagedUsage(t, args)).toBe(true);
    await expect(
      captureManagedUsage(t, args, {
        durationMs: 25,
        success: true,
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        costMicroCents: 426,
      }),
    ).rejects.toThrow(/changed.*replay/iu);
    await expect(
      captureManagedUsage(t, args, undefined, {
        billing: managedUsageEnvelope("managed-usage-fingerprint-b"),
      }),
    ).rejects.toThrow(/authority|fingerprint/iu);
    await expect(
      captureManagedUsage(t, args, undefined, { leaseId: "wrong-lease-id" }),
    ).rejects.toThrow(/authority/iu);

    await settleAttempt(t, args, "succeeded", 10_003);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, now: 10_004 },
      ),
    ).toEqual({ ready: true, pending: [] });
    const snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(425);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
  });

  it("reaps capture-then-crash without double billing and cleans the terminal receipt", async () => {
    vi.useFakeTimers();
    const now = 2_000_000_000_000;
    vi.setSystemTime(now);
    const t = createTest();
    const oldNow =
      now -
      MANAGED_PROVIDER_DISPATCH_LEASE_MS -
      MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS -
      1_000;
    const args = managedUsageAttemptArgs(
      "managed-capture-crash",
      "capture-crash",
      oldNow,
    );
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args, oldNow + 1);
    await captureManagedUsage(t, args);
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    let snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(425);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "outcome_unknown",
      billing: { billingState: "billed" },
    });

    const row = snapshot.dispatches[0]!;
    vi.setSystemTime(row.cleanupAt);
    await t.mutation(internal.billing.cleanupManagedProviderDispatchInternal, {
      attemptId: row.attemptId,
      leaseId: row.leaseId,
      cleanupAt: row.cleanupAt,
    });
    snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
  });

  it("charges the positive immutable fallback exactly once after response loss", async () => {
    const t = createTest();
    const ownerId = "managed-response-loss";
    const oldNow =
      Date.now() -
      MANAGED_PROVIDER_DISPATCH_LEASE_MS -
      MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS -
      1_000;
    const args = managedUsageAttemptArgs(ownerId, "response-loss", oldNow);
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args, oldNow + 1);
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    await t.mutation(
      internal.billing.finalizeManagedProviderDispatchBillingInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    const snapshot = await billingSnapshot(t, ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(750);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches[0]?.billing).toMatchObject({
      billingState: "billed",
      capturedUsage: { success: false, costMicroCents: 750 },
    });
  });

  it.each([
    ["NaN cost", { costMicroCents: Number.NaN }],
    ["infinite cost", { costMicroCents: Number.POSITIVE_INFINITY }],
    ["negative cost", { costMicroCents: -1 }],
    ["NaN token count", { inputTokens: Number.NaN }],
    ["infinite token count", { inputTokens: Number.POSITIVE_INFINITY }],
    ["negative token count", { inputTokens: -1 }],
  ])("rejects %s without suppressing the conservative fallback", async (_name, invalid) => {
    const t = createTest();
    const suffix = String(_name).replaceAll(" ", "-").toLowerCase();
    const args = managedUsageAttemptArgs(
      `managed-invalid-capture-${suffix}`,
      suffix,
      Date.now(),
    );
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await markAttempt(t, args);
    await expect(
      captureManagedUsage(t, args, {
        durationMs: 25,
        success: true,
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        costMicroCents: 425,
        ...invalid,
      }),
    ).rejects.toThrow();
    let snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
    expect(snapshot.usage?.activeReservedMicroCents).toBe(750);

    await settleAttempt(t, args, "outcome_unknown", Date.now() + 100);
    snapshot = await billingSnapshot(t, args.ownerId);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(750);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
  });
});
