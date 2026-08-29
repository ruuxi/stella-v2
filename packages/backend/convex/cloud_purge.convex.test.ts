/// <reference types="vite/client" />

import { S3Client } from "@aws-sdk/client-s3";
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ensureExternalOwnerPurge } from "./cloud_purge";
import { r2 } from "./r2_files";

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
    purgeOwnerBackupsInternal: FunctionReference<
      "action",
      "internal",
      Fence & { leaseId: string },
      null
    >;
    _deleteBackupRows: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        objects: Array<{ id: Id<"backup_objects">; r2Key: string }>;
        manifests: Array<{ id: Id<"backup_manifests">; r2Key: string }>;
      },
      { deleted: number }
    >;
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
    deleteDriveRowsInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        rows: Array<
          | { kind: "file"; id: Id<"cloud_drive_files">; r2Key: string }
          | {
              kind: "upload";
              id: Id<"cloud_drive_uploads">;
              r2Key: string;
              expiresAt: number;
            }
        >;
        now: number;
      },
      { deleted: number; deferred: number }
    >;
    deleteOwnerCloudBatch: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        table:
          | "cloud_app_storage"
          | "agent_events"
          | "cloud_memory_lifecycles"
          | "cloud_memory_wipe_jobs"
          | "cloud_agent_home_preferences"
          | "cloud_dream_dispatches"
          | "cloud_integration_call_receipts";
      },
      { hasMore: boolean }
    >;
    deleteOwnerAgentThreadCascadeBatchInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & { cursor: string | null },
      {
        hasThread: boolean;
        completedThread: boolean;
        deletedEvents: number;
        protectedEvents: number;
        cursor: string | null;
      }
    >;
    getOwnerIntegrationCallQuiescenceInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string; now: number },
      { ready: boolean; nextCheckAt?: number }
    >;
    deleteConfirmedConversationEditInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        ref: {
          id: Id<"cloud_conversation_edits">;
          editOperationId: string;
          targetConversationId?: string;
        };
      },
      boolean
    >;
    remainingOwnerStoresInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      string[]
    >;
  };
  cloudflare_tunnels: {
    deleteConfirmedOwnerTunnelRows: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        leaseId: string;
        mode: PurgeMode;
        refs: Array<{
          id: Id<"cloudflare_tunnels">;
          tunnelId: string;
          dnsRecordId?: string;
          tunnelName: string;
          hostname: string;
          provisionState?: "provisioning" | "ready";
          provisionLeaseExpiresAt?: number;
        }>;
      },
      { deleted: number }
    >;
    reserveTunnelProvision: FunctionReference<
      "mutation",
      "internal",
      {
        ownerId: string;
        ownerGeneration: string;
        deviceId: string;
        tunnelName: string;
        hostname: string;
        now: number;
        leaseExpiresAt: number;
      },
      Id<"cloudflare_tunnels">
    >;
    recordTunnelProvisionExternalRefs: FunctionReference<
      "mutation",
      "internal",
      {
        id: Id<"cloudflare_tunnels">;
        ownerId: string;
        ownerGeneration: string;
        tunnelId?: string;
        dnsRecordId?: string;
        now: number;
      },
      boolean
    >;
    finishTunnelProvision: FunctionReference<
      "mutation",
      "internal",
      {
        id: Id<"cloudflare_tunnels">;
        ownerId: string;
        ownerGeneration: string;
        tunnelId: string;
        tunnelToken: string;
        dnsRecordId: string;
        now: number;
      },
      boolean
    >;
    deleteConfirmedTunnelProvision: FunctionReference<
      "mutation",
      "internal",
      {
        id: Id<"cloudflare_tunnels">;
        ownerId: string;
        ownerGeneration: string;
        tunnelName: string;
      },
      boolean
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
          | "auth_link_requests"
          | "device_identity_successors"
          | "mobile_pairing_sessions"
          | "paired_mobile_devices"
          | "mobile_connect_intents"
          | "mobile_bridge_registrations"
          | "mobile_bridge_registration_limits"
          | "mobile_bridge_sessions"
          | "mobile_push_tokens";
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

const stubComponentR2Env = () => {
  vi.stubEnv("R2_ACCESS_KEY_ID", "cloud-purge-test-access");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "cloud-purge-test-secret");
  vi.stubEnv(
    "R2_ENDPOINT",
    "https://cloud-purge-test.r2.cloudflarestorage.com",
  );
  vi.stubEnv("R2_BUCKET", "cloud-purge-test-bucket");
  vi.stubEnv("CLOUD_BUILDER_URL", "https://builder.example.test");
  vi.stubEnv("BUILDER_SERVICE_SECRET", "test-builder-secret");
};

const mockCloudAndR2Purge = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/owners/purge/begin")) {
      return Response.json({ generation: "worker-purge-generation" });
    }
    if (url.endsWith("/owners/purge")) {
      return Response.json({ pending: [] });
    }
    if (url.endsWith("/owners/purge/release")) {
      return Response.json({ released: true });
    }
    throw new Error(`Unexpected purge request: ${url}`);
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

  it("deletes backup locators only for the exact externally confirmed key", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "backup-owner", "delete", "core");
    const { exactId, changedId } = await t.run(async (ctx) => ({
      exactId: await ctx.db.insert("backup_objects", {
        ownerId: fence.ownerId,
        objectId: "exact-object",
        r2Key: "backups/exact",
        algorithm: "test",
        plaintextSha256: "exact",
        plaintextSize: 1,
        ivBase64Url: "iv",
        authTagBase64Url: "tag",
        createdAt: 1,
      }),
      changedId: await ctx.db.insert("backup_objects", {
        ownerId: fence.ownerId,
        objectId: "changed-object",
        r2Key: "backups/current",
        algorithm: "test",
        plaintextSha256: "changed",
        plaintextSize: 1,
        ivBase64Url: "iv",
        authTagBase64Url: "tag",
        createdAt: 2,
      }),
    }));

    expect(
      await t.mutation(purgeFunctions.account_deletion._deleteBackupRows, {
        ...fence,
        objects: [
          { id: exactId, r2Key: "backups/exact" },
          { id: changedId, r2Key: "backups/stale" },
        ],
        manifests: [],
      }),
    ).toEqual({ deleted: 1 });
    expect(
      await t.run(async (ctx) => ({
        exact: await ctx.db.get(exactId),
        changed: await ctx.db.get(changedId),
      })),
    ).toMatchObject({ exact: null, changed: { r2Key: "backups/current" } });
  });

  it("retains backup locators across metadata failure and clears exact readback on replay", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "backup-physical-delete-owner",
      "delete",
      "core",
    );
    const rows = await t.run(async (ctx) => ({
      object: await ctx.db.insert("backup_objects", {
        ownerId: fence.ownerId,
        objectId: "private-object",
        r2Key: "backups/private-object",
        uploadExpiresAt: 0,
        algorithm: "test",
        plaintextSha256: "object-sha",
        plaintextSize: 10,
        ivBase64Url: "object-iv",
        authTagBase64Url: "object-tag",
        createdAt: 1,
      }),
      manifest: await ctx.db.insert("backup_manifests", {
        ownerId: fence.ownerId,
        snapshotId: "private-snapshot",
        snapshotHash: "snapshot-sha",
        sourceDeviceId: "device",
        manifestR2Key: "backups/private-manifest",
        uploadExpiresAt: 0,
        manifestAlgorithm: "test",
        manifestPlaintextSha256: "manifest-sha",
        manifestPlaintextSize: 11,
        manifestIvBase64Url: "manifest-iv",
        manifestAuthTagBase64Url: "manifest-tag",
        entryCount: 1,
        objectCount: 1,
        isLatest: true,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    }));
    stubComponentR2Env();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockRejectedValueOnce(new Error("component metadata unavailable"))
      .mockResolvedValue(undefined);
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Contents: [],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200 },
    } as never);
    const args = {
      ...fence,
      leaseId: `${fence.ownerId}-core-lease`,
    };

    await expect(
      t.action(purgeFunctions.account_deletion.purgeOwnerBackupsInternal, args),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await t.run(async (ctx) => {
      const sweep = await ctx.db
        .query("backup_legacy_r2_sweeps")
        .withIndex("by_scopeKey", (q) =>
          q.eq(
            "scopeKey",
            `purge:${encodeURIComponent(fence.ownerId)}:${fence.operationId}`,
          ),
        )
        .unique();
      if (!sweep) throw new Error("Expected purge backup sweep fixture.");
      await ctx.db.patch(sweep._id, { notBefore: Date.now() - 1 });
    });

    await expect(
      t.action(purgeFunctions.account_deletion.purgeOwnerBackupsInternal, args),
    ).rejects.toThrow(/locator rows were retained/u);
    await expect(
      t.run(async (ctx) => ({
        object: await ctx.db.get(rows.object),
        manifest: await ctx.db.get(rows.manifest),
      })),
    ).resolves.toMatchObject({
      object: { r2Key: "backups/private-object" },
      manifest: { manifestR2Key: "backups/private-manifest" },
    });

    await expect(
      t.action(purgeFunctions.account_deletion.purgeOwnerBackupsInternal, args),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(metadataSpy).toHaveBeenCalledTimes(3);
    await expect(
      t.run(async (ctx) => ({
        object: await ctx.db.get(rows.object),
        manifest: await ctx.db.get(rows.manifest),
      })),
    ).resolves.toEqual({ object: null, manifest: null });
    await expect(
      t.query(
        purgeFunctions.account_deletion.remainingOwnerAccountCoreStoresInternal,
        { ownerId: fence.ownerId },
      ),
    ).resolves.not.toContain("backup_objects");
    await expect(
      t.query(
        purgeFunctions.account_deletion.remainingOwnerAccountCoreStoresInternal,
        { ownerId: fence.ownerId },
      ),
    ).resolves.not.toContain("backup_manifests");
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

  it("retains failed Cloudflare locators and deletes only exact confirmed refs", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "tunnel-owner", "delete", "core");
    const rows = await t.run(async (ctx) => ({
      confirmed: await ctx.db.insert("cloudflare_tunnels", {
        ownerId: fence.ownerId,
        deviceId: "device-a",
        tunnelId: "tunnel-a",
        tunnelName: "t-owner-device-a",
        tunnelToken: "token-a",
        hostname: "a.stellatunnel.com",
        dnsRecordId: "dns-a",
        provisionState: "ready",
        createdAt: 1,
        updatedAt: 1,
      }),
      failed: await ctx.db.insert("cloudflare_tunnels", {
        ownerId: fence.ownerId,
        deviceId: "device-b",
        tunnelId: "tunnel-b",
        tunnelName: "t-owner-device-b",
        tunnelToken: "token-b",
        hostname: "b.stellatunnel.com",
        dnsRecordId: "dns-b",
        provisionState: "ready",
        createdAt: 2,
        updatedAt: 2,
      }),
    }));

    expect(
      await t.mutation(
        purgeFunctions.cloudflare_tunnels.deleteConfirmedOwnerTunnelRows,
        {
          ...fence,
          leaseId: "tunnel-owner-core-lease",
          mode: "delete",
          refs: [
            {
              id: rows.confirmed,
              tunnelId: "tunnel-a",
              tunnelName: "t-owner-device-a",
              hostname: "a.stellatunnel.com",
              dnsRecordId: "dns-a",
              provisionState: "ready",
            },
          ],
        },
      ),
    ).toEqual({ deleted: 1 });
    expect(await t.run(async (ctx) => ctx.db.get(rows.failed))).toMatchObject({
      tunnelId: "tunnel-b",
    });

    expect(
      await t.mutation(
        purgeFunctions.cloudflare_tunnels.deleteConfirmedOwnerTunnelRows,
        {
          ...fence,
          leaseId: "tunnel-owner-core-lease",
          mode: "delete",
          refs: [
            {
              id: rows.failed,
              tunnelId: "tunnel-b",
              tunnelName: "t-owner-device-b",
              hostname: "b.stellatunnel.com",
              dnsRecordId: "dns-b",
              provisionState: "ready",
            },
          ],
        },
      ),
    ).toEqual({ deleted: 1 });
    expect(await t.run(async (ctx) => ctx.db.get(rows.failed))).toBeNull();
  });

  it("keeps tunnel cleanup locators writable after the lifecycle closes", async () => {
    const t = createTest();
    const ownerId = "tunnel-race-owner";
    const id = await t.mutation(
      purgeFunctions.cloudflare_tunnels.reserveTunnelProvision,
      {
        ownerId,
        ownerGeneration: "legacy",
        deviceId: "device-race",
        tunnelName: "t-race-device",
        hostname: "race.stellatunnel.com",
        now: 1,
        leaseExpiresAt: 50_000,
      },
    );
    await beginAndClaim(t, ownerId, "delete", "core");
    expect(
      await t.mutation(
        purgeFunctions.cloudflare_tunnels.recordTunnelProvisionExternalRefs,
        {
          id,
          ownerId,
          ownerGeneration: "legacy",
          tunnelId: "late-tunnel",
          dnsRecordId: "late-dns",
          now: 2_000,
        },
      ),
    ).toBe(true);
    await expect(
      t.mutation(purgeFunctions.cloudflare_tunnels.finishTunnelProvision, {
        id,
        ownerId,
        ownerGeneration: "legacy",
        tunnelId: "late-tunnel",
        tunnelToken: "late-token",
        dnsRecordId: "late-dns",
        now: 2_001,
      }),
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.get(id))).toMatchObject({
      provisionState: "provisioning",
      tunnelId: "late-tunnel",
      dnsRecordId: "late-dns",
    });
    expect(
      await t.mutation(
        purgeFunctions.cloudflare_tunnels.deleteConfirmedTunnelProvision,
        {
          id,
          ownerId,
          ownerGeneration: "legacy",
          tunnelName: "t-race-device",
        },
      ),
    ).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  it("tracks Fork targets as strict external handshake debt", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "edit-owner", "delete", "cloud");
    const id = await t.run(async (ctx) =>
      ctx.db.insert("cloud_conversation_edits", {
        operationId: "edit-operation",
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        requestId: "edit-request-0001",
        fingerprint: "fingerprint",
        kind: "fork",
        state: "preparing",
        sourceConversationId: "source-conversation",
        targetConversationId: "target-conversation",
        throughSeq: 1,
        expectedEpoch: 1,
        expectedLastSeq: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(
      await t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).toContain("cloud_conversation_edits");
    expect(
      await t.mutation(
        purgeFunctions.cloud_purge.deleteConfirmedConversationEditInternal,
        {
          ...fence,
          ref: {
            id,
            editOperationId: "edit-operation",
            targetConversationId: "wrong-target",
          },
        },
      ),
    ).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(id))).not.toBeNull();
    expect(
      await t.mutation(
        purgeFunctions.cloud_purge.deleteConfirmedConversationEditInternal,
        {
          ...fence,
          ref: {
            id,
            editOperationId: "edit-operation",
            targetConversationId: "target-conversation",
          },
        },
      ),
    ).toBe(true);
  });

  it("uses exact-key CAS and retains live presigned upload locators", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "drive-owner", "reset", "cloud");
    const rows = await t.run(async (ctx) => ({
      exactFile: await ctx.db.insert("cloud_drive_files", {
        ownerId: fence.ownerId,
        path: "exact.txt",
        r2Key: "drive/exact",
        name: "exact.txt",
        sizeBytes: 1,
        contentType: "text/plain",
        source: "upload",
        updatedAt: 1,
        createdAt: 1,
      }),
      changedFile: await ctx.db.insert("cloud_drive_files", {
        ownerId: fence.ownerId,
        path: "changed.txt",
        r2Key: "drive/current",
        name: "changed.txt",
        sizeBytes: 1,
        contentType: "text/plain",
        source: "upload",
        updatedAt: 2,
        createdAt: 2,
      }),
      liveUpload: await ctx.db.insert("cloud_drive_uploads", {
        ownerId: fence.ownerId,
        path: "live.txt",
        r2Key: "drive/live",
        claimedBytes: 1,
        createdAt: 3,
        expiresAt: 20_000,
      }),
      expiredUpload: await ctx.db.insert("cloud_drive_uploads", {
        ownerId: fence.ownerId,
        path: "expired.txt",
        r2Key: "drive/expired",
        claimedBytes: 1,
        createdAt: 4,
        expiresAt: 9_000,
      }),
    }));

    expect(
      await t.mutation(purgeFunctions.cloud_purge.deleteDriveRowsInternal, {
        ...fence,
        rows: [
          { kind: "file", id: rows.exactFile, r2Key: "drive/exact" },
          { kind: "file", id: rows.changedFile, r2Key: "drive/stale" },
          {
            kind: "upload",
            id: rows.liveUpload,
            r2Key: "drive/live",
            expiresAt: 20_000,
          },
          {
            kind: "upload",
            id: rows.expiredUpload,
            r2Key: "drive/expired",
            expiresAt: 9_000,
          },
        ],
        now: 10_000,
      }),
    ).toEqual({ deleted: 2, deferred: 1 });
    expect(
      await t.run(async (ctx) => ({
        exactFile: await ctx.db.get(rows.exactFile),
        changedFile: await ctx.db.get(rows.changedFile),
        liveUpload: await ctx.db.get(rows.liveUpload),
        expiredUpload: await ctx.db.get(rows.expiredUpload),
      })),
    ).toMatchObject({
      exactFile: null,
      changedFile: { r2Key: "drive/current" },
      liveUpload: { r2Key: "drive/live" },
      expiredUpload: null,
    });
  });

  it("does no component delete while a Drive PUT URL can still replay", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "drive-live-write-authority",
      "reset",
      "cloud",
    );
    const uploadId = await t.run(async (ctx) =>
      ctx.db.insert("cloud_drive_uploads", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        uploadId: "live-upload",
        status: "pending",
        path: "private/live.txt",
        r2Key: "drive/live-write-authority",
        claimedBytes: 7,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    );
    stubComponentR2Env();
    const fetchSpy = mockCloudAndR2Purge();
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(purgeFunctions.cloud_purge.purgeOwnerCloudStack, fence),
    ).rejects.toThrow(/cloud_drive_objects|cloud_drive_uploads/u);
    const directDeletes = fetchSpy.mock.calls.filter(
      ([, init]) => init?.method === "DELETE",
    );
    expect(directDeletes).toEqual([]);
    expect(metadataSpy).not.toHaveBeenCalled();
    await expect(
      t.run(async (ctx) => ctx.db.get(uploadId)),
    ).resolves.toMatchObject({ r2Key: "drive/live-write-authority" });
  });

  it("confirms Drive object absence before exact row ACK and strict reset readback", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "drive-confirmed-object-purge",
      "reset",
      "cloud",
    );
    await t.run(async (ctx) =>
      seedReadyPurgeBackupSweep(ctx, {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
      }),
    );
    const rows = await t.run(async (ctx) => ({
      file: await ctx.db.insert("cloud_drive_files", {
        ownerId: fence.ownerId,
        path: "private/report.txt",
        r2Key: "drive/private-report",
        name: "report.txt",
        sizeBytes: 5,
        contentType: "text/plain",
        source: "agent",
        origin: "agent",
        updatedAt: 1,
        createdAt: 1,
      }),
      upload: await ctx.db.insert("cloud_drive_uploads", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        uploadId: "expired-upload",
        status: "pending",
        path: "private/expired.txt",
        r2Key: "drive/private-expired",
        claimedBytes: 6,
        createdAt: 1,
        expiresAt: 0,
      }),
    }));
    stubComponentR2Env();
    const fetchSpy = mockCloudAndR2Purge();
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(purgeFunctions.cloud_purge.purgeOwnerCloudStack, fence),
    ).resolves.toEqual({ pending: [] });
    const directDeletes = fetchSpy.mock.calls.filter(
      ([, init]) => init?.method === "DELETE",
    );
    expect(directDeletes).toHaveLength(2);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    await expect(
      t.run(async (ctx) => ({
        file: await ctx.db.get(rows.file),
        upload: await ctx.db.get(rows.upload),
      })),
    ).resolves.toEqual({ file: null, upload: null });
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toEqual([]);
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

  it("cascades paginated owner-less legacy events before deleting their last thread locator", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "legacy-thread-event-owner",
      "delete",
      "cloud",
    );
    const seeded = await t.run(async (ctx) => {
      const threadId = "legacy-event-thread";
      const thread = await ctx.db.insert("cloud_agent_threads", {
        threadId,
        ownerId: fence.ownerId,
        conversationId: "legacy-event-conversation",
        description: "Legacy event purge",
        workspace: "cloud",
        agentType: "general",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      });
      const privateEvents: Array<Id<"agent_events">> = [];
      for (let index = 0; index < 205; index += 1) {
        privateEvents.push(
          await ctx.db.insert("agent_events", {
            turnId: `missing-legacy-turn-${index}`,
            sessionId: threadId,
            seq: index,
            kind: "legacy-private",
            payloadJson: JSON.stringify({ private: index }),
            createdAt: index + 1,
          }),
        );
      }
      await ctx.db.insert("agent_turns", {
        turnId: "foreign-exact-turn",
        sessionId: "foreign-canonical-session",
        ownerId: "foreign-owner",
        prompt: "foreign",
        status: "completed",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      const protectedEvent = await ctx.db.insert("agent_events", {
        turnId: "foreign-exact-turn",
        sessionId: threadId,
        seq: 999,
        kind: "legacy-conflict",
        payloadJson: '{"foreign":true}',
        createdAt: 1_000,
      });
      return { thread, privateEvents, protectedEvent };
    });

    const first = await t.mutation(
      purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
      { ...fence, cursor: null },
    );
    expect(first).toMatchObject({
      hasThread: true,
      completedThread: false,
      deletedEvents: 100,
      protectedEvents: 0,
    });
    expect(first.cursor).not.toBeNull();

    // Simulate an action crash: discarding the cursor is safe because the
    // thread remains and already-deleted rows make a restart progress.
    const restarted = await t.mutation(
      purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
      { ...fence, cursor: null },
    );
    expect(restarted).toMatchObject({
      hasThread: true,
      completedThread: false,
      deletedEvents: 100,
      protectedEvents: 0,
    });

    const completed = await t.mutation(
      purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
      { ...fence, cursor: restarted.cursor },
    );
    expect(completed).toMatchObject({
      hasThread: true,
      completedThread: true,
      deletedEvents: 5,
      protectedEvents: 1,
      cursor: null,
    });
    expect(
      await t.mutation(
        purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
        { ...fence, cursor: null },
      ),
    ).toMatchObject({ hasThread: false, completedThread: false });

    const snapshot = await t.run(async (ctx) => ({
      thread: await ctx.db.get(seeded.thread),
      privateEvents: await Promise.all(
        seeded.privateEvents.map((id) => ctx.db.get(id)),
      ),
      protectedEvent: await ctx.db.get(seeded.protectedEvent),
    }));
    expect(snapshot.thread).toBeNull();
    expect(snapshot.privateEvents.every((row) => row === null)).toBe(true);
    expect(snapshot.protectedEvent).toMatchObject({
      turnId: "foreign-exact-turn",
      payloadJson: '{"foreign":true}',
    });
    expect(snapshot.protectedEvent?.ownerId).toBeUndefined();
    const remaining = await t.query(
      purgeFunctions.cloud_purge.remainingOwnerStoresInternal,
      { ownerId: fence.ownerId },
    );
    expect(remaining).not.toContain("cloud_agent_threads");
    expect(remaining).not.toContain("agent_events");
  });

  it("persists a generation-scoped cascade cursor across a protected first-page retry", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "protected-legacy-event-owner",
      "delete",
      "cloud",
    );
    const seeded = await t.run(async (ctx) => {
      const threadId = "protected-legacy-event-thread";
      const thread = await ctx.db.insert("cloud_agent_threads", {
        threadId,
        ownerId: fence.ownerId,
        conversationId: "protected-legacy-event-conversation",
        description: "Protected legacy event pagination",
        workspace: "cloud",
        agentType: "general",
        // A cursor from another lifecycle fence must never be trusted.
        legacyEventPurgeCursor: "stale-opaque-cursor",
        legacyEventPurgeOperationId: "stale-operation",
        legacyEventPurgeGeneration: "stale-generation",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      });
      const protectedEvents: Array<Id<"agent_events">> = [];
      for (let index = 0; index < 100; index += 1) {
        const turnId = `protected-foreign-turn-${index}`;
        await ctx.db.insert("agent_turns", {
          turnId,
          sessionId: `foreign-session-${index}`,
          ownerId: `foreign-owner-${index}`,
          prompt: "foreign",
          status: "completed",
          createdAt: index + 1,
          updatedAt: index + 1,
        });
        protectedEvents.push(
          await ctx.db.insert("agent_events", {
            turnId,
            sessionId: threadId,
            seq: index,
            kind: "legacy-conflict",
            payloadJson: JSON.stringify({ foreign: index }),
            createdAt: index + 1,
          }),
        );
      }
      const privateEvent = await ctx.db.insert("agent_events", {
        turnId: "missing-private-turn-after-protected-page",
        sessionId: threadId,
        seq: 101,
        kind: "legacy-private",
        payloadJson: '{"private":true}',
        createdAt: 1_000,
      });
      return { thread, protectedEvents, privateEvent };
    });

    const protectedPage = await t.mutation(
      purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
      { ...fence, cursor: null },
    );
    expect(protectedPage).toMatchObject({
      hasThread: true,
      completedThread: false,
      deletedEvents: 0,
      protectedEvents: 100,
    });
    expect(protectedPage.cursor).not.toBeNull();
    await expect(
      t.run(async (ctx) => ctx.db.get(seeded.thread)),
    ).resolves.toMatchObject({
      legacyEventPurgeCursor: protectedPage.cursor,
      legacyEventPurgeOperationId: fence.operationId,
      legacyEventPurgeGeneration: fence.generation,
    });

    // Simulate an action restart that lost its in-memory cursor. The parent
    // carries the exact operation/generation-scoped continuation, so the
    // retained conflict page cannot starve the later private event.
    await expect(
      t.mutation(
        purgeFunctions.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
        { ...fence, cursor: null },
      ),
    ).resolves.toMatchObject({
      hasThread: true,
      completedThread: true,
      deletedEvents: 1,
      protectedEvents: 0,
      cursor: null,
    });

    const snapshot = await t.run(async (ctx) => ({
      thread: await ctx.db.get(seeded.thread),
      privateEvent: await ctx.db.get(seeded.privateEvent),
      protectedEvents: await Promise.all(
        seeded.protectedEvents.map((eventId) => ctx.db.get(eventId)),
      ),
    }));
    expect(snapshot.thread).toBeNull();
    expect(snapshot.privateEvent).toBeNull();
    expect(snapshot.protectedEvents.every((row) => row !== null)).toBe(true);
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.not.toContain("agent_events");
  });

  it("drains owner-less thread events through the complete delete lifecycle and strict readback", async () => {
    const previousUrl = process.env.CLOUD_BUILDER_URL;
    const previousSecret = process.env.BUILDER_SERVICE_SECRET;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "test-secret";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/owners/purge/begin")) {
          return Response.json({ generation: "worker-delete-generation" });
        }
        if (url.endsWith("/owners/purge")) {
          return Response.json({ pending: [] });
        }
        throw new Error(`Unexpected purge request: ${url}`);
      });
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "legacy-event-lifecycle-owner",
      "delete",
      "cloud",
    );
    await t.run(async (ctx) =>
      seedReadyPurgeBackupSweep(ctx, {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
      }),
    );
    const seeded = await t.run(async (ctx) => {
      const threadId = "legacy-event-lifecycle-thread";
      const thread = await ctx.db.insert("cloud_agent_threads", {
        threadId,
        ownerId: fence.ownerId,
        conversationId: "legacy-event-lifecycle-conversation",
        description: "Lifecycle purge",
        workspace: "cloud",
        agentType: "general",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      });
      const events: Array<Id<"agent_events">> = [];
      for (let index = 0; index < 101; index += 1) {
        events.push(
          await ctx.db.insert("agent_events", {
            turnId: `missing-lifecycle-turn-${index}`,
            sessionId: threadId,
            seq: index,
            kind: "legacy-private",
            payloadJson: JSON.stringify({ private: index }),
            createdAt: index + 1,
          }),
        );
      }
      return { thread, events };
    });

    try {
      await expect(
        t.action(purgeFunctions.cloud_purge.purgeOwnerCloudStack, fence),
      ).resolves.toEqual({ pending: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const snapshot = await t.run(async (ctx) => ({
        thread: await ctx.db.get(seeded.thread),
        events: await Promise.all(
          seeded.events.map((eventId) => ctx.db.get(eventId)),
        ),
      }));
      expect(snapshot.thread).toBeNull();
      expect(snapshot.events.every((event) => event === null)).toBe(true);
      expect(
        await t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
          ownerId: fence.ownerId,
        }),
      ).toEqual([]);
    } finally {
      if (previousUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = previousUrl;
      if (previousSecret === undefined)
        delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = previousSecret;
    }
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
      await seedReadyPurgeBackupSweep(ctx, {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
      });
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
        suspensionTokenHash: "c".repeat(64),
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

  it("strictly reads back and drains Memory lifecycle and Dream control rows", async () => {
    const t = createTest();
    const fence = await beginAndClaim(
      t,
      "dream-dispatch-owner",
      "reset",
      "cloud",
    );
    const rows = await t.run(async (ctx) => ({
      lifecycleId: await ctx.db.insert("cloud_memory_lifecycles", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        epoch: "memory-epoch-purge",
        state: "wiping",
        operationId: "memory-wipe-purge",
        createdAt: 1,
        updatedAt: 1,
      }),
      wipeJobId: await ctx.db.insert("cloud_memory_wipe_jobs", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        operationId: "memory-wipe-purge",
        requestId: "memory-wipe-request-purge",
        requestedEpoch: "memory-epoch-purge",
        targetEpoch: "memory-epoch-purge",
        nextEpoch: "memory-epoch-after-purge",
        stage: "metadata",
        externalGeneration: "external-memory-purge",
        externalCursor: 3,
        metadataStoreIndex: 2,
        attempts: 1,
        nextRetryAt: 2,
        leaseId: "memory-wipe-lease-purge",
        leaseExpiresAt: 3,
        lastErrorCode: "retryable_test_error",
        objectsDeleted: 4,
        rowsDeleted: 5,
        createdAt: 1,
        updatedAt: 1,
      }),
      preferenceId: await ctx.db.insert("cloud_agent_home_preferences", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        memoryEnabled: false,
        revision: 1,
        lastRequestId: "memory-off-purge",
        lastRequestExpectedRevision: 0,
        lastRequestMemoryEnabled: false,
        createdAt: 1,
        updatedAt: 1,
      }),
      dispatchId: await ctx.db.insert("cloud_dream_dispatches", {
        dispatchId: "dream-dispatch-purge",
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        conversationId: "conversation-purge",
        turnId: "turn-purge",
        sourceKey: "thread:purge",
        sourceRevision: 1,
        payloadJson: '{"private":"owner-data"}',
        payloadSha256: "a".repeat(64),
        status: "running",
        attemptCount: 1,
        nextAttemptAt: 1,
        leaseId: "stale-generation-lease",
        leaseExpiresAt: Date.now() + 60_000,
        createdAt: 1,
        updatedAt: 1,
      }),
    }));

    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("cloud_memory_lifecycles");
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("cloud_memory_wipe_jobs");
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("cloud_dream_dispatches");
    await expect(
      t.query(purgeFunctions.cloud_purge.remainingOwnerStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("cloud_agent_home_preferences");
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_memory_lifecycles",
    });
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_memory_wipe_jobs",
    });
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_dream_dispatches",
    });
    await t.mutation(purgeFunctions.cloud_purge.deleteOwnerCloudBatch, {
      ...fence,
      table: "cloud_agent_home_preferences",
    });
    expect(await t.run(async (ctx) => ctx.db.get(rows.lifecycleId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.wipeJobId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.dispatchId))).toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.preferenceId)),
    ).toBeNull();
    const remaining = await t.query(
      purgeFunctions.cloud_purge.remainingOwnerStoresInternal,
      { ownerId: fence.ownerId },
    );
    expect(remaining).not.toContain("cloud_memory_lifecycles");
    expect(remaining).not.toContain("cloud_memory_wipe_jobs");
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

  it("drains every mobile pairing, bridge, and push credential on reset", async () => {
    const t = createTest();
    const fence = await beginAndClaim(t, "reset-mobile-owner", "reset", "core");
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_pairing_sessions", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        desktopDeviceId: "desktop-reset",
        pairingCode: "123456",
        createdAt: 1,
        expiresAt: 10_000,
      });
      await ctx.db.insert("paired_mobile_devices", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        desktopDeviceId: "desktop-reset",
        mobileDeviceId: "mobile-reset",
        pairSecretHash: "pair-secret",
        approvedAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("mobile_connect_intents", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        desktopDeviceId: "desktop-reset",
        mobileDeviceId: "mobile-reset",
        createdAt: 1,
        expiresAt: 10_000,
      });
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId: fence.ownerId,
        deviceId: "desktop-reset",
        baseUrls: ["https://desktop.test"],
        updatedAt: 1,
      });
      await ctx.db.insert("mobile_bridge_registration_limits", {
        ownerId: fence.ownerId,
        windowStartedAt: 1,
        count: 1,
      });
      await ctx.db.insert("mobile_bridge_sessions", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        desktopDeviceId: "desktop-reset",
        mobileDeviceId: "mobile-reset",
        sessionId: "mobile-session-reset",
        sessionSecretHash: "session-secret",
        desktopChallenge: "challenge",
        desktopPublicKey: "desktop-key",
        mobilePublicKey: "mobile-key",
        createdAt: 1,
        expiresAt: 10_000,
        lastSeenAt: 1,
      });
      await ctx.db.insert("mobile_push_tokens", {
        ownerId: fence.ownerId,
        ownerGeneration: fence.generation,
        mobileDeviceId: "mobile-reset",
        expoPushToken: "ExponentPushToken[reset]",
        platform: "ios",
        updatedAt: 1,
      });
    });

    const mobileTables = [
      "mobile_pairing_sessions",
      "paired_mobile_devices",
      "mobile_connect_intents",
      "mobile_bridge_registrations",
      "mobile_bridge_registration_limits",
      "mobile_bridge_sessions",
      "mobile_push_tokens",
    ] as const;
    await expect(
      t.query(purgeFunctions.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toEqual(expect.arrayContaining([...mobileTables]));
    for (const table of mobileTables) {
      await t.mutation(purgeFunctions.reset._deleteOwnerTableBatch, {
        ...fence,
        table,
      });
    }
    await expect(
      t.query(purgeFunctions.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toEqual([]);
  });

  it("drains both auth-link principals and device successors while retaining reset security and quota state", async () => {
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
        successor: await ctx.db.insert("device_identity_successors", {
          ownerId: fence.ownerId,
          previousDeviceId: "old-device",
          deviceId: "new-device",
          rotatedAt: 3,
        }),
        policy: await ctx.db.insert("auth_revoked_sessions", {
          ownerId: fence.ownerId,
          sessionId: "fenced-session",
          revokedAt: 4,
          expiresAt: 50_000,
        }),
        billingWindow: await ctx.db.insert("billing_usage_windows", {
          ownerId: fence.ownerId,
          rollingUsageMicroCents: 1,
          rollingWindowStartedAt: 1,
          weeklyUsageMicroCents: 2,
          weeklyWindowStartedAt: 1,
          monthlyUsageMicroCents: 3,
          monthlyWindowStartedAt: 1,
          totalUsageMicroCents: 6,
          totalRequestCount: 1,
          createdAt: 1,
          updatedAt: 4,
        }),
        billingProfile: await ctx.db.insert("billing_profiles", {
          ownerId: fence.ownerId,
          activePlan: "pro",
          subscriptionStatus: "active",
          stripeCustomerId: "cus_reset_audit",
          stripeSubscriptionId: "sub_reset_audit",
          stripePriceId: "price_reset_audit",
          defaultPaymentMethodId: "pm_reset_audit",
          paymentMethodBrand: "visa",
          paymentMethodLast4: "4242",
          currentPeriodStart: 1,
          currentPeriodEnd: 10,
          cancelAtPeriodEnd: false,
          monthlyAnchorAt: 1,
          createdAt: 1,
          updatedAt: 4,
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
      "device_identity_successors",
      "auth_link_requests.fromOwnerId",
      "auth_link_requests.toOwnerId",
    ]);

    await t.mutation(purgeFunctions.reset._deleteOwnerTableBatch, {
      ...fence,
      table: "auth_link_requests",
    });
    await t.mutation(purgeFunctions.reset._deleteOwnerTableBatch, {
      ...fence,
      table: "device_identity_successors",
    });

    expect(
      await t.query(purgeFunctions.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
    ).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.get(rows.policy))).not.toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.billingWindow)),
    ).not.toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.billingProfile)),
    ).not.toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.usageLog)),
    ).not.toBeNull();
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.usageRollup)),
    ).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.fromLink))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.toLink))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(rows.successor))).toBeNull();
  });
});
