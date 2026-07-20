/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "media-owner",
    tokenIdentifier: "https://issuer.test|media-owner",
  });

const ensureMediaEnv = () => {
  const values: Record<string, string> = {
    FAL_KEY: "test-fal-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_PLUS_PRICE_CENTS: "3000",
    STELLA_ULTRA_PRICE_CENTS: "4000",
    STELLA_MAX_PRICE_CENTS: "5000",
    STELLA_SECRETS_MASTER_KEYS_JSON: JSON.stringify({
      "1": Buffer.alloc(32, 7).toString("base64"),
    }),
    STELLA_SECRETS_MASTER_KEY_VERSION: "1",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
};

const imageRequest = (prompt = "a durable image"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "stella-image-gen-v1-test-key",
  },
  body: JSON.stringify({ capability: "text_to_image", prompt }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("managed media idempotency and cancellation", () => {
  it("retains and retries the private-blob outbox across repeated deletion failures", async () => {
    const t = createTest();
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["encrypted-private-reference"])),
    );
    await t.mutation(internal.media_jobs.registerPrivateSubmissionBlob, {
      ownerId: "blob-retry-owner",
      storageId,
      createdAt: Date.now(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        t.action(internal.media_image_submission.deleteSubmissionPayload, {
          storageId,
          testFailDelete: true,
        }),
      ).rejects.toThrow("Injected private blob deletion failure");
    }
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("media_private_blob_cleanup")
            .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
            .unique(),
      ),
    ).toMatchObject({ attempts: 2, state: "pending" });
    expect(
      await t.run(async (ctx) => ctx.storage.getUrl(storageId)),
    ).not.toBeNull();

    await t.action(internal.media_image_submission.deleteSubmissionPayload, {
      storageId,
    });
    expect(
      await t.run(async (ctx) => ctx.storage.getUrl(storageId)),
    ).toBeNull();
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db.query("media_private_blob_cleanup").collect(),
      ),
    ).toEqual([]);
  });

  it("tracks and purges a crash after every private payload persistence step", async () => {
    const t = createTest();
    for (
      let crashAfterChunks = 0;
      crashAfterChunks <= 3;
      crashAfterChunks += 1
    ) {
      const ownerId = `chunk-crash-owner-${crashAfterChunks}`;
      const manifestId = `chunk-crash-manifest-${crashAfterChunks}`;
      expect(
        await t.mutation(internal.media_jobs.createPrivatePayloadManifest, {
          ownerId,
          manifestId,
          jobId: `chunk-crash-job-${crashAfterChunks}`,
          clientRequestKey: `chunk-crash-key-${crashAfterChunks}`,
          expectedChunks: 3,
          totalChars: 6,
          createdAt: Date.now(),
        }),
      ).toBe("created");
      for (let index = 0; index < crashAfterChunks; index += 1) {
        expect(
          await t.mutation(internal.media_jobs.appendPrivatePayloadChunk, {
            ownerId,
            manifestId,
            index,
            data: "xx",
            writtenAt: Date.now(),
          }),
        ).toBe("appended");
      }
      const tracked = await t.run(async (ctx) => ({
        manifest: await ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_manifestId", (q) => q.eq("manifestId", manifestId))
          .unique(),
        chunks: await ctx.db
          .query("media_private_payload_chunks")
          .withIndex("by_manifestId_and_index", (q) =>
            q.eq("manifestId", manifestId),
          )
          .collect(),
      }));
      expect(tracked.manifest).toMatchObject({
        ownerId,
        jobId: `chunk-crash-job-${crashAfterChunks}`,
        writtenChunks: crashAfterChunks,
      });
      expect(tracked.chunks).toHaveLength(crashAfterChunks);
      expect(
        tracked.chunks.every(
          (chunk) =>
            chunk.ownerId === ownerId &&
            chunk.jobId === `chunk-crash-job-${crashAfterChunks}`,
        ),
      ).toBe(true);

      await t.mutation(internal.media_jobs.beginOwnerMediaPurge, {
        ownerId,
        startedAt: Date.now(),
      });
      expect(
        await t.action(
          internal.media_image_submission.drainOwnerPrivatePayloadManifests,
          { ownerId },
        ),
      ).toEqual({ remaining: 0 });
    }
    expect(
      await t.run(async (ctx) => ({
        manifests: await ctx.db
          .query("media_private_payload_manifests")
          .collect(),
        chunks: await ctx.db.query("media_private_payload_chunks").collect(),
      })),
    ).toEqual({ manifests: [], chunks: [] });
  });

  it("rejects unregistered or incomplete chunks without creating an unowned payload", async () => {
    const t = createTest();
    await expect(
      t.mutation(internal.media_jobs.appendPrivatePayloadChunk, {
        ownerId: "missing-manifest-owner",
        manifestId: "missing-manifest",
        index: 0,
        data: "secret",
        writtenAt: Date.now(),
      }),
    ).rejects.toThrow("manifest is unavailable");
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("media_private_payload_chunks").collect(),
      ),
    ).toEqual([]);

    await t.mutation(internal.media_jobs.createPrivatePayloadManifest, {
      ownerId: "incomplete-owner",
      manifestId: "incomplete-manifest",
      jobId: "incomplete-job",
      clientRequestKey: "incomplete-key",
      expectedChunks: 2,
      totalChars: 4,
      createdAt: Date.now(),
    });
    await t.mutation(internal.media_jobs.appendPrivatePayloadChunk, {
      ownerId: "incomplete-owner",
      manifestId: "incomplete-manifest",
      index: 0,
      data: "xx",
      writtenAt: Date.now(),
    });
    await expect(
      t.mutation(internal.media_jobs.finalizePrivatePayloadManifest, {
        ownerId: "incomplete-owner",
        manifestId: "incomplete-manifest",
        finalizedAt: Date.now(),
      }),
    ).rejects.toThrow("upload is incomplete");
    await expect(
      t.mutation(internal.media_jobs.reserveIdempotentJob, {
        ownerId: "incomplete-owner",
        jobId: "incomplete-job",
        clientRequestKey: "incomplete-key",
        clientRequestHash: "incomplete-hash",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "redacted" },
        submissionPayloadManifestId: "incomplete-manifest",
      }),
    ).rejects.toThrow("manifest is not complete");
    expect(
      await t.run(async (ctx) => ctx.db.query("media_jobs").collect()),
    ).toEqual([]);
  });

  it("retries manifest cleanup after a crash between chunk deletion and manifest deletion", async () => {
    const t = createTest();
    await t.mutation(internal.media_jobs.createPrivatePayloadManifest, {
      ownerId: "cleanup-crash-owner",
      manifestId: "cleanup-crash-manifest",
      jobId: "cleanup-crash-job",
      clientRequestKey: "cleanup-crash-key",
      expectedChunks: 2,
      totalChars: 4,
      createdAt: Date.now(),
    });
    for (let index = 0; index < 2; index += 1) {
      await t.mutation(internal.media_jobs.appendPrivatePayloadChunk, {
        ownerId: "cleanup-crash-owner",
        manifestId: "cleanup-crash-manifest",
        index,
        data: "xx",
        writtenAt: Date.now(),
      });
    }
    await t.mutation(internal.media_jobs.finalizePrivatePayloadManifest, {
      ownerId: "cleanup-crash-owner",
      manifestId: "cleanup-crash-manifest",
      finalizedAt: Date.now(),
    });
    await expect(
      t.action(internal.media_image_submission.deletePrivatePayloadManifest, {
        manifestId: "cleanup-crash-manifest",
        testCrashAfterBatches: 1,
      }),
    ).rejects.toThrow("Injected private payload cleanup crash");
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("media_private_payload_manifests").unique(),
      ),
    ).not.toBeNull();
    await t.action(
      internal.media_image_submission.deletePrivatePayloadManifest,
      { manifestId: "cleanup-crash-manifest" },
    );
    expect(
      await t.run(async (ctx) => ({
        manifests: await ctx.db
          .query("media_private_payload_manifests")
          .collect(),
        chunks: await ctx.db.query("media_private_payload_chunks").collect(),
      })),
    ).toEqual({ manifests: [], chunks: [] });
  });

  it("purges a complete manifest atomically attached to an account job", async () => {
    const t = createTest();
    const ownerId = "attached-manifest-owner";
    const manifestId = "attached-manifest";
    const jobId = "attached-manifest-job";
    const clientRequestKey = "attached-manifest-key";
    await t.mutation(internal.media_jobs.createPrivatePayloadManifest, {
      ownerId,
      manifestId,
      jobId,
      clientRequestKey,
      expectedChunks: 1,
      totalChars: 7,
      createdAt: Date.now(),
    });
    await t.mutation(internal.media_jobs.appendPrivatePayloadChunk, {
      ownerId,
      manifestId,
      index: 0,
      data: "private",
      writtenAt: Date.now(),
    });
    await t.mutation(internal.media_jobs.finalizePrivatePayloadManifest, {
      ownerId,
      manifestId,
      finalizedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.media_jobs.reserveIdempotentJob, {
        ownerId,
        jobId,
        clientRequestKey,
        clientRequestHash: "attached-manifest-hash",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "private Fashion reference" },
        submissionPayloadManifestId: manifestId,
      }),
    ).resolves.toMatchObject({ state: "created", jobId });

    await t.mutation(internal.media_jobs.beginOwnerMediaPurge, {
      ownerId,
      startedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.account_deletion._deleteExtraTableBatch, {
        ownerId,
        table: "media_jobs",
      }),
    ).resolves.toEqual({ hasMore: true });
    await expect(
      t.action(
        internal.media_image_submission.drainOwnerPrivatePayloadManifests,
        { ownerId },
      ),
    ).resolves.toEqual({ remaining: 0 });
    expect(
      await t.run(async (ctx) => ({
        jobs: await ctx.db.query("media_jobs").collect(),
        manifests: await ctx.db
          .query("media_private_payload_manifests")
          .collect(),
        chunks: await ctx.db.query("media_private_payload_chunks").collect(),
      })),
    ).toEqual({ jobs: [], manifests: [], chunks: [] });
  });

  it("atomically gates reservation and pending dispatch once media purge begins", async () => {
    const t = createTest();
    await t.mutation(internal.media_jobs.beginOwnerMediaPurge, {
      ownerId: "purged-media-owner",
      startedAt: Date.now(),
    });
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["encrypted-after-purge"])),
    );
    expect(
      await t.mutation(internal.media_jobs.registerPrivateSubmissionBlob, {
        ownerId: "purged-media-owner",
        storageId,
        createdAt: Date.now(),
      }),
    ).toBe("owner_purged");
    expect(
      await t.mutation(internal.media_jobs.reserveIdempotentJob, {
        ownerId: "purged-media-owner",
        jobId: "must-not-exist",
        clientRequestKey: "purged-request",
        clientRequestHash: "purged-hash",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "blocked" },
        submissionPayloadStorageId: storageId,
      }),
    ).toEqual({ state: "owner_purged" });
    expect(
      await t.run(async (ctx) => await ctx.db.query("media_jobs").collect()),
    ).toEqual([]);
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db.query("media_private_blob_cleanup").collect(),
      ),
    ).toEqual([expect.objectContaining({ state: "pending", storageId })]);
  });

  it("transactionally cleans pending and dispatching payload blobs during account deletion", async () => {
    ensureMediaEnv();
    vi.useFakeTimers();
    try {
      const t = createTest();
      const [pendingStorageId, dispatchingStorageId] = await t.run(
        async (ctx) =>
          await Promise.all([
            ctx.storage.store(new Blob(["pending-encrypted-reference"])),
            ctx.storage.store(new Blob(["dispatching-encrypted-reference"])),
          ]),
      );
      await t.run(async (ctx) => {
        const now = Date.now();
        for (const [index, submission] of [
          [0, { state: "pending" as const, storageId: pendingStorageId }],
          [
            1,
            { state: "dispatching" as const, storageId: dispatchingStorageId },
          ],
        ] as const) {
          await ctx.db.insert("media_jobs", {
            ownerId: "account-delete-media-owner",
            jobId: `account-delete-media-${index}`,
            capability: "text_to_image",
            profile: "best",
            provider: "fal",
            endpointId: "fal-ai/flux/dev",
            request: { prompt: "private Fashion reference" },
            submissionState: submission.state,
            submissionPayloadStorageId: submission.storageId,
            ...(submission.state === "dispatching"
              ? {
                  submissionAttemptId: "in-flight-at-delete",
                  submissionClaimedAt: now,
                }
              : {}),
            status: "queued",
            upstreamStatus: "IN_QUEUE",
            queuePosition: null,
            createdAt: now,
            updatedAt: now,
          });
          await ctx.db.insert("media_webhook_events", {
            scope: "legacy-media-webhook",
            dedupKey: `legacy-${index}`,
            jobId: `account-delete-media-${index}`,
            receivedAt: now,
            applied: false,
          });
        }
      });

      const firstDrain = await t.mutation(
        internal.account_deletion._deleteExtraTableBatch,
        {
          ownerId: "account-delete-media-owner",
          table: "media_jobs",
        },
      );
      expect(firstDrain.hasMore).toBe(true);
      expect(
        await t.mutation(internal.account_deletion._deleteExtraTableBatch, {
          ownerId: "account-delete-media-owner",
          table: "media_jobs",
        }),
      ).toEqual({ hasMore: false });
      expect(
        await t.mutation(internal.media_jobs.releaseImageSubmissionPayload, {
          jobId: "account-delete-media-1",
          storageId: dispatchingStorageId,
        }),
      ).toBe(false);
      expect(
        await t.run(async (ctx) => {
          const row = await ctx.db
            .query("media_jobs")
            .withIndex("by_jobId", (q) =>
              q.eq("jobId", "account-delete-media-1"),
            )
            .unique();
          return {
            request: row?.request,
            submissionPayloadStorageId: row?.submissionPayloadStorageId,
          };
        }),
      ).toEqual({ request: {}, submissionPayloadStorageId: undefined });
      await t.mutation(internal.media_jobs.markSubmitted, {
        jobId: "account-delete-media-1",
        submissionAttemptId: "in-flight-at-delete",
        providerRequestId: "provider-accepted-during-delete",
        upstreamStatus: "IN_QUEUE",
      });
      await t.mutation(internal.account_deletion._deleteExtraTableBatch, {
        ownerId: "account-delete-media-owner",
        table: "media_jobs",
      });
      expect(
        await t.run(async (ctx) => await ctx.db.query("media_jobs").collect()),
      ).toEqual([]);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 200 })),
      );
      expect(
        await t.run(
          async (ctx) =>
            await ctx.db.query("media_private_blob_cleanup").collect(),
        ),
      ).toHaveLength(2);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        await t.run(
          async (ctx) =>
            await ctx.db.query("media_private_blob_cleanup").collect(),
        ),
      ).toEqual([]);
      expect(
        await t.run(
          async (ctx) => await ctx.db.query("media_webhook_events").collect(),
        ),
      ).toEqual([]);
      expect(
        await t.run(
          async (ctx) =>
            await ctx.db.query("media_provider_cancellations").collect(),
        ),
      ).toEqual([]);
      const urls = await t.run(
        async (ctx) =>
          await Promise.all([
            ctx.storage.getUrl(pendingStorageId),
            ctx.storage.getUrl(dispatchingStorageId),
          ]),
      );
      expect(urls).toEqual([null, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a late purge webhook only to reconcile provider cancellation", async () => {
    ensureMediaEnv();
    const t = createTest();
    await t.mutation(internal.media_jobs.createJob, {
      ownerId: "purge-webhook-owner",
      jobId: "purge-webhook-job",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "must never bill" },
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("media_jobs")
        .withIndex("by_jobId", (q) => q.eq("jobId", "purge-webhook-job"))
        .unique();
      if (!row) throw new Error("missing purge webhook fixture");
      await ctx.db.patch(row._id, {
        status: "canceled",
        submissionState: "dispatching",
        submissionAttemptId: "lost-response-attempt",
        upstreamStatus: "OWNER_PURGED",
        error: { code: "OWNER_PURGED", message: "owner deletion" },
        completedAt: Date.now(),
      });
    });

    await t.mutation(internal.media_jobs.applyFalWebhook, {
      dedupKey: "purge-late-provider-id",
      jobId: "purge-webhook-job",
      providerRequestId: "fal-purge-late-request",
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/ignored.png" }] },
      billing: {
        endpointId: "fal-ai/flux/dev",
        billingUnit: "image",
        unitPriceUsd: 0.01,
        quantity: 1,
        costMicroCents: 1_000_000,
        meteredFrom: "output",
      },
      receivedAt: Date.now(),
    });

    const [job, cancellations, receipts] = await t.run(async (ctx) => [
      await ctx.db
        .query("media_jobs")
        .withIndex("by_jobId", (q) => q.eq("jobId", "purge-webhook-job"))
        .unique(),
      await ctx.db.query("media_provider_cancellations").collect(),
      await ctx.db.query("billing_media_usage_receipts").collect(),
    ]);
    expect(job).toMatchObject({
      status: "canceled",
      upstreamStatus: "OWNER_PURGED",
      providerRequestId: "fal-purge-late-request",
    });
    expect(cancellations).toEqual([
      expect.objectContaining({
        jobId: "purge-webhook-job",
        providerRequestId: "fal-purge-late-request",
      }),
    ]);
    expect(receipts).toEqual([]);
  });

  it("purges an ambiguous canceled claim after the provider reconciliation envelope", async () => {
    ensureMediaEnv();
    const t = createTest();
    const claimedAt = Date.now() - (3 * 60 * 60_000 + 16 * 60_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("media_jobs", {
        ownerId: "expired-purge-owner",
        jobId: "expired-purge-job",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: {},
        submissionState: "dispatching",
        submissionAttemptId: "expired-ambiguous-attempt",
        submissionClaimedAt: claimedAt,
        status: "canceled",
        upstreamStatus: "OWNER_PURGED",
        queuePosition: null,
        error: { code: "OWNER_PURGED", message: "owner deletion" },
        createdAt: claimedAt,
        updatedAt: claimedAt,
        completedAt: claimedAt,
      });
      await ctx.db.insert("media_webhook_events", {
        ownerId: "expired-purge-owner",
        scope: "media_fal_webhook",
        dedupKey: "expired-purge-event",
        jobId: "expired-purge-job",
        receivedAt: claimedAt,
        applied: false,
      });
    });

    await expect(
      t.mutation(internal.account_deletion._deleteExtraTableBatch, {
        ownerId: "expired-purge-owner",
        table: "media_jobs",
      }),
    ).resolves.toEqual({ hasMore: true });
    expect(
      await t.run(async (ctx) => ({
        jobs: await ctx.db.query("media_jobs").collect(),
        events: await ctx.db.query("media_webhook_events").collect(),
      })),
    ).toEqual({ jobs: [], events: [] });
  });

  it("reattaches a repeated POST without a second upstream submission", async () => {
    ensureMediaEnv();
    const t = createTest();
    let upstreamSubmissions = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("queue.fal.run") && init?.method === "POST") {
        upstreamSubmissions += 1;
        return new Response(
          JSON.stringify({ request_id: "fal-request-1", status: "IN_QUEUE" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const owner = asOwner(t);
    const first = await owner.fetch("/api/media/v1/generate", imageRequest());
    const firstBody = (await first.json()) as {
      jobId: string;
      reattached?: boolean;
    };
    const repeated = await owner.fetch(
      "/api/media/v1/generate",
      imageRequest(),
    );
    const repeatedBody = (await repeated.json()) as {
      jobId: string;
      reattached?: boolean;
    };

    expect(first.status).toBe(202);
    expect(repeated.status).toBe(202);
    expect(repeatedBody.jobId).toBe(firstBody.jobId);
    expect(repeatedBody.reattached).toBe(true);
    await vi.waitFor(() => expect(upstreamSubmissions).toBe(1));
  });

  it("does not resubmit after an ambiguous upstream response loss", async () => {
    ensureMediaEnv();
    const t = createTest();
    let upstreamSubmissions = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      upstreamSubmissions += 1;
      throw new Error("connection reset after request send");
    });

    const owner = asOwner(t);
    const first = await owner.fetch("/api/media/v1/generate", imageRequest());
    const firstBody = (await first.json()) as { jobId: string };
    const repeated = await owner.fetch(
      "/api/media/v1/generate",
      imageRequest(),
    );
    const repeatedBody = (await repeated.json()) as {
      jobId: string;
      reattached?: boolean;
    };

    expect(first.status).toBe(202);
    expect(repeated.status).toBe(202);
    expect(repeatedBody.jobId).toBe(firstBody.jobId);
    expect(repeatedBody.reattached).toBe(true);
    await vi.waitFor(() => expect(upstreamSubmissions).toBe(1));
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        jobId: firstBody.jobId,
        providerRequestId: "fal-accepted-response-lost",
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/reconciled.png" }] },
        receivedAt: Date.now(),
      }),
    ).toMatchObject({ updated: true });
    expect(
      (
        await owner.query(api.media_jobs.getByJobId, {
          jobId: firstBody.jobId,
        })
      )?.status,
    ).toBe("succeeded");
  });

  it("rejects key reuse with a different request body", async () => {
    ensureMediaEnv();
    const t = createTest();
    let upstreamSubmissions = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      upstreamSubmissions += 1;
      return new Response(
        JSON.stringify({ request_id: "fal-request-2", status: "IN_QUEUE" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const owner = asOwner(t);
    expect(
      (await owner.fetch("/api/media/v1/generate", imageRequest("first")))
        .status,
    ).toBe(202);
    const conflicting = await owner.fetch(
      "/api/media/v1/generate",
      imageRequest("different"),
    );
    expect(conflicting.status).toBe(409);
    expect(await conflicting.text()).toContain("different media request");
    await vi.waitFor(() => expect(upstreamSubmissions).toBe(1));
  });

  it("lets a cancellation tombstone win before POST reservation", async () => {
    ensureMediaEnv();
    const t = createTest();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const owner = asOwner(t);
    const canceled = await owner.fetch("/api/media/v1/job", {
      method: "DELETE",
      headers: { "idempotency-key": "stella-image-gen-v1-test-key" },
    });
    expect(canceled.status).toBe(200);

    const post = await owner.fetch("/api/media/v1/generate", imageRequest());
    expect(post.status).toBe(409);
    expect(await post.text()).toContain("canceled before submission");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels upstream once and ignores a late completion webhook", async () => {
    ensureMediaEnv();
    const t = createTest();
    let submissions = 0;
    let cancellations = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        submissions += 1;
        return new Response(
          JSON.stringify({
            request_id: "fal-request-cancel",
            status: "IN_QUEUE",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PUT" && url.endsWith("/cancel")) {
        cancellations += 1;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const owner = asOwner(t);
    const submitted = await owner.fetch(
      "/api/media/v1/generate",
      imageRequest(),
    );
    const { jobId } = (await submitted.json()) as { jobId: string };
    await vi.waitFor(() => expect(submissions).toBe(1));
    const canceled = await owner.fetch("/api/media/v1/job", {
      method: "DELETE",
      headers: { "idempotency-key": "stella-image-gen-v1-test-key" },
    });
    expect(canceled.status).toBe(200);
    expect(submissions).toBe(1);
    expect(cancellations).toBe(1);

    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        jobId,
        providerRequestId: "fal-request-cancel",
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/late.png" }] },
        receivedAt: Date.now(),
      }),
    ).toMatchObject({ updated: false, jobId });
    const job = await owner.query(api.media_jobs.getByJobId, { jobId });
    expect(job?.status).toBe("canceled");
  });

  it("atomically reserves one job and one provider POST under concurrent requests", async () => {
    ensureMediaEnv();
    const t = createTest();
    let submissions = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("queue.fal.run") && init?.method === "POST") {
        submissions += 1;
        return new Response(
          JSON.stringify({ request_id: "fal-concurrent", status: "IN_QUEUE" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    const owner = asOwner(t);
    const [left, right] = await Promise.all([
      owner.fetch("/api/media/v1/generate", imageRequest()),
      owner.fetch("/api/media/v1/generate", imageRequest()),
    ]);
    const leftBody = (await left.json()) as { jobId: string };
    const rightBody = (await right.json()) as { jobId: string };
    expect(leftBody.jobId).toBe(rightBody.jobId);
    await vi.waitFor(() => expect(submissions).toBe(1));
  });

  it("keeps a pre-dispatch crash recoverable but never reclaims a durable claim", async () => {
    ensureMediaEnv();
    const t = createTest();
    const storageId = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["encrypted"])),
    );
    await t.mutation(internal.media_jobs.reserveIdempotentJob, {
      ownerId: "owner-crash",
      jobId: "job-crash-before-post",
      clientRequestKey: "crash-key",
      clientRequestHash: "request-hash",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "crash before post" },
      submissionPayloadStorageId: storageId,
    });
    const rescheduled = await t.mutation(
      internal.media_jobs.reconcilePendingImageSubmissions,
      { pendingBefore: Date.now() + 1, unknownBefore: 0 },
    );
    expect(rescheduled.rescheduled).toBe(1);

    const [first, second] = await Promise.all([
      t.mutation(internal.media_jobs.claimImageSubmission, {
        jobId: "job-crash-before-post",
        attemptId: "attempt-one",
        claimedAt: 10,
      }),
      t.mutation(internal.media_jobs.claimImageSubmission, {
        jobId: "job-crash-before-post",
        attemptId: "attempt-two",
        claimedAt: 11,
      }),
    ]);
    expect([first.state, second.state].sort()).toEqual(["claimed", "skip"]);
    const reconciled = await t.mutation(
      internal.media_jobs.reconcilePendingImageSubmissions,
      { pendingBefore: 0, unknownBefore: Date.now() + 1 },
    );
    expect(reconciled.rescheduled).toBe(0);
    await t.mutation(internal.media_jobs.reconcilePendingImageSubmissions, {
      pendingBefore: 0,
      unknownBefore: Date.now() + 1,
    });
    const ambiguousJob = await t.run(
      async (ctx) =>
        await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", "job-crash-before-post"))
          .unique(),
    );
    expect(ambiguousJob).toMatchObject({
      status: "unknown",
      upstreamStatus: "SUBMISSION_OUTCOME_UNKNOWN",
      error: { code: "SUBMISSION_OUTCOME_UNKNOWN" },
    });
    expect(ambiguousJob?.submissionPayloadStorageId).toBeUndefined();
  });

  it("abandons and cleans an encrypted payload only after the pending retention window", async () => {
    ensureMediaEnv();
    const t = createTest();
    const storageId = await t.run(
      async (ctx) =>
        await ctx.storage.store(new Blob(["encrypted-private-reference"])),
    );
    await t.mutation(internal.media_jobs.reserveIdempotentJob, {
      ownerId: "retention-owner",
      jobId: "retention-job",
      clientRequestKey: "retention-key",
      clientRequestHash: "retention-hash",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "retention" },
      submissionPayloadStorageId: storageId,
    });
    const retained = await t.mutation(
      internal.media_jobs.reconcilePendingImageSubmissions,
      {
        pendingBefore: Date.now() + 1,
        pendingRetentionMs: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(retained.rescheduled).toBe(1);
    const abandoned = await t.mutation(
      internal.media_jobs.reconcilePendingImageSubmissions,
      {
        pendingBefore: Date.now() + 1,
        pendingRetentionMs: -1,
      },
    );
    expect(abandoned.abandoned).toBe(1);
    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", "retention-job"))
          .unique(),
    );
    expect(row).toMatchObject({
      status: "failed",
      upstreamStatus: "SUBMISSION_ABANDONED",
    });
    expect(row?.submissionPayloadStorageId).toBeUndefined();
  });

  it("makes success immutable against a later failure webhook", async () => {
    ensureMediaEnv();
    const t = createTest();
    await t.mutation(internal.media_jobs.createJob, {
      ownerId: "terminal-owner",
      jobId: "terminal-success",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "terminal" },
    });
    await t.mutation(internal.media_jobs.markGenerated, {
      jobId: "terminal-success",
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/success.png" }] },
    });
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, {
        jobId: "terminal-success",
        upstreamStatus: "ERROR",
        error: { message: "late opposite webhook" },
        receivedAt: Date.now(),
      }),
    ).toMatchObject({ updated: false });
    expect(
      (
        await t.run(
          async (ctx) =>
            await ctx.db
              .query("media_jobs")
              .withIndex("by_jobId", (q) => q.eq("jobId", "terminal-success"))
              .unique(),
        )
      )?.status,
    ).toBe("succeeded");
  });

  it("makes failure and stale timeout immutable against late success", async () => {
    ensureMediaEnv();
    const t = createTest();
    for (const jobId of ["terminal-failure", "terminal-timeout"]) {
      await t.mutation(internal.media_jobs.createJob, {
        ownerId: "terminal-owner",
        jobId,
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: jobId },
      });
    }
    await t.mutation(internal.media_jobs.markSubmissionFailed, {
      jobId: "terminal-failure",
      upstreamStatus: "ERROR",
      error: { message: "definitive failure" },
    });
    await t.mutation(internal.media_jobs.markStaleJobsFailed, {
      cutoffMs: Date.now() + 1,
    });
    for (const jobId of ["terminal-failure", "terminal-timeout"]) {
      expect(
        await t.mutation(internal.media_jobs.applyFalWebhook, {
          jobId,
          upstreamStatus: "OK",
          output: { images: [{ url: "https://example.test/late.png" }] },
          receivedAt: Date.now(),
        }),
      ).toMatchObject({ updated: false });
    }
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query("media_jobs").collect())
        .filter((job) => job.jobId.startsWith("terminal-"))
        .map((job) => [job.jobId, job.status]),
    );
    expect(Object.fromEntries(statuses)).toMatchObject({
      "terminal-failure": "failed",
      "terminal-timeout": "unknown",
    });
  });

  it("reconciles an accepted request by owner key and exact request hash", async () => {
    ensureMediaEnv();
    const t = createTest();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ request_id: "fal-reconcile", status: "IN_QUEUE" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const owner = asOwner(t);
    const request = imageRequest("lookup accepted");
    const body = String(request.body);
    const acceptedResponse = await owner.fetch(
      "/api/media/v1/generate",
      request,
    );
    const accepted = (await acceptedResponse.json()) as { jobId: string };
    const requestHash = createHash("sha256").update(body).digest("hex");

    const lookup = await owner.fetch(
      `/api/media/v1/job?clientRequestKey=stella-image-gen-v1-test-key&requestHash=${requestHash}`,
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()) as { jobId: string }).toMatchObject({
      jobId: accepted.jobId,
    });
    const wrongHash = await owner.fetch(
      "/api/media/v1/job?clientRequestKey=stella-image-gen-v1-test-key&requestHash=wrong",
    );
    expect(wrongHash.status).toBe(409);
  });

  it("rolls webhook dedup back on a crash and bills only the retried allowed transition", async () => {
    ensureMediaEnv();
    const t = createTest();
    await t.mutation(internal.media_jobs.createJob, {
      ownerId: "billing-owner",
      jobId: "webhook-atomic-job",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "atomic" },
    });
    const webhook = {
      dedupKey: "fal-request:payload-hash",
      jobId: "webhook-atomic-job",
      providerRequestId: "fal-request",
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/atomic.png" }] },
      billing: {
        endpointId: "fal-ai/flux/dev",
        billingUnit: "image" as const,
        unitPriceUsd: 0.01,
        quantity: 1,
        costMicroCents: 1_000_000,
        meteredFrom: "output" as const,
      },
      receivedAt: Date.now(),
    };
    await expect(
      t.mutation(internal.media_jobs.applyFalWebhook, {
        ...webhook,
        testCrashAfterDedup: true,
      }),
    ).rejects.toThrow("Injected crash");
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("media_webhook_events").collect(),
      ),
    ).toHaveLength(0);
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, webhook),
    ).toMatchObject({ updated: true });
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("media_webhook_events").unique(),
      ),
    ).toMatchObject({ ownerId: "billing-owner", jobId: "webhook-atomic-job" });
    expect(
      await t.mutation(internal.media_jobs.applyFalWebhook, webhook),
    ).toMatchObject({ updated: false, duplicate: true });
    await vi.waitFor(async () => {
      const receipts = await t.run(
        async (ctx) =>
          await ctx.db.query("billing_media_usage_receipts").collect(),
      );
      expect(receipts).toHaveLength(1);
    });
  });

  it("never bills late success after cancel or terminal unknown", async () => {
    ensureMediaEnv();
    const t = createTest();
    for (const jobId of ["late-canceled", "late-unknown"]) {
      await t.mutation(internal.media_jobs.createJob, {
        ownerId: "late-billing-owner",
        jobId,
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: jobId },
      });
    }
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("media_jobs")
        .withIndex("by_jobId", (q) => q.eq("jobId", "late-canceled"))
        .unique();
      if (!row) throw new Error("missing cancellation fixture");
      await ctx.db.patch(row._id, {
        status: "canceled",
        upstreamStatus: "CANCELED",
        completedAt: Date.now(),
      });
    });
    await t.mutation(internal.media_jobs.markStaleJobsFailed, {
      cutoffMs: Date.now() + 1,
    });
    for (const jobId of ["late-canceled", "late-unknown"]) {
      expect(
        await t.mutation(internal.media_jobs.applyFalWebhook, {
          dedupKey: `${jobId}:late-success`,
          jobId,
          upstreamStatus: "OK",
          output: { images: [{ url: "https://example.test/late.png" }] },
          billing: {
            endpointId: "fal-ai/flux/dev",
            billingUnit: "image",
            unitPriceUsd: 0.01,
            quantity: 1,
            costMicroCents: 1_000_000,
            meteredFrom: "output",
          },
          receivedAt: Date.now(),
        }),
      ).toMatchObject({ updated: false });
    }
    const receipts = await t.run(
      async (ctx) =>
        await ctx.db.query("billing_media_usage_receipts").collect(),
    );
    expect(receipts).toHaveLength(0);
  });

  it("retries and terminally accounts for restart-stuck image connector delivery", async () => {
    ensureMediaEnv();
    const t = createTest();
    await t.mutation(internal.media_jobs.createJob, {
      ownerId: "connector-owner",
      jobId: "connector-image-job",
      capability: "text_to_image",
      profile: "best",
      provider: "fal",
      endpointId: "fal-ai/flux/dev",
      request: { prompt: "connector image" },
      connectorRequestId: "missing-connector-turn",
    });
    await t.mutation(internal.media_jobs.markGenerated, {
      jobId: "connector-image-job",
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/connector.png" }] },
    });
    expect(
      await t.mutation(internal.media_jobs.retryStuckImageConnectorDeliveries, {
        staleMs: -1,
        maxAttempts: 2,
      }),
    ).toMatchObject({ retried: 1 });
    expect(
      await t.mutation(internal.media_jobs.retryStuckImageConnectorDeliveries, {
        staleMs: -1,
        maxAttempts: 2,
      }),
    ).toMatchObject({ abandoned: 1 });
    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("media_jobs")
          .withIndex("by_jobId", (q) => q.eq("jobId", "connector-image-job"))
          .unique(),
    );
    expect(row?.connectorMediaDeliveryAttempts).toBe(2);
    expect(row?.connectorMediaDeliveryAbandonedAt).toEqual(expect.any(Number));
  });
});
