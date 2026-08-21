/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const listScheduledDrainNames = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => {
    const scheduled = await ctx.db.system
      .query("_scheduled_functions")
      .collect();
    return scheduled
      .map((job) => job.name)
      .filter((name) => name.includes("media_image_submission"))
      .sort();
  });

describe("sweepMediaCleanupQueues cron gate", () => {
  it("schedules nothing when every cleanup queue is empty", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(
      internal.media_jobs.sweepMediaCleanupQueues,
      {},
    );

    expect(result).toEqual({
      blobCleanupDue: false,
      payloadManifestsDue: false,
      providerCancellationsDue: false,
    });
    expect(await listScheduledDrainNames(t)).toEqual([]);
  });

  it("only schedules the drain whose queue has due rows", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("media_private_blob_cleanup", {
        ownerId: "owner-1",
        storageId: (await ctx.storage.store(new Blob(["x"]))) as never,
        state: "pending",
        attempts: 1,
        nextAttemptAt: now - 1_000,
        createdAt: now - 60_000,
        updatedAt: now - 1_000,
      });
    });

    const result = await t.mutation(
      internal.media_jobs.sweepMediaCleanupQueues,
      {},
    );

    expect(result).toEqual({
      blobCleanupDue: true,
      payloadManifestsDue: false,
      providerCancellationsDue: false,
    });
    const scheduled = await listScheduledDrainNames(t);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toContain("drainPrivateBlobCleanup");
  });

  it("ignores rows whose nextAttemptAt is still in the future", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("media_provider_cancellations", {
        ownerId: "owner-1",
        jobId: "job-1",
        endpointId: "fal-ai/test",
        providerRequestId: "req-1",
        attempts: 1,
        nextAttemptAt: now + 60 * 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(
      internal.media_jobs.sweepMediaCleanupQueues,
      {},
    );

    expect(result).toEqual({
      blobCleanupDue: false,
      payloadManifestsDue: false,
      providerCancellationsDue: false,
    });
    expect(await listScheduledDrainNames(t)).toEqual([]);
  });

  it("schedules the manifest and cancellation drains when their queues are due", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("media_private_payload_manifests", {
        ownerId: "owner-1",
        manifestId: "manifest-1",
        jobId: "job-1",
        clientRequestKey: "key-1",
        state: "pending",
        expectedChunks: 1,
        writtenChunks: 1,
        totalChars: 10,
        writtenChars: 10,
        createdAt: now - 60_000,
        updatedAt: now - 1_000,
        nextAttemptAt: now - 1_000,
      });
      await ctx.db.insert("media_provider_cancellations", {
        ownerId: "owner-1",
        jobId: "job-1",
        endpointId: "fal-ai/test",
        providerRequestId: "req-1",
        attempts: 0,
        nextAttemptAt: now - 1_000,
        createdAt: now - 60_000,
        updatedAt: now - 1_000,
      });
    });

    const result = await t.mutation(
      internal.media_jobs.sweepMediaCleanupQueues,
      {},
    );

    expect(result).toEqual({
      blobCleanupDue: false,
      payloadManifestsDue: true,
      providerCancellationsDue: true,
    });
    const scheduled = await listScheduledDrainNames(t);
    expect(scheduled).toHaveLength(2);
    expect(scheduled.join(",")).toContain("drainPrivatePayloadManifests");
    expect(scheduled.join(",")).toContain("drainProviderCancellations");
  });
});
