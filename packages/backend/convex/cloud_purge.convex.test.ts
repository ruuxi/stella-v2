/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { ensureExternalOwnerPurge } from "./cloud_purge";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

type PurgeMode = "reset" | "delete";
type PurgeStage = "core" | "cloud" | "complete";
type Fence = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const lifecycle = (
  internal as unknown as {
    owner_lifecycle: {
      beginOwnerDataPurgeInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          mode: PurgeMode;
          now: number;
        },
        {
          operationId: string;
          generation: string;
          mode: PurgeMode;
          stage: PurgeStage;
        }
      >;
      claimOwnerPurgeStageInternal: FunctionReference<
        "mutation",
        "internal",
        Fence & { stage: PurgeStage; leaseId: string; now: number },
        { claimed: boolean; complete: boolean; mode: PurgeMode }
      >;
      renewOwnerPurgeLeaseInternal: FunctionReference<
        "mutation",
        "internal",
        Fence & {
          stage: PurgeStage;
          leaseId: string;
          mode: PurgeMode;
          now: number;
        },
        number
      >;
      advanceOwnerPurgeStageInternal: FunctionReference<
        "mutation",
        "internal",
        Fence & {
          leaseId: string;
          stage: PurgeStage;
          nextStage: PurgeStage;
          now: number;
        },
        boolean
      >;
    };
  }
).owner_lifecycle;

const purgeFunctions = internal as unknown as {
  account_deletion: {
    remainingOwnerAccountCoreStoresInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      string[]
    >;
  };
  reset: {
    _deleteOwnerTableBatch: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        table:
          | "auth_browser_handoffs"
          | "auth_link_requests";
      },
      { hasMore: boolean }
    >;
    remainingOwnerResetStoresInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      string[]
    >;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const beginAndClaim = async (
  t: TestHarness,
  ownerId: string,
  mode: PurgeMode,
  stage: "core" | "cloud",
): Promise<Fence> => {
  const operationId = `${ownerId}-operation`;
  const begun = await t.mutation(lifecycle.beginOwnerDataPurgeInternal, {
    ownerId,
    operationId,
    mode,
    now: 1_000,
  });
  const fence = {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
  };

  const coreLeaseId = `${ownerId}-core-lease`;
  expect(
    await t.mutation(lifecycle.claimOwnerPurgeStageInternal, {
      ...fence,
      stage: "core",
      leaseId: coreLeaseId,
      now: 1_001,
    }),
  ).toMatchObject({ claimed: true, complete: false, mode });
  if (stage === "core") return fence;

  expect(
    await t.mutation(lifecycle.advanceOwnerPurgeStageInternal, {
      ...fence,
      leaseId: coreLeaseId,
      stage: "core",
      nextStage: "cloud",
      now: 1_002,
    }),
  ).toBe(true);
  expect(
    await t.mutation(lifecycle.claimOwnerPurgeStageInternal, {
      ...fence,
      stage: "cloud",
      leaseId: `${ownerId}-cloud-lease`,
      now: 1_003,
    }),
  ).toMatchObject({ claimed: true, complete: false, mode });
  return fence;
};

describe("owner purge adversarial invariants", () => {
  it("renews the exact lease before external I/O and rejects its stale holder after reclaim", async () => {
    const t = createTest();
    const ownerId = "renewed-lease-owner";
    const fence = await beginAndClaim(t, ownerId, "delete", "core");
    const originalLeaseId = `${ownerId}-core-lease`;

    expect(
      await t.mutation(lifecycle.renewOwnerPurgeLeaseInternal, {
        ...fence,
        stage: "core",
        leaseId: originalLeaseId,
        mode: "delete",
        now: 500_000,
      }),
    ).toBe(1_040_000);
    expect(
      await t.mutation(lifecycle.claimOwnerPurgeStageInternal, {
        ...fence,
        stage: "core",
        leaseId: "replacement-lease",
        now: 600_000,
      }),
    ).toMatchObject({ claimed: false, complete: false, mode: "delete" });
    expect(
      await t.mutation(lifecycle.claimOwnerPurgeStageInternal, {
        ...fence,
        stage: "core",
        leaseId: "replacement-lease",
        now: 1_040_001,
      }),
    ).toMatchObject({ claimed: true, complete: false, mode: "delete" });
    await expect(
      t.mutation(lifecycle.renewOwnerPurgeLeaseInternal, {
        ...fence,
        stage: "core",
        leaseId: originalLeaseId,
        mode: "delete",
        now: 1_040_002,
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");
  });

  it("upgrades a released delete rejoin to an exact permanent worker fence", async () => {
    const previousUrl = process.env.CLOUD_BUILDER_URL;
    const previousSecret = process.env.BUILDER_SERVICE_SECRET;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "test-secret";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ generation: "replacement", rejoined: true }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ generation: "replacement", rejoined: false }),
          { status: 200 },
        ),
      );
    const ctx = {
      runQuery: vi.fn().mockResolvedValue({
        externalGeneration: "released-generation",
      }),
      runMutation: vi.fn().mockResolvedValue("replacement"),
    } as unknown as Parameters<typeof ensureExternalOwnerPurge>[0];

    try {
      await expect(
        ensureExternalOwnerPurge(ctx, {
          ownerId: "delete-rejoin-owner",
          operationId: "delete-rejoin-operation",
          generation: "convex-generation",
          mode: "delete",
        }),
      ).resolves.toBe("replacement");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
      );
      const secondBody = JSON.parse(
        String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
      );
      expect(firstBody).toMatchObject({
        mode: "permanent",
        requestId: "delete-rejoin-operation",
        expectedGeneration: "released-generation",
      });
      expect(secondBody).toMatchObject({
        mode: "permanent",
        requestId: "delete-rejoin-operation",
        expectedGeneration: "replacement",
      });
    } finally {
      if (previousUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = previousUrl;
      if (previousSecret === undefined)
        delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = previousSecret;
    }
  });

  it("keys an initial worker fence to the durable lifecycle operation", async () => {
    const previousUrl = process.env.CLOUD_BUILDER_URL;
    const previousSecret = process.env.BUILDER_SERVICE_SECRET;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "test-secret";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ generation: "initial-worker-generation" }),
          { status: 200 },
        ),
      );
    const ctx = {
      runQuery: vi.fn().mockResolvedValue({}),
      runMutation: vi.fn().mockResolvedValue("initial-worker-generation"),
    } as unknown as Parameters<typeof ensureExternalOwnerPurge>[0];

    try {
      await expect(
        ensureExternalOwnerPurge(ctx, {
          ownerId: "initial-begin-owner",
          operationId: "durable-operation-id",
          generation: "convex-generation",
          mode: "reset",
        }),
      ).resolves.toBe("initial-worker-generation");
      const body = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
      );
      expect(body).toEqual({
        ownerId: "initial-begin-owner",
        mode: "temporary",
        requestId: "durable-operation-id",
      });
    } finally {
      if (previousUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = previousUrl;
      if (previousSecret === undefined)
        delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = previousSecret;
    }
  });

  it("refuses account completion for owner-indexed orphan core rows", async () => {
    const t = createTest();
    const ownerId = "account-core-orphan-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId,
        sessionId: "orphan-session",
        revokedAt: 1,
        expiresAt: 20_000,
      });
    });

    expect(
      await t.query(
        purgeFunctions.account_deletion.remainingOwnerAccountCoreStoresInternal,
        { ownerId },
      ),
    ).toEqual(["auth_revoked_sessions"]);
  });

  it("includes ephemeral browser handoffs in the fenced core drain", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "handoff-owner", "reset", "core");
    const rows = await t.run(async (ctx) => ({
      owned: await ctx.db.insert("auth_browser_handoffs", {
        requestId: "owned-request",
        provider: "google",
        fromOwnerId: fence.ownerId,
        fromOwnerGeneration: fence.generation,
        returnOrigin: "https://example.test",
        returnTo: "/",
        status: "pending",
        expiresAt: 20_000,
        createdAt: 1,
      }),
      unrelated: await ctx.db.insert("auth_browser_handoffs", {
        requestId: "other-request",
        provider: "google",
        fromOwnerId: "other-owner",
        fromOwnerGeneration: "legacy",
        returnOrigin: "https://example.test",
        returnTo: "/",
        status: "pending",
        expiresAt: 20_000,
        createdAt: 2,
      }),
    }));

    await t.mutation(purgeFunctions.reset._deleteOwnerTableBatch, {
      ...fence,
      table: "auth_browser_handoffs",
    });
    expect(
      await t.run(async (ctx) => ({
        owned: await ctx.db.get(rows.owned),
        unrelated: await ctx.db.get(rows.unrelated),
      })),
    ).toMatchObject({ owned: null, unrelated: { requestId: "other-request" } });
  });

  it("drains both auth-link principals while retaining reset security state", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "reset-auth-owner", "reset", "core");
    const rows = await t.run(async (ctx) => {
      return {
        fromLink: await ctx.db.insert("auth_link_requests", {
          email: "from@example.test",
          requestId: "from-owner-request",
          status: "pending",
          fromOwnerId: fence.ownerId,
          fromOwnerGeneration: fence.generation,
          expiresAt: 50_000,
          createdAt: 1,
        }),
        toLink: await ctx.db.insert("auth_link_requests", {
          email: "to@example.test",
          requestId: "to-owner-request",
          status: "completed",
          toOwnerId: fence.ownerId,
          toOwnerGeneration: fence.generation,
          tokenEnc: "enc:secret-bearer",
          expiresAt: 50_000,
          createdAt: 2,
        }),
        policy: await ctx.db.insert("auth_revoked_sessions", {
          ownerId: fence.ownerId,
          sessionId: "fenced-session",
          revokedAt: 4,
          expiresAt: 50_000,
        }),

      };
    });


    expect(
      await t.query(purgeFunctions.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).toEqual([
      "auth_link_requests.fromOwnerId",
      "auth_link_requests.toOwnerId",
    ]);

    await t.mutation(purgeFunctions.reset._deleteOwnerTableBatch, {
      ...fence,
      table: "auth_link_requests",
    });

    expect(
      await t.query(purgeFunctions.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.get(rows.policy))).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.fromLink))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.toLink))).toBeNull();
  });
});
