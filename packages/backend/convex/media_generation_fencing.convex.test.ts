/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "10",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reopenOwnerAfterReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  nextGeneration: string,
  duringReset?: () => Promise<void>,
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
  await duringReset?.();
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
  return nextGeneration;
};

const createJob = async (
  t: ReturnType<typeof createTest>,
  args: { ownerId: string; ownerGeneration: string; jobId: string },
) =>
  await t.mutation(internal.media_jobs.createJob, {
    ...args,
    capability: "text_to_image",
    profile: "best",
    provider: "fal",
    endpointId: "fal-ai/flux/dev",
    request: { prompt: args.jobId },
  });

const billing = {
  endpointId: "fal-ai/flux/dev",
  billingUnit: "image" as const,
  unitPriceUsd: 0.01,
  quantity: 1,
  costMicroCents: 1_000_000,
  meteredFrom: "output" as const,
};

describe("media owner-generation fencing", () => {
  it("records the named no-provider exemption before any physical dispatch", async () => {
    const t = createTest();
    const ownerId = "media-explicit-no-provider-owner";
    const jobId = "media-explicit-no-provider-job";
    await createJob(t, { ownerId, ownerGeneration: "legacy", jobId });

    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique(),
      ),
    ).toMatchObject({
      billingDispositionState: "not_chargeable",
      billingDispositionPolicy: "no_stella_paid_provider_dispatch",
    });

    await expect(
      t.mutation(internal.media_jobs.markGenerated, {
        jobId,
        ownerGeneration: "legacy",
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/local-only.png" }] },
      }),
    ).resolves.toEqual({
      applied: true,
      billingDisposition: "not_chargeable",
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").collect(),
      ),
    ).toEqual([]);
  });

  it("restores a named no-charge disposition when the provider call never starts", async () => {
    const t = createTest();
    const ownerId = "media-provider-not-started-owner";
    const ownerGeneration = "legacy";
    const jobId = "media-provider-not-started-job";
    const dispatchId = "media:test-provider-not-started";
    const attemptId = "media-test-provider-not-started-attempt";
    const admittedAt = Date.now();
    await createJob(t, { ownerId, ownerGeneration, jobId });
    await t.mutation(internal.media_jobs.reserveMediaProviderDispatchInternal, {
      ownerId,
      ownerGeneration,
      dispatchId,
      attemptId,
      kind: "openrouter",
      jobId,
      now: admittedAt,
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique(),
      ),
    ).toMatchObject({
      billingDispositionState: "pending",
      billingDispositionAttemptId: attemptId,
    });

    await expect(
      t.mutation(internal.media_jobs.settleMediaProviderDispatchInternal, {
        ownerId,
        ownerGeneration,
        dispatchId,
        attemptId,
        providerStarted: false,
      }),
    ).resolves.toBe(true);
    await t.mutation(internal.media_jobs.markSubmissionFailed, {
      jobId,
      ownerGeneration,
      upstreamStatus: "DISPATCH_NOT_STARTED",
      error: { message: "Provider dispatch was fenced before fetch." },
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique(),
      ),
    ).toMatchObject({
      status: "failed",
      billingDispositionState: "not_chargeable",
      billingDispositionPolicy: "provider_call_not_started",
    });
    await expect(
      t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).resolves.toEqual([]);
  });

  it("preserves the named BYO-key exemption across a completed provider attempt", async () => {
    const t = createTest();
    const ownerId = "media-byo-key-owner";
    const ownerGeneration = "legacy";
    const jobId = "media-byo-key-job";
    const dispatchId = "media:google_lyria:byo-key-test";
    const attemptId = "media-byo-key-attempt";
    const admittedAt = Date.now();
    await t.mutation(internal.media_jobs.createJob, {
      ownerId,
      ownerGeneration,
      jobId,
      capability: "music_generation",
      profile: "lyria-3-pro-preview",
      provider: "google_lyria",
      endpointId: "google/lyria-3-pro-preview",
      request: {},
    });
    await t.mutation(
      internal.media_jobs.markJobUserProvidedKeyNotChargeableInternal,
      { jobId, ownerGeneration, markedAt: admittedAt },
    );
    await t.mutation(internal.media_jobs.reserveMediaProviderDispatchInternal, {
      ownerId,
      ownerGeneration,
      dispatchId,
      attemptId,
      kind: "google_lyria",
      jobId,
      now: admittedAt + 1,
    });
    await expect(
      t.mutation(internal.media_jobs.markGenerated, {
        jobId,
        ownerGeneration,
        upstreamStatus: "OK",
        output: { audio: { mimeType: "audio/wav", streamedToCaller: true } },
      }),
    ).resolves.toEqual({
      applied: true,
      billingDisposition: "not_chargeable",
    });
    await t.mutation(internal.media_jobs.settleMediaProviderDispatchInternal, {
      ownerId,
      ownerGeneration,
      dispatchId,
      attemptId,
      providerStarted: true,
    });

    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique(),
      ),
    ).toMatchObject({
      status: "succeeded",
      billingDispositionState: "not_chargeable",
      billingDispositionPolicy: "user_provided_provider_key_not_chargeable",
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").collect(),
      ),
    ).toEqual([]);
    await expect(
      t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).resolves.toEqual([]);
  });

  it("rejects paid success without valid billing and blocks purge until receipt reconciliation", async () => {
    const t = createTest();
    const ownerId = "media-billing-disposition-debt-owner";
    const ownerGeneration = "legacy";
    const admittedAt = Date.now();
    const jobs = [
      {
        jobId: "media-missing-billing-job",
        completionBilling: undefined,
      },
      {
        jobId: "media-unsupported-billing-job",
        completionBilling: {
          ...billing,
          endpointId: "unsupported/provider-endpoint",
        },
      },
    ] as const;

    for (const [index, entry] of jobs.entries()) {
      await createJob(t, {
        ownerId,
        ownerGeneration,
        jobId: entry.jobId,
      });
      const dispatchId = `media:test-billing:${entry.jobId}`;
      const attemptId = `attempt-${index}`;
      await expect(
        t.mutation(internal.media_jobs.reserveMediaProviderDispatchInternal, {
          ownerId,
          ownerGeneration,
          dispatchId,
          attemptId,
          kind: "fal_download",
          jobId: entry.jobId,
          now: admittedAt + index,
        }),
      ).resolves.toMatchObject({ acquired: true, status: "reserved" });
      await expect(
        t.mutation(internal.media_jobs.settleMediaProviderDispatchInternal, {
          ownerId,
          ownerGeneration,
          dispatchId,
          attemptId,
          providerStarted: true,
        }),
      ).resolves.toBe(true);
      await expect(
        t.mutation(internal.media_jobs.markGenerated, {
          jobId: entry.jobId,
          ownerGeneration,
          upstreamStatus: "OK",
          output: {
            images: [{ url: `https://example.test/${entry.jobId}.png` }],
          },
          ...(entry.completionBilling
            ? { billing: entry.completionBilling }
            : {}),
        }),
      ).resolves.toEqual({
        applied: true,
        billingDisposition: "unknown",
      });
    }

    const beforePurge = await t.run(async (ctx) => ({
      jobs: await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
      receipts: await ctx.db.query("billing_media_usage_receipts").collect(),
    }));
    expect(beforePurge.jobs).toHaveLength(2);
    expect(beforePurge.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: jobs[0].jobId,
          status: "unknown",
          upstreamStatus: "BILLING_DISPOSITION_UNKNOWN",
          billingDispositionState: "unknown",
        }),
        expect.objectContaining({
          jobId: jobs[1].jobId,
          status: "unknown",
          upstreamStatus: "BILLING_DISPOSITION_UNKNOWN",
          billingDispositionState: "unknown",
        }),
      ]),
    );
    expect(
      beforePurge.jobs.every(
        (job) => job.connectorMediaDeliveryScheduledAt === undefined,
      ),
    ).toBe(true);
    expect(beforePurge.receipts).toEqual([]);

    const purgeAt = admittedAt + 100;
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: "media-billing-debt-reset",
        mode: "reset",
        now: purgeAt,
      },
    );
    const leaseId = "media-billing-debt-core-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: purgeAt + 1,
    });
    const blocked = await t.mutation(
      internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
      {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId,
        mode: "reset",
        now: purgeAt + 2,
      },
    );
    expect(blocked.ready).toBe(false);
    expect(blocked.pending).toEqual(
      expect.arrayContaining([
        `media_billing_unknown:${jobs[0].jobId}`,
        `media_billing_unknown:${jobs[1].jobId}`,
      ]),
    );
    await expect(
      t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).resolves.toContain("media_billing_disposition_debt");

    for (const [index, entry] of jobs.entries()) {
      await expect(
        t.mutation(
          internal.media_jobs.finalizeMediaBillingDispositionInternal,
          {
            jobId: entry.jobId,
            ownerGeneration,
            billing,
            finalizedAt: purgeAt + 10 + index,
          },
        ),
      ).resolves.toEqual({ finalized: true, duplicate: false });
    }
    await expect(
      t.mutation(
        internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
        {
          ownerId,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId,
          mode: "reset",
          now: purgeAt + 20,
        },
      ),
    ).resolves.toMatchObject({ ready: true, pending: [] });
    await expect(
      t.query(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId },
      ),
    ).resolves.toEqual([]);

    const reconciled = await t.run(async (ctx) => ({
      jobs: await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
      receipts: await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    }));
    expect(reconciled.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: jobs[0].jobId,
          status: "unknown",
          billingDispositionState: "billed",
        }),
        expect.objectContaining({
          jobId: jobs[1].jobId,
          status: "unknown",
          billingDispositionState: "billed",
        }),
      ]),
    );
    expect(
      reconciled.jobs.every(
        (job) => job.connectorMediaDeliveryScheduledAt === undefined,
      ),
    ).toBe(true);
    expect(reconciled.receipts).toHaveLength(2);
  });





  it("cannot apply a stale completion to a same-id job in the reopened generation", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const ownerId = "media-completion-generation-owner";
    const jobId = "same-logical-media-job";
    await createJob(t, { ownerId, ownerGeneration: "legacy", jobId });

    const currentGeneration = await reopenOwnerAfterReset(
      t,
      ownerId,
      "reopened-media-completion",
      async () => {
        await t.run(async (ctx) => {
          const old = await ctx.db
            .query("media_jobs")
            .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
            .unique();
          if (old) await ctx.db.delete(old._id);
        });
      },
    );
    await createJob(t, { ownerId, ownerGeneration: currentGeneration, jobId });

    await expect(
      t.mutation(internal.media_jobs.markGenerated, {
        jobId,
        ownerGeneration: "legacy",
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/stale.png" }] },
        billing,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    await expect(
      t.mutation(internal.media_jobs.applyFalWebhook, {
        jobId,
        ownerGeneration: "legacy",
        dedupKey: "stale-webhook",
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/stale.png" }] },
        billing,
        receivedAt: 20_000,
      }),
    ).resolves.toMatchObject({ updated: false, staleGeneration: true });

    expect(
      await t.run(async (ctx) => ({
        job: await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique(),
        events: await ctx.db.query("media_webhook_events").collect(),
        logs: await ctx.db.query("media_job_logs").collect(),
        receipts: await ctx.db.query("billing_media_usage_receipts").collect(),
      })),
    ).toMatchObject({
      job: { status: "queued", ownerGeneration: currentGeneration },
      events: [],
      logs: [],
      receipts: [],
    });

    await t.mutation(internal.media_jobs.markGenerated, {
      jobId,
      ownerGeneration: currentGeneration,
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/current.png" }] },
      billing,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_media_usage_receipts").unique(),
      ),
    ).toMatchObject({ ownerGeneration: currentGeneration, jobId });
  });

  it("uses the row generation as the final durable Fal dispatch claim", async () => {
    const t = createTest();
    const ownerId = "media-claim-generation-owner";
    const currentGeneration = await reopenOwnerAfterReset(
      t,
      ownerId,
      "reopened-media-claim",
    );
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["encrypted"])),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("media_jobs", {
        ownerId,
        ownerGeneration: currentGeneration,
        jobId: "generation-claim-job",
        clientRequestKey: "generation-claim-key",
        clientRequestHash: "generation-claim-hash",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "claim" },
        submissionState: "pending",
        submissionPayloadStorageId: storageId,
        status: "queued",
        upstreamStatus: "IN_QUEUE",
        queuePosition: null,
        createdAt: 20_000,
        updatedAt: 20_000,
      });
    });

    await expect(
      t.mutation(internal.media_jobs.claimImageSubmission, {
        jobId: "generation-claim-job",
        ownerGeneration: "legacy",
        attemptId: "stale-attempt",
        claimedAt: 20_001,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    expect(
      await t.mutation(internal.media_jobs.claimImageSubmission, {
        jobId: "generation-claim-job",
        ownerGeneration: currentGeneration,
        attemptId: "current-attempt",
        claimedAt: 20_002,
      }),
    ).toMatchObject({
      state: "claimed",
      ownerId,
      ownerGeneration: currentGeneration,
    });
  });

  it("makes generation-oblivious media watchdogs skip stale residual rows", async () => {
    const t = createTest();
    const ownerId = "media-watchdog-generation-owner";
    await t.run(async (ctx) => {
      const base = {
        ownerId,
        ownerGeneration: "legacy",
        capability: "text_to_image" as const,
        profile: "best",
        provider: "fal" as const,
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "stale watchdog" },
        queuePosition: null,
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.db.insert("media_jobs", {
        ...base,
        jobId: "stale-pending-watchdog",
        submissionState: "pending",
        submissionPayloadStorageId: await ctx.storage.store(
          new Blob(["encrypted"]),
        ),
        status: "queued",
        upstreamStatus: "IN_QUEUE",
      });
      await ctx.db.insert("media_jobs", {
        ...base,
        jobId: "stale-submitted-watchdog",
        submissionState: "submitted",
        status: "running",
        upstreamStatus: "IN_PROGRESS",
      });
      await ctx.db.insert("media_jobs", {
        ...base,
        jobId: "stale-connector-watchdog",
        connectorRequestId: "connector-request",
        connectorMediaDeliveryScheduledAt: 1,
        connectorMediaDeliveryAttempts: 1,
        output: { images: [{ url: "https://example.test/image.png" }] },
        status: "succeeded",
        upstreamStatus: "OK",
        completedAt: 1,
      });
    });
    await reopenOwnerAfterReset(t, ownerId, "reopened-media-watchdog");

    await expect(
      t.mutation(internal.media_jobs.reconcilePendingImageSubmissions, {
        pendingBefore: 100,
        dispatchBefore: 100,
        unknownBefore: 100,
      }),
    ).resolves.toEqual({ rescheduled: 0, terminalUnknown: 0, abandoned: 0 });
    await expect(
      t.mutation(internal.media_jobs.markStaleJobsFailed, { cutoffMs: 100 }),
    ).resolves.toEqual({ updated: 0 });
    await expect(
      t.mutation(internal.media_jobs.retryStuckImageConnectorDeliveries, {
        staleMs: -1,
      }),
    ).resolves.toEqual({ retried: 0, abandoned: 0 });

    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("media_jobs").collect()).map((row) => ({
        jobId: row.jobId,
        status: row.status,
        submissionState: row.submissionState,
        attempts: row.connectorMediaDeliveryAttempts,
      })),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "stale-pending-watchdog",
          status: "queued",
          submissionState: "pending",
        }),
        expect.objectContaining({
          jobId: "stale-submitted-watchdog",
          status: "running",
          submissionState: "submitted",
        }),
        expect.objectContaining({
          jobId: "stale-connector-watchdog",
          status: "succeeded",
          attempts: 1,
        }),
      ]),
    );
  });

  it("does not deliver delayed connector media after source ownership migration", async () => {
    const t = createTest();
    const ownerId = "media-connector-migration-source";
    const targetOwnerId = "media-connector-migration-target";
    const requestId = "media-connector-migration-request";
    const jobId = "media-connector-migration-job";
    const lifecycle = await t.query(
      internal.owner_lifecycle.getOwnerDataAccessStateInternal,
      { ownerId },
    );
    const ownerGeneration = lifecycle.generation;
    await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        ownerId,
        isDefault: false,
        eventCount: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("events", {
        conversationId,
        timestamp: 1,
        type: "remote_turn_request",
        requestId,
        ownerId,
        ownerGeneration,
        ownerBindingState: "bound",
        requestState: "fulfilled",
        fulfilledAt: 2,
        payload: {
          provider: "telegram",
          deliveryMeta: { chatId: "test-chat" },
        },
      });
      await ctx.db.insert("media_jobs", {
        ownerId,
        ownerGeneration,
        jobId,
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "migration-fenced connector delivery" },
        connectorRequestId: requestId,
        connectorMediaDeliveryScheduledAt: 2,
        connectorMediaDeliveryAttempts: 1,
        output: { images: [{ url: "https://example.test/image.png" }] },
        status: "succeeded",
        upstreamStatus: "OK",
        queuePosition: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      });
    });

    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId: ownerId,
      toOwnerId: targetOwnerId,
    });
    const claim = await t.mutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        fromOwnerId: ownerId,
        toOwnerId: targetOwnerId,
        leaseId: "media-connector-migration-lease",
        now: 30_000,
      },
    );
    expect(claim.claimed).toBe(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connector provider I/O must not run"));

    await expect(
      t.action(
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          ownerId,
          ownerGeneration,
          requestId,
          jobId,
          output: { images: [{ url: "https://example.test/image.png" }] },
        },
      ),
    ).rejects.toThrow(/linked to an account/u);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique();
        return {
          deliveredAt: row?.connectorMediaDeliveredAt,
          deliveryError: row?.connectorMediaDeliveryError,
        };
      }),
    ).toEqual({ deliveredAt: undefined, deliveryError: undefined });
  });

  it("does not deliver delayed connector media into an active migration target", async () => {
    const t = createTest();
    const sourceOwnerId = "media-connector-incoming-source";
    const ownerId = "media-connector-incoming-target";
    const requestId = "media-connector-incoming-request";
    const jobId = "media-connector-incoming-job";
    const lifecycle = await t.query(
      internal.owner_lifecycle.getOwnerDataAccessStateInternal,
      { ownerId },
    );
    const ownerGeneration = lifecycle.generation;
    await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        ownerId,
        isDefault: false,
        eventCount: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("events", {
        conversationId,
        timestamp: 1,
        type: "remote_turn_request",
        requestId,
        ownerId,
        ownerGeneration,
        ownerBindingState: "bound",
        requestState: "fulfilled",
        fulfilledAt: 2,
        payload: {
          provider: "telegram",
          deliveryMeta: { chatId: "incoming-test-chat" },
        },
      });
      await ctx.db.insert("media_jobs", {
        ownerId,
        ownerGeneration,
        jobId,
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "incoming migration connector delivery" },
        connectorRequestId: requestId,
        connectorMediaDeliveryScheduledAt: 2,
        connectorMediaDeliveryAttempts: 1,
        output: { images: [{ url: "https://example.test/incoming.png" }] },
        status: "succeeded",
        upstreamStatus: "OK",
        queuePosition: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      });
    });

    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId: sourceOwnerId,
      toOwnerId: ownerId,
    });
    const claim = await t.mutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        fromOwnerId: sourceOwnerId,
        toOwnerId: ownerId,
        leaseId: "media-connector-incoming-lease",
        now: 40_000,
      },
    );
    expect(claim.claimed).toBe(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connector provider I/O must not run"));

    await expect(
      t.action(
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          ownerId,
          ownerGeneration,
          requestId,
          jobId,
          output: { images: [{ url: "https://example.test/incoming.png" }] },
        },
      ),
    ).rejects.toThrow(/linked to an account/u);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .unique();
        return {
          deliveredAt: row?.connectorMediaDeliveredAt,
          deliveryError: row?.connectorMediaDeliveryError,
        };
      }),
    ).toEqual({ deliveredAt: undefined, deliveryError: undefined });
  });

});
