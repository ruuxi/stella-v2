/// <reference types="vite/client" />

import { S3Client } from "@aws-sdk/client-s3";
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
  cloud_purge: {
    purgeOwnerCloudStack: FunctionReference<
      "action",
      "internal",
      Fence,
      { pending: string[] }
    >;
    deleteOwnerCloudBatch: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        table:
          | "cloud_app_storage"
          | "agent_events"
          | "cloud_integration_call_receipts";
      },
      { hasMore: boolean }
    >;
    getOwnerIntegrationCallQuiescenceInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string; now: number },
      { ready: boolean; nextCheckAt?: number }
    >;
    remainingOwnerStoresInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      string[]
    >;
  };
  reset: {
    _deleteConversationBatch: FunctionReference<
      "mutation",
      "internal",
      Fence & { conversationId: Id<"conversations"> },
      { hasMore: boolean }
    >;
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
  data: {
    canvas_shares: {
      deleteConfirmedOwnerShareRows: FunctionReference<
        "mutation",
        "internal",
        Fence & {
          leaseId: string;
          mode: PurgeMode;
          refs: Array<{
            id: Id<"canvas_shares">;
            slug: string;
            r2Key: string;
          }>;
        },
        { deleted: number }
      >;
      reserveSharePublication: FunctionReference<
        "mutation",
        "internal",
        {
          slug: string;
          ownerUserId: string;
          ownerGeneration: string;
          r2Key: string;
          createdAt: number;
          publicationLeaseExpiresAt: number;
        },
        Id<"canvas_shares">
      >;
      finishSharePublication: FunctionReference<
        "mutation",
        "internal",
        {
          id: Id<"canvas_shares">;
          ownerUserId: string;
          ownerGeneration: string;
          slug: string;
          r2Key: string;
          expiresAt: number;
        },
        boolean
      >;
      deleteConfirmedSharePublication: FunctionReference<
        "mutation",
        "internal",
        {
          id: Id<"canvas_shares">;
          ownerUserId: string;
          ownerGeneration: string;
          slug: string;
          r2Key: string;
        },
        boolean
      >;
    };
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

  it("retains failed canvas R2 locators and deletes them on a confirmed retry", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "canvas-owner", "delete", "core");
    const rows = await t.run(async (ctx) => ({
      confirmed: await ctx.db.insert("canvas_shares", {
        slug: "confirmed",
        ownerUserId: fence.ownerId,
        r2Key: "shares/confirmed.html",
        createdAt: 1,
        expiresAt: 20_000,
        revoked: false,
      }),
      failed: await ctx.db.insert("canvas_shares", {
        slug: "failed",
        ownerUserId: fence.ownerId,
        r2Key: "shares/failed.html",
        createdAt: 2,
        expiresAt: 20_000,
        revoked: false,
      }),
    }));

    expect(
      await t.mutation(
        purgeFunctions.data.canvas_shares.deleteConfirmedOwnerShareRows,
        {
          ...fence,
          leaseId: "canvas-owner-core-lease",
          mode: "delete",
          // The action passes only fulfilled R2 deletes. The failed locator is
          // deliberately absent and therefore remains durable for retry.
          refs: [
            {
              id: rows.confirmed,
              slug: "confirmed",
              r2Key: "shares/confirmed.html",
            },
          ],
        },
      ),
    ).toEqual({ deleted: 1 });
    expect(
      await t.run(async (ctx) => ({
        confirmed: await ctx.db.get(rows.confirmed),
        failed: await ctx.db.get(rows.failed),
      })),
    ).toMatchObject({
      confirmed: null,
      failed: { r2Key: "shares/failed.html" },
    });

    expect(
      await t.mutation(
        purgeFunctions.data.canvas_shares.deleteConfirmedOwnerShareRows,
        {
          ...fence,
          leaseId: "canvas-owner-core-lease",
          mode: "delete",
          refs: [
            {
              id: rows.failed,
              slug: "failed",
              r2Key: "shares/failed.html",
            },
          ],
        },
      ),
    ).toEqual({ deleted: 1 });
    expect(await t.run(async (ctx) => ctx.db.get(rows.failed))).toBeNull();
  });

  it("keeps an in-flight canvas locator fenced until external cleanup acknowledges it", async () => {
    const t = createTest();
    const ownerId = "canvas-race-owner";
    const publicationId = await t.mutation(
      purgeFunctions.data.canvas_shares.reserveSharePublication,
      {
        slug: "race-share",
        ownerUserId: ownerId,
        ownerGeneration: "legacy",
        r2Key: "shares/race-share.html",
        createdAt: 1,
        publicationLeaseExpiresAt: 50_000,
      },
    );
    await beginAndClaim(t, ownerId, "delete", "core");

    await expect(
      t.mutation(purgeFunctions.data.canvas_shares.finishSharePublication, {
        id: publicationId,
        ownerUserId: ownerId,
        ownerGeneration: "legacy",
        slug: "race-share",
        r2Key: "shares/race-share.html",
        expiresAt: 100_000,
      }),
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.get(publicationId))).toMatchObject(
      {
        publicationState: "uploading",
        r2Key: "shares/race-share.html",
      },
    );
    expect(
      await t.mutation(
        purgeFunctions.data.canvas_shares.deleteConfirmedSharePublication,
        {
          id: publicationId,
          ownerUserId: ownerId,
          ownerGeneration: "legacy",
          slug: "race-share",
          r2Key: "shares/race-share.html",
        },
      ),
    ).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(publicationId))).toBeNull();
  });

  it("drains app storage for both owner and user principals", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "dual-principal", "reset", "cloud");
    const rows = await t.run(async (ctx) => ({
      owned: await ctx.db.insert("cloud_app_storage", {
        appId: "owned-app",
        ownerId: fence.ownerId,
        userId: "another-user",
        key: "owned",
        valueJson: "{}",
        sizeBytes: 2,
        updatedAt: 1,
      }),
      used: await ctx.db.insert("cloud_app_storage", {
        appId: "foreign-app",
        ownerId: "another-owner",
        userId: fence.ownerId,
        key: "used",
        valueJson: "{}",
        sizeBytes: 2,
        updatedAt: 2,
      }),
      unrelated: await ctx.db.insert("cloud_app_storage", {
        appId: "other-app",
        ownerId: "another-owner",
        userId: "another-user",
        key: "unrelated",
        valueJson: "{}",
        sizeBytes: 2,
        updatedAt: 3,
      }),
    }));

    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_app_storage",
    });
    expect(
      await t.run(async (ctx) => ({
        owned: await ctx.db.get(rows.owned),
        used: await ctx.db.get(rows.used),
        unrelated: await ctx.db.get(rows.unrelated),
      })),
    ).toMatchObject({
      owned: null,
      used: null,
      unrelated: { key: "unrelated" },
    });
  });

  it("finds and drains owner-attributed events even when the parent turn is missing", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "orphan-event-owner",
      "delete",
      "cloud",
    );
    const eventId = await t.run(async (ctx) =>
      ctx.db.insert("agent_events", {
        ownerId: fence.ownerId,
        turnId: "missing-parent-turn",
        sessionId: "missing-parent-session",
        seq: 1,
        kind: "tool",
        payloadJson: '{"private":"owner-data"}',
        createdAt: 1,
      }),
    );

    expect(
      await t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).toContain("agent_events");
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "agent_events",
    });
    expect(await t.run(async (ctx) => ctx.db.get(eventId))).toBeNull();
  });

  it("retains browser interaction debt until the fenced Gateway profile purge succeeds", async () => {
    vi.stubEnv("CLOUD_BUILDER_URL", "https://builder.example.test");
    vi.stubEnv("BUILDER_SERVICE_SECRET", "test-secret");
    const purgeBodies: Array<Record<string, unknown>> = [];
    let purgeAttempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/owners/purge/begin")) {
        return Response.json({
          generation: "worker-browser-purge-generation",
          rejoined: false,
        });
      }
      if (url.endsWith("/owners/purge")) {
        purgeBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        purgeAttempt += 1;
        return Response.json({
          pending: purgeAttempt === 1 ? ["browser-profile:default"] : [],
        });
      }
      throw new Error(`Unexpected purge request: ${url}`);
    });
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "browser-profile-purge-owner",
      "delete",
      "cloud",
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_browser_interactions", {
        interactionId: "interaction:purge",
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        conversationId: "conversation:purge",
        threadId: "thread:purge",
        turnId: "turn:purge",
        attemptGeneration: 1,
        toolCallId: "tool-call:purge",
        requestDigest: "b".repeat(64),
        profileId: "default",
        profileEpoch: 3,
        kind: "login_takeover",
        state: "pending",
        displayOrigin: "https://accounts.example",
        revision: 1,
        expiresAt: 60_000,
        suspensionEventPayloadHash: "d".repeat(64),
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.action(purgeFunctions.cloud_purge.purgeOwnerCloudStack, fence),
    ).rejects.toThrow("browser-profile:default");
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_interactionId", (q) =>
            q.eq("interactionId", "interaction:purge"),
          )
          .unique(),
      ),
    ).resolves.not.toBeNull();

    await expect(
      t.action(purgeFunctions.cloud_purge.purgeOwnerCloudStack, fence),
    ).resolves.toEqual({ pending: [] });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_interactionId", (q) =>
            q.eq("interactionId", "interaction:purge"),
          )
          .unique(),
      ),
    ).resolves.toBeNull();
    expect(purgeBodies).toHaveLength(2);
    for (const body of purgeBodies) {
      expect(body).toMatchObject({
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        purgeGeneration: "worker-browser-purge-generation",
        browserProfiles: ["default"],
        mode: "delete",
      });
      expect(body.ownerGeneration).not.toBe(body.purgeGeneration);
    }
  });

  it("retains a live Code integration dispatch receipt until its bounded lease expires", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "integration-dispatch-owner",
      "reset",
      "cloud",
    );
    const liveUntil = Date.now() + 90_000;
    const receiptId = await t.run(async (ctx) =>
      ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        requestId: "code-call-request",
        fingerprint: "fingerprint",
        toolName: "connected.read",
        revision: "revision-1",
        state: "dispatching",
        leaseId: "dispatch-lease",
        leaseExpiresAt: liveUntil,
        attempts: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await expect(
      t.query(
        purgeFunctions.cloud_purge.getOwnerIntegrationCallQuiescenceInternal,
        { ownerId: fence.ownerId, now: liveUntil - 1 },
      ),
    ).resolves.toEqual({ ready: false, nextCheckAt: liveUntil });
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("cloud_integration_call_receipts");

    // The row mutation repeats the lease defense even if a caller skips the
    // action-level preflight.
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_integration_call_receipts",
    });
    expect(await t.run(async (ctx) => ctx.db.get(receiptId))).not.toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.patch(receiptId, { leaseExpiresAt: Date.now() - 1 });
    });
    await expect(
      t.query(
        purgeFunctions.cloud_purge.getOwnerIntegrationCallQuiescenceInternal,
        { ownerId: fence.ownerId, now: Date.now() },
      ),
    ).resolves.toEqual({ ready: true });
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_integration_call_receipts",
    });
    expect(await t.run(async (ctx) => ctx.db.get(receiptId))).toBeNull();
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
      await ctx.db.insert("media_private_payload_chunks", {
        ownerId,
        manifestId: "missing-manifest",
        jobId: "missing-job",
        index: 0,
        data: "encrypted-owner-payload",
        createdAt: 1,
      });
    });

    expect(
      await t.query(
        purgeFunctions.account_deletion.remainingOwnerAccountCoreStoresInternal,
        { ownerId },
      ),
    ).toEqual(["auth_revoked_sessions", "media_private_payload_chunks"]);
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

  it("drains both auth-link principals while retaining reset security and quota state", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "reset-auth-owner", "reset", "core");
    const rows = await t.run(async (ctx) => {
      const auditConversation = await ctx.db.insert("conversations", {
        ownerId: fence.ownerId,
        title: "Resettable conversation",
        isDefault: false,
        eventCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      return {
        auditConversation,
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
        usageLog: await ctx.db.insert("usage_logs", {
          ownerId: fence.ownerId,
          conversationId: auditConversation,
          agentType: "primary",
          model: "test-model",
          costMicroCents: 6,
          durationMs: 10,
          success: true,
          createdAt: 4,
        }),
        usageRollup: await ctx.db.insert("usage_rollups", {
          ownerId: fence.ownerId,
          bucketStartMs: 0,
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          requestCount: 1,
          toolCallCount: 0,
          updatedAt: 4,
        }),
      };
    });

    await t.mutation(purgeFunctions.reset._deleteConversationBatch, {
      ...fence,
      conversationId: rows.auditConversation,
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
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.usageLog)),
    ).not.toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.usageRollup)),
    ).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.fromLink))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.toLink))).toBeNull();
  });
});
