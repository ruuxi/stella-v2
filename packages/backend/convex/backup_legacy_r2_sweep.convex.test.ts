/// <reference types="vite/client" />

import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { r2 } from "./r2_files";
import { encryptSecret } from "./data/secrets_crypto";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

const R2_ENV = {
  R2_ACCESS_KEY_ID: "legacy-sweep-access",
  R2_SECRET_ACCESS_KEY: "legacy-sweep-secret",
  R2_ENDPOINT: "https://legacy-sweep.r2.cloudflarestorage.com",
  R2_BUCKET: "legacy-sweep-bucket",
} as const;

type PurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
  mode: "delete";
};

type MigrationLease = {
  fromOwnerId: string;
  toOwnerId: string;
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};

type MigrationSweepFence = {
  fromOwnerId: string;
  toOwnerId: string;
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  planRevision: number;
  now: number;
};

const migrateBackupsBatchRef = makeFunctionReference<
  "mutation",
  MigrationLease,
  { hasMore: boolean; retryAfterMs?: number }
>("backup_migration:migrateBackupsBatchInternal");

const advancePurgeSweepRef = makeFunctionReference<
  "action",
  PurgeFence,
  { ready: boolean; retryAfterMs?: number }
>("backup_legacy_r2_sweep:advancePurgeLegacyR2SweepInternal");

const advanceMigrationSweepRef = makeFunctionReference<
  "action",
  MigrationSweepFence,
  { ready: boolean; retryAfterMs?: number }
>("backup_legacy_r2_sweep:advanceMigrationLegacyR2SweepInternal");

const upgradePurgeSweepRef = makeFunctionReference<
  "mutation",
  PurgeFence,
  unknown
>("backup_legacy_r2_sweep_store:upgradePurgeSweepToEmptyInternal");

const beginPurge = async (
  t: TestHarness,
  ownerId: string,
): Promise<PurgeFence> => {
  const operationId = `delete-${ownerId}`;
  const begun = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode: "delete", now: Date.now() },
  );
  const leaseId = `core-lease-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
    stage: "core",
    leaseId,
    now: Date.now(),
  });
  return {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
    leaseId,
    mode: "delete",
  };
};

const releaseBarrier = async (t: TestHarness, scopeKey: string) => {
  await t.run(async (ctx) => {
    const sweep = await ctx.db
      .query("backup_legacy_r2_sweeps")
      .withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
      .unique();
    if (!sweep) throw new Error("missing legacy sweep state");
    await ctx.db.patch(sweep._id, { notBefore: Date.now() - 1 });
  });
};

const installR2Inventory = (
  keys: Iterable<string>,
  options: {
    loseFirstDeleteResponse?: boolean;
    beforeConfirmedAbsent?: (key: string) => Promise<void>;
  } = {},
) => {
  for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
  const inventory = new Set(keys);
  const listedPrefixes: string[] = [];
  const headedKeys: string[] = [];
  const deletedKeys: string[] = [];
  let loseDeleteResponse = options.loseFirstDeleteResponse === true;

  const send = async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const startAfter = command.input.StartAfter;
      const maxKeys = command.input.MaxKeys ?? 1_000;
      listedPrefixes.push(prefix);
      const page = [...inventory]
        .filter(
          (key) =>
            key.startsWith(prefix) &&
            (startAfter === undefined || key > startAfter),
        )
        .sort()
        .slice(0, maxKeys);
      const remaining = [...inventory].some(
        (key) =>
          key.startsWith(prefix) &&
          (page.length === 0 || key > page[page.length - 1]!),
      );
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: remaining,
        $metadata: { httpStatusCode: 200 },
      };
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key ?? "";
      headedKeys.push(key);
      if (inventory.has(key)) {
        return { $metadata: { httpStatusCode: 200 } };
      }
      await options.beforeConfirmedAbsent?.(key);
      throw { $metadata: { httpStatusCode: 404 } };
    }
    throw new Error("unexpected S3 command");
  };
  vi.spyOn(S3Client.prototype, "send").mockImplementation(send as never);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init?.method).toBe("DELETE");
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const bucketPrefix = `/${R2_ENV.R2_BUCKET}/`;
    expect(url.pathname.startsWith(bucketPrefix)).toBe(true);
    const key = url.pathname
      .slice(bucketPrefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    deletedKeys.push(key);
    const existed = inventory.delete(key);
    if (loseDeleteResponse) {
      loseDeleteResponse = false;
      throw new Error("simulated response loss after R2 delete");
    }
    return new Response(null, { status: existed ? 204 : 404 });
  });
  return { inventory, listedPrefixes, headedKeys, deletedKeys };
};

const advancePurgeUntilReady = async (
  t: TestHarness,
  fence: PurgeFence,
  maxPasses = 32,
) => {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await t.action(advancePurgeSweepRef, fence);
    if (result.ready) return;
  }
  throw new Error("purge legacy sweep did not converge");
};

const advanceMigrationUntilReady = async (
  t: TestHarness,
  fence: MigrationSweepFence,
  maxPasses = 32,
) => {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await t.action(advanceMigrationSweepRef, fence);
    if (result.ready) return;
  }
  throw new Error("migration legacy sweep did not converge");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("legacy backup raw-R2 sweep", () => {
  it("deletes more than two bounded pages, survives response loss, verifies again, and retires only at terminal purge", async () => {
    const t = createTest();
    const ownerId = "legacy-sweep-many-pages";
    const objectPrefix = `backups/${encodeURIComponent(ownerId)}/objects/`;
    const manifestPrefix = `backups/${encodeURIComponent(ownerId)}/manifests/`;
    const rawKeys = [
      ...Array.from(
        { length: 70 },
        (_, index) => `${objectPrefix}${String(index).padStart(3, "0")}.bin`,
      ),
      `${manifestPrefix}lost-prepare.bin`,
    ];
    const fake = installR2Inventory(rawKeys, {
      loseFirstDeleteResponse: true,
    });
    const fence = await beginPurge(t, ownerId);

    const first = await t.action(advancePurgeSweepRef, fence);
    expect(first.ready).toBe(false);
    expect(first.retryAfterMs).toBe(1_000);
    const fenced = await t.action(advancePurgeSweepRef, fence);
    expect(fenced.ready).toBe(false);
    expect(fenced.retryAfterMs).toBeGreaterThan(19 * 60_000);
    expect(fake.listedPrefixes).toEqual([]);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(ownerId)}:${fence.operationId}`,
    );

    const revisionBeforeLostResponse = await t.run(
      async (ctx) =>
        (await ctx.db.query("backup_legacy_r2_sweeps").unique())?.revision,
    );
    await expect(t.action(advancePurgeSweepRef, fence)).rejects.toThrow(
      /could not confirm physical absence/u,
    );
    expect(fake.inventory.size).toBe(rawKeys.length - 1);
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.query("backup_legacy_r2_sweeps").unique())?.revision,
      ),
    ).toBe(revisionBeforeLostResponse);
    await advancePurgeUntilReady(t, fence);
    expect(fake.inventory.size).toBe(0);
    expect(new Set(fake.deletedKeys).size).toBe(rawKeys.length);
    expect(fake.headedKeys.length).toBeGreaterThan(0);

    await t.mutation(upgradePurgeSweepRef, fence);
    await advancePurgeUntilReady(t, fence);
    const ready = await t.run(async (ctx) =>
      ctx.db
        .query("backup_legacy_r2_sweeps")
        .withIndex("by_scopeKey", (q) =>
          q.eq(
            "scopeKey",
            `purge:${encodeURIComponent(ownerId)}:${fence.operationId}`,
          ),
        )
        .unique(),
    );
    expect(ready).toMatchObject({
      protocolVersion: 1,
      goal: "empty",
      phase: "ready",
      legacyRowFenceComplete: true,
    });

    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId: fence.leaseId,
      stage: "core",
      nextStage: "cloud",
      now: Date.now(),
    });
    const cloudLeaseId = "legacy-many-pages-cloud";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      stage: "cloud",
      leaseId: cloudLeaseId,
      now: Date.now(),
    });
    await expect(
      t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
        ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
        leaseId: cloudLeaseId,
        nextGeneration: "unused-delete-generation",
        now: Date.now(),
      }),
    ).resolves.toBe(true);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_legacy_r2_sweeps").collect(),
      ),
    ).toEqual([]);
  });

  it("walks only the four exact migration prefixes in deterministic cleanup and verification order", async () => {
    const t = createTest();
    const fromOwnerId = "legacy-four-prefix-source";
    const toOwnerId = "legacy-four-prefix-destination";
    const fromOwnerGeneration = "legacy-four-prefix-source-generation";
    const toOwnerGeneration = "legacy-four-prefix-destination-generation";
    const migrationId = await t.run(async (ctx) => {
      for (const [ownerId, generation] of [
        [fromOwnerId, fromOwnerGeneration],
        [toOwnerId, toOwnerGeneration],
      ] as const) {
        await ctx.db.insert("cloud_owner_lifecycles", {
          ownerId,
          generation,
          state: "open",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId,
        toOwnerId,
        status: "running",
        leaseId: "legacy-four-prefix-lease",
        leaseGeneration: 1,
        leaseExpiresAt: Date.now() + 60_000,
        fromOwnerGeneration,
        toOwnerGeneration,
        planRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const expectedPrefixes = [
      `backups/${encodeURIComponent(fromOwnerId)}/objects/`,
      `backups/${encodeURIComponent(fromOwnerId)}/manifests/`,
      `backups/${encodeURIComponent(toOwnerId)}/objects/`,
      `backups/${encodeURIComponent(toOwnerId)}/manifests/`,
    ];
    const exactKeys = expectedPrefixes.map((prefix) => `${prefix}orphan.bin`);
    const neighbors = [
      `backups/${encodeURIComponent(fromOwnerId)}/keys/not-legacy.bin`,
      `backups/${encodeURIComponent(toOwnerId)}/objectz/not-legacy.bin`,
    ];
    const fake = installR2Inventory([...exactKeys, ...neighbors]);
    const fence: MigrationSweepFence = {
      fromOwnerId,
      toOwnerId,
      migrationId: String(migrationId),
      leaseId: "legacy-four-prefix-lease",
      leaseGeneration: 1,
      fromOwnerGeneration,
      toOwnerGeneration,
      planRevision: 1,
      now: Date.now(),
    };
    for (let pass = 0; pass < 4; pass += 1) {
      const waiting = await t.action(advanceMigrationSweepRef, fence);
      expect(waiting.ready).toBe(false);
    }
    expect(fake.listedPrefixes).toEqual([]);
    await releaseBarrier(
      t,
      `migration:${encodeURIComponent(fromOwnerId)}:${String(migrationId)}`,
    );
    await advanceMigrationUntilReady(t, fence);
    expect(fake.inventory).toEqual(new Set(neighbors));
    expect(fake.listedPrefixes).toEqual([
      ...expectedPrefixes,
      ...expectedPrefixes,
    ]);
  });

  it("durably dirties verification before DELETE and restarts after HEAD succeeds but page acknowledgement is lost", async () => {
    const t = createTest();
    const ownerId = "legacy-lost-page-ack";
    const objectPrefix = `backups/${encodeURIComponent(ownerId)}/objects/`;
    const manifestPrefix = `backups/${encodeURIComponent(ownerId)}/manifests/`;
    const key = `${objectPrefix}orphan.bin`;
    let losePageAcknowledgement = true;
    let observedDurableDirtyMarker = false;
    const fake = installR2Inventory([], {
      beforeConfirmedAbsent: async (confirmedKey) => {
        if (!losePageAcknowledgement) return;
        losePageAcknowledgement = false;
        expect(confirmedKey).toBe(key);
        await t.run(async (ctx) => {
          const receipt = await ctx.db
            .query("backup_legacy_r2_sweeps")
            .unique();
          expect(receipt?.phase).toBe("verify");
          expect(receipt?.verifyDirty).toBe(true);
          observedDurableDirtyMarker = true;
          if (!receipt) throw new Error("missing legacy sweep receipt");
          // Force the post-provider page acknowledgement to lose its CAS.
          // This models an action response/process loss after DELETE + HEAD.
          await ctx.db.patch(receipt._id, { revision: receipt.revision + 1 });
        });
      },
    });
    const fence = await beginPurge(t, ownerId);
    await t.action(advancePurgeSweepRef, fence);
    await t.action(advancePurgeSweepRef, fence);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(ownerId)}:${fence.operationId}`,
    );
    await t.action(advancePurgeSweepRef, fence);
    await t.action(advancePurgeSweepRef, fence);
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.query("backup_legacy_r2_sweeps").unique())?.phase,
      ),
    ).toBe("verify");
    const verificationListOffset = fake.listedPrefixes.length;
    fake.inventory.add(key);

    await expect(t.action(advancePurgeSweepRef, fence)).rejects.toThrow(
      /cursor is no longer current/u,
    );
    expect(observedDurableDirtyMarker).toBe(true);
    expect(fake.inventory.has(key)).toBe(false);
    expect(fake.headedKeys).toContain(key);
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.query("backup_legacy_r2_sweeps").unique())?.verifyDirty,
      ),
    ).toBe(true);

    await advancePurgeUntilReady(t, fence);
    expect(fake.inventory.size).toBe(0);
    expect(fake.deletedKeys).toEqual([key]);
    expect(fake.listedPrefixes.slice(verificationListOffset)).toEqual([
      objectPrefix,
      objectPrefix,
      manifestPrefix,
      objectPrefix,
      manifestPrefix,
    ]);
  });

  it("preserves migrated source-prefix bytes, deletes an orphan neighbor, then destination deletion removes the exact immutable keys", async () => {
    const t = createTest();
    const fromOwnerId = "legacy-migrated-source";
    const toOwnerId = "legacy-migrated-destination";
    const fromOwnerGeneration = "legacy-source-generation";
    const toOwnerGeneration = "legacy-destination-generation";
    const rawKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const keyFingerprint =
      "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
    const objectKey = `backups/${encodeURIComponent(fromOwnerId)}/objects/object.bin`;
    const orphanKey = `backups/${encodeURIComponent(fromOwnerId)}/objects/orphan.bin`;
    const manifestKey = `backups/${encodeURIComponent(fromOwnerId)}/manifests/snapshot.bin`;
    vi.stubEnv(
      "STELLA_SECRETS_MASTER_KEYS_JSON",
      JSON.stringify({ 1: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=" }),
    );
    vi.stubEnv("STELLA_SECRETS_MASTER_KEY_VERSION", "1");
    const encryptedKey = JSON.stringify(await encryptSecret(rawKey));
    const migration = await t.run(async (ctx) => {
      for (const [ownerId, generation] of [
        [fromOwnerId, fromOwnerGeneration],
        [toOwnerId, toOwnerGeneration],
      ] as const) {
        await ctx.db.insert("cloud_owner_lifecycles", {
          ownerId,
          generation,
          state: "open",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      await ctx.db.insert("backup_key_escrows", {
        ownerId: fromOwnerId,
        ownerGeneration: fromOwnerGeneration,
        encryptedKey,
        keyFingerprint,
        isCurrent: true,
        keyVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("backup_objects", {
        ownerId: fromOwnerId,
        ownerGeneration: fromOwnerGeneration,
        keyFingerprint,
        objectId: "b".repeat(64),
        r2Key: objectKey,
        uploadExpiresAt: 0,
        algorithm: "AES-256-GCM",
        plaintextSha256: "c".repeat(64),
        plaintextSize: 10,
        ivBase64Url: "iv",
        authTagBase64Url: "tag",
        createdAt: 1,
      });
      await ctx.db.insert("backup_manifests", {
        ownerId: fromOwnerId,
        ownerGeneration: fromOwnerGeneration,
        keyFingerprint,
        snapshotId: "source-snapshot",
        snapshotHash: "d".repeat(64),
        sourceDeviceId: "source-device",
        manifestR2Key: manifestKey,
        uploadExpiresAt: 0,
        manifestAlgorithm: "AES-256-GCM",
        manifestPlaintextSha256: "e".repeat(64),
        manifestPlaintextSize: 12,
        manifestIvBase64Url: "manifest-iv",
        manifestAuthTagBase64Url: "manifest-tag",
        entryCount: 1,
        objectCount: 1,
        isLatest: true,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId,
        toOwnerId,
        status: "running",
        leaseId: "legacy-migration-lease",
        leaseGeneration: 1,
        leaseExpiresAt: Date.now() + 60_000,
        fromOwnerGeneration,
        toOwnerGeneration,
        planRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    for (let pass = 0; pass < 16; pass += 1) {
      const result = await t.mutation(migrateBackupsBatchRef, {
        fromOwnerId,
        toOwnerId,
        leaseId: "legacy-migration-lease",
        leaseGeneration: 1,
        leaseNow: Date.now(),
      });
      if (!result.hasMore) break;
      if (pass === 15) throw new Error("backup migration did not converge");
    }
    await t.run(async (ctx) => {
      await ctx.db.patch(migration as Id<"auth_owner_migrations">, {
        status: "complete",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const fake = installR2Inventory([objectKey, orphanKey, manifestKey]);
    vi.spyOn(r2, "deleteObject").mockResolvedValue(undefined);
    const sourceFence = await beginPurge(t, fromOwnerId);
    await t.action(advancePurgeSweepRef, sourceFence);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(fromOwnerId)}:${sourceFence.operationId}`,
    );
    await advancePurgeUntilReady(t, sourceFence);
    await t.mutation(upgradePurgeSweepRef, sourceFence);
    await advancePurgeUntilReady(t, sourceFence);
    expect(fake.inventory).toEqual(new Set([objectKey, manifestKey]));
    const migratedRows = await t.run(async (ctx) => ({
      object: await ctx.db.query("backup_objects").unique(),
      manifest: await ctx.db.query("backup_manifests").unique(),
      destinationEscrow: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId_and_keyFingerprint", (q) =>
          q.eq("ownerId", toOwnerId).eq("keyFingerprint", keyFingerprint),
        )
        .unique(),
    }));
    expect(migratedRows.object?.ownerId).toBe(toOwnerId);
    expect(migratedRows.manifest?.ownerId).toBe(toOwnerId);
    expect(migratedRows.destinationEscrow).not.toBeNull();

    const destinationFence = await beginPurge(t, toOwnerId);
    await expect(
      t.action(
        internal.account_deletion.purgeOwnerBackupsInternal,
        destinationFence,
      ),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(toOwnerId)}:${destinationFence.operationId}`,
    );
    await expect(
      t.action(
        internal.account_deletion.purgeOwnerBackupsInternal,
        destinationFence,
      ),
    ).resolves.toBeNull();
    expect(fake.inventory.size).toBe(0);
    expect(
      await t.run(async (ctx) => ({
        objects: await ctx.db.query("backup_objects").collect(),
        manifests: await ctx.db.query("backup_manifests").collect(),
        escrows: await ctx.db
          .query("backup_key_escrows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", toOwnerId))
          .collect(),
      })),
    ).toEqual({ objects: [], manifests: [], escrows: [] });
  });

  it("fails closed on a malformed out-of-prefix page and retains the exact cursor", async () => {
    const t = createTest();
    const ownerId = "legacy-malformed-page";
    const fence = await beginPurge(t, ownerId);
    for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
    const send = async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: "backups/unrelated-owner/objects/escape.bin" }],
          IsTruncated: false,
          $metadata: { httpStatusCode: 200 },
        };
      }
      throw new Error("unexpected S3 command");
    };
    vi.spyOn(S3Client.prototype, "send").mockImplementation(send as never);
    await t.action(advancePurgeSweepRef, fence);
    await t.action(advancePurgeSweepRef, fence);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(ownerId)}:${fence.operationId}`,
    );
    const before = await t.run(async (ctx) =>
      ctx.db.query("backup_legacy_r2_sweeps").unique(),
    );
    await expect(t.action(advancePurgeSweepRef, fence)).rejects.toThrow(
      /invalid key order/u,
    );
    const after = await t.run(async (ctx) =>
      ctx.db.query("backup_legacy_r2_sweeps").unique(),
    );
    expect({
      revision: after?.revision,
      phase: after?.phase,
      targetIndex: after?.targetIndex,
      startAfter: after?.startAfter,
    }).toEqual({
      revision: before?.revision,
      phase: before?.phase,
      targetIndex: before?.targetIndex,
      startAfter: before?.startAfter,
    });
  });

  it("keeps the durable cursor fenced when credentials are missing or listing is forbidden", async () => {
    const t = createTest();
    const ownerId = "legacy-provider-failure";
    const fence = await beginPurge(t, ownerId);
    await t.action(advancePurgeSweepRef, fence);
    await t.action(advancePurgeSweepRef, fence);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(ownerId)}:${fence.operationId}`,
    );
    const before = await t.run(async (ctx) =>
      ctx.db.query("backup_legacy_r2_sweeps").unique(),
    );
    await expect(t.action(advancePurgeSweepRef, fence)).rejects.toThrow(
      /credentials are unavailable/u,
    );

    for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
    const forbidden = async () => {
      throw { $metadata: { httpStatusCode: 403 } };
    };
    vi.spyOn(S3Client.prototype, "send").mockImplementation(forbidden as never);
    await expect(t.action(advancePurgeSweepRef, fence)).rejects.toThrow(
      /raw-storage listing failed/u,
    );
    const after = await t.run(async (ctx) =>
      ctx.db.query("backup_legacy_r2_sweeps").unique(),
    );
    expect({
      revision: after?.revision,
      phase: after?.phase,
      targetIndex: after?.targetIndex,
      startAfter: after?.startAfter,
    }).toEqual({
      revision: before?.revision,
      phase: before?.phase,
      targetIndex: before?.targetIndex,
      startAfter: before?.startAfter,
    });
  });

  it("fences terminal purge receipt ABA and makes the exact commit replay-safe", async () => {
    const t = createTest();
    const ownerId = "legacy-terminal-purge-aba";
    const fence = await beginPurge(t, ownerId);
    await t.run(async (ctx) => {
      const sweepId = await seedReadyPurgeBackupSweep(ctx, {
        ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
      });
      await ctx.db.patch(sweepId, {
        sourceOwnerGeneration: "replayed-old-generation",
      });
    });
    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId: fence.leaseId,
      stage: "core",
      nextStage: "cloud",
      now: Date.now(),
    });
    const cloudLeaseId = "legacy-terminal-purge-cloud";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      stage: "cloud",
      leaseId: cloudLeaseId,
      now: Date.now(),
    });
    const finishArgs = {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId: cloudLeaseId,
      nextGeneration: "terminal-next-generation",
      now: Date.now(),
    };
    await expect(
      t.mutation(
        internal.owner_lifecycle.finishOwnerCloudPurgeInternal,
        finishArgs,
      ),
    ).rejects.toThrow(/raw-storage absence proof is not ready/u);
    await t.run(async (ctx) => {
      const sweep = await ctx.db.query("backup_legacy_r2_sweeps").unique();
      if (!sweep) throw new Error("missing ABA receipt");
      await ctx.db.patch(sweep._id, {
        sourceOwnerGeneration: fence.generation,
        revision: sweep.revision + 1,
      });
    });
    await expect(
      t.mutation(
        internal.owner_lifecycle.finishOwnerCloudPurgeInternal,
        finishArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        internal.owner_lifecycle.finishOwnerCloudPurgeInternal,
        finishArgs,
      ),
    ).resolves.toBe(false);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_legacy_r2_sweeps").collect(),
      ),
    ).toEqual([]);
  });

  it("rewinds a pre-rollout cloud-stage purge instead of completing without raw-storage proof", async () => {
    const t = createTest();
    const ownerId = "legacy-pre-rollout-cloud-job";
    const fence = await beginPurge(t, ownerId);
    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId: fence.leaseId,
      stage: "core",
      nextStage: "cloud",
      now: Date.now(),
    });
    const cloudLeaseId = "legacy-pre-rollout-cloud-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      stage: "cloud",
      leaseId: cloudLeaseId,
      now: Date.now(),
    });
    await expect(
      t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
        ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
        leaseId: cloudLeaseId,
        nextGeneration: "must-not-publish",
        now: Date.now(),
      }),
    ).resolves.toBe(false);
    expect(
      await t.run(async (ctx) => ({
        lifecycle: await ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        job: await ctx.db
          .query("cloud_owner_purge_jobs")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      })),
    ).toMatchObject({
      lifecycle: {
        state: "deleting",
        operationId: fence.operationId,
        generation: fence.generation,
      },
      job: {
        stage: "core",
      },
    });
    const rewoundJob = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    );
    expect(rewoundJob?.leaseId).toBeUndefined();
    expect(rewoundJob?.leaseExpiresAt).toBeUndefined();
  });

  it("blocks an independent source purge for a partially moved row, but accepts the exact destination-purge dependency", async () => {
    const t = createTest();
    const fromOwnerId = "legacy-partial-source";
    const toOwnerId = "legacy-partial-destination";
    const keyFingerprint = "f".repeat(64);
    const objectKey = `backups/${encodeURIComponent(fromOwnerId)}/objects/partial.bin`;
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: fromOwnerId,
        generation: "partial-source-open",
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: toOwnerId,
        generation: "partial-destination-open",
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("backup_objects", {
        ownerId: toOwnerId,
        ownerGeneration: "partial-destination-open",
        keyFingerprint,
        objectId: "1".repeat(64),
        r2Key: objectKey,
        uploadExpiresAt: 0,
        algorithm: "AES-256-GCM",
        plaintextSha256: "2".repeat(64),
        plaintextSize: 8,
        ivBase64Url: "iv",
        authTagBase64Url: "tag",
        createdAt: 1,
      });
    });
    const destinationFence = await beginPurge(t, toOwnerId);
    const sourceFence = await beginPurge(t, fromOwnerId);
    const fake = installR2Inventory([objectKey]);
    await t.action(advancePurgeSweepRef, sourceFence);
    await t.action(advancePurgeSweepRef, sourceFence);
    await releaseBarrier(
      t,
      `purge:${encodeURIComponent(fromOwnerId)}:${sourceFence.operationId}`,
    );
    await expect(t.action(advancePurgeSweepRef, sourceFence)).rejects.toThrow(
      /no destination escrow or exact purge dependency/u,
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId,
        toOwnerId,
        status: "failed",
        fromOwnerGeneration: "partial-source-open",
        toOwnerGeneration: "partial-destination-open",
        planRevision: 1,
        lastError: "quiesced by linked destination deletion",
        sourcePurgeDependency: {
          sourceOperationId: sourceFence.operationId,
          sourceGeneration: sourceFence.generation,
          destinationOperationId: destinationFence.operationId,
          destinationGeneration: destinationFence.generation,
        },
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await advancePurgeUntilReady(t, sourceFence);
    await t.mutation(upgradePurgeSweepRef, sourceFence);
    await advancePurgeUntilReady(t, sourceFence);
    expect(fake.inventory).toEqual(new Set([objectKey]));
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_legacy_r2_sweeps").collect(),
      ),
    ).toContainEqual(
      expect.objectContaining({
        operationId: sourceFence.operationId,
        goal: "empty",
        phase: "ready",
        protectedCount: expect.any(Number),
      }),
    );
  });
});
