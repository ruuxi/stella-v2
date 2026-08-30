/// <reference types="vite/client" />

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { encryptSecret } from "./data/secrets_crypto";
import schema from "./schema";
import { r2 } from "./r2_files";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

type MigrationLease = {
  fromOwnerId: string;
  toOwnerId: string;
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};

const migrateBackupsBatchRef = makeFunctionReference<
  "mutation",
  MigrationLease,
  { hasMore: boolean; retryAfterMs?: number }
>("backup_migration:migrateBackupsBatchInternal");

const migrateBackupsPassRef = makeFunctionReference<
  "action",
  {
    fromOwnerId: string;
    toOwnerId: string;
    migrationId: string;
    leaseId: string;
    leaseGeneration: number;
    fromOwnerGeneration: string;
    toOwnerGeneration: string;
    planRevision: number;
    now: number;
  },
  { ready: boolean; retryAfterMs?: number }
>("backup_migration:migrateBackupsForOwnershipPassInternal");

const BACKUP_MASTER_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const COMPONENT_R2_ENV = {
  R2_ACCESS_KEY_ID: "backup-migration-test-access",
  R2_SECRET_ACCESS_KEY: "backup-migration-test-secret",
  R2_ENDPOINT: "https://backup-migration-test.r2.cloudflarestorage.com",
  R2_BUCKET: "backup-migration-test-bucket",
} as const;
const rawKeyA = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const rawKeyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const rawKeyC = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
const keyA = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
const keyB = "75877bb41d393b5fb8455ce60ecd8dda001d06316496b14dfa7f895656eeca4a";
const keyC = "648aa5c579fb30f38af744d97d6ec840c7a91277a499a0d780f3e7314eca090b";
const rawKeyByFingerprint = new Map([
  [keyA, rawKeyA],
  [keyB, rawKeyB],
  [keyC, rawKeyC],
]);
const objectA = "1".repeat(64);
const objectB = "2".repeat(64);
const objectC = "3".repeat(64);
const plaintextA = "4".repeat(64);
const plaintextB = "5".repeat(64);
const plaintextC = "6".repeat(64);
const manifestHash = "7".repeat(64);

const seedMigration = async (
  t: TestHarness,
  args: { fromOwnerId: string; toOwnerId: string },
) => {
  const fromOwnerGeneration = "from-generation";
  const toOwnerGeneration = "to-generation";
  const leaseId = "backup-migration-lease";
  const leaseGeneration = 4;
  const migrationId = await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: args.fromOwnerId,
      generation: fromOwnerGeneration,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: args.toOwnerId,
      generation: toOwnerGeneration,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("devices", {
      ownerId: args.toOwnerId,
      ownerGeneration: toOwnerGeneration,
      deviceId: "destination-device",
    });
    return await ctx.db.insert("auth_owner_migrations", {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      status: "running",
      leaseId,
      leaseGeneration,
      leaseExpiresAt: Date.now() + 60_000,
      fromOwnerGeneration,
      toOwnerGeneration,
      planRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return {
    ...args,
    migrationId,
    fromOwnerGeneration,
    toOwnerGeneration,
    leaseId,
    leaseGeneration,
    leaseNow: Date.now(),
  };
};

const insertEscrow = async (
  t: TestHarness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    keyFingerprint: string;
    isCurrent?: boolean;
    rawKeyBase64Url?: string;
  },
) => {
  vi.stubEnv(
    "STELLA_SECRETS_MASTER_KEYS_JSON",
    JSON.stringify({ 1: BACKUP_MASTER_KEY }),
  );
  vi.stubEnv("STELLA_SECRETS_MASTER_KEY_VERSION", "1");
  return await t.run(async (ctx) =>
    ctx.db.insert("backup_key_escrows", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      keyFingerprint: args.keyFingerprint,
      ...(args.isCurrent !== undefined ? { isCurrent: args.isCurrent } : {}),
      encryptedKey: JSON.stringify(
        await encryptSecret(
          args.rawKeyBase64Url ??
            rawKeyByFingerprint.get(args.keyFingerprint) ??
            rawKeyA,
        ),
      ),
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
};

const insertObject = async (
  t: TestHarness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    keyFingerprint: string;
    objectId: string;
    plaintextSha256: string;
    r2Key: string;
    uploadExpiresAt?: number;
    iv?: string;
    createdAt?: number;
  },
) =>
  await t.run(async (ctx) =>
    ctx.db.insert("backup_objects", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      keyFingerprint: args.keyFingerprint,
      objectId: args.objectId,
      r2Key: args.r2Key,
      uploadExpiresAt: args.uploadExpiresAt ?? 0,
      algorithm: "AES-256-GCM",
      plaintextSha256: args.plaintextSha256,
      plaintextSize: 42,
      ivBase64Url: args.iv ?? "iv",
      authTagBase64Url: `tag:${args.iv ?? "iv"}`,
      createdAt: args.createdAt ?? 1,
    }),
  );

const insertManifest = async (
  t: TestHarness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    keyFingerprint: string;
    snapshotId: string;
    r2Key: string;
    sourceDeviceId: string;
    isLatest: boolean;
    createdAt: number;
    uploadExpiresAt?: number;
  },
) =>
  await t.run(async (ctx) =>
    ctx.db.insert("backup_manifests", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      keyFingerprint: args.keyFingerprint,
      snapshotId: args.snapshotId,
      snapshotHash: manifestHash,
      sourceDeviceId: args.sourceDeviceId,
      manifestR2Key: args.r2Key,
      uploadExpiresAt: args.uploadExpiresAt ?? 0,
      manifestAlgorithm: "AES-256-GCM",
      manifestPlaintextSha256: "8".repeat(64),
      manifestPlaintextSize: 80,
      manifestIvBase64Url: "manifest-iv",
      manifestAuthTagBase64Url: "manifest-tag",
      entryCount: 1,
      objectCount: 1,
      isLatest: args.isLatest,
      version: 1,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    }),
  );

const drainMigration = async (t: TestHarness, lease: MigrationLease) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await t.mutation(migrateBackupsBatchRef, {
      ...lease,
      leaseNow: Date.now(),
    });
    if (!result.hasMore) return;
  }
  throw new Error("Backup migration did not converge within the test bound.");
};

const exactLease = (lease: MigrationLease): MigrationLease => ({
  fromOwnerId: lease.fromOwnerId,
  toOwnerId: lease.toOwnerId,
  leaseId: lease.leaseId,
  leaseGeneration: lease.leaseGeneration,
  leaseNow: Date.now(),
});

const beginDestinationDelete = async (t: TestHarness, ownerId: string) => {
  const begun = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `delete-${ownerId}`,
      mode: "delete",
      now: Date.now(),
    },
  );
  const leaseId = `delete-lease-${ownerId}`;
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
    mode: "delete" as const,
  };
};

const stubEmptyLegacyR2 = () => {
  for (const [name, value] of Object.entries(COMPONENT_R2_ENV)) {
    vi.stubEnv(name, value);
  }
  return vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
    Contents: [],
    IsTruncated: false,
    $metadata: { httpStatusCode: 200 },
  } as never);
};

const releaseLegacySweepBarrier = async (t: TestHarness, scopeKey: string) => {
  await t.run(async (ctx) => {
    const sweep = await ctx.db
      .query("backup_legacy_r2_sweeps")
      .withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
      .unique();
    if (!sweep) throw new Error("missing backup legacy sweep fixture");
    await ctx.db.patch(sweep._id, { notBefore: Date.now() - 1 });
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("backup ownership migration", () => {
  it("preserves multi-key ciphertext, deduplicates exact locators, aliases snapshot collisions, and keeps one destination upload key", async () => {
    const t = createTest();
    const fromOwnerId = "backup-source-owner";
    const toOwnerId = "backup-destination-owner";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });

    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyB,
      isCurrent: false,
    });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyC,
      isCurrent: false,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyC,
      isCurrent: true,
    });

    const sourceObjectAKey = `backups/source/keys/${keyA}/objects/${objectA}.bin`;
    const sharedObjectBKey = `backups/shared/keys/${keyB}/objects/${objectB}.bin`;
    const sourceObjectCKey = `backups/source/keys/${keyC}/objects/${objectC}.bin`;
    const destinationObjectCKey = `backups/destination/keys/${keyC}/objects/${objectC}.bin`;
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: sourceObjectAKey,
    });
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyB,
      objectId: objectB,
      plaintextSha256: plaintextB,
      r2Key: sharedObjectBKey,
      iv: "shared-iv",
    });
    await insertObject(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyB,
      objectId: objectB,
      plaintextSha256: plaintextB,
      r2Key: sharedObjectBKey,
      iv: "shared-iv",
    });
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyC,
      objectId: objectC,
      plaintextSha256: plaintextC,
      r2Key: sourceObjectCKey,
      iv: "source-variant",
    });
    await insertObject(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyC,
      objectId: objectC,
      plaintextSha256: plaintextC,
      r2Key: destinationObjectCKey,
      iv: "destination-variant",
    });

    const sourceManifestKey = `backups/source/keys/${keyA}/manifests/collision.bin`;
    const destinationManifestKey = `backups/destination/keys/${keyC}/manifests/collision.bin`;
    await insertManifest(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "collision",
      r2Key: sourceManifestKey,
      sourceDeviceId: "source-device",
      isLatest: true,
      createdAt: 20,
    });
    await insertManifest(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyC,
      snapshotId: "collision",
      r2Key: destinationManifestKey,
      sourceDeviceId: "destination-device",
      isLatest: true,
      createdAt: 30,
    });

    // The destination is unavailable while a partial account-link could expose
    // an incomplete set of key groups.
    await expect(
      t.query(internal.backups.listBackupsForOwnerInternal, {
        ownerId: toOwnerId,
        deviceId: "destination-device",
      }),
    ).rejects.toThrow(/account data is being linked/u);

    // Lose the first mutation response after its commit, then restart from the
    // same durable migration row. Source selection makes the replay idempotent.
    await t.mutation(migrateBackupsBatchRef, exactLease(fence));
    await drainMigration(t, exactLease(fence));

    const state = await t.run(async (ctx) => ({
      sourceEscrows: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .collect(),
      escrows: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", toOwnerId))
        .collect(),
      sourceObjects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      objects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
      sourceManifests: await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      manifests: await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    }));
    expect(state.sourceEscrows).toEqual([]);
    expect(state.sourceObjects).toEqual([]);
    expect(state.sourceManifests).toEqual([]);
    expect(state.escrows).toHaveLength(3);
    expect(
      state.escrows
        .filter((row) => row.isCurrent === true)
        .map((row) => row.keyFingerprint),
    ).toEqual([keyC]);
    expect(
      state.escrows.every(
        (row) => row.ownerGeneration === fence.toOwnerGeneration,
      ),
    ).toBe(true);
    expect(
      state.objects.filter((row) => row.r2Key === sharedObjectBKey),
    ).toHaveLength(1);
    expect(state.objects.map((row) => row.r2Key)).toEqual(
      expect.arrayContaining([
        sourceObjectAKey,
        sharedObjectBKey,
        sourceObjectCKey,
        destinationObjectCKey,
      ]),
    );
    expect(state.manifests.filter((row) => row.isLatest)).toHaveLength(1);
    expect(state.manifests.find((row) => row.isLatest)?.manifestR2Key).toBe(
      destinationManifestKey,
    );
    const imported = state.manifests.find(
      (row) => row.manifestR2Key === sourceManifestKey,
    );
    expect(imported?.snapshotId).not.toBe("collision");
    expect(imported?.originalSnapshotId).toBe("collision");
    expect(imported?.keyFingerprint).toBe(keyA);
    expect(imported?.ownerGeneration).toBe(fence.toOwnerGeneration);

    await t.run(async (ctx) => {
      await ctx.db.patch(fence.migrationId as Id<"auth_owner_migrations">, {
        status: "complete",
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const listed = await t.query(internal.backups.listBackupsForOwnerInternal, {
      ownerId: toOwnerId,
      deviceId: "destination-device",
    });
    expect(listed.map((row) => row.snapshotId)).toContain(imported!.snapshotId);
    expect(
      listed.find((row) => row.snapshotId === imported!.snapshotId)
        ?.originalSnapshotId,
    ).toBe("collision");
    const manifestRecord = await t.query(
      internal.backups.getManifestRecordInternal,
      {
        ownerId: toOwnerId,
        deviceId: "destination-device",
        snapshotId: imported!.snapshotId,
      },
    );
    expect(manifestRecord).toMatchObject({
      keyFingerprint: keyA,
      uploadKeyFingerprint: keyC,
    });
    expect(manifestRecord?.encryptedKey).toEqual(expect.any(String));
    expect(manifestRecord?.uploadEncryptedKey).toEqual(expect.any(String));

    vi.spyOn(r2, "getUrl").mockResolvedValue("https://download.invalid/object");
    const manifestPlan = await t.action(
      internal.backups.getManifestDownloadPlanInternal,
      {
        ownerId: toOwnerId,
        deviceId: "destination-device",
        snapshotId: imported!.snapshotId,
      },
    );
    expect(manifestPlan).toMatchObject({
      keyBase64Url: rawKeyA,
      uploadKeyBase64Url: rawKeyC,
      uploadKeyFingerprint: keyC,
      snapshot: {
        snapshotId: imported!.snapshotId,
        originalSnapshotId: "collision",
      },
      manifest: { r2Key: sourceManifestKey },
    });
    const objectPlan = await t.action(
      internal.backups.getObjectDownloadPlanInternal,
      {
        ownerId: toOwnerId,
        deviceId: "destination-device",
        snapshotId: imported!.snapshotId,
        objectIds: [objectA],
      },
    );
    expect(objectPlan[0]?.r2Key).toBe(sourceObjectAKey);

    const legacyObjectId = "9".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("backup_objects", {
        ownerId: toOwnerId,
        ownerGeneration: fence.toOwnerGeneration,
        objectId: legacyObjectId,
        r2Key: "backups/legacy/object.bin",
        algorithm: "AES-256-GCM",
        plaintextSha256: "0".repeat(64),
        plaintextSize: 1,
        ivBase64Url: "legacy-iv",
        authTagBase64Url: "legacy-tag",
        createdAt: 1,
      });
    });
    await expect(
      t.action(internal.backups.getObjectDownloadPlanInternal, {
        ownerId: toOwnerId,
        deviceId: "destination-device",
        snapshotId: imported!.snapshotId,
        objectIds: [legacyObjectId],
      }),
    ).rejects.toThrow(/not found/u);
    await expect(
      t.action(internal.backups.getObjectDownloadPlanInternal, {
        ownerId: toOwnerId,
        deviceId: "destination-device",
        snapshotId: imported!.snapshotId,
        objectIds: [objectC],
      }),
    ).rejects.toThrow(/not found/u);
  });

  it("waits out finalized PUT authority before changing any owner or R2 locator", async () => {
    const t = createTest();
    const fromOwnerId = "backup-active-source";
    const toOwnerId = "backup-active-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    const objectR2Key = "backups/source/active-object.bin";
    const manifestR2Key = "backups/source/active-manifest.bin";
    const activeUntil = Date.now() + 30_000;
    const objectRow = await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: objectR2Key,
      uploadExpiresAt: activeUntil,
    });
    const manifestRow = await insertManifest(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "active-snapshot",
      r2Key: manifestR2Key,
      sourceDeviceId: "source-device",
      isLatest: true,
      createdAt: 10,
      uploadExpiresAt: activeUntil,
    });

    const waiting = await t.mutation(migrateBackupsBatchRef, exactLease(fence));
    expect(waiting).toMatchObject({ hasMore: true });
    expect(waiting.retryAfterMs).toBeGreaterThan(1_000);
    const beforeExpiry = await t.run(async (ctx) => ({
      object: await ctx.db.get(objectRow),
      manifest: await ctx.db.get(manifestRow),
    }));
    expect(beforeExpiry.object).toMatchObject({
      ownerId: fromOwnerId,
      r2Key: objectR2Key,
    });
    expect(beforeExpiry.manifest).toMatchObject({
      ownerId: fromOwnerId,
      manifestR2Key,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(objectRow, { uploadExpiresAt: Date.now() - 1 });
      await ctx.db.patch(manifestRow, { uploadExpiresAt: Date.now() - 1 });
    });
    await drainMigration(t, exactLease(fence));
    const after = await t.run(async (ctx) => ({
      object: await ctx.db.get(objectRow),
      manifest: await ctx.db.get(manifestRow),
    }));
    expect(after.object).toMatchObject({
      ownerId: toOwnerId,
      r2Key: objectR2Key,
    });
    expect(after.manifest).toMatchObject({
      ownerId: toOwnerId,
      manifestR2Key,
    });
  });

  it("deduplicates a byte-identical manifest R2 locator", async () => {
    const t = createTest();
    const fromOwnerId = "backup-manifest-dedupe-source";
    const toOwnerId = "backup-manifest-dedupe-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    for (const owner of [
      { id: fromOwnerId, generation: fence.fromOwnerGeneration },
      { id: toOwnerId, generation: fence.toOwnerGeneration },
    ]) {
      await insertEscrow(t, {
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        keyFingerprint: keyA,
        isCurrent: true,
      });
      await insertManifest(t, {
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        keyFingerprint: keyA,
        snapshotId: "same-snapshot",
        r2Key: "backups/shared/same-manifest.bin",
        sourceDeviceId: "same-device",
        isLatest: true,
        createdAt: 10,
      });
    }

    await drainMigration(t, exactLease(fence));
    const manifests = await t.run(async (ctx) =>
      ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    );
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      snapshotId: "same-snapshot",
      manifestR2Key: "backups/shared/same-manifest.bin",
      ownerGeneration: fence.toOwnerGeneration,
      isLatest: true,
    });
  });

  it("does not reauthorize a stale destination-generation collision", async () => {
    const t = createTest();
    const fromOwnerId = "backup-stale-source";
    const toOwnerId = "backup-stale-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    const sharedLocator = "backups/shared/stale-object.bin";
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: sharedLocator,
    });
    const staleId = await insertObject(t, {
      ownerId: toOwnerId,
      ownerGeneration: "stale-destination-generation",
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: sharedLocator,
    });

    await expect(
      t.mutation(migrateBackupsBatchRef, exactLease(fence)),
    ).rejects.toThrow(/stale owner generation/u);
    const state = await t.run(async (ctx) => ({
      source: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      stale: await ctx.db.get(staleId),
    }));
    expect(state.source).toHaveLength(1);
    expect(state.stale?.ownerGeneration).toBe("stale-destination-generation");
  });

  it("rejects an exact object R2 locator already bound to another key-group object", async () => {
    const t = createTest();
    const fromOwnerId = "backup-object-locator-source";
    const toOwnerId = "backup-object-locator-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyB,
      isCurrent: false,
    });
    const sharedLocator = "backups/shared/cross-key-object.bin";
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: sharedLocator,
    });
    const destinationId = await insertObject(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyB,
      objectId: objectB,
      plaintextSha256: plaintextB,
      r2Key: sharedLocator,
    });

    await expect(
      t.mutation(migrateBackupsBatchRef, exactLease(fence)),
    ).rejects.toThrow(/already bound to another key-group object/u);
    const state = await t.run(async (ctx) => ({
      source: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      destination: await ctx.db.get(destinationId),
    }));
    expect(state.source).toHaveLength(1);
    expect(state.destination).toMatchObject({
      ownerId: toOwnerId,
      keyFingerprint: keyB,
      objectId: objectB,
      r2Key: sharedLocator,
    });
  });

  it("migrates the bounded eight-by-sixty-three ciphertext fanout without exceeding the restore cap", async () => {
    const t = createTest();
    const fromOwnerId = "backup-max-fanout-source";
    const toOwnerId = "backup-max-fanout-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });

    for (let objectIndex = 0; objectIndex < 8; objectIndex += 1) {
      const fanoutObjectId = (objectIndex + 1).toString(16).padStart(64, "0");
      await t.run(async (ctx) => {
        await ctx.db.insert("backup_objects", {
          ownerId: fromOwnerId,
          ownerGeneration: fence.fromOwnerGeneration,
          keyFingerprint: keyA,
          objectId: fanoutObjectId,
          r2Key: `backups/source/fanout-${objectIndex}.bin`,
          uploadExpiresAt: 0,
          algorithm: "AES-256-GCM",
          plaintextSha256: plaintextA,
          plaintextSize: 42,
          ivBase64Url: "source-iv",
          authTagBase64Url: "source-tag",
          createdAt: objectIndex + 1,
        });
        for (let variant = 0; variant < 63; variant += 1) {
          await ctx.db.insert("backup_objects", {
            ownerId: toOwnerId,
            ownerGeneration: fence.toOwnerGeneration,
            keyFingerprint: keyA,
            objectId: fanoutObjectId,
            r2Key: `backups/destination/fanout-${objectIndex}-${variant}.bin`,
            uploadExpiresAt: 0,
            algorithm: "AES-256-GCM",
            plaintextSha256: plaintextA,
            plaintextSize: 42,
            ivBase64Url: `destination-iv-${variant}`,
            authTagBase64Url: `destination-tag-${variant}`,
            createdAt: variant + 1,
          });
        }
      });
    }

    await expect(
      t.mutation(migrateBackupsBatchRef, exactLease(fence)),
    ).resolves.toEqual({ hasMore: true });
    const state = await t.run(async (ctx) => ({
      source: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      destination: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    }));
    expect(state.source).toEqual([]);
    expect(state.destination).toHaveLength(8 * 64);
    for (const fanoutObjectId of new Set(
      state.destination.map((row) => row.objectId),
    )) {
      expect(
        state.destination.filter((row) => row.objectId === fanoutObjectId),
      ).toHaveLength(64);
    }
  });

  it("does not let a stale destination latest row suppress the source latest snapshot", async () => {
    const t = createTest();
    const fromOwnerId = "backup-stale-latest-source";
    const toOwnerId = "backup-stale-latest-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    const sourceManifestId = await insertManifest(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "source-latest",
      r2Key: "backups/source/latest.bin",
      sourceDeviceId: "source-device",
      isLatest: true,
      createdAt: 20,
    });
    const staleManifestId = await insertManifest(t, {
      ownerId: toOwnerId,
      ownerGeneration: "stale-destination-generation",
      keyFingerprint: keyA,
      snapshotId: "stale-latest",
      r2Key: "backups/destination/stale-latest.bin",
      sourceDeviceId: "destination-device",
      isLatest: true,
      createdAt: 30,
    });

    await expect(
      t.mutation(migrateBackupsBatchRef, exactLease(fence)),
    ).rejects.toThrow(/stale owner generation/u);
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.get(sourceManifestId),
      stale: await ctx.db.get(staleManifestId),
    }));
    expect(state.source).toMatchObject({
      ownerId: fromOwnerId,
      isLatest: true,
    });
    expect(state.stale).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "stale-destination-generation",
      isLatest: true,
    });
  });

  it("fails before moving rows when an escrow does not decrypt to its fingerprint", async () => {
    const t = createTest();
    const fromOwnerId = "backup-key-mismatch-source";
    const toOwnerId = "backup-key-mismatch-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
      rawKeyBase64Url: rawKeyB,
    });
    const sourceObjectId = await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: "backups/source/key-mismatch.bin",
    });

    await expect(
      t.mutation(migrateBackupsBatchRef, exactLease(fence)),
    ).rejects.toThrow(/does not match its fingerprint/u);
    await expect(
      t.run(async (ctx) => ctx.db.get(sourceObjectId)),
    ).resolves.toMatchObject({ ownerId: fromOwnerId });
  });

  it("places legacy finalized rows behind a conservative PUT-expiry barrier before re-ownership", async () => {
    const t = createTest();
    const fromOwnerId = "backup-legacy-put-source";
    const toOwnerId = "backup-legacy-put-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    const ids = await t.run(async (ctx) => ({
      object: await ctx.db.insert("backup_objects", {
        ownerId: fromOwnerId,
        ownerGeneration: fence.fromOwnerGeneration,
        keyFingerprint: keyA,
        objectId: objectA,
        r2Key: "backups/source/legacy-put-object.bin",
        algorithm: "AES-256-GCM",
        plaintextSha256: plaintextA,
        plaintextSize: 42,
        ivBase64Url: "legacy-put-iv",
        authTagBase64Url: "legacy-put-tag",
        createdAt: 1,
      }),
      manifest: await ctx.db.insert("backup_manifests", {
        ownerId: fromOwnerId,
        ownerGeneration: fence.fromOwnerGeneration,
        keyFingerprint: keyA,
        snapshotId: "legacy-put-snapshot",
        snapshotHash: manifestHash,
        sourceDeviceId: "source-device",
        manifestR2Key: "backups/source/legacy-put-manifest.bin",
        manifestAlgorithm: "AES-256-GCM",
        manifestPlaintextSha256: "8".repeat(64),
        manifestPlaintextSize: 80,
        manifestIvBase64Url: "legacy-manifest-iv",
        manifestAuthTagBase64Url: "legacy-manifest-tag",
        entryCount: 1,
        objectCount: 1,
        isLatest: true,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    }));

    const fenced = await t.mutation(migrateBackupsBatchRef, exactLease(fence));
    expect(fenced).toMatchObject({ hasMore: true });
    expect(fenced.retryAfterMs).toBeGreaterThanOrEqual(20 * 60_000);
    const beforeExpiry = await t.run(async (ctx) => ({
      object: await ctx.db.get(ids.object),
      manifest: await ctx.db.get(ids.manifest),
    }));
    expect(beforeExpiry.object).toMatchObject({ ownerId: fromOwnerId });
    expect(beforeExpiry.manifest).toMatchObject({ ownerId: fromOwnerId });
    expect(beforeExpiry.object?.uploadExpiresAt).toBeGreaterThan(Date.now());
    expect(beforeExpiry.manifest?.uploadExpiresAt).toBeGreaterThan(Date.now());

    await t.run(async (ctx) => {
      await ctx.db.patch(ids.object, { uploadExpiresAt: Date.now() - 1 });
      await ctx.db.patch(ids.manifest, { uploadExpiresAt: Date.now() - 1 });
    });
    await drainMigration(t, exactLease(fence));
    await expect(
      t.run(async (ctx) => ctx.db.get(ids.object)),
    ).resolves.toMatchObject({ ownerId: toOwnerId });
    await expect(
      t.run(async (ctx) => ctx.db.get(ids.manifest)),
    ).resolves.toMatchObject({ ownerId: toOwnerId });
  });

  it("repairs a destination with manifests but no latest snapshot", async () => {
    const t = createTest();
    const fromOwnerId = "backup-no-latest-source";
    const toOwnerId = "backup-no-latest-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertEscrow(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertManifest(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "source-not-latest",
      r2Key: "backups/source/not-latest.bin",
      sourceDeviceId: "source-device",
      isLatest: false,
      createdAt: 20,
    });
    await insertManifest(t, {
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "destination-not-latest",
      r2Key: "backups/destination/not-latest.bin",
      sourceDeviceId: "destination-device",
      isLatest: false,
      createdAt: 30,
    });

    await drainMigration(t, exactLease(fence));
    const latest = await t.run(async (ctx) =>
      ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_isLatest", (q) =>
          q.eq("ownerId", toOwnerId).eq("isLatest", true),
        )
        .collect(),
    );
    expect(latest).toHaveLength(1);
    expect(latest[0]?.snapshotId).toBe("destination-not-latest");
  });

  it("fails before moving backup rows when a multi-key account has no unique current upload key", async () => {
    const t = createTest();
    const fromOwnerId = "backup-ambiguous-source";
    const toOwnerId = "backup-ambiguous-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
    });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyB,
    });
    const sourceR2Key = "backups/source/ambiguous-object.bin";
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: sourceR2Key,
    });

    await expect(drainMigration(t, exactLease(fence))).rejects.toThrow(
      /multiple backup keys but no unambiguous current upload key/u,
    );
    const state = await t.run(async (ctx) => ({
      sourceEscrows: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .collect(),
      sourceObjects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      destinationObjects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    }));
    expect(state.sourceEscrows).toHaveLength(2);
    expect(state.sourceObjects).toHaveLength(1);
    expect(state.sourceObjects[0]?.r2Key).toBe(sourceR2Key);
    expect(state.destinationObjects).toEqual([]);
  });

  it("the action pass converges after a lost response without rewriting immutable R2 keys", async () => {
    const t = createTest();
    const fromOwnerId = "backup-pass-source";
    const toOwnerId = "backup-pass-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    const r2Key = "backups/source/immutable-object.bin";
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key,
    });
    const args = {
      fromOwnerId,
      toOwnerId,
      migrationId: String(fence.migrationId),
      leaseId: fence.leaseId,
      leaseGeneration: fence.leaseGeneration,
      fromOwnerGeneration: fence.fromOwnerGeneration,
      toOwnerGeneration: fence.toOwnerGeneration,
      planRevision: 1,
      now: Date.now(),
    };

    stubEmptyLegacyR2();
    await t.action(migrateBackupsPassRef, args);
    await releaseLegacySweepBarrier(
      t,
      `migration:${encodeURIComponent(fromOwnerId)}:${String(fence.migrationId)}`,
    );
    let ready = false;
    for (let attempt = 0; attempt < 24 && !ready; attempt += 1) {
      ready = (await t.action(migrateBackupsPassRef, args)).ready;
    }
    expect(ready).toBe(true);
    await expect(t.action(migrateBackupsPassRef, args)).resolves.toEqual({
      ready: true,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: fence.toOwnerGeneration,
      r2Key,
    });
  });

  it("deletes every migrated locator and escrow from the destination with exact zero readback", async () => {
    const t = createTest();
    const fromOwnerId = "backup-delete-after-migration-source";
    const toOwnerId = "backup-delete-after-migration-destination";
    const fence = await seedMigration(t, { fromOwnerId, toOwnerId });
    await insertEscrow(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      isCurrent: true,
    });
    await insertObject(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      objectId: objectA,
      plaintextSha256: plaintextA,
      r2Key: "backups/source/delete-after-migration-object.bin",
    });
    await insertManifest(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fence.fromOwnerGeneration,
      keyFingerprint: keyA,
      snapshotId: "delete-after-migration",
      r2Key: "backups/source/delete-after-migration-manifest.bin",
      sourceDeviceId: "source-device",
      isLatest: true,
      createdAt: 10,
    });
    await drainMigration(t, exactLease(fence));
    await t.run(async (ctx) => {
      await ctx.db.patch(fence.migrationId as Id<"auth_owner_migrations">, {
        status: "complete",
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const deletionFence = await beginDestinationDelete(t, toOwnerId);
    stubEmptyLegacyR2();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(
        internal.account_deletion.purgeOwnerBackupsInternal,
        deletionFence,
      ),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await releaseLegacySweepBarrier(
      t,
      `purge:${encodeURIComponent(toOwnerId)}:${deletionFence.operationId}`,
    );
    await expect(
      t.action(
        internal.account_deletion.purgeOwnerBackupsInternal,
        deletionFence,
      ),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    const residue = await t.run(async (ctx) => ({
      sourceEscrows: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .collect(),
      destinationEscrows: await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", toOwnerId))
        .collect(),
      sourceObjects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      destinationObjects: await ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
      sourceManifests: await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
      destinationManifests: await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", toOwnerId),
        )
        .collect(),
    }));
    expect(residue).toEqual({
      sourceEscrows: [],
      destinationEscrows: [],
      sourceObjects: [],
      destinationObjects: [],
      sourceManifests: [],
      destinationManifests: [],
    });
  });
});
