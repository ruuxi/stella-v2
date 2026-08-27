/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const SERVICE_SECRET = "cloud-model-service-secret";
const OWNER_ID = "https://issuer.test|cloud-model-owner";
const OWNER_GENERATION = "cloud-model-generation";
const MODEL_REQUEST_ID = `cloud-model:${"a".repeat(64)}`;

beforeAll(() => {
  const values: Record<string, string> = {
    BUILDER_SERVICE_SECRET: SERVICE_SECRET,
    ANTHROPIC_API_KEY: "test-anthropic-key",
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

const createTest = async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: now,
      updatedAt: now,
    });
  });
  return t;
};

const modelRequest = (
  ownerGeneration: string,
  options?: { prompt?: string; requestId?: string | null },
) => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${SERVICE_SECRET}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    ownerId: OWNER_ID,
    ownerGeneration,
    prompt: options?.prompt ?? "Make a calm habit dashboard.",
    ...(options?.requestId === null
      ? {}
      : { requestId: options?.requestId ?? MODEL_REQUEST_ID }),
  }),
});

describe("POST /api/cloud/model owner lifecycle binding", () => {
  it("rejects a stale worker generation before provider spend", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("The stale request must not reach Anthropic."),
      );

    const response = await t.fetch(
      "/api/cloud/model",
      modelRequest("generation-before-reset"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Owner data generation is stale",
    });
    expect(upstream).not.toHaveBeenCalled();

    const billingRows = await t.run(async (ctx) =>
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    );
    expect(billingRows).toEqual([]);
  });

  it("uses the admitted generation for dispatch and managed billing", async () => {
    const t = await createTest();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "Habits",
                habits: [],
              }),
            },
          ],
          usage: { input_tokens: 42, output_tokens: 17 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [, init] = upstream.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const upstreamBody = JSON.parse(String(init?.body)) as {
      model?: string;
    };
    expect(upstreamBody.model).toBe("claude-haiku-4-5-20251001");

    const billingWindow = await t.run(async (ctx) =>
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    );
    expect(billingWindow).toMatchObject({
      ownerId: OWNER_ID,
      totalRequestCount: 1,
      activeReservedMicroCents: 0,
    });
    expect(billingWindow?.totalUsageMicroCents).toBeGreaterThan(0);

    const dispatchRows = await t.run(async (ctx) =>
      ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    );
    expect(dispatchRows).toHaveLength(1);
    expect(dispatchRows[0]).toMatchObject({
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      state: "terminal",
      outcome: "succeeded",
    });
    expect(dispatchRows[0]!.providerDeadlineAt).toBeLessThan(
      dispatchRows[0]!.leaseExpiresAt,
    );
    const bindings = await t.run(async (ctx) =>
      ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      ownerGeneration: OWNER_GENERATION,
      route: "cloud:model",
      requestId: MODEL_REQUEST_ID,
    });
  });

  it("rejects a legacy request without a stable request id before provider spend", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("missing-id I/O must not run"));

    const response = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION, { requestId: null }),
    );

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("billing_managed_request_bindings").collect(),
      ),
    ).toEqual([]);
  });

  it("rejects an identical logical replay without a second provider attempt or charge", async () => {
    const t = await createTest();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          content: [
            {
              type: "text",
              text: JSON.stringify({ title: "Habits", habits: [] }),
            },
          ],
          usage: { input_tokens: 42, output_tokens: 17 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const first = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );
    const replay = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
    const snapshot = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
      dispatches: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    }));
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches).toHaveLength(1);
  });

  it("rejects changed provider bytes under the same logical request id", async () => {
    const t = await createTest();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ title: "Habits", habits: [] }),
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(
      (
        await t.fetch(
          "/api/cloud/model",
          modelRequest(OWNER_GENERATION, { prompt: "Original prompt" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await t.fetch(
          "/api/cloud/model",
          modelRequest(OWNER_GENERATION, { prompt: "Changed prompt" }),
        )
      ).status,
    ).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("bills an ambiguous response loss once and blocks service replay", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed after provider dispatch"));

    const first = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );
    const replay = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );

    expect(first.status).toBe(502);
    expect(replay.status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
    const snapshot = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
      dispatches: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    }));
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBeGreaterThan(0);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]).toMatchObject({
      outcome: "outcome_unknown",
      billing: { billingState: "billed" },
    });
  });

  it("rejects an active incoming owner migration before provider spend", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "https://issuer.test|cloud-model-source",
        toOwnerId: OWNER_ID,
        status: "running",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: OWNER_GENERATION,
        planRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("migration-fenced I/O must not run"));

    const response = await t.fetch(
      "/api/cloud/model",
      modelRequest(OWNER_GENERATION),
    );

    expect(response.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("usage_logs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
      ),
    ).toEqual([]);
  });
});
