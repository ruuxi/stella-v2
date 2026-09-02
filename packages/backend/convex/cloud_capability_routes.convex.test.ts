/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_CAPABILITY_ISSUERS } from "@stella/contracts/gateway/capability";
import schema from "./schema";
import {
  GATEWAY_CAPABILITY_AUDIENCE,
  createControlPlaneSigner,
  type ControlPlaneSigner,
} from "../tests/helpers/control_plane_capability";

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "https://issuer.test|capability-owner";
const GENERATION = "generation-capability";
const TURN_ID = "turn-capability-1";
const CONVERSATION_ID = "conversation-capability-1";

let signer: ControlPlaneSigner;

beforeAll(async () => {
  signer = await createControlPlaneSigner();
  process.env.CAPABILITY_JWKS = signer.jwksJson;
  delete process.env.PARALLEL_API_KEY;
});

afterEach(() => {
  process.env.CAPABILITY_JWKS = signer.jwksJson;
});

const createTest = async () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return t;
};
type Harness = Awaited<ReturnType<typeof createTest>>;

const mint = (
  overrides: Partial<Parameters<ControlPlaneSigner["mint"]>[0]> = {},
) =>
  signer.mint({
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    turnId: TURN_ID,
    conversationId: CONVERSATION_ID,
    ...overrides,
  });

const post = (t: Harness, path: string, token: string | null, body: unknown) =>
  t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("control-plane capability verification on callback routes", () => {
  it("accepts a builder-issued control-plane turn capability", async () => {
    const t = await createTest();
    const schedule = await post(t, "/api/cloud/schedule", await mint(), {
      action: "list",
      // The capability's subject wins over anything the body claims.
      ownerId: "https://issuer.test|someone-else",
      ownerGeneration: "not-mine",
    });
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toEqual({ ok: true, schedules: [] });
    const search = await post(t, "/api/cloud/web-search", await mint(), {
      query: "stella",
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({
      text: expect.stringContaining("not configured"),
    });
  });

  it("refuses missing, model-gateway, foreign-issuer, expired, and mis-bound capabilities", async () => {
    const t = await createTest();
    expect((await post(t, "/api/cloud/schedule", null, {})).status).toBe(401);
    const gatewayAudience = await post(
      t,
      "/api/cloud/schedule",
      await mint({ audience: GATEWAY_CAPABILITY_AUDIENCE }),
      {},
    );
    expect(gatewayAudience.status).toBe(401);
    expect(await gatewayAudience.json()).toMatchObject({
      reason: "audience_mismatch",
    });
    const convexIssued = await post(
      t,
      "/api/cloud/schedule",
      await mint({ issuer: GATEWAY_CAPABILITY_ISSUERS.convex }),
      {},
    );
    expect(convexIssued.status).toBe(401);
    const expired = await post(
      t,
      "/api/cloud/schedule",
      await mint({ ttlMs: 1_000, now: Date.now() - 10 * 60_000 }),
      {},
    );
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ reason: "expired" });
    const otherTurn = await post(t, "/api/cloud/web-search", await mint(), {
      query: "stella",
      turnId: "another-turn",
    });
    expect(otherTurn.status).toBe(403);
    expect((await post(t, "/api/cloud/schedule", "not.a.jwt", {})).status).toBe(
      401,
    );
  });

  it("lets a turn capability or the service secret reach cloud home routes", async () => {
    const t = await createTest();
    process.env.BUILDER_SERVICE_SECRET = "home-service-secret";
    const viaCapability = await post(
      t,
      "/api/cloud/home/skills/catalog",
      await mint(),
      {
        ownerId: "https://issuer.test|someone-else",
        ownerGeneration: "x",
        agentType: "orchestrator",
      },
    );
    expect(viaCapability.status).toBe(200);
    const viaSecret = await post(
      t,
      "/api/cloud/home/skills/catalog",
      "home-service-secret",
      {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      },
    );
    expect(viaSecret.status).toBe(200);
    expect(await viaSecret.json()).toEqual(await viaCapability.json());
    expect(
      (await post(t, "/api/cloud/home/skills/catalog", "not-a-secret", {}))
        .status,
    ).toBe(401);
    delete process.env.BUILDER_SERVICE_SECRET;
  });

  it("refuses a capability from before an owner reset and a fenced owner", async () => {
    const t = await createTest();
    const before = await mint({ ownerGeneration: "generation-before-reset" });
    const stale = await post(t, "/api/cloud/schedule", before, {});
    expect(stale.status).toBe(409);
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      await ctx.db.patch(lifecycle!._id, { state: "deleting" });
    });
    expect(
      (await post(t, "/api/cloud/schedule", await mint(), {})).status,
    ).toBe(409);
  });

  it("fails closed without a JWKS and refuses keys it does not know", async () => {
    const t = await createTest();
    delete process.env.CAPABILITY_JWKS;
    expect(
      (await post(t, "/api/cloud/schedule", await mint(), {})).status,
    ).toBe(503);
    const other = await createControlPlaneSigner("other-kid");
    process.env.CAPABILITY_JWKS = other.jwksJson;
    const unknownKey = await post(t, "/api/cloud/schedule", await mint(), {});
    expect(unknownKey.status).toBe(401);
    expect(await unknownKey.json()).toMatchObject({ reason: "unknown_key" });
  });

  it("closes the window once the projected turn row says the turn ended", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_turns", {
        turnId: TURN_ID,
        sessionId: "chat-capability",
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        conversationId: CONVERSATION_ID,
        prompt: "hello",
        status: "completed",
        terminalKind: "completed",
        kind: "chat",
        createdAt: 1,
        updatedAt: 2,
      });
    });
    const sync = await post(t, "/api/cloud/drive/sync", await mint(), {});
    expect(sync.status).toBe(409);
    expect(await sync.json()).toEqual({
      error: "Cloud turn is no longer active.",
    });
  });
});
