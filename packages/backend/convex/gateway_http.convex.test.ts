/// <reference types="vite/client" />

import { GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS } from "@stella/contracts/gateway/api";
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listManagedModelIds } from "@stella/model-catalog/model";
import { STATIC_MANAGED_MODEL_PRICE_OVERRIDES } from "@stella/model-catalog/pricing";
import {
  CONVEX_GATEWAY_CONFIG_PATH,
  CONVEX_GATEWAY_ENGINE_ACCESS_PATH,
  CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,

  CONVEX_GATEWAY_USAGE_PATH,
  type GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import { components, internal } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import { encryptEnginePayload } from "./cloud_engines";
import { dollarsToMicroCents } from "./lib/billing_money";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const SERVICE_SECRET = "gateway-service-secret";
const OWNER_ID = "https://convex.test|gateway-owner";
const OWNER_GENERATION = "gateway-generation";
const ANON_OWNER_ID = "https://convex.test|gateway-anon";
const ANON_MAX_REQUESTS = 3;
const DEVICE_KEY_HASH = "A".repeat(43);

const toPem = (pkcs8: Uint8Array) => {
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
};

beforeAll(async () => {
  const values: Record<string, string> = {
    GATEWAY_SERVICE_SECRET: SERVICE_SECRET,
    STELLA_ADMIN_API_SECRET: "gateway-admin-secret",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "100",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "200",
    STELLA_FREE_MONTHLY_LIMIT_USD: "300",
    STELLA_FREE_LIFETIME_LIMIT_USD: "8",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: String(ANON_MAX_REQUESTS),
    STELLA_ANON_LIFETIME_LIMIT_USD: "0.10",
    ANON_DEVICE_ID_HASH_SALT: "gateway-test-salt",
    CAPABILITY_SIGNING_KID: "convex-test",
    CLOUD_LLM_CREDENTIALS_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
    MODEL_GATEWAY_URL: "https://gateway.test/",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  process.env.CAPABILITY_SIGNING_KEY = toPem(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
});

afterEach(() => {
  process.env.GATEWAY_SERVICE_SECRET = SERVICE_SECRET;
  process.env.STELLA_ADMIN_API_SECRET = "gateway-admin-secret";
  process.env.MODEL_GATEWAY_URL = "https://gateway.test/";
  delete process.env.STELLA_DEPLOYMENT_IDENTITY;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.restoreAllMocks();
});

const createTest = async () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(t);
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const ownerId of [OWNER_ID, ANON_OWNER_ID]) {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("conversations", {
      ownerId: OWNER_ID,
      isDefault: true,
      eventCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("conversations", {
      ownerId: ANON_OWNER_ID,
      isDefault: true,
      eventCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
  return t;
};

type Harness = Awaited<ReturnType<typeof createTest>>;

const serviceHeaders = {
  authorization: `Bearer ${SERVICE_SECRET}`,
  "content-type": "application/json",
};

const post = (
  t: Harness,
  path: string,
  body: unknown,
  headers = serviceHeaders,
) => t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });

const usageEvent = (
  overrides: Partial<GatewayUsageEvent> & { requestId: string },
): GatewayUsageEvent => ({
  v: 1,
  capabilityId: "cap-1",
  kind: "session",
  ownerId: OWNER_ID,
  ownerGeneration: OWNER_GENERATION,
  audience: "free",
  agentType: "chat",
  provider: "anthropic",
  protocol: "anthropic-messages",
  requestedModel: "stella/default",
  resolvedModel: "anthropic/claude-sonnet-4.6",
  usage: { inputTokens: 100, outputTokens: 20, reported: true },
  chargedMicroCents: 1_234,
  outcome: "succeeded",
  startedAt: 1_000,
  finishedAt: 1_250,
  billable: true,
  ...overrides,
});


describe("gateway service authentication", () => {
  it("rejects missing or wrong bearer secrets and disables itself without one", async () => {
    const t = await createTest();
    const unauthenticated = await t.fetch(CONVEX_GATEWAY_CONFIG_PATH, {
      method: "GET",
    });
    expect(unauthenticated.status).toBe(401);
    const wrong = await t.fetch(CONVEX_GATEWAY_CONFIG_PATH, {
      method: "GET",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect(wrong.status).toBe(401);
    delete process.env.GATEWAY_SERVICE_SECRET;
    const disabled = await t.fetch(CONVEX_GATEWAY_CONFIG_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    expect(disabled.status).toBe(503);
  });
});

describe("GET /api/gateway/owner-enforcement", () => {
  it("requires the gateway bearer and returns the authoritative versioned state", async () => {
    const t = await createTest();
    const unauthenticated = await t.fetch(
      `${CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH}?ownerId=${encodeURIComponent(OWNER_ID)}`,
      { method: "GET" },
    );
    expect(unauthenticated.status).toBe(401);

    const absent = await t.fetch(
      `${CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH}?ownerId=${encodeURIComponent(OWNER_ID)}`,
      { method: "GET", headers: serviceHeaders },
    );
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      enforcement: { status: "ok" },
      updatedAt: null,
    });

    const changed = await t.mutation(
      internal.owner_enforcement.setOwnerEnforcementInternal,
      {
        ownerId: OWNER_ID,
        status: "suspended",
        reason: "test enforcement",
        actor: "test",
      },
    );
    const response = await t.fetch(
      `${CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH}?ownerId=${encodeURIComponent(OWNER_ID)}`,
      { method: "GET", headers: serviceHeaders },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enforcement: { status: "suspended", reason: "test enforcement" },
      updatedAt: changed.updatedAt,
    });
  });

  it("rejects a missing owner id", async () => {
    const t = await createTest();
    const response = await t.fetch(CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH, {
      method: "GET",
      headers: serviceHeaders,
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/gateway/alerts", () => {
  it("forwards an authenticated gateway alert to the shared webhook", async () => {
    const t = await createTest();
    process.env.STELLA_ALERT_WEBHOOK_URL = "https://alerts.test/hook";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const response = await post(t, "/api/gateway/alerts", {
      text: "Gateway breaker tripped",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://alerts.test/hook",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Gateway breaker tripped" }),
      }),
    );
    delete process.env.STELLA_ALERT_WEBHOOK_URL;
  });
});

describe("POST /api/gateway/usage", () => {

  it("treats a request id repeated inside one batch as a duplicate", async () => {
    const t = await createTest();
    const response = await post(t, CONVEX_GATEWAY_USAGE_PATH, {
      v: 1,
      events: [
        usageEvent({ requestId: "twice" }),
        usageEvent({ requestId: "twice" }),
      ],
    });
    expect(await response.json()).toEqual({
      accepted: ["twice"],
      duplicate: ["twice"],
      rejected: [],
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("gateway_usage_receipts").collect()),
    ).toHaveLength(1);
  });


  it("rejects malformed batches", async () => {
    const t = await createTest();
    expect(
      (await post(t, CONVEX_GATEWAY_USAGE_PATH, { v: 2, events: [] })).status,
    ).toBe(400);
    expect((await post(t, CONVEX_GATEWAY_USAGE_PATH, { v: 1 })).status).toBe(
      400,
    );
  });
});

describe("GET /api/gateway/config", () => {
  it("serves synced prices, static fill-ins, and anonymous ceilings", async () => {
    const t = await createTest();
    const syncedModel = listManagedModelIds()[0]!;
    const staticModel = Object.keys(STATIC_MANAGED_MODEL_PRICE_OVERRIDES).find(
      (model) => model !== syncedModel,
    )!;
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_model_prices", {
        model: syncedModel,
        source: "models.dev",
        sourceProvider: "test",
        sourceModelId: syncedModel,
        inputPerMillionUsd: 1.5,
        outputPerMillionUsd: 6,
        cacheReadPerMillionUsd: 0.15,
        cacheWritePerMillionUsd: 1.875,
        reasoningPerMillionUsd: 6,
        sourceUpdatedAt: "2026-01-01",
        syncedAt: 1_700_000_000_000,
      });
    });
    const response = await t.fetch(CONVEX_GATEWAY_CONFIG_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      v: number;
      prices: Array<Record<string, unknown>>;
      anonymous: Record<string, number>;
      tierCeilings: Array<Record<string, number | string>>;
      updatedAt: number;
    };
    expect(body.v).toBe(1);
    expect(body.anonymous).toEqual({
      maxRequestsPerOwner: ANON_MAX_REQUESTS,
      maxRequestsPerIp: ANON_MAX_REQUESTS * 10,
    });
    expect(body.tierCeilings).toEqual([
      {
        audience: "anonymous",
        hourlyMicroCents: dollarsToMicroCents(20),
        dailyMicroCents: dollarsToMicroCents(200),
      },
      {
        audience: "free",
        hourlyMicroCents: dollarsToMicroCents(100),
        dailyMicroCents: dollarsToMicroCents(1_000),
      },
    ]);
    expect(body.updatedAt).toBe(1_700_000_000_000);
    expect(body.prices.find((price) => price.model === syncedModel)).toEqual({
      model: syncedModel,
      inputPerMillionUsd: 1.5,
      outputPerMillionUsd: 6,
      cacheReadPerMillionUsd: 0.15,
      cacheWritePerMillionUsd: 1.875,
      reasoningPerMillionUsd: 6,
    });
    const staticPrice = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[staticModel]!;
    expect(body.prices.find((price) => price.model === staticModel)).toEqual({
      model: staticModel,
      inputPerMillionUsd: staticPrice.inputPerMillionUsd,
      outputPerMillionUsd: staticPrice.outputPerMillionUsd,
      cacheReadPerMillionUsd: staticPrice.cacheReadPerMillionUsd ?? 0,
      cacheWritePerMillionUsd: staticPrice.cacheWritePerMillionUsd ?? 0,
      reasoningPerMillionUsd:
        staticPrice.reasoningPerMillionUsd ?? staticPrice.outputPerMillionUsd,
    });
  });
});

describe("POST /api/gateway/engine-access", () => {
  it("resolves a stored credential with its expiry and fails closed otherwise", async () => {
    const t = await createTest();
    const request = (body: unknown) =>
      post(t, CONVEX_GATEWAY_ENGINE_ACCESS_PATH, body);

    expect(
      (
        await request({
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          provider: "gemini",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          ownerId: OWNER_ID,
          ownerGeneration: "stale",
          provider: "anthropic",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request({
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          provider: "anthropic",
        })
      ).status,
    ).toBe(404);

    const expires = Date.now() + 3_600_000;
    const payloadEncrypted = await encryptEnginePayload({
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires,
      accountId: "acct-123",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_llm_credentials", {
        ownerId: OWNER_ID,
        provider: "openai-codex",
        payloadEncrypted,
        label: "test",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const resolved = await request({
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      provider: "openai-codex",
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      accessToken: "codex-access-token",
      accountId: "acct-123",
      expiresAt: expires,
    });
  });
});


describe("owner enforcement admin routes", () => {
  it("sets enforcement by email and returns the owner control-plane summary", async () => {
    const t = await createTest();
    const ownerId = await (async () => {
      const user = (await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: "user",
          data: {
            name: "admin-lookup",
            email: "admin-lookup@stella.test",
            emailVerified: true,
            isAnonymous: false,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      })) as { _id: string };
      const value = tokenIdentifierForBetterAuthUserId(user._id);
      await t.run(async (ctx) => {
        await ctx.db.insert("cloud_owner_lifecycles", {
          ownerId: value,
          generation: OWNER_GENERATION,
          state: "open",
          createdAt: 1,
          updatedAt: 1,
        });
      });
      return value;
    })();
    const headers = {
      authorization: "Bearer gateway-admin-secret",
      "content-type": "application/json",
    };
    const changed = await t.fetch("/api/admin/owners/enforcement", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "admin-lookup@stella.test",
        status: "throttled",
        reason: "automated review",
      }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      ownerId,
      enforcement: { status: "throttled", reason: "automated review" },
    });

    const lookup = await t.fetch(
      `/api/admin/owners/lookup?ownerId=${encodeURIComponent(ownerId)}`,
      { method: "GET", headers },
    );
    expect(lookup.status).toBe(200);
    const payload = (await lookup.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ownerId,
      isAnonymous: false,
      email: "admin-lookup@stella.test",
      plan: "free",
      enforcement: { status: "throttled", reason: "automated review" },
      usageReceipts: [],
    });
  });

  it("returns the highest-risk owners for an authenticated top query", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      for (const [ownerId, score] of [
        ["low-risk", 10],
        ["high-risk", 90],
      ] as const) {
        await ctx.db.insert("owner_risk_signals", {
          ownerId,
          window: "24h",
          requests: score,
          chargedMicroCents: score,
          mints: score,
          hostingRequests: 0,
          distinctIps: 0,
          ipHashes: [],
          distinctConversations: 0,
          conversationIds: [],
          failedRequests: 0,
          sybilFlags: 0,
          score,
          updatedAt: Date.now(),
        });
      }
    });
    const response = await t.fetch(
      "/api/admin/owners/top?window=24h&by=score",
      {
        method: "GET",
        headers: { authorization: "Bearer gateway-admin-secret" },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      window: "24h",
      by: "score",
      owners: [
        { ownerId: "high-risk", score: 90 },
        { ownerId: "low-risk", score: 10 },
      ],
    });
  });
});

describe("GET /api/stella/models", () => {
  it("advertises the model gateway origin", async () => {
    const t = await createTest();
    const response = await t.fetch("/api/stella/models", { method: "GET" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; api: string }>;
      gateway: { origin: string };
      updatedAt: number;
    };
    expect(body.gateway).toEqual({ origin: "https://gateway.test" });
    expect(body.data.length).toBeGreaterThan(0);
    expect(
      body.data.find(
        (model) => model.id === "stella/meta/muse-spark-1.3-contributor",
      )?.api,
    ).toBe("openai-responses");
  });

  it("fails in production when the gateway origin is unset", async () => {
    const t = await createTest();
    delete process.env.MODEL_GATEWAY_URL;
    process.env.STELLA_DEPLOYMENT_IDENTITY = "prod:intent-jackal-330";
    const response = await t.fetch("/api/stella/models", { method: "GET" });
    expect(response.status).toBe(500);
  });
});
