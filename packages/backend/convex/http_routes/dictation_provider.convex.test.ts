/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { dollarsToMicroCents } from "../lib/billing_money";
import {
  MUSE_DICTATION_MODEL,
  MUSE_STT_USD_PER_SECOND,
  MUSE_MAX_SESSION_MS,
} from "./dictation";
const modules = import.meta.glob("../**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
const ownerId = "https://issuer.test|dictation-billing";
const post = (t: ReturnType<typeof createTest>, path: string, body: unknown) =>
  t.fetch(`/api/cloud/dictation/${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer dictation-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
const prepare = async (t: ReturnType<typeof createTest>) => {
  const response = await post(t, "prepare", { ownerId });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    sessionId: string;
    ownerGeneration: string;
    providerDeadlineAt: number;
    maxAudioBytes: number;
  };
};
beforeEach(() => {
  // Billing plan limits are cached when each Convex module is first loaded.
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("BUILDER_SERVICE_SECRET", "dictation-test");
  vi.stubEnv("STELLA_INCLUDED_USAGE_UTILIZATION_RATE", "0.5");
  vi.stubEnv("STELLA_FREE_ROLLING_WINDOW_HOURS", "5");
  vi.stubEnv("STELLA_GO_PRICE_CENTS", "1000");
  vi.stubEnv("STELLA_PRO_PRICE_CENTS", "2000");
  for (const window of ["LIFETIME", "ROLLING", "WEEKLY", "MONTHLY"])
    vi.stubEnv(`STELLA_FREE_${window}_LIMIT_USD`, "10");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("Muse realtime dictation", () => {
  it("pins the public model id and accepted list rate", () => {
    expect(MUSE_DICTATION_MODEL).toBe("muse-voice-transcribe-1.0");
    expect(MUSE_STT_USD_PER_SECOND * 60).toBeCloseTo(0.003);
    expect(MUSE_STT_USD_PER_SECOND * 3600).toBeCloseTo(0.18);
  });
  it("reserves one hour and bills an exact session once across retries", async () => {
    const t = createTest();
    const session = await prepare(t);
    expect(session.providerDeadlineAt - Date.now()).toBe(MUSE_MAX_SESSION_MS);
    expect(session.maxAudioBytes).toBe(32_000 * 3600);
    const receipt = await t.run((ctx) =>
      ctx.db.query("billing_managed_dispatch_leases").first(),
    );
    expect(receipt?.billing).toMatchObject({
      providerState: "may_have_dispatched",
      billingState: "pending",
      fallbackCostMicroCents: dollarsToMicroCents(0.18),
    });
    const body = {
      ownerId,
      ...session,
      audioBytes: 32_000 * 60,
      durationMs: 60_000,
      success: true,
    };
    expect((await post(t, "settle", body)).status).toBe(200);
    expect((await post(t, "settle", body)).status).toBe(200);
    expect(
      await t.run((ctx) =>
        ctx.db.query("billing_managed_dispatch_leases").first(),
      ),
    ).toMatchObject({
      state: "terminal",
      usageReservationState: "released",
      billing: {
        billingState: "billed",
        capturedUsage: { costMicroCents: dollarsToMicroCents(0.003) },
      },
    });
    const usage = await t.run((ctx) =>
      ctx.db.query("billing_usage_windows").first(),
    );
    expect(usage?.totalRequestCount).toBe(1);
    expect(usage?.totalUsageMicroCents).toBe(dollarsToMicroCents(0.003));
  });
  it("rejects unprepared sessions and changed usage without another charge", async () => {
    const t = createTest();
    const session = await prepare(t);
    const body = {
      ownerId,
      ...session,
      audioBytes: 32_000,
      durationMs: 1000,
      success: true,
    };
    expect(
      (
        await post(t, "settle", {
          ...body,
          sessionId: `muse_${crypto.randomUUID()}`,
        })
      ).status,
    ).toBe(409);
    expect((await post(t, "settle", body)).status).toBe(200);
    await expect(
      post(t, "settle", { ...body, audioBytes: 64_000 }),
    ).rejects.toThrow("Managed usage changed");
    await expect(
      post(t, "settle", { ...body, ownerId: "another-owner" }),
    ).rejects.toThrow("exact attempt authority");
    expect(
      (await t.run((ctx) => ctx.db.query("billing_usage_windows").first()))
        ?.totalRequestCount,
    ).toBe(1);
  });
  it("fits a ten-cent allowance and settles exact usage without spending the full grant", async () => {
    for (const window of ["LIFETIME", "ROLLING", "WEEKLY", "MONTHLY"])
      vi.stubEnv(`STELLA_FREE_${window}_LIMIT_USD`, "0.10");
    const t = createTest();
    const session = await prepare(t);
    expect(session.providerDeadlineAt - Date.now()).toBe(2_000_000);
    expect(session.maxAudioBytes).toBe(32_000 * 2000);
    expect(
      await t.run((ctx) =>
        ctx.db.query("billing_managed_dispatch_leases").first(),
      ),
    ).toMatchObject({
      billing: { fallbackCostMicroCents: dollarsToMicroCents(0.1) },
    });
    const body = {
      ownerId,
      ...session,
      audioBytes: 32_000 * 60,
      durationMs: 60_000,
      success: true,
    };
    // The caller cannot expand the durable grant with a forged response field.
    expect(
      (
        await post(t, "settle", {
          ...body,
          maxAudioBytes: 32_000 * 3600,
          audioBytes: session.maxAudioBytes + 2,
        })
      ).status,
    ).toBe(400);
    expect(
      await t.run((ctx) =>
        ctx.db.query("billing_managed_dispatch_leases").first(),
      ),
    ).toMatchObject({ billing: { billingState: "pending" } });
    expect((await post(t, "settle", body)).status).toBe(200);
    expect((await post(t, "settle", body)).status).toBe(200);
    expect(
      await t.run((ctx) => ctx.db.query("billing_usage_windows").first()),
    ).toMatchObject({
      totalRequestCount: 1,
      totalUsageMicroCents: dollarsToMicroCents(0.003),
    });
  });
  it("rejects an allowance below one second without reserving a session", async () => {
    for (const window of ["LIFETIME", "ROLLING", "WEEKLY", "MONTHLY"])
      vi.stubEnv(`STELLA_FREE_${window}_LIMIT_USD`, "0.000049");
    const t = createTest();
    expect((await post(t, "prepare", { ownerId })).status).toBe(429);
    expect(
      await t.run((ctx) =>
        ctx.db.query("billing_managed_dispatch_leases").first(),
      ),
    ).toBeNull();
  });
  it.each([
    { allowance: "10", fallbackUsd: 0.18 },
    { allowance: "0.10", fallbackUsd: 0.1 },
  ])(
    "durably charges the bounded fallback with $allowance allowance if the relay disappears",
    async ({ allowance, fallbackUsd }) => {
      for (const window of ["LIFETIME", "ROLLING", "WEEKLY", "MONTHLY"])
        vi.stubEnv(`STELLA_FREE_${window}_LIMIT_USD`, allowance);
      const t = createTest();
      const session = await prepare(t);
      vi.setSystemTime(session.providerDeadlineAt + 45_000);
      const args = { attemptId: session.sessionId, leaseId: session.sessionId };
      await t.mutation(
        internal.billing.finalizeManagedProviderDispatchBillingInternal,
        args,
      );
      await t.mutation(
        internal.billing.finalizeManagedProviderDispatchBillingInternal,
        args,
      );
      expect(
        await t.run((ctx) =>
          ctx.db.query("billing_managed_dispatch_leases").first(),
        ),
      ).toMatchObject({
        state: "terminal",
        billing: {
          billingState: "billed",
          capturedUsage: {
            costMicroCents: dollarsToMicroCents(fallbackUsd),
            success: false,
          },
        },
      });
      expect(
        (await t.run((ctx) => ctx.db.query("billing_usage_windows").first()))
          ?.totalRequestCount,
      ).toBe(1);
    },
  );
  it("rejects provider leases beyond one hour", async () => {
    const t = createTest();
    await expect(
      t.mutation(internal.billing.acquireManagedProviderDispatchInternal, {
        ownerId,
        ownerGeneration: "legacy",
        executionId: "invalid",
        attemptId: "invalid",
        leaseId: "invalid",
        now: Date.now(),
        providerTimeoutMs: MUSE_MAX_SESSION_MS + 1,
      }),
    ).rejects.toThrow("1 hour");
  });
});
