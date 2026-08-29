/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { meterCompletedMediaJob } from "./media_billing";
import schema from "./schema";

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
      "1": Buffer.alloc(32, 13).toString("base64"),
    }),
    STELLA_SECRETS_MASTER_KEY_VERSION: "1",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable emoji media generation", () => {
  it("reconciles response-lost submissions by webhook and commits canonical billing before lease release", async () => {
    const t = createTest();
    const ownerId = "durable-product-media-owner";
    const ownerGeneration = "legacy";
    let submissions = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("queue.fal.run") && init?.method === "POST") {
        submissions += 1;
        throw new Error("provider accepted but response was lost");
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    const firstSheet = await t.action(
      internal.data.emoji_pack_generation.reserveEmojiSheetGenerationJob,
      {
        ownerId,
        ownerGeneration,
        uploadId: "emoji-upload-durable",
        sheetIndex: 0,
        prompt: "neon clay party",
      },
    );
    const secondSheet = await t.action(
      internal.data.emoji_pack_generation.reserveEmojiSheetGenerationJob,
      {
        ownerId,
        ownerGeneration,
        uploadId: "emoji-upload-durable",
        sheetIndex: 1,
        prompt: "neon clay party",
      },
    );
    expect(firstSheet?.jobId).toMatch(/^emoji_pack_generation_/u);
    expect(secondSheet?.jobId).toMatch(/^emoji_pack_generation_/u);
    expect(firstSheet!.jobId).not.toBe(secondSheet!.jobId);
    await vi.waitFor(() => expect(submissions).toBe(2));

    const reserved = await t.run(async (ctx) => ({
      first: await ctx.db
        .query("media_jobs")
        .withIndex("by_jobId", (q) => q.eq("jobId", firstSheet!.jobId))
        .unique(),
      second: await ctx.db
        .query("media_jobs")
        .withIndex("by_jobId", (q) => q.eq("jobId", secondSheet!.jobId))
        .unique(),
    }));
    expect(reserved.first).toMatchObject({
      capability: "image_edit",
      profile: "default",
      endpointId: "openai/gpt-image-2/edit",
      submissionState: "unknown",
      request: {
        input: { image_urls: ["[embedded emoji reference sheet 0]"] },
      },
    });
    expect(reserved.second).toMatchObject({
      capability: "image_edit",
      profile: "default",
      endpointId: "openai/gpt-image-2/edit",
      submissionState: "unknown",
      request: {
        input: { image_urls: ["[embedded emoji reference sheet 1]"] },
      },
    });

    for (const jobId of [firstSheet!.jobId, secondSheet!.jobId]) {
      await t.action(
        internal.media_image_submission.submitReservedImageJob,
        { jobId, ownerGeneration },
      );
    }
    expect(submissions).toBe(2);

    const jobs = await t.run(async (ctx) =>
      Promise.all(
        [firstSheet!.jobId, secondSheet!.jobId].map(async (jobId) =>
          ctx.db
            .query("media_jobs")
            .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
            .unique(),
        ),
      ),
    );
    const output = {
      images: [{ url: "https://images.example.test/reconciled.webp" }],
    };
    let expectedCost = 0;
    for (const [index, job] of jobs.entries()) {
      if (!job) throw new Error("missing durable emoji media job");
      const billing = meterCompletedMediaJob({
        endpointId: job.endpointId,
        request: job.request,
        output,
      });
      if ("supported" in billing) throw new Error(billing.reason);
      expectedCost += billing.costMicroCents;
      await expect(
        t.mutation(internal.media_jobs.applyFalWebhook, {
          ownerGeneration,
          dedupKey: `durable-product-media-webhook-${index}`,
          jobId: job.jobId,
          providerRequestId: `fal-durable-product-${index}`,
          upstreamStatus: "OK",
          output,
          billing,
          receivedAt: Date.now() + index,
        }),
      ).resolves.toMatchObject({ updated: true, jobId: job.jobId });
    }

    const disposition = await t.run(async (ctx) => ({
      receipts: await ctx.db.query("billing_media_usage_receipts").collect(),
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      attempts: await ctx.db
        .query("media_provider_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    }));
    expect(disposition.receipts).toHaveLength(2);
    expect(disposition.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: firstSheet!.jobId,
          endpointId: "openai/gpt-image-2/edit",
        }),
        expect.objectContaining({
          jobId: secondSheet!.jobId,
          endpointId: "openai/gpt-image-2/edit",
        }),
      ]),
    );
    expect(disposition.usage).toMatchObject({
      totalUsageMicroCents: expectedCost,
      totalRequestCount: 2,
    });
    expect(disposition.attempts).toEqual([]);
  });
});
