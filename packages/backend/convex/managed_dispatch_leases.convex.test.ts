/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import {
  MANAGED_EXECUTION_HARD_MS,
  MANAGED_EXECUTION_LEASE_MS,
  MANAGED_EXECUTION_QUIESCENCE_MS,
  MANAGED_PROVIDER_DISPATCH_DEADLINE_MS,
  MANAGED_PROVIDER_DISPATCH_LEASE_MS,
  MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS,
} from "./billing";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const attemptArgs = (ownerId: string, suffix: string, now = 100) => ({
  ownerId,
  ownerGeneration: "legacy",
  executionId: `execution-${suffix}`,
  attemptId: `attempt-${suffix}`,
  leaseId: `lease-${suffix}`,
  now,
});

const beginReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  operationId: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode: "reset", now: 1_000 },
  );
  const leaseId = `purge-lease-${operationId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId,
    now: 1_001,
  });
  return {
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
  };
};

describe("managed provider dispatch leases", () => {
  it("reserves one exact physical try and settles it idempotently", async () => {
    const t = createTest();
    const args = attemptArgs("managed-dispatch-owner", "idempotent");
    const timing = await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    expect(timing).toEqual({
      providerDeadlineAt: args.now + MANAGED_PROVIDER_DISPATCH_DEADLINE_MS,
      leaseExpiresAt: args.now + MANAGED_PROVIDER_DISPATCH_LEASE_MS,
      quiescentAfterAt:
        args.now +
        MANAGED_PROVIDER_DISPATCH_LEASE_MS +
        MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS,
    });

    const settleArgs = {
      ...args,
      outcome: "succeeded" as const,
      now: 200,
    };
    expect(
      await t.mutation(
        internal.billing.settleManagedProviderDispatchInternal,
        settleArgs,
      ),
    ).toBe(true);
    expect(
      await t.mutation(
        internal.billing.settleManagedProviderDispatchInternal,
        settleArgs,
      ),
    ).toBe(true);
    await expect(
      t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
        ...settleArgs,
        outcome: "failed",
      }),
    ).rejects.toThrow(/outcome changed/iu);
  });

  it("allows one physical try per execution at a time and fresh ids after settlement", async () => {
    const t = createTest();
    const first = attemptArgs("managed-dispatch-owner", "serialized-first");
    const second = {
      ...attemptArgs("managed-dispatch-owner", "serialized-second", 101),
      executionId: first.executionId,
    };
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      first,
    );
    await expect(
      t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        second,
      ),
    ).rejects.toThrow(/already has an active try/iu);
    await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
      ...first,
      outcome: "failed",
      now: 102,
    });
    await expect(
      t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        second,
      ),
    ).resolves.toMatchObject({
      providerDeadlineAt: 101 + MANAGED_PROVIDER_DISPATCH_DEADLINE_MS,
    });
  });

  it("fences reset until an active try settles, then drains terminal control state", async () => {
    const t = createTest();
    const ownerId = "managed-dispatch-reset-owner";
    const args = attemptArgs(ownerId, "reset-live");
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    const purge = await beginReset(t, ownerId, "managed-dispatch-reset");

    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, ownerId, mode: "reset", now: 1_002 },
      ),
    ).toEqual({
      ready: false,
      pending: ["billing_managed_dispatch_leases"],
    });
    await expect(
      t.mutation(internal.billing.acquireManagedProviderDispatchInternal, {
        ...attemptArgs(ownerId, "post-fence", 1_003),
        ownerGeneration: args.ownerGeneration,
      }),
    ).rejects.toThrow(/reset|account data/iu);

    expect(
      await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
        ...args,
        outcome: "succeeded",
        now: 1_004,
      }),
    ).toBe(true);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, ownerId, mode: "reset", now: 1_005 },
      ),
    ).toEqual({ ready: true, pending: [] });
  });

  it("waits through hard expiry plus quiescence before discarding a crashed try", async () => {
    const t = createTest();
    const ownerId = "managed-dispatch-crash-owner";
    const args = attemptArgs(ownerId, "crashed", 100);
    const timing = await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    const purge = await beginReset(t, ownerId, "managed-dispatch-crash");

    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        {
          ...purge,
          ownerId,
          mode: "reset",
          now: timing.quiescentAfterAt - 1,
        },
      ),
    ).toMatchObject({ ready: false });
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        {
          ...purge,
          ownerId,
          mode: "reset",
          now: timing.quiescentAfterAt,
        },
      ),
    ).toEqual({ ready: true, pending: [] });
  });

  it("retains an ambiguous terminal provider outcome through quiescence", async () => {
    const t = createTest();
    const ownerId = "managed-dispatch-unknown-owner";
    const args = attemptArgs(ownerId, "unknown", 100);
    const timing = await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      args,
    );
    await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
      ...args,
      outcome: "outcome_unknown",
      now: 200,
    });
    const purge = await beginReset(t, ownerId, "managed-dispatch-unknown");

    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        {
          ...purge,
          ownerId,
          mode: "reset",
          now: timing.quiescentAfterAt - 1,
        },
      ),
    ).toEqual({
      ready: false,
      pending: ["billing_managed_dispatch_leases"],
    });
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        {
          ...purge,
          ownerId,
          mode: "reset",
          now: timing.quiescentAfterAt,
        },
      ),
    ).toEqual({ ready: true, pending: [] });
  });

  it("joins a nested model/tool execution to reset until exact settlement", async () => {
    const t = createTest();
    const ownerId = "managed-tool-execution-owner";
    const executionArgs = {
      ownerId,
      ownerGeneration: "legacy",
      executionId: "managed-tool-execution",
      leaseId: "managed-tool-execution-lease",
      now: 100,
    };
    expect(
      await t.mutation(
        internal.billing.acquireManagedExecutionInternal,
        executionArgs,
      ),
    ).toEqual({
      leaseExpiresAt: 100 + MANAGED_EXECUTION_LEASE_MS,
      hardExpiresAt: 100 + MANAGED_EXECUTION_HARD_MS,
      quiescentAfterAt:
        100 + MANAGED_EXECUTION_LEASE_MS + MANAGED_EXECUTION_QUIESCENCE_MS,
    });
    const purge = await beginReset(t, ownerId, "managed-tool-execution-reset");
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, ownerId, mode: "reset", now: 1_002 },
      ),
    ).toEqual({
      ready: false,
      pending: ["billing_managed_execution_leases"],
    });
    await expect(
      t.mutation(internal.billing.heartbeatManagedExecutionInternal, {
        ...executionArgs,
        now: 1_003,
      }),
    ).rejects.toThrow(/reset|account data/iu);
    expect(
      await t.mutation(internal.billing.settleManagedExecutionInternal, {
        ...executionArgs,
        outcome: "aborted",
        now: 1_004,
      }),
    ).toBe(true);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...purge, ownerId, mode: "reset", now: 1_005 },
      ),
    ).toEqual({ ready: true, pending: [] });
  });

  it("rejects claims for both source and active destination migrations", async () => {
    const t = createTest();
    const sourceOwnerId = "managed-dispatch-migration-source";
    const destinationOwnerId = "managed-dispatch-migration-destination";
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: sourceOwnerId,
        toOwnerId: destinationOwnerId,
        status: "running",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        attemptArgs(sourceOwnerId, "source-migration"),
      ),
    ).rejects.toThrow(/linked to an account|ownership_migrated/iu);
    await expect(
      t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        attemptArgs(destinationOwnerId, "destination-migration"),
      ),
    ).rejects.toThrow(/moving|migrat/iu);
  });
});
