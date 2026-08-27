/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

vi.mock("./media_lyria", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./media_lyria")>();
  return {
    ...actual,
    generateMusic: vi.fn(async () => ({
      audio: { data: "AQIDBA==", mimeType: "audio/wav" },
      promptLabel: "Durable billing test",
      textParts: ["generated"],
    })),
  };
});

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "https://issuer.test|music-billing-owner";

const createTest = async () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  await t.mutation(internal.billing.setAdminBillingPlan, {
    ownerId: OWNER_ID,
    plan: "pro",
  });
  return t;
};

const asOwner = (t: Awaited<ReturnType<typeof createTest>>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "music-billing-owner",
    tokenIdentifier: OWNER_ID,
  });

const ensureEnv = () => {
  const values: Record<string, string> = {
    GOOGLE_AI_API_KEY: "test-google-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("music stream durable billing disposition", () => {
  it("commits the Lyria media receipt before releasing physical authority", async () => {
    ensureEnv();
    const t = await createTest();
    const response = await asOwner(t).fetch("/api/music/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weightedPrompts: [{ text: "warm analog synth", weight: 1 }],
        musicGenerationConfig: {
          bpm: 100,
          density: 0.5,
          brightness: 0.5,
          guidance: 3,
          temperature: 1,
        },
        promptLabel: "Durable billing test",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      audio: { data: "AQIDBA==", mimeType: "audio/wav" },
    });
    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
      receipts: await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
      exactAttempts: await ctx.db
        .query("media_provider_dispatch_leases")
        .collect(),
    }));
    expect(state.jobs).toEqual([
      expect.objectContaining({
        ownerId: OWNER_ID,
        ownerGeneration: "legacy",
        capability: "music_generation",
        endpointId: "google/lyria-3-pro-preview",
        status: "succeeded",
        billingDispositionState: "billed",
        billing: expect.objectContaining({
          billingUnit: "request",
          costMicroCents: 8_000_000,
        }),
      }),
    ]);
    expect(state.receipts).toEqual([
      expect.objectContaining({
        ownerId: OWNER_ID,
        ownerGeneration: "legacy",
        jobId: state.jobs[0]!.jobId,
        endpointId: "google/lyria-3-pro-preview",
        billingUnit: "request",
        costMicroCents: 8_000_000,
      }),
    ]);
    expect(state.exactAttempts).toEqual([]);
  });
});
