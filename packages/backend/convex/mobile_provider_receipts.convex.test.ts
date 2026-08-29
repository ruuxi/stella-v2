/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "anon:mobile:device:receipt-test-device";

beforeAll(() => {
  const values: Record<string, string> = {
    OPENROUTER_API_KEY: "mobile-receipt-test-key",
    // The transcription route this file exercises now goes straight to xAI.
    XAI_API_KEY: "mobile-receipt-test-xai-key",
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
const transcribeRequest = (overrides: Record<string, unknown> = {}) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-stella-mobile-device-id": "receipt-test-device",
  },
  body: JSON.stringify({
    requestId: "mobile-stt:logical-recording-0001",
    audio: "AAAA",
    format: "wav",
    ...overrides,
  }),
});

const providerSuccess = () =>
  new Response(
    JSON.stringify({
      text: "hello world",
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
        cost: 0.00001,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("mobile paid provider request receipts", () => {
  it("rejects a missing request id before provider I/O", async () => {
    const t = createTest();
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await t.fetch(
      "/api/mobile/transcribe",
      transcribeRequest({ requestId: undefined }),
    );

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        await ctx.db.query("billing_managed_dispatch_leases").collect(),
      ),
    ).toEqual([]);
  });

  it("binds the logical request, meters the joined body, and closes execution", async () => {
    const t = createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(providerSuccess());

    const response = await t.fetch(
      "/api/mobile/transcribe",
      transcribeRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "hello world" });
    expect(upstream).toHaveBeenCalledTimes(1);
    const snapshot = await t.run(async (ctx) => ({
      bindings: await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
      dispatches: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
      executions: await ctx.db
        .query("billing_managed_execution_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    }));
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "succeeded",
      billing: { billingState: "billed" },
    });
    expect(snapshot.executions).toHaveLength(1);
    expect(snapshot.executions[0]).toMatchObject({
      state: "terminal",
      outcome: "succeeded",
    });
  });

  it("never redispatches identical replay and rejects a changed provider body", async () => {
    const t = createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(providerSuccess());
    expect(
      (
        await t.fetch("/api/mobile/transcribe", transcribeRequest())
      ).status,
    ).toBe(200);

    const replay = await t.fetch(
      "/api/mobile/transcribe",
      transcribeRequest(),
    );
    expect(replay.status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);

    const conflict = await t.fetch(
      "/api/mobile/transcribe",
      transcribeRequest({ language: "fr" }),
    );
    expect(conflict.status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await t.run(async (ctx) =>
        await ctx.db
          .query("billing_managed_dispatch_leases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
      ),
    ).toHaveLength(1);
  });

  it("terminalizes tagged response loss as unknown with no live execution residue", async () => {
    const t = createTest();
    const error = new Error("network response disappeared after admission");
    (
      error as Error & {
        providerOutcomeUnknown?: boolean;
      }
    ).providerOutcomeUnknown = true;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);

    const response = await t.fetch(
      "/api/mobile/transcribe",
      transcribeRequest({ requestId: "mobile-stt:response-loss-0002" }),
    );
    expect(response.status).toBe(500);

    const snapshot = await t.run(async (ctx) => ({
      dispatch: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
      execution: await ctx.db
        .query("billing_managed_execution_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    }));
    expect(snapshot.dispatch).toMatchObject({
      state: "terminal",
      outcome: "outcome_unknown",
      billing: { billingState: "billed" },
    });
    expect(snapshot.execution).toMatchObject({
      state: "terminal",
      outcome: "outcome_unknown",
    });
  });
});
