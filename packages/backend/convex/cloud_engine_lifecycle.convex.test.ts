/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
const originalCredentialKey = process.env.CLOUD_LLM_CREDENTIALS_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCredentialKey === undefined) {
    delete process.env.CLOUD_LLM_CREDENTIALS_KEY;
  } else {
    process.env.CLOUD_LLM_CREDENTIALS_KEY = originalCredentialKey;
  }
});

const reopenOwnerAfterReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  nextGeneration: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `reset-${ownerId}`,
      mode: "reset",
      now: 10_000,
    },
  );
  const coreLeaseId = `core-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: coreLeaseId,
    now: 10_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: coreLeaseId,
    stage: "core",
    nextStage: "cloud",
    now: 10_002,
  });
  const cloudLeaseId = `cloud-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: cloudLeaseId,
    now: 10_003,
  });
  expect(
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration,
      now: 10_004,
    }),
  ).toBe(true);
};

const createConnect = (
  t: ReturnType<typeof createTest>,
  args: {
    ownerId: string;
    ownerGeneration: string;
    connectId: string;
    now?: number;
  },
) =>
  t.mutation(internal.cloud_engines.createConnectInternal, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    connectId: args.connectId,
    provider: "anthropic",
    verifier: `verifier-${args.connectId}`,
    state: `state-${args.connectId}`,
    now: args.now ?? 1,
  });

describe("cloud engine connect generation fencing", () => {
  it("drops an actual OAuth response when reset completes during token exchange", async () => {
    const t = createTest();
    const ownerId = "https://issuer.test|cloud-engine-action-owner";
    const connectId = "cloud-engine-action-connect";
    await createConnect(t, {
      ownerId,
      ownerGeneration: "legacy",
      connectId,
      now: Date.now(),
    });
    process.env.CLOUD_LLM_CREDENTIALS_KEY = btoa(
      String.fromCharCode(...new Uint8Array(32)),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await reopenOwnerAfterReset(t, ownerId, "cloud-engine-action-next");
        return new Response(
          JSON.stringify({
            access_token: "stale-access-token",
            refresh_token: "stale-refresh-token",
            expires_in: 3_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const owner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "cloud-engine-action-owner",
      tokenIdentifier: ownerId,
    });

    await expect(
      owner.action(api.cloud_engines.finishEngineConnect, {
        connectId,
        pastedInput: `code-${connectId}`,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("cloud_llm_credentials").collect(),
      ),
    ).toEqual([]);
  });

  it("rejects a final credential write when reset wins after dispatch admission", async () => {
    const t = createTest();
    const ownerId = "cloud-engine-reset-owner";
    const connectId = "cloud-engine-reset-connect";
    await createConnect(t, {
      ownerId,
      ownerGeneration: "legacy",
      connectId,
    });
    await expect(
      t.mutation(internal.cloud_engines.assertConnectDispatchAllowedInternal, {
        ownerId,
        ownerGeneration: "legacy",
        connectId,
        now: 2,
      }),
    ).resolves.toBeNull();

    await reopenOwnerAfterReset(t, ownerId, "cloud-engine-next");
    await expect(
      t.mutation(internal.cloud_engines.storeCredentialInternal, {
        ownerId,
        ownerGeneration: "legacy",
        provider: "anthropic",
        payloadEncrypted: "stale-encrypted-payload",
        label: "stale",
        now: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    await expect(
      t.mutation(internal.cloud_engines.assertConnectDispatchAllowedInternal, {
        ownerId,
        ownerGeneration: "legacy",
        connectId,
        now: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("cloud_llm_credentials").collect(),
      ),
    ).toEqual([]);
  });

  it("allows a newly admitted connect in the reopened generation", async () => {
    const t = createTest();
    const ownerId = "cloud-engine-current-owner";
    const ownerGeneration = "cloud-engine-current";
    await reopenOwnerAfterReset(t, ownerId, ownerGeneration);
    await expect(
      createConnect(t, {
        ownerId,
        ownerGeneration,
        connectId: "cloud-engine-current-connect",
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.cloud_engines.storeCredentialInternal, {
        ownerId,
        ownerGeneration,
        provider: "anthropic",
        payloadEncrypted: "current-encrypted-payload",
        label: "current",
        now: 20_000,
      }),
    ).resolves.toBeNull();
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("cloud_llm_credentials").unique(),
      ),
    ).toMatchObject({ ownerId, payloadEncrypted: "current-encrypted-payload" });
  });

  it("rejects connect and credential writes during permanent deletion", async () => {
    const t = createTest();
    const ownerId = "cloud-engine-delete-owner";
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId,
      operationId: "delete-cloud-engine-owner",
      mode: "delete",
      now: 30_000,
    });
    await expect(
      createConnect(t, {
        ownerId,
        ownerGeneration: "legacy",
        connectId: "cloud-engine-delete-connect",
      }),
    ).rejects.toThrow(/being deleted/u);
    await expect(
      t.mutation(internal.cloud_engines.storeCredentialInternal, {
        ownerId,
        ownerGeneration: "legacy",
        provider: "anthropic",
        payloadEncrypted: "delete-encrypted-payload",
        label: "delete",
        now: 30_001,
      }),
    ).rejects.toThrow(/being deleted/u);
    expect(
      await t.run(async (ctx) => ({
        connects: await ctx.db.query("cloud_engine_connects").collect(),
        credentials: await ctx.db.query("cloud_llm_credentials").collect(),
      })),
    ).toEqual({ connects: [], credentials: [] });
  });

  it("fences both owners during ownership migration", async () => {
    const t = createTest();
    const fromOwnerId = "cloud-engine-migration-source";
    const toOwnerId = "cloud-engine-migration-target";
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const claim = await t.mutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        fromOwnerId,
        toOwnerId,
        leaseId: "cloud-engine-migration-lease",
        now: 40_000,
      },
    );
    if (!("fromOwnerGeneration" in claim)) {
      throw new Error("Ownership migration did not capture generations.");
    }

    for (const [ownerId, ownerGeneration, suffix] of [
      [fromOwnerId, claim.fromOwnerGeneration, "source"],
      [toOwnerId, claim.toOwnerGeneration, "target"],
    ] as const) {
      await expect(
        createConnect(t, {
          ownerId,
          ownerGeneration,
          connectId: `cloud-engine-migration-${suffix}`,
        }),
      ).rejects.toThrow(/linked to an account/u);
      await expect(
        t.mutation(internal.cloud_engines.storeCredentialInternal, {
          ownerId,
          ownerGeneration,
          provider: "anthropic",
          payloadEncrypted: `migration-${suffix}`,
          label: suffix,
          now: 40_001,
        }),
      ).rejects.toThrow(/linked to an account/u);
    }
    expect(
      await t.run(async (ctx) => ({
        connects: await ctx.db.query("cloud_engine_connects").collect(),
        credentials: await ctx.db.query("cloud_llm_credentials").collect(),
      })),
    ).toEqual({ connects: [], credentials: [] });
  });
});
