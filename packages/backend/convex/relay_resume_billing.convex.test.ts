/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

type ReserveArgs = {
  relayRequestId: string;
  ownerId: string;
  turnId?: string;
  ownerGeneration: string;
  provider: string;
  model: string;
  requestBinding: string;
  agentType: string;
  billingAuthority?: "managed_dispatch";
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  startedAt: number;
  nowMs: number;
};

type TerminalStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "error"
  | "canceled"
  | "upstream_eof"
  | "truncated";

type ActualUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
};

const relayInternal = (
  internal as unknown as {
    stella_provider: {
      relay_resume_store: {
        reserveRelayResumeStream: FunctionReference<
          "mutation",
          "internal",
          ReserveArgs,
          | "reserved"
          | "existing"
          | "expired"
          | "canceled"
          | "conflict"
          | "owner_quota"
          | "global_quota"
          | "owner_purged"
        >;
        markRelayBillingDispatched: FunctionReference<
          "mutation",
          "internal",
          {
            relayRequestId: string;
            ownerId: string;
            ownerGeneration: string;
            requestBinding: string;
            nowMs: number;
          },
          "dispatched" | "terminal" | "not_found" | "conflict"
        >;
        activateRelayResumeStream: FunctionReference<
          "mutation",
          "internal",
          {
            relayRequestId: string;
            ownerId: string;
            upstreamStatus: number;
            upstreamRequestId?: string;
            nowMs: number;
          },
          | "not_found"
          | "streaming"
          | "completed"
          | "incomplete"
          | "failed"
          | "error"
          | "canceled"
          | "upstream_eof"
          | "truncated"
        >;
        cancelRelayResumeStream: FunctionReference<
          "mutation",
          "internal",
          {
            relayRequestId: string;
            ownerId: string;
            turnId?: string;
            nowMs: number;
          },
          | "not_found"
          | "expired"
          | "intent_quota"
          | "streaming"
          | "completed"
          | "incomplete"
          | "failed"
          | "error"
          | "canceled"
          | "upstream_eof"
          | "truncated"
        >;
        finalizeRelayBillingReceipt: FunctionReference<
          "mutation",
          "internal",
          {
            relayRequestId: string;
            ownerId: string;
            requestBinding: string;
            terminalStatus: TerminalStatus;
            success: boolean;
            durationMs: number;
            actualUsage?: ActualUsage;
            nowMs: number;
          },
          "finalized" | "upgraded" | "duplicate" | "not_found" | "conflict"
        >;
        getRelayResumeReservationState: FunctionReference<
          "query",
          "internal",
          {
            relayRequestId: string;
            ownerId: string;
            turnId?: string;
            requestBinding: string;
          },
          "not_found" | "conflict" | "existing" | "expired"
        >;
        deleteOwnerRelayResumeBatch: FunctionReference<
          "mutation",
          "internal",
          {
            ownerId: string;
            operationId: string;
            generation: string;
            nowMs: number;
          },
          { hasMore: boolean }
        >;
      };
    };
  }
).stella_provider.relay_resume_store;

const billingInternal = (
  internal as unknown as {
    billing: {
      logRelayManagedUsage: FunctionReference<
        "mutation",
        "internal",
        {
          relayRequestId: string;
          requestBinding: string;
          nowMs: number;
        },
        | "billed"
        | "already_billed"
        | "not_ready"
        | "not_found"
        | "conflict"
        | "delegated"
      >;
    };
  }
).billing;

const lifecycleInternal = (
  internal as unknown as {
    owner_lifecycle: {
      beginOwnerDataPurgeInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          mode: "reset" | "delete";
          now: number;
        },
        {
          operationId: string;
          generation: string;
          mode: "reset" | "delete";
          stage: "core" | "cloud" | "complete";
        }
      >;
    };
  }
).owner_lifecycle;

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

const reserveArgs = (
  ownerId: string,
  suffix: string,
  overrides: Partial<ReserveArgs> = {},
): ReserveArgs => ({
  relayRequestId: `relay-${suffix}`,
  ownerId,
  turnId: `turn-${suffix}`,
  ownerGeneration: "legacy",
  provider: "openai",
  model: "openai/test-reasoning-model",
  requestBinding: `sha256:${suffix.padEnd(64, "0").slice(0, 64)}`,
  agentType: "general",
  estimatedInputTokens: 100,
  estimatedOutputTokens: 200,
  startedAt: 1_000,
  nowMs: 1_000,
  ...overrides,
});

const seedDefaultConversation = async (t: TestHarness, ownerId: string) =>
  await t.run(async (ctx) => {
    await ctx.db.insert("conversations", {
      ownerId,
      isDefault: true,
      eventCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
  });

const receiptSnapshot = async (
  t: TestHarness,
  args: { ownerId: string; relayRequestId: string },
) =>
  await t.run(async (ctx) => {
    const [receipt, usage, logs] = await Promise.all([
      ctx.db
        .query("stella_relay_billing_receipts")
        .withIndex("by_relayRequestId", (q) =>
          q.eq("relayRequestId", args.relayRequestId),
        )
        .unique(),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .collect(),
    ]);
    return { receipt, usage, logs };
  });

const markDispatched = async (t: TestHarness, args: ReserveArgs) =>
  await t.mutation(relayInternal.markRelayBillingDispatched, {
    relayRequestId: args.relayRequestId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    requestBinding: args.requestBinding,
    nowMs: args.nowMs + 1,
  });

const cancel = async (t: TestHarness, args: ReserveArgs, nowMs: number) =>
  await t.mutation(relayInternal.cancelRelayResumeStream, {
    relayRequestId: args.relayRequestId,
    ownerId: args.ownerId,
    turnId: args.turnId,
    nowMs,
  });

const settle = async (
  t: TestHarness,
  args: ReserveArgs,
  actualUsage?: ActualUsage,
) =>
  await t.mutation(relayInternal.finalizeRelayBillingReceipt, {
    relayRequestId: args.relayRequestId,
    ownerId: args.ownerId,
    requestBinding: args.requestBinding,
    terminalStatus: "canceled",
    success: false,
    durationMs: 50,
    actualUsage,
    nowMs: args.nowMs + 50,
  });

const bill = async (t: TestHarness, args: ReserveArgs, nowMs: number) =>
  await t.mutation(billingInternal.logRelayManagedUsage, {
    relayRequestId: args.relayRequestId,
    requestBinding: args.requestBinding,
    nowMs,
  });

describe("durable resumable relay billing", () => {
  it("turns a pre-header cancellation intent into no dispatch and no receipt", async () => {
    const t = createTest();
    const args = reserveArgs("pre-header-owner", "preheader");

    expect(await cancel(t, args, 900)).toBe("canceled");
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "canceled",
    );
    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt).toBeNull();
    expect(snapshot.usage).toBeNull();
  });

  it("settles a cancel between reservation and dispatch as explicit zero usage", async () => {
    const t = createTest();
    const args = reserveArgs("reserved-cancel-owner", "reservedcancel");
    await seedDefaultConversation(t, args.ownerId);
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await cancel(t, args, 1_005)).toBe("canceled");
    expect(await markDispatched(t, args)).toBe("terminal");
    expect(await bill(t, args, 1_100)).toBe("billed");

    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt).toMatchObject({
      phase: "terminal",
      terminalStatus: "canceled",
      billingReady: true,
      hasActualUsage: true,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualTotalTokens: 0,
      actualCostMicroCents: 0,
    });
    expect(snapshot.logs).toHaveLength(1);
    expect(snapshot.logs[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicroCents: 0,
    });
  });

  it("settles a post-header/pre-activation cancel without racing fallback billing", async () => {
    const t = createTest();
    const args = reserveArgs("pre-activation-owner", "preactivation");
    await seedDefaultConversation(t, args.ownerId);
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await markDispatched(t, args)).toBe("dispatched");
    expect(await cancel(t, args, 1_010)).toBe("canceled");

    const terminal = await receiptSnapshot(t, args);
    expect(terminal.receipt).toMatchObject({
      phase: "terminal",
      terminalStatus: "canceled",
      hasActualUsage: false,
    });
    expect(terminal.receipt?.billingReady).not.toBe(true);
    expect(await bill(t, args, 1_011)).toBe("not_ready");
    expect(
      await t.mutation(relayInternal.activateRelayResumeStream, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        upstreamStatus: 200,
        nowMs: 1_012,
      }),
    ).toBe("canceled");

    expect(await settle(t, args)).toBe("upgraded");
    expect(await bill(t, args, 1_100)).toBe("billed");
    const billed = await receiptSnapshot(t, args);
    expect(billed.receipt?.billingReady).toBe(true);
    expect(billed.usage?.totalRequestCount).toBe(1);
    expect(billed.logs).toHaveLength(1);
    expect(billed.logs[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
      success: false,
    });
  });

  it("bills an accepted mid-stream cancel without usage from the input estimate only", async () => {
    const t = createTest();
    const args = reserveArgs("midstream-fallback-owner", "midfallback");
    await seedDefaultConversation(t, args.ownerId);
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await markDispatched(t, args)).toBe("dispatched");
    expect(
      await t.mutation(relayInternal.activateRelayResumeStream, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        upstreamStatus: 200,
        upstreamRequestId: "upstream-1",
        nowMs: 1_010,
      }),
    ).toBe("streaming");
    expect(await cancel(t, args, 1_020)).toBe("canceled");
    expect(await settle(t, args)).toBe("upgraded");
    expect(await bill(t, args, 1_100)).toBe("billed");

    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt).toMatchObject({
      acceptedAt: 1_010,
      terminalStatus: "canceled",
      billingReady: true,
      hasActualUsage: false,
    });
    expect(snapshot.logs[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
    });
  });

  it("uses late terminal usage and makes duplicate finalizers and deliveries no-ops", async () => {
    const t = createTest();
    const args = reserveArgs("midstream-usage-owner", "midusage");
    await seedDefaultConversation(t, args.ownerId);
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await markDispatched(t, args)).toBe("dispatched");
    expect(
      await t.mutation(relayInternal.activateRelayResumeStream, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        upstreamStatus: 200,
        nowMs: 1_010,
      }),
    ).toBe("streaming");
    expect(await cancel(t, args, 1_020)).toBe("canceled");

    const actualUsage = {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 2,
      costMicroCents: 321,
    };
    expect(await settle(t, args, actualUsage)).toBe("upgraded");
    expect(await settle(t, args, actualUsage)).toBe("duplicate");
    expect(await bill(t, args, 1_100)).toBe("billed");
    expect(await bill(t, args, 1_101)).toBe("already_billed");
    expect(await settle(t, args, actualUsage)).toBe("duplicate");

    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.logs).toHaveLength(1);
    expect(snapshot.logs[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 2,
      costMicroCents: 321,
    });
  });

  it("delegates new resumable requests to the exact physical-attempt receipt without double billing", async () => {
    const t = createTest();
    const args = reserveArgs("delegated-owner", "delegated", {
      billingAuthority: "managed_dispatch",
    });
    await seedDefaultConversation(t, args.ownerId);
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await markDispatched(t, args)).toBe("dispatched");
    expect(
      await t.mutation(relayInternal.finalizeRelayBillingReceipt, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        requestBinding: args.requestBinding,
        terminalStatus: "completed",
        success: true,
        durationMs: 50,
        actualUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        nowMs: 1_050,
      }),
    ).toBe("finalized");
    expect(await bill(t, args, 1_100)).toBe("delegated");

    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt).toMatchObject({
      billingAuthority: "managed_dispatch",
      phase: "terminal",
      terminalStatus: "completed",
      hasActualUsage: true,
    });
    expect(snapshot.receipt?.billingReady).not.toBe(true);
    expect(snapshot.receipt?.billedAt).toBeUndefined();
    expect(snapshot.usage).toBeNull();
    expect(snapshot.logs).toHaveLength(0);
  });

  it("never resolves a legacy receipt without captured generation against the reopened owner", async () => {
    const t = createTest();
    const args = reserveArgs("legacy-receipt-owner", "legacyreceipt");
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await markDispatched(t, args)).toBe("dispatched");
    expect(await cancel(t, args, 1_020)).toBe("canceled");
    expect(await settle(t, args)).toBe("upgraded");

    await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("stella_relay_billing_receipts")
        .withIndex("by_relayRequestId", (q) =>
          q.eq("relayRequestId", args.relayRequestId),
        )
        .unique();
      await ctx.db.patch(receipt!._id, { ownerGeneration: undefined });
    });

    expect(await bill(t, args, 1_100)).toBe("conflict");
    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt?.billedAt).toBeUndefined();
    expect(snapshot.usage).toBeNull();
    expect(snapshot.logs).toEqual([]);
  });

  it("resumes only the exact owner, turn, and logical request, then keeps a billed tombstone", async () => {
    const t = createTest();
    const args = reserveArgs("resume-owner", "resume");
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "existing",
    );
    expect(
      await t.query(relayInternal.getRelayResumeReservationState, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        turnId: args.turnId,
        requestBinding: args.requestBinding,
      }),
    ).toBe("existing");
    expect(
      await t.query(relayInternal.getRelayResumeReservationState, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        turnId: "foreign-turn",
        requestBinding: args.requestBinding,
      }),
    ).toBe("conflict");
    expect(
      await t.query(relayInternal.getRelayResumeReservationState, {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        turnId: args.turnId,
        requestBinding: `${args.requestBinding}-changed`,
      }),
    ).toBe("conflict");

    await t.run(async (ctx) => {
      const stream = await ctx.db
        .query("stella_relay_response_streams")
        .withIndex("by_relayRequestId", (q) =>
          q.eq("relayRequestId", args.relayRequestId),
        )
        .unique();
      await ctx.db.delete(stream!._id);
    });
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "expired",
    );
  });

  it("rejects a dispatch admitted before account deletion without charging", async () => {
    const t = createTest();
    const args = reserveArgs("deletion-fence-owner", "deletefence");
    expect(await t.mutation(relayInternal.reserveRelayResumeStream, args)).toBe(
      "reserved",
    );
    await t.mutation(lifecycleInternal.beginOwnerDataPurgeInternal, {
      ownerId: args.ownerId,
      operationId: "delete-operation",
      mode: "delete",
      now: 1_010,
    });

    await expect(markDispatched(t, args)).rejects.toThrow(
      /account is being deleted/u,
    );
    const snapshot = await receiptSnapshot(t, args);
    expect(snapshot.receipt).toMatchObject({ phase: "reserved" });
    expect(snapshot.receipt?.billingReady).not.toBe(true);
    expect(snapshot.usage).toBeNull();
  });

  it("purges an owner-indexed orphan lease after its stream is gone", async () => {
    const t = createTest();
    const ownerId = "orphan-relay-lease-owner";
    const purge = await t.mutation(
      lifecycleInternal.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: "orphan-relay-lease-purge",
        mode: "delete",
        now: 2_000,
      },
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("stella_relay_response_leases", {
        leaseId: "orphan-lease",
        relayRequestId: "missing-stream",
        ownerId,
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 10_000,
      });
    });

    expect(
      await t.mutation(relayInternal.deleteOwnerRelayResumeBatch, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        nowMs: 2_001,
      }),
    ).toEqual({ hasMore: true });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("stella_relay_response_leases")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .collect(),
      ),
    ).toEqual([]);
    expect(
      await t.mutation(relayInternal.deleteOwnerRelayResumeBatch, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        nowMs: 2_002,
      }),
    ).toEqual({ hasMore: false });
  });
});
