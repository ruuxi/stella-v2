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
});

describe("Cloud Home private HTTP routes", () => {
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
