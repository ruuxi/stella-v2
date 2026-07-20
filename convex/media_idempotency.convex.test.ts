/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

describe("managed media idempotency and cancellation", () => {
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
    expect(await t.mutation(internal.media_jobs.applyFalWebhook, {
      jobId: firstBody.jobId,
      providerRequestId: "fal-accepted-response-lost",
      upstreamStatus: "OK",
      output: { images: [{ url: "https://example.test/reconciled.png" }] },
      receivedAt: Date.now(),
    })).toMatchObject({ updated: true });
    expect((await owner.query(api.media_jobs.getByJobId, {
      jobId: firstBody.jobId,
    }))?.status).toBe("succeeded");
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
    const storageId = await t.run(async (ctx) =>
      await ctx.storage.store(new Blob(["encrypted"])),
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
    const ambiguousJob = await t.run(async (ctx) =>
      await ctx.db.query("media_jobs").withIndex("by_jobId", (q) =>
        q.eq("jobId", "job-crash-before-post"),
      ).unique(),
    );
    expect(ambiguousJob).toMatchObject({
      status: "failed",
      upstreamStatus: "SUBMISSION_OUTCOME_UNKNOWN",
      error: { code: "SUBMISSION_OUTCOME_UNKNOWN" },
    });
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
    expect(await t.mutation(internal.media_jobs.applyFalWebhook, {
      jobId: "terminal-success",
      upstreamStatus: "ERROR",
      error: { message: "late opposite webhook" },
      receivedAt: Date.now(),
    })).toMatchObject({ updated: false });
    expect((await t.run(async (ctx) =>
      await ctx.db.query("media_jobs").withIndex("by_jobId", (q) =>
        q.eq("jobId", "terminal-success"),
      ).unique(),
    ))?.status).toBe("succeeded");
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
      expect(await t.mutation(internal.media_jobs.applyFalWebhook, {
        jobId,
        upstreamStatus: "OK",
        output: { images: [{ url: "https://example.test/late.png" }] },
        receivedAt: Date.now(),
      })).toMatchObject({ updated: false });
    }
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query("media_jobs").collect())
        .filter((job) => job.jobId.startsWith("terminal-"))
        .map((job) => [job.jobId, job.status]),
    );
    expect(Object.fromEntries(statuses)).toMatchObject({
      "terminal-failure": "failed",
      "terminal-timeout": "failed",
    });
  });
});
