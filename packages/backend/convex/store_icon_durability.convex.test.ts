/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

beforeAll(() => {
  const values: Record<string, string> = {
    CONVEX_SITE_URL: "https://stella.test",
    FAL_KEY: "test-fal-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "10",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_SECRETS_MASTER_KEYS_JSON: JSON.stringify({
      "1": Buffer.alloc(32, 9).toString("base64"),
    }),
    STELLA_SECRETS_MASTER_KEY_VERSION: "1",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const iconArgs = (
  ownerId: string,
  ownerGeneration = "legacy",
  packageId = "durable-store-package",
) => ({
  ownerId,
  ownerGeneration,
  packageId,
  displayName: "Durable Store App",
  description: "A focused productivity companion",
  category: "productivity" as const,
});

const iconBilling = {
  endpointId: "fal-ai/flux-2/turbo",
  billingUnit: "request" as const,
  unitPriceUsd: 0.003146,
  quantity: 1,
  costMicroCents: 314_600,
  meteredFrom: "request" as const,
  note: "Fixed 512x512 icon generation request.",
};

const reopenOwnerAfterReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  nextGeneration: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `reset-${ownerId}`,
      mode: "reset",
      now: 10_000,
    },
  );
  const coreLeaseId = `core-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: coreLeaseId,
    now: 10_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: coreLeaseId,
    stage: "core",
    nextStage: "cloud",
    now: 10_002,
  });
  const cloudLeaseId = `cloud-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: cloudLeaseId,
    now: 10_003,
  });
  await t.run(async (ctx) => {
    await seedReadyPurgeBackupSweep(ctx, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      now: 10_004,
    });
  });
  expect(
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration,
      now: 10_004,
    }),
  ).toBe(true);
};

describe("durable Store auto-icon generation", () => {
  it("reattaches after a lost Fal response, reconciles by webhook, and bills exactly once", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const args = iconArgs("store-icon-response-loss-owner");
    let submissions = 0;
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (
          String(input).includes("queue.fal.run") &&
          init?.method === "POST"
        ) {
          submissions += 1;
          expect(String(input)).toContain(
            "fal_webhook=https%3A%2F%2Fstella.test%2Fapi%2Fmedia%2Fv1%2Fwebhooks%2Ffal",
          );
          throw new Error("connection reset after request send");
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      });

    const reserved = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      args,
    );
    expect(reserved?.jobId).toMatch(/^store_icon_/u);
    await t.action(internal.media_image_submission.submitReservedImageJob, {
      jobId: reserved!.jobId,
      ownerGeneration: args.ownerGeneration,
    });
    expect(submissions).toBe(1);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", reserved!.jobId))
          .unique(),
      ),
    ).toMatchObject({
      capability: "icon",
      endpointId: iconBilling.endpointId,
      ownerGeneration: args.ownerGeneration,
      submissionState: "unknown",
      error: { code: "SUBMISSION_OUTCOME_UNKNOWN" },
    });

    expect(
      await t.action(internal.lib.store_icon.reserveStoreIconJob, args),
    ).toEqual(reserved);
    await t.action(internal.media_image_submission.submitReservedImageJob, {
      jobId: reserved!.jobId,
      ownerGeneration: args.ownerGeneration,
    });
    expect(submissions).toBe(1);

    const output = {
      images: [{ url: "https://images.example.test/reconciled-icon.png" }],
    };
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        ownerGeneration: args.ownerGeneration,
        dedupKey: "store-icon-response-loss-webhook",
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-response-lost",
        upstreamStatus: "OK",
        output,
        billing: iconBilling,
        receivedAt: Date.now(),
      }),
    ).toMatchObject({ updated: true, jobId: reserved!.jobId });
    const atomicDisposition = await t.run(async (ctx) => ({
      receipt: await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_jobId", (q) =>
          q.eq("ownerId", args.ownerId).eq("jobId", reserved!.jobId),
        )
        .unique(),
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      providerAttempts: await ctx.db
        .query("media_provider_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .collect(),
    }));
    expect(atomicDisposition).toMatchObject({
      receipt: {
        ownerGeneration: args.ownerGeneration,
        jobId: reserved!.jobId,
        costMicroCents: iconBilling.costMicroCents,
      },
      usage: {
        totalUsageMicroCents: iconBilling.costMicroCents,
        totalRequestCount: 1,
      },
      providerAttempts: [],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      await t.action(internal.lib.store_icon.generateStoreIcon, args),
    ).toEqual({
      jobId: reserved!.jobId,
      iconUrl: "https://images.example.test/reconciled-icon.png",
    });
    expect(submissions).toBe(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").collect(),
      ),
    ).toEqual([
      expect.objectContaining({
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-response-lost",
        endpointId: iconBilling.endpointId,
        costMicroCents: iconBilling.costMicroCents,
      }),
    ]);
  });

  it("rejects a stale Store icon dispatch after reset/reopen while the new generation can reserve", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const ownerId = "store-icon-reset-owner";
    const staleArgs = iconArgs(ownerId);
    const stale = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      staleArgs,
    );
    await reopenOwnerAfterReset(t, ownerId, "store-icon-reopened-generation");
    const providerFetch = vi.spyOn(globalThis, "fetch");

    await expect(
      t.action(internal.media_image_submission.submitReservedImageJob, {
        jobId: stale!.jobId,
        ownerGeneration: staleArgs.ownerGeneration,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    expect(providerFetch).not.toHaveBeenCalled();

    const current = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      iconArgs(ownerId, "store-icon-reopened-generation"),
    );
    expect(current?.jobId).toMatch(/^store_icon_/u);
    expect(current?.jobId).not.toBe(stale?.jobId);
  });

  it("retains an accepted provider locator and cancellation debt when delete wins during POST", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const args = iconArgs("store-icon-delete-owner");
    const reserved = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      args,
    );
    let releasePost!: (response: Response) => void;
    let postStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    const pendingPost = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    let cancelAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("queue.fal.run") && init?.method === "POST") {
        postStarted();
        return await pendingPost;
      }
      if (String(input).endsWith("/cancel") && init?.method === "PUT") {
        cancelAttempts += 1;
        throw new Error("ambiguous cancellation response");
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const submission = t.action(
      internal.media_image_submission.submitReservedImageJob,
      {
        jobId: reserved!.jobId,
        ownerGeneration: args.ownerGeneration,
      },
    );
    await started;
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: args.ownerId,
        operationId: "delete-store-icon-owner",
        mode: "delete",
        now: 20_000,
      },
    );
    await t.mutation(internal.media_jobs.beginOwnerMediaPurge, {
      ownerId: args.ownerId,
      startedAt: 20_001,
    });
    await t.mutation(internal.account_deletion._deleteExtraTableBatch, {
      ownerId: args.ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      table: "media_jobs",
    });
    releasePost(
      new Response(
        JSON.stringify({
          request_id: "fal-store-icon-delete-race",
          response_url:
            "https://queue.fal.run/fal-ai/flux-2/turbo/requests/delete-race",
          status_url:
            "https://queue.fal.run/fal-ai/flux-2/turbo/requests/delete-race/status",
          status: "IN_QUEUE",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await submission;

    expect(cancelAttempts).toBe(1);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", reserved!.jobId))
          .unique(),
      ),
    ).toMatchObject({
      status: "canceled",
      submissionState: "canceled",
      upstreamStatus: "OWNER_PURGED",
      providerRequestId: "fal-store-icon-delete-race",
      error: { code: "OWNER_PURGED" },
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_provider_cancellations")
          .withIndex("by_jobId", (q) => q.eq("jobId", reserved!.jobId))
          .unique(),
      ),
    ).toMatchObject({
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: reserved!.jobId,
      providerRequestId: "fal-store-icon-delete-race",
      attempts: 1,
      lastError: "ambiguous cancellation response",
    });
  });

  it("keeps reset non-quiescent across a hanging POST, locator handoff, and exact cancellation ACK", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const ownerId = "store-icon-reset-inflight-owner";
    const args = iconArgs(ownerId);
    const reserved = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      args,
    );
    let releasePost!: (response: Response) => void;
    let postStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    const pendingPost = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    let cancellationFails = true;
    let cancelAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("queue.fal.run") && init?.method === "POST") {
        postStarted();
        return await pendingPost;
      }
      if (String(input).endsWith("/cancel") && init?.method === "PUT") {
        cancelAttempts += 1;
        if (cancellationFails) throw new Error("cancel ACK was lost");
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const submission = t.action(
      internal.media_image_submission.submitReservedImageJob,
      {
        jobId: reserved!.jobId,
        ownerGeneration: args.ownerGeneration,
      },
    );
    await started;

    const now = Date.now();
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: "reset-store-icon-inflight",
        mode: "reset",
        now,
      },
    );
    const coreLeaseId = "reset-store-icon-inflight-core";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId: coreLeaseId,
      now: now + 1,
    });
    const whilePostHangs = await t.mutation(
      internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
      {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: coreLeaseId,
        mode: "reset",
        now: now + 2,
      },
    );
    expect(whilePostHangs).toMatchObject({ ready: false, canceled: 1 });
    expect(whilePostHangs.pending).toEqual(
      expect.arrayContaining([
        expect.stringContaining("media_provider_debt:fal_submit"),
        expect.stringContaining("media_billing_pending"),
      ]),
    );
    expect(
      await t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).toContain("media_provider_dispatch_debt");

    releasePost(
      new Response(
        JSON.stringify({
          request_id: "fal-store-icon-reset-inflight",
          response_url:
            "https://queue.fal.run/fal-ai/flux-2/turbo/requests/reset-inflight",
          status: "IN_QUEUE",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await submission;
    expect(cancelAttempts).toBe(1);

    const cancellation = await t.run(async (ctx) =>
      ctx.db
        .query("media_provider_cancellations")
        .withIndex("by_jobId", (q) => q.eq("jobId", reserved!.jobId))
        .unique(),
    );
    expect(cancellation).toMatchObject({
      ownerId,
      ownerGeneration: args.ownerGeneration,
      providerRequestId: "fal-store-icon-reset-inflight",
      attempts: 1,
      lastError: "cancel ACK was lost",
    });
    expect(
      await t.mutation(
        internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
        {
          ownerId,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: coreLeaseId,
          mode: "reset",
          now: now + 3,
        },
      ),
    ).toMatchObject({
      ready: false,
      pending: [expect.stringContaining("media_provider_cancel_debt")],
    });

    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        ownerGeneration: args.ownerGeneration,
        dedupKey: "store-icon-reset-inflight-late-webhook",
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-reset-inflight",
        upstreamStatus: "OK",
        output: {
          images: [{ url: "https://images.example.test/late-reset.png" }],
        },
        billing: iconBilling,
        receivedAt: now + 4,
      }),
    ).toMatchObject({ updated: false, jobId: reserved!.jobId });
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").collect(),
      ),
    ).toEqual([
      expect.objectContaining({
        ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-reset-inflight",
        costMicroCents: iconBilling.costMicroCents,
      }),
    ]);

    cancellationFails = false;
    vi.setSystemTime(cancellation!.nextAttemptAt);
    await t.action(
      internal.media_image_submission.cancelPurgedProviderRequest,
      { jobId: reserved!.jobId },
    );
    expect(cancelAttempts).toBe(2);
    const cancellationAckedAt = Date.now();
    expect(
      await t.mutation(
        internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
        {
          ownerId,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: coreLeaseId,
          mode: "reset",
          now: cancellationAckedAt,
        },
      ),
    ).toMatchObject({ ready: true, pending: [] });
    expect(
      await t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).toEqual([]);

    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: coreLeaseId,
      stage: "core",
      nextStage: "cloud",
      now: cancellationAckedAt + 1,
    });
    const cloudLeaseId = "reset-store-icon-inflight-cloud";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "cloud",
      leaseId: cloudLeaseId,
      now: cancellationAckedAt + 2,
    });
    await t.run(async (ctx) => {
      await seedReadyPurgeBackupSweep(ctx, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        now: cancellationAckedAt + 3,
      });
    });
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration: "store-icon-reset-inflight-reopened",
      now: cancellationAckedAt + 3,
    });
    const current = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      iconArgs(ownerId, "store-icon-reset-inflight-reopened"),
    );
    expect(current?.jobId).not.toBe(reserved?.jobId);
    expect(
      await t.run(async (ctx) => ({
        oldJob: await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", reserved!.jobId))
          .unique(),
        receipts: await ctx.db.query("billing_media_usage_receipts").collect(),
      })),
    ).toMatchObject({
      oldJob: {
        status: "canceled",
        ownerGeneration: args.ownerGeneration,
        providerRequestId: "fal-store-icon-reset-inflight",
      },
      receipts: [
        expect.objectContaining({
          ownerGeneration: args.ownerGeneration,
          jobId: reserved!.jobId,
          costMicroCents: iconBilling.costMicroCents,
        }),
      ],
    });
  });

  it("blocks delayed Store icon dispatch on both sides of an active ownership migration", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const sourceOwnerId = "store-icon-migration-source";
    const targetOwnerId = "store-icon-migration-target";
    const source = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      iconArgs(sourceOwnerId),
    );
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId: sourceOwnerId,
      toOwnerId: targetOwnerId,
    });
    expect(
      await t.mutation(internal.auth_migration.claimOwnershipMigration, {
        fromOwnerId: sourceOwnerId,
        toOwnerId: targetOwnerId,
        leaseId: "store-icon-source-migration-lease",
        now: 30_000,
      }),
    ).toMatchObject({ claimed: true });
    const providerFetch = vi.spyOn(globalThis, "fetch");
    await expect(
      t.action(internal.media_image_submission.submitReservedImageJob, {
        jobId: source!.jobId,
        ownerGeneration: "legacy",
      }),
    ).rejects.toThrow(/linked to an account/u);

    const incomingSourceOwnerId = "store-icon-incoming-source";
    const incomingTargetOwnerId = "store-icon-incoming-target";
    const target = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      iconArgs(incomingTargetOwnerId),
    );
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId: incomingSourceOwnerId,
      toOwnerId: incomingTargetOwnerId,
    });
    expect(
      await t.mutation(internal.auth_migration.claimOwnershipMigration, {
        fromOwnerId: incomingSourceOwnerId,
        toOwnerId: incomingTargetOwnerId,
        leaseId: "store-icon-target-migration-lease",
        now: 30_001,
      }),
    ).toMatchObject({ claimed: true });
    await expect(
      t.action(internal.media_image_submission.submitReservedImageJob, {
        jobId: target!.jobId,
        ownerGeneration: "legacy",
      }),
    ).rejects.toThrow(/linked to an account/u);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("uses the media timeout envelope and retains exactly one accepted-request receipt", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const args = iconArgs("store-icon-timeout-owner");
    const reserved = await t.action(
      internal.lib.store_icon.reserveStoreIconJob,
      args,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          request_id: "fal-store-icon-timeout",
          status: "IN_QUEUE",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await t.action(internal.media_image_submission.submitReservedImageJob, {
      jobId: reserved!.jobId,
      ownerGeneration: args.ownerGeneration,
    });
    expect(
      await t.mutation(internal.media_jobs.markStaleJobsFailed, {
        cutoffMs: Date.now() + 1,
      }),
    ).toEqual({ updated: 1 });
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        ownerGeneration: args.ownerGeneration,
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-timeout",
        upstreamStatus: "OK",
        output: {
          images: [{ url: "https://images.example.test/too-late.png" }],
        },
        billing: iconBilling,
        receivedAt: Date.now() + 2,
      }),
    ).toMatchObject({ updated: false, jobId: reserved!.jobId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").collect(),
      ),
    ).toEqual([
      expect.objectContaining({
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: reserved!.jobId,
        providerRequestId: "fal-store-icon-timeout",
        costMicroCents: iconBilling.costMicroCents,
      }),
    ]);
  });
});
