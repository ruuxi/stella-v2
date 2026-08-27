/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { r2 } from "./r2_files";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

const COMPONENT_R2_ENV = {
  R2_ACCESS_KEY_ID: "backup-test-access",
  R2_SECRET_ACCESS_KEY: "backup-test-secret",
  R2_ENDPOINT: "https://backup-test.r2.cloudflarestorage.com",
  R2_BUCKET: "backup-test-bucket",
} as const;

const objectId = "a".repeat(64);
const objectCiphertextSha256 = "f".repeat(64);
const objectPlaintextSha256 = "b".repeat(64);
const manifestCiphertextSha256 = "1".repeat(64);
const manifestPlaintextSha256 = "c".repeat(64);
const snapshotHash = "d".repeat(64);

const seedOwner = async (
  t: TestHarness,
  args: {
    ownerId: string;
    generation: string;
    deviceId?: string;
    deviceGeneration?: string;
    escrow?: boolean;
  },
) =>
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: args.ownerId,
      generation: args.generation,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    const deviceId = args.deviceId ?? "device-1";
    const device = await ctx.db.insert("devices", {
      ownerId: args.ownerId,
      ...(args.deviceGeneration
        ? { ownerGeneration: args.deviceGeneration }
        : {}),
      deviceId,
    });
    if (args.escrow) {
      await ctx.db.insert("backup_key_escrows", {
        ownerId: args.ownerId,
        ownerGeneration: args.generation,
        encryptedKey: "test-only-encrypted-key",
        keyFingerprint: "e".repeat(64),
        keyVersion: 1,
        sourceDeviceId: deviceId,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    return device;
  });

const stubUploadUrls = () =>
  vi.spyOn(r2, "generateUploadUrl").mockImplementation(async (key?: string) => {
    const exactKey = key ?? "generated-backup-key";
    return {
      key: exactKey,
      url: `https://upload.invalid/${encodeURIComponent(exactKey)}`,
    };
  });

const stubComponentR2Env = () => {
  for (const [key, value] of Object.entries(COMPONENT_R2_ENV)) {
    vi.stubEnv(key, value);
  }
};

const stubEmptyLegacyR2 = () => {
  stubComponentR2Env();
  return vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
    Contents: [],
    IsTruncated: false,
    $metadata: { httpStatusCode: 200 },
  } as never);
};

const releasePurgeSweepBarrier = async (
  t: TestHarness,
  fence: { ownerId: string; operationId: string },
) => {
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
    if (!sweep) throw new Error("missing backup purge sweep fixture");
    await ctx.db.patch(sweep._id, { notBefore: Date.now() - 1 });
  });
};

const prepare = async (
  t: TestHarness,
  ownerId: string,
  deviceId: string,
  snapshotId: string,
  metadata: {
    objectCiphertextSha256?: string;
    objectIvBase64Url?: string;
    objectAuthTagBase64Url?: string;
    manifestCiphertextSha256?: string;
    manifestIvBase64Url?: string;
    manifestAuthTagBase64Url?: string;
  } = {},
) => {
  const result = await t.mutation(internal.backups.prepareUploadInternal, {
    ownerId,
    sourceDeviceId: deviceId,
    snapshotId,
    snapshotHash,
    createdAt: 100,
    objects: [
      {
        objectId,
        ciphertextSha256:
          metadata.objectCiphertextSha256 ?? objectCiphertextSha256,
        plaintextSha256: objectPlaintextSha256,
        plaintextSize: 42,
        algorithm: "AES-256-GCM",
        ivBase64Url: metadata.objectIvBase64Url ?? "object-iv",
        authTagBase64Url: metadata.objectAuthTagBase64Url ?? "object-tag",
      },
    ],
    manifest: {
      ciphertextSha256:
        metadata.manifestCiphertextSha256 ?? manifestCiphertextSha256,
      plaintextSha256: manifestPlaintextSha256,
      plaintextSize: 43,
      algorithm: "AES-256-GCM",
      ivBase64Url: metadata.manifestIvBase64Url ?? "manifest-iv",
      authTagBase64Url: metadata.manifestAuthTagBase64Url ?? "manifest-tag",
    },
  });
  if (result.status !== "prepared") {
    throw new Error("Expected a prepared backup upload.");
  }
  return result;
};

const finalize = async (
  t: TestHarness,
  args: {
    ownerId: string;
    deviceId: string;
    snapshotId: string;
    objectR2Key: string;
    manifestR2Key: string;
    markLatest?: boolean;
    objectCiphertextSha256?: string;
    objectIvBase64Url?: string;
    objectAuthTagBase64Url?: string;
    manifestCiphertextSha256?: string;
    manifestIvBase64Url?: string;
    manifestAuthTagBase64Url?: string;
  },
) =>
  await t.mutation(internal.backups.finalizeUploadInternal, {
    ownerId: args.ownerId,
    sourceDeviceId: args.deviceId,
    snapshotId: args.snapshotId,
    snapshotHash,
    createdAt: 100,
    sourceHostname: "backup-device.test",
    version: 1,
    entryCount: 1,
    objectCount: 1,
    markLatest: args.markLatest,
    manifest: {
      r2Key: args.manifestR2Key,
      ciphertextSha256:
        args.manifestCiphertextSha256 ?? manifestCiphertextSha256,
      plaintextSha256: manifestPlaintextSha256,
      plaintextSize: 43,
      algorithm: "AES-256-GCM",
      ivBase64Url: args.manifestIvBase64Url ?? "manifest-iv",
      authTagBase64Url: args.manifestAuthTagBase64Url ?? "manifest-tag",
    },
    uploadedObjects: [
      {
        objectId,
        ciphertextSha256: args.objectCiphertextSha256 ?? objectCiphertextSha256,
        r2Key: args.objectR2Key,
        plaintextSha256: objectPlaintextSha256,
        plaintextSize: 42,
        algorithm: "AES-256-GCM",
        ivBase64Url: args.objectIvBase64Url ?? "object-iv",
        authTagBase64Url: args.objectAuthTagBase64Url ?? "object-tag",
      },
    ],
  });

const beginAndClaim = async (
  t: TestHarness,
  ownerId: string,
  mode: "reset" | "delete",
) => {
  const operationId = `${mode}-${ownerId}`;
  const begun = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode, now: Date.now() },
  );
  const leaseId = `lease-${ownerId}`;
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
    mode,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("backup upload authority", () => {
  it("fails closed on a legacy device row and reserves exact owner-generation locators before returning upload URLs", async () => {
    const t = createTest();
    const ownerId = "backup:user:prepared";
    const generation = "generation-prepared";
    const deviceId = "device-prepared";
    const device = await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      escrow: true,
    });
    stubUploadUrls();

    await expect(
      prepare(t, ownerId, deviceId, "snapshot-prepared"),
    ).rejects.toThrow(/device registration predates/u);
    await t.run(async (ctx) =>
      ctx.db.patch(device as Id<"devices">, { ownerGeneration: generation }),
    );

    const result = await prepare(t, ownerId, deviceId, "snapshot-prepared");
    expect(result.existingObjectIds).toEqual([]);
    expect(result.missingObjects).toHaveLength(1);
    expect(result.missingObjects[0]?.r2Key).toBe(
      `backups/${encodeURIComponent(ownerId)}/keys/${"e".repeat(64)}/objects/${objectId}/${objectCiphertextSha256}.bin`,
    );
    expect(result.manifest.r2Key).toMatch(
      new RegExp(
        `^backups/${encodeURIComponent(ownerId)}/keys/${"e".repeat(64)}/manifests/snapshot-prepared/[a-f0-9]{32}-${manifestCiphertextSha256}\\.bin$`,
        "u",
      ),
    );
    const reservations = await t.run(async (ctx) =>
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .collect(),
    );
    expect(reservations).toHaveLength(2);
    expect(
      reservations.map((row) => ({
        generation: row.ownerGeneration,
        kind: row.kind,
        snapshotId: row.snapshotId,
        objectId: row.objectId,
        r2Key: row.r2Key,
        live: row.uploadExpiresAt > Date.now(),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          generation,
          kind: "object",
          snapshotId: "snapshot-prepared",
          objectId,
          r2Key: result.missingObjects[0]!.r2Key,
          live: true,
        },
        {
          generation,
          kind: "manifest",
          snapshotId: "snapshot-prepared",
          objectId: undefined,
          r2Key: result.manifest.r2Key,
          live: true,
        },
      ]),
    );
  });

  it("rejects snapshot path segments before issuing upload authority", async () => {
    const t = createTest();
    const ownerId = "backup-unsafe-snapshot-owner";
    const generation = "generation-unsafe-snapshot";
    const deviceId = "device-unsafe-snapshot";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    const uploadSpy = stubUploadUrls();

    await expect(prepare(t, ownerId, deviceId, "../escape")).rejects.toThrow(
      /safe opaque path segment/u,
    );
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_upload_reservations").collect(),
      ),
    ).toEqual([]);
  });

  it("blocks backup reads and download URL minting as soon as reset is fenced", async () => {
    const t = createTest();
    const ownerId = "backup-read-fence-owner";
    const generation = "generation-read-fence";
    const deviceId = "device-read-fence";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("backup_objects", {
        ownerId,
        ownerGeneration: generation,
        objectId,
        r2Key: `backups/${ownerId}/objects/${objectId}.bin`,
        uploadExpiresAt: 0,
        algorithm: "AES-256-GCM",
        plaintextSha256: objectPlaintextSha256,
        plaintextSize: 42,
        ivBase64Url: "object-iv",
        authTagBase64Url: "object-tag",
        sourceDeviceId: deviceId,
        createdAt: 1,
      });
    });
    await beginAndClaim(t, ownerId, "reset");
    const getUrlSpy = vi.spyOn(r2, "getUrl");

    await expect(
      t.query(internal.backups.listBackupsForOwnerInternal, {
        ownerId,
        deviceId,
      }),
    ).rejects.toThrow(/data is being reset/u);
    await expect(
      t.action(internal.backups.getObjectDownloadPlanInternal, {
        ownerId,
        deviceId,
        snapshotId: "snapshot-read-fence",
        objectIds: [objectId],
      }),
    ).rejects.toThrow(/data is being reset/u);
    await expect(
      t.action(internal.backups.getKeyEscrowStatusInternal, {
        ownerId,
        deviceId,
      }),
    ).rejects.toThrow(/data is being reset/u);
    expect(getUrlSpy).not.toHaveBeenCalled();
  });

  it("rejects client-chosen cross-owner keys and stale-generation finalize without consuming reservations", async () => {
    const t = createTest();
    const ownerId = "backup-owner-authority";
    const generation = "generation-one";
    const deviceId = "device-authority";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    stubUploadUrls();
    const prepared = await prepare(t, ownerId, deviceId, "snapshot-authority");

    await expect(
      finalize(t, {
        ownerId,
        deviceId,
        snapshotId: "snapshot-authority",
        objectR2Key: prepared.missingObjects[0]!.r2Key,
        manifestR2Key: "backups/another-owner/manifests/stolen.bin",
      }),
    ).rejects.toThrow(/does not match this owner and snapshot/u);

    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      const device = await ctx.db
        .query("devices")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", deviceId),
        )
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: "generation-two",
        updatedAt: 2,
      });
      await ctx.db.patch(device!._id, { ownerGeneration: "generation-two" });
    });
    await expect(
      finalize(t, {
        ownerId,
        deviceId,
        snapshotId: "snapshot-authority",
        objectR2Key: prepared.missingObjects[0]!.r2Key,
        manifestR2Key: prepared.manifest.r2Key,
      }),
    ).rejects.toThrow(
      /predates the current account-data generation|reservation is no longer current/u,
    );

    const residue = await t.run(async (ctx) => ({
      reservations: await ctx.db.query("backup_upload_reservations").collect(),
      objects: await ctx.db.query("backup_objects").collect(),
      manifests: await ctx.db.query("backup_manifests").collect(),
    }));
    expect(residue.reservations).toHaveLength(2);
    expect(residue.objects).toEqual([]);
    expect(residue.manifests).toEqual([]);
  });

  it("shares one immutable content-addressed object reservation across concurrent snapshots", async () => {
    const t = createTest();
    const ownerId = "backup-shared-object-owner";
    const generation = "generation-shared";
    const deviceId = "device-shared";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    stubUploadUrls();
    const first = await prepare(t, ownerId, deviceId, "snapshot-first");
    const second = await prepare(t, ownerId, deviceId, "snapshot-second");
    expect(second.missingObjects[0]?.r2Key).toBe(
      first.missingObjects[0]?.r2Key,
    );

    const beforeFinalize = await t.run(async (ctx) =>
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .collect(),
    );
    expect(beforeFinalize.filter((row) => row.kind === "object")).toHaveLength(
      1,
    );
    expect(beforeFinalize.find((row) => row.kind === "object")).toMatchObject({
      ownerGeneration: generation,
      snapshotId: "snapshot-second",
      objectId,
      r2Key: first.missingObjects[0]!.r2Key,
    });

    await finalize(t, {
      ownerId,
      deviceId,
      snapshotId: "snapshot-first",
      objectR2Key: first.missingObjects[0]!.r2Key,
      manifestR2Key: first.manifest.r2Key,
    });
    await finalize(t, {
      ownerId,
      deviceId,
      snapshotId: "snapshot-second",
      objectR2Key: second.missingObjects[0]!.r2Key,
      manifestR2Key: second.manifest.r2Key,
    });

    const result = await t.run(async (ctx) => ({
      reservations: await ctx.db.query("backup_upload_reservations").collect(),
      objects: await ctx.db.query("backup_objects").collect(),
      manifests: await ctx.db.query("backup_manifests").collect(),
    }));
    expect(result.reservations).toEqual([]);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toMatchObject({
      ownerId,
      ownerGeneration: generation,
      objectId,
      r2Key: first.missingObjects[0]!.r2Key,
    });
    expect(result.manifests).toHaveLength(2);
  });

  it("replays finalize after a lost response without duplicating rows or changing latest authority", async () => {
    const t = createTest();
    const ownerId = "backup-finalize-replay-owner";
    const generation = "generation-finalize-replay";
    const deviceId = "device-finalize-replay";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    stubUploadUrls();
    const prepared = await prepare(
      t,
      ownerId,
      deviceId,
      "snapshot-finalize-replay",
    );
    const args = {
      ownerId,
      deviceId,
      snapshotId: "snapshot-finalize-replay",
      objectR2Key: prepared.missingObjects[0]!.r2Key,
      manifestR2Key: prepared.manifest.r2Key,
    };

    const committed = await finalize(t, args);
    expect(committed).toEqual({
      snapshotId: "snapshot-finalize-replay",
      isLatest: true,
    });
    await expect(finalize(t, args)).resolves.toEqual(committed);

    const state = await t.run(async (ctx) => ({
      reservations: await ctx.db.query("backup_upload_reservations").collect(),
      objects: await ctx.db.query("backup_objects").collect(),
      manifests: await ctx.db.query("backup_manifests").collect(),
    }));
    expect(state.reservations).toEqual([]);
    expect(state.objects).toHaveLength(1);
    expect(state.manifests).toHaveLength(1);
    expect(state.manifests[0]?.isLatest).toBe(true);
  });

  it("retains a prepared locator through expiry and response loss, then converges on restart", async () => {
    const t = createTest();
    const ownerId = "backup-prepared-delete-owner";
    const generation = "generation-prepared-delete";
    const deviceId = "device-prepared-delete";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    stubUploadUrls();
    await prepare(t, ownerId, deviceId, "snapshot-prepared-delete");
    const fence = await beginAndClaim(t, ownerId, "delete");
    stubEmptyLegacyR2();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await releasePurgeSweepBarrier(t, fence);
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/active backup upload authority/u);
    expect(fetchSpy).not.toHaveBeenCalled();

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("backup_upload_reservations").collect();
      await Promise.all(
        rows.map((row) =>
          ctx.db.patch(row._id, { uploadExpiresAt: Date.now() - 1 }),
        ),
      );
    });
    fetchSpy
      .mockRejectedValueOnce(new Error("response lost after direct delete"))
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/locator rows were retained for retry/u);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_upload_reservations").collect(),
      ),
    ).toHaveLength(1);

    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).resolves.toBeNull();
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    expect(
      await t.run(async (ctx) => ({
        reservations: await ctx.db
          .query("backup_upload_reservations")
          .collect(),
        objects: await ctx.db.query("backup_objects").collect(),
        manifests: await ctx.db.query("backup_manifests").collect(),
        escrows: await ctx.db.query("backup_key_escrows").collect(),
      })),
    ).toEqual({ reservations: [], objects: [], manifests: [], escrows: [] });
  });

  it("migration cleanup waits out source PUT authority and deletes only unfinalized reservations", async () => {
    const t = createTest();
    const fromOwnerId = "backup-migration-source";
    const toOwnerId = "backup-migration-destination";
    const fromGeneration = "backup-migration-source-generation";
    const toGeneration = "backup-migration-destination-generation";
    const deviceId = "backup-migration-device";
    await seedOwner(t, {
      ownerId: fromOwnerId,
      generation: fromGeneration,
      deviceId,
      deviceGeneration: fromGeneration,
      escrow: true,
    });
    await seedOwner(t, {
      ownerId: toOwnerId,
      generation: toGeneration,
      deviceId: "destination-device",
      deviceGeneration: toGeneration,
    });
    stubUploadUrls();
    await prepare(t, fromOwnerId, deviceId, "snapshot-migration-pending");
    const leaseId = "backup-migration-lease";
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId,
          toOwnerId,
          status: "running",
          leaseId,
          leaseGeneration: 7,
          fromOwnerGeneration: fromGeneration,
          toOwnerGeneration: toGeneration,
          planRevision: 1,
          leaseExpiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("backup_upload_reservations", {
        ownerId: toOwnerId,
        ownerGeneration: toGeneration,
        keyFingerprint: "e".repeat(64),
        kind: "manifest",
        snapshotId: "destination-pre-link-prepare",
        r2Key: `backups/${encodeURIComponent(toOwnerId)}/keys/${"e".repeat(64)}/manifests/destination-pre-link-prepare.bin`,
        uploadExpiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const args = {
      fromOwnerId,
      toOwnerId,
      migrationId: String(migrationId),
      leaseId,
      leaseGeneration: 7,
      fromOwnerGeneration: fromGeneration,
      toOwnerGeneration: toGeneration,
      planRevision: 1,
      now: Date.now(),
    };
    stubComponentR2Env();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(r2, "deleteObject").mockResolvedValue(undefined);

    await expect(
      t.action(
        internal.account_deletion
          .cleanupOwnerBackupReservationsForMigrationInternal,
        args,
      ),
    ).resolves.toMatchObject({ ready: false });
    expect(fetchSpy).not.toHaveBeenCalled();

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("backup_upload_reservations").collect();
      await Promise.all(
        rows.map((row) =>
          ctx.db.patch(row._id, { uploadExpiresAt: Date.now() - 1 }),
        ),
      );
    });
    fetchSpy.mockRejectedValue(new Error("lost delete response"));
    await expect(
      t.action(
        internal.account_deletion
          .cleanupOwnerBackupReservationsForMigrationInternal,
        args,
      ),
    ).resolves.toEqual({ ready: false, retryAfterMs: 5_000 });
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("backup_upload_reservations").collect(),
      ),
    ).toHaveLength(3);

    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      t.action(
        internal.account_deletion
          .cleanupOwnerBackupReservationsForMigrationInternal,
        args,
      ),
    ).resolves.toEqual({ ready: true });
    expect(
      await t.run(async (ctx) => ({
        reservations: await ctx.db
          .query("backup_upload_reservations")
          .collect(),
        objects: await ctx.db.query("backup_objects").collect(),
        manifests: await ctx.db.query("backup_manifests").collect(),
      })),
    ).toEqual({ reservations: [], objects: [], manifests: [] });
  });

  it("fences legacy finalized locators before delete so a stale PUT remains nameable until exact cleanup", async () => {
    const t = createTest();
    const ownerId = "backup-legacy-finalized-delete-owner";
    const generation = "generation-legacy-finalized-delete";
    const deviceId = "device-legacy-finalized-delete";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    const objectR2Key = `backups/${encodeURIComponent(ownerId)}/legacy-object.bin`;
    const manifestR2Key = `backups/${encodeURIComponent(ownerId)}/legacy-manifest.bin`;
    await t.run(async (ctx) => {
      await ctx.db.insert("backup_objects", {
        ownerId,
        ownerGeneration: generation,
        keyFingerprint: "e".repeat(64),
        objectId,
        r2Key: objectR2Key,
        algorithm: "AES-256-GCM",
        plaintextSha256: objectPlaintextSha256,
        plaintextSize: 42,
        ivBase64Url: "legacy-object-iv",
        authTagBase64Url: "legacy-object-tag",
        sourceDeviceId: deviceId,
        createdAt: 1,
      });
      await ctx.db.insert("backup_manifests", {
        ownerId,
        ownerGeneration: generation,
        keyFingerprint: "e".repeat(64),
        snapshotId: "snapshot-legacy-finalized-delete",
        snapshotHash,
        sourceDeviceId: deviceId,
        manifestR2Key,
        manifestAlgorithm: "AES-256-GCM",
        manifestPlaintextSha256,
        manifestPlaintextSize: 43,
        manifestIvBase64Url: "legacy-manifest-iv",
        manifestAuthTagBase64Url: "legacy-manifest-tag",
        entryCount: 1,
        objectCount: 1,
        isLatest: true,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const fence = await beginAndClaim(t, ownerId, "delete");
    stubEmptyLegacyR2();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(r2, "deleteObject").mockResolvedValue(undefined);

    const fenceStartedAt = Date.now();
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await releasePurgeSweepBarrier(t, fence);
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/backup object upload authority to expire/u);
    expect(fetchSpy).not.toHaveBeenCalled();
    const fencedRows = await t.run(async (ctx) => ({
      object: await ctx.db.query("backup_objects").unique(),
      manifest: await ctx.db.query("backup_manifests").unique(),
    }));
    expect(fencedRows.object?.uploadExpiresAt).toBeGreaterThan(fenceStartedAt);
    expect(fencedRows.manifest?.uploadExpiresAt).toBeGreaterThan(
      fenceStartedAt,
    );

    // Model a legacy URL replay after the first purge attempt. The database
    // still retains both exact locators, so post-expiry cleanup can address and
    // remove the bytes rather than orphaning them.
    const replayedRawR2Bytes = new Set([objectR2Key, manifestR2Key]);
    fetchSpy.mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      const bucketPrefix = `/${COMPONENT_R2_ENV.R2_BUCKET}/`;
      const key = url.pathname
        .slice(bucketPrefix.length)
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      const existed = replayedRawR2Bytes.delete(key);
      return new Response(null, { status: existed ? 204 : 404 });
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(fencedRows.object!._id, {
        uploadExpiresAt: Date.now() - 1,
      });
      await ctx.db.patch(fencedRows.manifest!._id, {
        uploadExpiresAt: Date.now() - 1,
      });
    });

    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).resolves.toBeNull();
    expect(replayedRawR2Bytes.size).toBe(0);
    expect(
      await t.run(async (ctx) => ({
        objects: await ctx.db.query("backup_objects").collect(),
        manifests: await ctx.db.query("backup_manifests").collect(),
        escrows: await ctx.db.query("backup_key_escrows").collect(),
      })),
    ).toEqual({ objects: [], manifests: [], escrows: [] });
  });

  it("keeps finalized locators and escrow across a stale PUT window, then reset clears exact backup readback", async () => {
    const t = createTest();
    const ownerId = "backup-finalized-reset-owner";
    const generation = "generation-finalized-reset";
    const deviceId = "device-finalized-reset";
    await seedOwner(t, {
      ownerId,
      generation,
      deviceId,
      deviceGeneration: generation,
      escrow: true,
    });
    stubUploadUrls();
    const prepared = await prepare(
      t,
      ownerId,
      deviceId,
      "snapshot-finalized-reset",
    );
    await finalize(t, {
      ownerId,
      deviceId,
      snapshotId: "snapshot-finalized-reset",
      objectR2Key: prepared.missingObjects[0]!.r2Key,
      manifestR2Key: prepared.manifest.r2Key,
    });
    const fence = await beginAndClaim(t, ownerId, "reset");
    stubEmptyLegacyR2();
    const replayedRawR2Bytes = new Map<string, Uint8Array>();
    const directlyDeletedKeys: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        );
        expect(init?.method).toBe("DELETE");
        const bucketPrefix = `/${COMPONENT_R2_ENV.R2_BUCKET}/`;
        expect(url.pathname.startsWith(bucketPrefix)).toBe(true);
        const key = url.pathname
          .slice(bucketPrefix.length)
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        directlyDeletedKeys.push(key);
        const existed = replayedRawR2Bytes.delete(key);
        return new Response(null, { status: existed ? 204 : 404 });
      });
    vi.spyOn(r2, "deleteObject").mockResolvedValue(undefined);

    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/legacy backup raw-storage quiescence/u);
    await releasePurgeSweepBarrier(t, fence);
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).rejects.toThrow(/active backup object upload authority/u);
    expect(fetchSpy).not.toHaveBeenCalled();
    const beforeExpiry = await t.run(async (ctx) => ({
      object: await ctx.db.query("backup_objects").first(),
      manifest: await ctx.db.query("backup_manifests").first(),
      escrow: await ctx.db.query("backup_key_escrows").first(),
    }));
    expect(beforeExpiry.object?.r2Key).toBe(prepared.missingObjects[0]!.r2Key);
    expect(beforeExpiry.manifest?.manifestR2Key).toBe(prepared.manifest.r2Key);
    expect(beforeExpiry.escrow).not.toBeNull();
    // Replay both old presigned PUTs while their authority is still live. The
    // durable locators remain, so the post-expiry direct DELETE must remove
    // these exact bytes before Convex forgets how to address them.
    replayedRawR2Bytes.set(
      prepared.missingObjects[0]!.r2Key,
      new Uint8Array([1, 2, 3]),
    );
    replayedRawR2Bytes.set(prepared.manifest.r2Key, new Uint8Array([4, 5, 6]));
    expect(replayedRawR2Bytes.size).toBe(2);

    await t.run(async (ctx) => {
      const objects = await ctx.db.query("backup_objects").collect();
      const manifests = await ctx.db.query("backup_manifests").collect();
      await Promise.all([
        ...objects.map((row) =>
          ctx.db.patch(row._id, { uploadExpiresAt: Date.now() - 1 }),
        ),
        ...manifests.map((row) =>
          ctx.db.patch(row._id, { uploadExpiresAt: Date.now() - 1 }),
        ),
      ]);
    });
    await expect(
      t.action(internal.account_deletion.purgeOwnerBackupsInternal, fence),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(replayedRawR2Bytes.size).toBe(0);
    expect(new Set(directlyDeletedKeys)).toEqual(
      new Set([prepared.missingObjects[0]!.r2Key, prepared.manifest.r2Key]),
    );
    const resetResidue = await t.query(
      internal.reset.remainingOwnerResetStoresInternal,
      { ownerId },
    );
    expect(resetResidue.filter((name) => name.startsWith("backup_"))).toEqual(
      [],
    );
    const accountResidue = await t.query(
      internal.account_deletion.remainingOwnerAccountCoreStoresInternal,
      { ownerId },
    );
    expect(accountResidue.filter((name) => name.startsWith("backup_"))).toEqual(
      [],
    );
  });
});
