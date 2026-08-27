/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { sha256Hex } from "./lib/x_oauth";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

beforeAll(() => {
  const values: Record<string, string> = {
    CONVEX_SITE_URL: "https://stella.test",
    STELLA_AUTH_BASE_URL: "https://stella.test",
    X_CLIENT_ID: "x-client-id",
    X_CLIENT_SECRET: "x-client-secret",
    STELLA_SECRETS_MASTER_KEYS_JSON: JSON.stringify({
      "1": Buffer.alloc(32, 17).toString("base64"),
    }),
    STELLA_SECRETS_MASTER_KEY_VERSION: "1",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type TestHarness = ReturnType<typeof createTest>;

const asOwner = (t: TestHarness, ownerId: string, isAnonymous = false) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: ownerId.split("|").slice(-1)[0] ?? ownerId,
    tokenIdentifier: ownerId,
    isAnonymous,
  });

const installOpenGeneration = async (
  t: TestHarness,
  ownerId: string,
  generation: string,
) => {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        generation,
        state: "open",
        operationId: undefined,
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation,
      state: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
};

const createState = async (
  t: TestHarness,
  ownerId: string,
  isAnonymous = false,
) => {
  const result = await asOwner(t, ownerId, isAnonymous).mutation(
    api.data.integrations.createXConnectUrl,
    {},
  );
  const state = new URL(result.url).searchParams.get("state");
  if (!state) throw new Error("Expected X OAuth state in authorization URL.");
  const stateHash = await sha256Hex(state);
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("x_oauth_states")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
      .unique(),
  );
  if (!row) throw new Error("Expected persisted X OAuth state.");
  return { state, row };
};

const xCredentialSnapshot = async (t: TestHarness) =>
  await t.run(async (ctx) => ({
    states: await ctx.db.query("x_oauth_states").collect(),
    tokens: await ctx.db.query("x_oauth_tokens").collect(),
    integrations: await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt")
      .collect(),
  }));

const xRequest = (): RequestInit => ({
  method: "POST",
  headers: {
    Origin: "https://stella.sh",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ method: "GET", path: "/2/users/me" }),
});

const seedToken = async (
  t: TestHarness,
  ownerId: string,
  ownerGeneration: string,
) => {
  await t.mutation(internal.data.integrations.upsertXOAuthTokensForOwner, {
    ownerId,
    ownerGeneration,
    xUserId: `x-${ownerId}`,
    username: "stella_test",
    tokenSet: {
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
      tokenType: "bearer",
      issuedAt: 1,
    },
    scopes: ["tweet.read"],
    tokenType: "bearer",
    accessTokenExpiresAt: 1,
  });
};

describe("X OAuth owner lifecycle and migration fencing", () => {
  it("captures the current owner generation in every newly issued state", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-state-owner";
    await installOpenGeneration(t, ownerId, "x-state-generation");

    const { row } = await createState(t, ownerId);

    expect(row).toMatchObject({
      ownerId,
      ownerGeneration: "x-state-generation",
    });
  });

  it("persists a successful callback in the state generation", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-successful-callback-owner";
    await installOpenGeneration(t, ownerId, "x-successful-generation");
    const { state } = await createState(t, ownerId);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "callback-access-token",
            refresh_token: "callback-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            scope: "tweet.read users.read",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "x-callback-user",
              username: "callback_user",
              name: "Callback User",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const response = await t.fetch(
      `/api/x/oauth_callback?state=${encodeURIComponent(state)}&code=valid-code`,
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.tokens[0]).toMatchObject({
      ownerId,
      ownerGeneration: "x-successful-generation",
      xUserId: "x-callback-user",
      username: "callback_user",
    });
    expect(snapshot.integrations).toHaveLength(1);
    expect(snapshot.integrations[0]).toMatchObject({
      ownerId,
      provider: "x",
      externalId: "x-callback-user",
    });
  });

  it("refreshes and dispatches a request only inside the captured generation", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-successful-request-owner";
    await installOpenGeneration(t, ownerId, "x-request-generation");
    await seedToken(t, ownerId, "x-request-generation");
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            scope: "tweet.read",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "x-me" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const response = await asOwner(t, ownerId).fetch(
      "/api/x/request",
      xRequest(),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "https://api.x.com/2/oauth2/token",
    );
    expect(upstream.mock.calls[1]?.[0]?.toString()).toBe(
      "https://api.x.com/2/users/me",
    );
    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.tokens[0]).toMatchObject({
      ownerId,
      ownerGeneration: "x-request-generation",
    });
    expect(snapshot.tokens[0]?.lastRefreshedAt).toEqual(expect.any(Number));
  });

  it("rejects a pre-reset callback before consuming state or calling X", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-reset-callback-owner";
    await installOpenGeneration(t, ownerId, "x-before-reset");
    const { state, row } = await createState(t, ownerId);
    await installOpenGeneration(t, ownerId, "x-after-reset");
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("stale callback must not call X"));

    const response = await t.fetch(
      `/api/x/oauth_callback?state=${encodeURIComponent(state)}&code=stale-code`,
    );

    expect(response.status).toBe(410);
    expect(upstream).not.toHaveBeenCalled();
    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
    expect(snapshot.states).toHaveLength(1);
    expect(snapshot.states[0]?._id).toBe(row._id);
    expect(snapshot.states[0]?.usedAt).toBeUndefined();
  });

  it("rejects a callback final write when reset wins after state consumption", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-reset-final-write-owner";
    await installOpenGeneration(t, ownerId, "x-callback-generation");
    const { state } = await createState(t, ownerId);
    const consumed = await t.mutation(
      internal.data.integrations.consumeXOAuthState,
      { state },
    );
    if (!consumed) throw new Error("Expected state consumption to succeed.");
    await installOpenGeneration(t, ownerId, "x-reset-winner-generation");

    await expect(
      t.mutation(internal.data.integrations.upsertXOAuthTokensForOwner, {
        ownerId,
        ownerGeneration: consumed.ownerGeneration,
        xUserId: "x-user-after-reset",
        username: "must_not_persist",
        tokenSet: { accessToken: "must-not-persist" },
        scopes: ["tweet.read"],
        tokenType: "bearer",
      }),
    ).rejects.toThrow(/before the account data was reset/u);

    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
  });

  it("rejects a callback while permanent deletion is active with zero writes", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-delete-owner";
    await installOpenGeneration(t, ownerId, "x-before-delete");
    const { state, row } = await createState(t, ownerId);
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId,
      operationId: "delete-x-owner",
      mode: "delete",
      now: Date.now(),
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("deleted owner must not call X"));

    const response = await t.fetch(
      `/api/x/oauth_callback?state=${encodeURIComponent(state)}&code=stale-code`,
    );

    expect(response.status).toBe(410);
    expect(upstream).not.toHaveBeenCalled();
    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
    expect(snapshot.states[0]?._id).toBe(row._id);
    expect(snapshot.states[0]?.usedAt).toBeUndefined();
  });

  it("fences callbacks for both owners throughout ownership migration", async () => {
    const t = createTest();
    const fromOwnerId = "https://issuer.test|x-migration-source";
    const toOwnerId = "https://issuer.test|x-migration-destination";
    await installOpenGeneration(t, fromOwnerId, "x-source-generation");
    await installOpenGeneration(t, toOwnerId, "x-destination-generation");
    const source = await createState(t, fromOwnerId, true);
    const destination = await createState(t, toOwnerId);
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("migrating owners must not call X"));

    for (const state of [source.state, destination.state]) {
      const response = await t.fetch(
        `/api/x/oauth_callback?state=${encodeURIComponent(state)}&code=stale-code`,
      );
      expect(response.status).toBe(410);
    }

    expect(upstream).not.toHaveBeenCalled();
    const snapshot = await xCredentialSnapshot(t);
    expect(snapshot.tokens).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
    expect(snapshot.states).toHaveLength(2);
    expect(snapshot.states.every((row) => row.usedAt === undefined)).toBe(true);
  });

  it("blocks stale refresh and request dispatch after reset", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|x-stale-request-owner";
    await installOpenGeneration(t, ownerId, "x-request-before-reset");
    await seedToken(t, ownerId, "x-request-before-reset");
    await installOpenGeneration(t, ownerId, "x-request-after-reset");
    const before = await xCredentialSnapshot(t);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("stale refresh must not call X"));

    const response = await asOwner(t, ownerId).fetch(
      "/api/x/request",
      xRequest(),
    );

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(await xCredentialSnapshot(t)).toEqual(before);
  });

  it("blocks request dispatch for both migration directions without token writes", async () => {
    const t = createTest();
    const fromOwnerId = "https://issuer.test|x-request-migration-source";
    const toOwnerId = "https://issuer.test|x-request-migration-destination";
    await installOpenGeneration(t, fromOwnerId, "x-request-source-generation");
    await installOpenGeneration(
      t,
      toOwnerId,
      "x-request-destination-generation",
    );
    await seedToken(t, fromOwnerId, "x-request-source-generation");
    await seedToken(t, toOwnerId, "x-request-destination-generation");
    const before = await xCredentialSnapshot(t);
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const afterFence = await xCredentialSnapshot(t);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("migrating request must not call X"));

    for (const ownerId of [fromOwnerId, toOwnerId]) {
      const response = await asOwner(t, ownerId).fetch(
        "/api/x/request",
        xRequest(),
      );
      expect(response.status).toBe(401);
    }

    expect(upstream).not.toHaveBeenCalled();
    expect(await xCredentialSnapshot(t)).toEqual(afterFence);
    expect(afterFence.tokens).toEqual(before.tokens);
    expect(afterFence.integrations).toEqual(before.integrations);
  });
});
