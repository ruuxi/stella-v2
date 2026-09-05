import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
} from "@stella/contracts/gateway/capability";
import {
  generateCapabilityKeyPair,
  importCapabilitySigningKey,
  signCapability,
} from "@stella/contracts/gateway/jwt";
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_SECRET = "cloud-home-http-service-secret";
const OWNER_ID = "owner:cloud-home-http";
const OWNER_GENERATION = "generation:cloud-home-http";

beforeEach(() => {
  process.env.BUILDER_SERVICE_SECRET = SERVICE_SECRET;
});

afterEach(() => {
  delete process.env.BUILDER_SERVICE_SECRET;
  delete process.env.CAPABILITY_JWKS;
});

describe("Cloud Home private HTTP routes", () => {
  it("binds optimized reads to the signed owner and refuses stale, deleting, and invalid authorities", async () => {
    const t = convexTest(schema, modules);
    const pair = await generateCapabilityKeyPair();
    const key = await importCapabilitySigningKey(
      pair.privateKeyPem,
      "home-read",
    );
    process.env.CAPABILITY_JWKS = JSON.stringify({
      keys: [
        {
          kid: "home-read",
          issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
          jwk: pair.publicJwk,
        },
      ],
    });
    const { token } = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        aud: CONTROL_PLANE_CAPABILITY_AUDIENCE,
        sub: OWNER_ID,
        gen: OWNER_GENERATION,
        kind: "turn",
        audience: "pro",
        budgetMicroCents: 10,
        turn: {
          turnId: "turn-home",
          conversationId: "conversation-home",
          execution: {
            engine: "stella",
            provider: "stella",
            model: "stella/default",
            reasoningEffort: "default",
          },
        },
      },
      key,
      { ttlMs: 60_000 },
    );
    const lifecycleId = await t.run(async (ctx) =>
      ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const read = (path: string, bearer = token) =>
      t.fetch(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId: "spoofed-owner",
          ownerGeneration: "spoofed-generation",
          ...(path.includes("skills") ? { agentType: "orchestrator" } : {}),
        }),
      });
    const paths = [
      "/api/cloud/home/memory/preference",
      "/api/cloud/home/skills/catalog",
    ];
    for (const path of paths) {
      expect((await read(path)).status).toBe(200);
      expect((await read(path, "invalid")).status).toBe(401);
    }
    await t.run(async (ctx) =>
      ctx.db.patch(lifecycleId, { generation: "rotated" }),
    );
    for (const path of paths) expect((await read(path)).ok).toBe(false);
    await t.run(async (ctx) =>
      ctx.db.patch(lifecycleId, {
        generation: OWNER_GENERATION,
        state: "deleting",
      }),
    );
    for (const path of paths) expect((await read(path)).ok).toBe(false);
  });

  it("calls read-only controls without an undeclared mutation timestamp", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("cloud_agent_home_preferences", {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        memoryEnabled: false,
        revision: 1,
        lastRequestId: "cloud-home-http-preference",
        lastRequestExpectedRevision: 0,
        lastRequestMemoryEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const response = await t.fetch("/api/cloud/home/memory/preference", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ownerGeneration: OWNER_GENERATION,
      memoryEpoch: "legacy",
      memoryEnabled: false,
      revision: 1,
      updatedAt: now,
    });
  });
});
