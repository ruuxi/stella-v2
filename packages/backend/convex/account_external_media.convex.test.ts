/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { rawR2KeyFromOwnedPublicUrl } from "./account_external_media_store";
import { r2 } from "./r2_files";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const reserve = makeFunctionReference<"mutation">(
  "account_external_media_store:reserveExternalMediaUploadInternal",
);
const finalize = makeFunctionReference<"mutation">(
  "account_external_media_store:finalizeExternalMediaUploadInternal",
);
const getPurgeBatch = makeFunctionReference<"query">(
  "account_external_media_store:getOwnerExternalMediaPurgeBatchInternal",
);
const acknowledge = makeFunctionReference<"mutation">(
  "account_external_media_store:acknowledgeOwnerExternalMediaDeletedInternal",
);
const remaining = makeFunctionReference<"query">(
  "account_external_media_store:remainingOwnerExternalMediaRowsInternal",
);
const materializeLegacy = makeFunctionReference<"mutation">(
  "account_external_media_store:materializeLegacyExternalMediaInternal",
);
const purgeExternalMedia = makeFunctionReference<"action">(
  "account_external_media:purgeOwnerExternalMediaInternal",
);
const getMigrationBatch = makeFunctionReference<"query">(
  "account_external_media_store:getOwnerExternalMediaMigrationCleanupBatchInternal",
);
const acknowledgeMigrationCleanup = makeFunctionReference<"mutation">(
  "account_external_media_store:acknowledgeExternalMediaMigrationCleanupInternal",
);
const beginPurge = makeFunctionReference<"mutation">(
  "owner_lifecycle:beginOwnerDataPurgeInternal",
);
const claimPurge = makeFunctionReference<"mutation">(
  "owner_lifecycle:claimOwnerPurgeStageInternal",
);
const prepareOwnershipMigration = makeFunctionReference<"mutation">(
  "auth_migration:prepareOwnershipMigration",
);
const claimOwnershipMigration = makeFunctionReference<"mutation">(
  "auth_migration:claimOwnershipMigration",
);
const migrateExternalMedia = makeFunctionReference<"mutation">(
  "auth_migration:migrateAccountExternalMediaContentBatch",
);
const migrateStoreContent = makeFunctionReference<"mutation">(
  "auth_migration:migrateStoreContentBatch",
);

const rawObject = (role: string, key: string) => ({
  objectRole: role,
  storageKind: "raw-r2" as const,
  bucket: "test-media",
  r2Key: key,
  payloadSha256: "a".repeat(64),
  publicUrl: `https://media.example.test/${key}`,
});

const RAW_MEDIA_ENV = {
  R2_PETS_BUCKET: "stella-v2-pets-dev",
  R2_PETS_PUBLIC_BASE_URL: "https://pets.dev.example.test",
  R2_EMOJI_BUCKET: "stella-v2-emoji-dev",
  R2_EMOJI_PUBLIC_BASE_URL: "https://emoji.dev.example.test",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
  R2_BUCKET: "test-component-media",
} as const;

const stubRawMediaEnv = () => {
  for (const [key, value] of Object.entries(RAW_MEDIA_ENV)) {
    vi.stubEnv(key, value);
  }
};

const ownerKeyFor = async (ownerId: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerId)),
  );
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
};

const beginDeleteLease = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  now: number,
) => {
  const operationId = `delete-${ownerId}`;
  const lifecycle = (await t.mutation(beginPurge, {
    ownerId,
    operationId,
    mode: "delete",
    now,
  })) as { generation: string };
  const leaseId = `lease-${ownerId}`;
  const claim = (await t.mutation(claimPurge, {
    ownerId,
    operationId,
    generation: lifecycle.generation,
    stage: "core",
    leaseId,
    now,
  })) as { claimed: boolean };
  expect(claim.claimed).toBe(true);
  return { ownerId, operationId, generation: lifecycle.generation, leaseId };
};

const insertCommittedLocator = async (
  t: ReturnType<typeof createTest>,
  args: {
    ownerId: string;
    storageKind: "raw-r2" | "component-r2";
    r2Key: string;
    bucket?: string;
    uploadExpiresAt?: number;
  },
) =>
  await t.run(async (ctx) =>
    ctx.db.insert("account_external_media_objects", {
      ownerId: args.ownerId,
      ownerGeneration: "legacy",
      uploadId: `upload-${args.ownerId}`,
      objectRole: "media",
      storageKind: args.storageKind,
      ...(args.bucket ? { bucket: args.bucket } : {}),
      r2Key: args.r2Key,
      payloadSha256: "b".repeat(64),
      state: "committed",
      uploadExpiresAt: args.uploadExpiresAt ?? 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  );

describe("account external-media durability", () => {
  it("accepts only URLs under the exact owner prefix", () => {
    const publicBase = new URL("https://media.example.test/assets");
    expect(
      rawR2KeyFromOwnedPublicUrl({
        value:
          "https://media.example.test/assets/user-pets/abc123/pet/upload/sheet.webp",
        publicBase,
        acceptedPrefixes: ["user-pets"],
        ownerKey: "abc123",
      }),
    ).toBe("user-pets/abc123/pet/upload/sheet.webp");
    expect(
      rawR2KeyFromOwnedPublicUrl({
        value:
          "https://media.example.test/assets/user-pets/someone-else/pet/upload/sheet.webp",
        publicBase,
        acceptedPrefixes: ["user-pets"],
        ownerKey: "abc123",
      }),
    ).toBeNull();
    expect(
      rawR2KeyFromOwnedPublicUrl({
        value:
          "https://attacker.example.test/assets/user-pets/abc123/pet/upload/sheet.webp",
        publicBase,
        acceptedPrefixes: ["user-pets"],
        ownerKey: "abc123",
      }),
    ).toBeNull();

    for (const value of [
      "https://media.example.test/assets/user-pets/abc123/%2F..%2F..%2F..%2Fuser-pets%2Fvictim%2Fpet%2Fupload%2Fsheet.webp",
      "https://media.example.test/assets/user-pets/abc123/%2F..%2F..%2F..%2F..%2Femoji-dev%2Fvictim%2Fsheet.webp",
      "https://media.example.test/assets/user-pets/abc123/%5C..%5Cvictim%5Csheet.webp",
      "https://media.example.test/assets/user-pets/abc123/%252F..%252Fvictim%252Fsheet.webp",
      "https://media.example.test/assets/user-pets/abc123/%ZZ",
      "https://media.example.test/assets/user-pets/abc123//sheet.webp",
      "https://media.example.test/assets/user-pets/abc123/../victim/sheet.webp",
    ]) {
      expect(
        rawR2KeyFromOwnedPublicUrl({
          value,
          publicBase,
          acceptedPrefixes: ["user-pets"],
          ownerKey: "abc123",
        }),
      ).toBeNull();
    }
  });

  it.each([
    [
      "cross-owner",
      "%2F..%2F..%2F..%2Fuser-pets%2Fvictim%2Fpet%2Fupload%2Fsheet.webp",
    ],
    [
      "cross-bucket",
      "%2F..%2F..%2F..%2F..%2Fstella-v2-emoji-dev%2Femoji-packs%2Fvictim%2Fsheet.webp",
    ],
  ])(
    "retains a legacy pet and rolls back locators for a malformed %s reference",
    async (_case, encodedAttack) => {
      const t = createTest();
      const ownerId = `owner-malformed-${_case}`;
      const ownerKey = await ownerKeyFor(ownerId);
      const now = Date.now();
      const petId = await t.run(async (ctx) =>
        ctx.db.insert("user_pets", {
          ownerId,
          petId: `malformed-${_case}-pet`,
          displayName: "Malformed legacy pet",
          description: "test",
          tags: [],
          spritesheetUrl: `https://pets.dev.example.test/user-pets/${ownerKey}/pet/upload/sheet.webp`,
          previewUrl: `https://pets.dev.example.test/user-pets/${ownerKey}/${encodedAttack}`,
          visibility: "private",
          searchText: "malformed legacy pet",
          createdAt: now,
          updatedAt: now,
        }),
      );
      const fence = await beginDeleteLease(t, ownerId, now + 1);
      stubRawMediaEnv();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));
      try {
        await expect(t.mutation(materializeLegacy, fence)).rejects.toThrow(
          /retained as deletion debt/u,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        const snapshot = await t.run(async (ctx) => ({
          pet: await ctx.db.get(petId),
          locators: await ctx.db
            .query("account_external_media_objects")
            .withIndex("by_ownerId_and_uploadId", (q) =>
              q.eq("ownerId", ownerId),
            )
            .take(8),
        }));
        expect(snapshot.pet).not.toBeNull();
        expect(snapshot.locators).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps malicious legacy locator debt and performs no cross-owner or cross-bucket DELETE", async () => {
    const t = createTest();
    const ownerId = "owner-malicious-materialized-locators";
    const now = Date.now();
    const crossOwner =
      "user-pets/attacker//../../../user-pets/victim/pet/upload/sheet.webp";
    const crossBucket =
      "user-pets/attacker//../../../../stella-v2-emoji-dev/emoji-packs/victim/sheet.webp";
    const { petId, locatorIds } = await t.run(async (ctx) => {
      const petId = await ctx.db.insert("user_pets", {
        ownerId,
        petId: "malicious-materialized-pet",
        displayName: "Malicious materialized pet",
        description: "test",
        tags: [],
        spritesheetUrl: "https://pets.dev.example.test/legacy.webp",
        visibility: "private",
        searchText: "malicious materialized pet",
        createdAt: now,
        updatedAt: now,
      });
      const sourceKey = `user_pet:${petId}`;
      const locatorIds: Id<"account_external_media_objects">[] = [];
      for (const [index, r2Key] of [crossOwner, crossBucket].entries()) {
        locatorIds.push(
          await ctx.db.insert("account_external_media_objects", {
            ownerId,
            ownerGeneration: "legacy",
            uploadId: `legacy:${sourceKey}`,
            objectRole: index === 0 ? "cross-owner" : "cross-bucket",
            storageKind: "raw-r2",
            bucket: "stella-v2-pets-dev",
            r2Key,
            payloadSha256: "legacy-unknown",
            state: "committed",
            uploadExpiresAt: 0,
            sourceKind: "user_pet",
            sourceId: petId,
            sourceKey,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      return { petId, locatorIds };
    });
    const fence = await beginDeleteLease(t, ownerId, now + 1);
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const result = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(result.ready).toBe(false);
      expect(result.pending).toEqual(
        expect.arrayContaining([
          `delete_failed:raw-r2:locator:${locatorIds[0]}`,
          `delete_failed:raw-r2:locator:${locatorIds[1]}`,
        ]),
      );
      expect(result.pending.join("\n")).not.toContain(crossOwner);
      expect(result.pending.join("\n")).not.toContain(crossBucket);
      expect(result.pending.join("\n")).not.toContain(
        RAW_MEDIA_ENV.R2_SECRET_ACCESS_KEY,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      const snapshot = await t.run(async (ctx) => ({
        pet: await ctx.db.get(petId),
        locators: await Promise.all(locatorIds.map((id) => ctx.db.get(id))),
      }));
      expect(snapshot.pet).not.toBeNull();
      expect(snapshot.locators.every((row) => row?.state === "committed")).toBe(
        true,
      );
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("leaves C8-retired pet and Store media to the exact global cleanup owner", async () => {
    const t = createTest();
    const ownerId = "owner-c8-global-media-cleanup";
    const ownerKey = await ownerKeyFor(ownerId);
    const now = Date.now();
    const seeded = await t.run(async (ctx) => {
      const petId = await ctx.db.insert("user_pets", {
        ownerId,
        petId: "c8-retired-pet",
        displayName: "C8 retired pet",
        description: "global cleanup owns this row",
        tags: [],
        spritesheetUrl: `https://pets.dev.example.test/user-pets/${ownerKey}/pet/upload/sheet.webp`,
        visibility: "private",
        searchText: "c8 retired pet",
        createdAt: now,
        updatedAt: now,
      });
      const packId = await ctx.db.insert("emoji_packs", {
        ownerId,
        packId: "c8-emoji-pack",
        displayName: "C8 emoji pack",
        tags: [],
        coverEmoji: "star",
        sheetUrls: [
          `https://emoji.dev.example.test/emoji-packs/${ownerKey}/pack/sheet.webp`,
        ],
        visibility: "private",
        searchText: "c8 emoji pack",
        createdAt: now,
        updatedAt: now,
      });
      const packageId = await ctx.db.insert("store_packages", {
        ownerId,
        packageId: "c8-retired-package",
        displayName: "C8 retired package",
        searchText: "c8 retired package",
        latestReleaseNumber: 1,
        createdAt: now,
        updatedAt: now,
      });
      const releaseId = await ctx.db.insert("store_package_releases", {
        ownerId,
        packageRef: packageId,
        packageId: "c8-retired-package",
        releaseNumber: 1,
        manifest: {},
        blueprintMarkdown: "# C8 retired release",
        diffRef: {
          kind: "r2",
          r2Key: "store/c8/shared-release.diff",
          sha256: "c8-store-release-sha",
          sizeBytes: 10,
        },
        createdAt: now,
      });
      await ctx.db.patch(packageId, { latestReleaseId: releaseId });
      return { petId, packId, packageId, releaseId };
    });
    const fence = await beginDeleteLease(t, ownerId, now + 1);
    stubRawMediaEnv();
    vi.stubEnv("CONVEX_CLOUD_URL", "https://impartial-crab-34.convex.cloud");
    vi.stubEnv("CONVEX_SITE_URL", "https://impartial-crab-34.convex.site");
    vi.stubEnv("STELLA_C8_RETIRED_WRITES_DISABLED", "1");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("C8 media must not use account deletion"));
    try {
      await expect(t.mutation(materializeLegacy, fence)).resolves.toEqual({
        materialized: 1,
        deletedEmpty: 0,
      });
      const afterMaterialize = await t.run(async (ctx) => ({
        pet: await ctx.db.get(seeded.petId),
        pack: await ctx.db.get(seeded.packId),
        pkg: await ctx.db.get(seeded.packageId),
        release: await ctx.db.get(seeded.releaseId),
        locators: await ctx.db
          .query("account_external_media_objects")
          .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", ownerId).eq("state", "committed"),
          )
          .take(8),
      }));
      expect(afterMaterialize.pet).not.toBeNull();
      expect(afterMaterialize.pack).not.toBeNull();
      expect(afterMaterialize.pkg).not.toBeNull();
      expect(afterMaterialize.release).not.toBeNull();
      expect(afterMaterialize.locators).toHaveLength(1);
      expect(afterMaterialize.locators[0]?.sourceKind).toBe("emoji_pack");
      expect(
        afterMaterialize.locators.some(
          (row) =>
            row.sourceKind === "user_pet" || row.sourceKind === "store_release",
        ),
      ).toBe(false);

      const retiredLocatorIds = await t.run(async (ctx) => {
        for (const locator of afterMaterialize.locators) {
          await ctx.db.delete(locator._id);
        }
        await ctx.db.delete(seeded.packId);
        const common = {
          ownerId,
          ownerGeneration: "legacy",
          uploadId: "c8-retired-upload",
          payloadSha256: "c8-retired-sha",
          state: "committed" as const,
          uploadExpiresAt: 0,
          createdAt: now,
          updatedAt: now,
        };
        return await Promise.all([
          ctx.db.insert("account_external_media_objects", {
            ...common,
            objectRole: "spritesheet",
            storageKind: "component-r2",
            r2Key: "shared-c8/user-pet/sheet.webp",
            sourceKind: "user_pet",
            sourceId: String(seeded.petId),
            sourceKey: `user_pet:${String(seeded.petId)}`,
          }),
          ctx.db.insert("account_external_media_objects", {
            ...common,
            objectRole: "diff",
            storageKind: "component-r2",
            r2Key: "shared-c8/store/release.diff",
            sourceKind: "store_release",
            sourceId: String(seeded.releaseId),
            sourceKey: `store_release:${String(seeded.releaseId)}`,
          }),
          ctx.db.insert("account_external_media_objects", {
            ...common,
            objectRole: "store-diff",
            storageKind: "component-r2",
            r2Key: "shared-c8/store/orphan.diff",
          }),
        ]);
      });

      const batch = (await t.query(getPurgeBatch, {
        ownerId,
        now: Date.now(),
      })) as { targets: unknown[] };
      expect(batch.targets).toEqual([]);
      const result = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(result.ready).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      const afterPurgeAttempt = await t.run(async (ctx) => ({
        pet: await ctx.db.get(seeded.petId),
        pkg: await ctx.db.get(seeded.packageId),
        release: await ctx.db.get(seeded.releaseId),
        locators: await Promise.all(
          retiredLocatorIds.map((id) => ctx.db.get(id)),
        ),
      }));
      expect(afterPurgeAttempt.pet).not.toBeNull();
      expect(afterPurgeAttempt.pkg).not.toBeNull();
      expect(afterPurgeAttempt.release).not.toBeNull();
      expect(afterPurgeAttempt.locators.every(Boolean)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("fails closed before legacy materialization when the R2 target is not explicit", async () => {
    const t = createTest();
    const ownerId = "owner-unconfigured-legacy-target";
    const now = 5_000;
    const petId = await t.run(async (ctx) =>
      ctx.db.insert("user_pets", {
        ownerId,
        petId: "unconfigured-target-pet",
        displayName: "Unconfigured target pet",
        description: "test",
        tags: [],
        spritesheetUrl:
          "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev/user-pets/legacy/sheet.webp",
        visibility: "private",
        searchText: "unconfigured target pet",
        createdAt: now,
        updatedAt: now,
      }),
    );
    const fence = await beginDeleteLease(t, ownerId, now + 1);
    vi.stubEnv(
      "R2_PUBLIC_BASE_URL",
      "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev",
    );
    vi.stubEnv("R2_PETS_BUCKET", "");
    vi.stubEnv("R2_EMOJI_BUCKET", "");
    vi.stubEnv("R2_PETS_PUBLIC_BASE_URL", "");
    vi.stubEnv("R2_EMOJI_PUBLIC_BASE_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(t.mutation(materializeLegacy, fence)).rejects.toThrow(
        /R2_PETS_BUCKET/u,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      const snapshot = await t.run(async (ctx) => ({
        pet: await ctx.db.get(petId),
        locators: await ctx.db
          .query("account_external_media_objects")
          .withIndex("by_ownerId_and_uploadId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      }));
      expect(snapshot.pet).not.toBeNull();
      expect(snapshot.locators).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps committed media durable until its full signed-write barrier expires", async () => {
    const t = createTest();
    const ownerId = "owner-committed-write-barrier";
    const now = Date.now();
    const uploadExpiresAt = now + 60_000;
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "raw-r2",
      bucket: "test-media",
      r2Key: `user-pets/${ownerId}/upload/still-writable.webp`,
      uploadExpiresAt,
    });
    const fence = await beginDeleteLease(t, ownerId, now);
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const active = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(active.ready).toBe(false);
      expect(active.pending).toContain(
        `active_upload:upload-${ownerId}:until:${uploadExpiresAt}`,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).not.toBeNull();

      // Advancing the durable barrier models the later retry after the server
      // clock has passed the full presigned-write authority window.
      await t.run(async (ctx) => {
        await ctx.db.patch(locatorId, { uploadExpiresAt: 0, updatedAt: now });
      });
      await expect(t.action(purgeExternalMedia, fence)).resolves.toEqual({
        ready: true,
        pending: [],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([403, 503])(
    "retains the exact raw-R2 locator after a %s delete response without returning secrets",
    async (status) => {
      const t = createTest();
      const ownerId = `owner-raw-delete-${status}`;
      const r2Key = `user-pets/${ownerId}/upload/private.webp`;
      const locatorId = await insertCommittedLocator(t, {
        ownerId,
        storageKind: "raw-r2",
        bucket: "test-media",
        r2Key,
      });
      const fence = await beginDeleteLease(t, ownerId, Date.now());
      stubRawMediaEnv();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("provider failure", { status }));
      try {
        const result = (await t.action(purgeExternalMedia, fence)) as {
          ready: boolean;
          pending: string[];
        };
        expect(result.ready).toBe(false);
        expect(result.pending).toContain(
          `delete_failed:raw-r2:locator:${locatorId}`,
        );
        expect(result.pending.join("\n")).not.toContain(r2Key);
        expect(result.pending.join("\n")).not.toContain("test-media");
        expect(result.pending.join("\n")).not.toContain(
          RAW_MEDIA_ENV.R2_SECRET_ACCESS_KEY,
        );
        expect(
          await t.run(async (ctx) => ctx.db.get(locatorId)),
        ).not.toBeNull();
      } finally {
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("treats a raw-R2 404 as confirmed absence and acknowledges the locator", async () => {
    const t = createTest();
    const ownerId = "owner-raw-delete-404";
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "raw-r2",
      bucket: "test-media",
      r2Key: `user-pets/${ownerId}/upload/already-gone.webp`,
    });
    const fence = await beginDeleteLease(t, ownerId, Date.now());
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    try {
      await expect(t.action(purgeExternalMedia, fence)).resolves.toEqual({
        ready: true,
        pending: [],
      });
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("retains a raw-R2 locator after a lost delete response and converges on retry", async () => {
    const t = createTest();
    const ownerId = "owner-raw-delete-response-loss";
    const r2Key = `user-pets/${ownerId}/upload/response-lost.webp`;
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "raw-r2",
      bucket: "test-media",
      r2Key,
    });
    const fence = await beginDeleteLease(t, ownerId, Date.now());
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error(`lost response for ${r2Key}`))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    try {
      const first = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(first.ready).toBe(false);
      expect(first.pending).toContain(
        `delete_failed:raw-r2:locator:${locatorId}`,
      );
      expect(first.pending.join("\n")).not.toContain(r2Key);
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).not.toBeNull();

      await expect(t.action(purgeExternalMedia, fence)).resolves.toEqual({
        ready: true,
        pending: [],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("deletes component-R2 bytes before metadata and retries when metadata removal fails", async () => {
    const t = createTest();
    const ownerId = "owner-component-delete-order";
    const r2Key = `store/${ownerId}/private-diff.json`;
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "component-r2",
      r2Key,
    });
    const fence = await beginDeleteLease(t, ownerId, Date.now());
    stubRawMediaEnv();
    const calls: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        calls.push("physical-delete");
        return new Response(null, { status: 204 });
      });
    const metadataDeleteSpy = vi
      .spyOn(r2, "deleteObject")
      .mockImplementationOnce(async () => {
        calls.push("metadata-delete-failed");
        throw new Error("component metadata unavailable");
      })
      .mockImplementationOnce(async () => {
        calls.push("metadata-delete-succeeded");
      });
    try {
      const first = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(first.ready).toBe(false);
      expect(first.pending).toContain(
        `delete_failed:component-r2:locator:${locatorId}`,
      );
      expect(first.pending.join("\n")).not.toContain(r2Key);
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).not.toBeNull();
      expect(calls).toEqual(["physical-delete", "metadata-delete-failed"]);

      await expect(t.action(purgeExternalMedia, fence)).resolves.toEqual({
        ready: true,
        pending: [],
      });
      expect(calls).toEqual([
        "physical-delete",
        "metadata-delete-failed",
        "physical-delete",
        "metadata-delete-succeeded",
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(metadataDeleteSpy).toHaveBeenCalledTimes(2);
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).toBeNull();
    } finally {
      metadataDeleteSpy.mockRestore();
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("never removes component metadata when the direct physical delete fails", async () => {
    const t = createTest();
    const ownerId = "owner-component-physical-failure";
    const r2Key = `store/${ownerId}/private-diff.json`;
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "component-r2",
      r2Key,
    });
    const fence = await beginDeleteLease(t, ownerId, Date.now());
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const metadataDeleteSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);
    try {
      const result = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(result.ready).toBe(false);
      expect(result.pending).toContain(
        `delete_failed:component-r2:locator:${locatorId}`,
      );
      expect(result.pending.join("\n")).not.toContain(r2Key);
      expect(metadataDeleteSpy).not.toHaveBeenCalled();
      expect(await t.run(async (ctx) => ctx.db.get(locatorId))).not.toBeNull();
    } finally {
      metadataDeleteSpy.mockRestore();
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("re-reads the exact locator tuple before acknowledging an external delete", async () => {
    const t = createTest();
    const ownerId = "owner-exact-locator-ack";
    const originalKey = `user-pets/${ownerId}/upload/original.webp`;
    const replacementKey = `user-pets/${ownerId}/upload/replacement.webp`;
    const locatorId = await insertCommittedLocator(t, {
      ownerId,
      storageKind: "raw-r2",
      bucket: "test-media",
      r2Key: originalKey,
    });
    const fence = await beginDeleteLease(t, ownerId, Date.now());
    stubRawMediaEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await t.run(async (ctx) => {
          await ctx.db.patch(locatorId, {
            r2Key: replacementKey,
            updatedAt: 2,
          });
        });
        return new Response(null, { status: 204 });
      });
    try {
      const result = (await t.action(purgeExternalMedia, fence)) as {
        ready: boolean;
        pending: string[];
      };
      expect(result.ready).toBe(false);
      const retained = await t.run(async (ctx) => ctx.db.get(locatorId));
      expect(retained?.r2Key).toBe(replacementKey);
      expect(result.pending.join("\n")).not.toContain(originalKey);
      expect(result.pending.join("\n")).not.toContain(replacementKey);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("makes reservation replay exact and exposes the full live-write barrier", async () => {
    const t = createTest();
    const ownerId = "owner-reservation-replay";
    const now = 10_000;
    const args = {
      ownerId,
      ownerGeneration: "legacy",
      uploadId: "upload-1",
      uploadExpiresAt: now + 20_000,
      objects: [rawObject("spritesheet", "user-pets/owner/pet/u/sheet.webp")],
      now,
    };
    await t.mutation(reserve, args);
    await t.mutation(reserve, args);
    await expect(
      t.mutation(reserve, {
        ...args,
        objects: [rawObject("spritesheet", "user-pets/owner/pet/u/other.webp")],
      }),
    ).rejects.toThrow(/replay did not match/i);

    const live = (await t.query(getPurgeBatch, {
      ownerId,
      now: now + 1,
    })) as {
      targets: unknown[];
      activeReservation?: { uploadId: string; uploadExpiresAt: number };
    };
    expect(live.targets).toHaveLength(0);
    expect(live.activeReservation).toEqual({
      uploadId: "upload-1",
      uploadExpiresAt: now + 20_000,
    });

    const expired = (await t.query(getPurgeBatch, {
      ownerId,
      now: now + 20_000,
    })) as { targets: Array<{ r2Key: string }> };
    expect(expired.targets.map((target) => target.r2Key)).toEqual([
      "user-pets/owner/pet/u/sheet.webp",
    ]);
  });

  it("surfaces the earliest unexpired write across reserved and committed media", async () => {
    const t = createTest();
    const ownerId = "owner-earliest-media-write";
    await t.mutation(reserve, {
      ownerId,
      ownerGeneration: "legacy",
      uploadId: "later-reserved-write",
      uploadExpiresAt: 300,
      objects: [rawObject("reserved", `user-pets/${ownerId}/reserved.webp`)],
      now: 100,
    });
    await insertCommittedLocator(t, {
      ownerId,
      storageKind: "raw-r2",
      bucket: "test-media",
      r2Key: `user-pets/${ownerId}/committed.webp`,
      uploadExpiresAt: 200,
    });

    const batch = (await t.query(getPurgeBatch, {
      ownerId,
      now: 101,
    })) as {
      targets: unknown[];
      activeReservation?: { uploadId: string; uploadExpiresAt: number };
    };
    expect(batch.targets).toEqual([]);
    expect(batch.activeReservation).toEqual({
      uploadId: `upload-${ownerId}`,
      uploadExpiresAt: 200,
    });
  });

  it("rejects finalize after account deletion wins the lifecycle race", async () => {
    const t = createTest();
    const ownerId = "owner-finalize-race";
    const now = 20_000;
    const object = rawObject("spritesheet", "user-pets/owner/pet/u/sheet.webp");
    await t.mutation(reserve, {
      ownerId,
      ownerGeneration: "legacy",
      uploadId: "upload-race",
      uploadExpiresAt: now + 20_000,
      objects: [object],
      now,
    });
    await beginDeleteLease(t, ownerId, now + 1);
    await expect(
      t.mutation(finalize, {
        ownerId,
        ownerGeneration: "legacy",
        uploadId: "upload-race",
        sourceKind: "user_pet",
        sourceId: "fake-source",
        objects: [object],
        now: now + 2,
      }),
    ).rejects.toThrow(/being deleted/i);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_uploadId", (q) =>
          q.eq("ownerId", ownerId).eq("uploadId", "upload-race"),
        )
        .take(8),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("reserved");
  });

  it("keeps the product row until every external object is acknowledged, then drops locators last", async () => {
    const t = createTest();
    const ownerId = "owner-object-before-row";
    const now = 30_000;
    const objects = [
      rawObject("spritesheet", "user-pets/owner/pet/u/sheet.webp"),
      rawObject("preview", "user-pets/owner/pet/u/preview.webp"),
    ];
    await t.mutation(reserve, {
      ownerId,
      ownerGeneration: "legacy",
      uploadId: "upload-committed",
      uploadExpiresAt: now + 20_000,
      objects,
      now,
    });
    const petId = await t.run(async (ctx) =>
      ctx.db.insert("user_pets", {
        ownerId,
        petId: "durable-pet",
        displayName: "Durable pet",
        description: "test",
        tags: [],
        spritesheetUrl: objects[0]!.publicUrl,
        previewUrl: objects[1]!.publicUrl,
        visibility: "private",
        searchText: "durable pet",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.mutation(finalize, {
      ownerId,
      ownerGeneration: "legacy",
      uploadId: "upload-committed",
      sourceKind: "user_pet",
      sourceId: petId,
      objects,
      now: now + 1,
    });
    const fence = await beginDeleteLease(t, ownerId, now + 2);
    const liveBatch = (await t.query(getPurgeBatch, {
      ownerId,
      now: now + 3,
    })) as {
      targets: unknown[];
      activeReservation?: { uploadId: string; uploadExpiresAt: number };
    };
    expect(liveBatch.targets).toEqual([]);
    expect(liveBatch.activeReservation).toEqual({
      uploadId: "upload-committed",
      uploadExpiresAt: now + 20_000,
    });

    const batch = (await t.query(getPurgeBatch, {
      ownerId,
      now: now + 20_000,
    })) as {
      targets: Array<{
        id: Id<"account_external_media_objects">;
        storageKind: "raw-r2";
        bucket: string;
        r2Key: string;
      }>;
    };
    expect(batch.targets).toHaveLength(2);

    await t.mutation(acknowledge, {
      ...fence,
      refs: [batch.targets[0]],
    });
    const afterFirst = await t.run(async (ctx) => ({
      pet: await ctx.db.get(petId),
      locators: await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_uploadId", (q) =>
          q.eq("ownerId", ownerId).eq("uploadId", "upload-committed"),
        )
        .take(8),
    }));
    expect(afterFirst.pet).not.toBeNull();
    expect(afterFirst.locators).toHaveLength(2);
    expect(afterFirst.locators.map((row) => row.state).sort()).toEqual([
      "committed",
      "external_deleted",
    ]);

    await t.mutation(acknowledge, {
      ...fence,
      refs: [batch.targets[1]],
    });
    const afterSecond = await t.run(async (ctx) => ({
      pet: await ctx.db.get(petId),
      locators: await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_uploadId", (q) =>
          q.eq("ownerId", ownerId).eq("uploadId", "upload-committed"),
        )
        .take(8),
    }));
    expect(afterSecond.pet).toBeNull();
    expect(afterSecond.locators).toHaveLength(0);
    expect(await t.query(remaining, { ownerId })).toEqual([]);
  });

  it("keeps committed pet, Store, and orphan locators source-owned until signed PUT authority expires", async () => {
    const t = createTest();
    const fromOwnerId = "barrier-source-owner";
    const toOwnerId = "barrier-destination-owner";
    await t.mutation(prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const claim = (await t.mutation(claimOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
      leaseId: "external-media-barrier-lease",
      now: 1_000,
    })) as { claimed: boolean; leaseGeneration?: number };
    expect(claim.claimed).toBe(true);
    const uploadExpiresAt = 2_000;
    const seeded = await t.run(async (ctx) => {
      const petId = await ctx.db.insert("user_pets", {
        ownerId: fromOwnerId,
        petId: "barrier-pet",
        displayName: "Barrier pet",
        description: "must move with its locator",
        tags: [],
        spritesheetUrl: "https://media.test/barrier-pet.webp",
        visibility: "private",
        searchText: "barrier pet",
        createdAt: 1,
        updatedAt: 1,
      });
      const petLocatorId = await ctx.db.insert(
        "account_external_media_objects",
        {
          ownerId: fromOwnerId,
          ownerGeneration: "legacy",
          uploadId: "barrier-pet-upload",
          objectRole: "spritesheet",
          storageKind: "raw-r2",
          bucket: "pets",
          r2Key: "user-pets/source/barrier-pet.webp",
          payloadSha256: "barrier-pet-sha",
          state: "committed",
          uploadExpiresAt,
          sourceKind: "user_pet",
          sourceId: String(petId),
          sourceKey: `user_pet:${String(petId)}`,
          createdAt: 1,
          updatedAt: 1,
        },
      );
      const packageId = await ctx.db.insert("store_packages", {
        ownerId: fromOwnerId,
        packageId: "barrier-package",
        displayName: "Barrier package",
        searchText: "barrier package",
        latestReleaseNumber: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const releaseId = await ctx.db.insert("store_package_releases", {
        ownerId: fromOwnerId,
        packageRef: packageId,
        packageId: "barrier-package",
        releaseNumber: 1,
        manifest: {},
        blueprintMarkdown: "# Barrier package",
        diffRef: {
          kind: "r2",
          r2Key: "store/source/barrier.diff",
          sha256: "barrier-store-sha",
          sizeBytes: 10,
        },
        createdAt: 1,
      });
      await ctx.db.patch(packageId, { latestReleaseId: releaseId });
      const storeLocatorId = await ctx.db.insert(
        "account_external_media_objects",
        {
          ownerId: fromOwnerId,
          ownerGeneration: "legacy",
          uploadId: "barrier-store-upload",
          objectRole: "diff",
          storageKind: "component-r2",
          r2Key: "store/source/barrier.diff",
          payloadSha256: "barrier-store-sha",
          state: "committed",
          uploadExpiresAt,
          sourceKind: "store_release",
          sourceId: String(releaseId),
          sourceKey: `store_release:${String(releaseId)}`,
          createdAt: 1,
          updatedAt: 1,
        },
      );
      const orphanLocatorId = await ctx.db.insert(
        "account_external_media_objects",
        {
          ownerId: fromOwnerId,
          ownerGeneration: "legacy",
          uploadId: "barrier-orphan-upload",
          objectRole: "detached-artifact",
          storageKind: "component-r2",
          r2Key: "detached/source/barrier.bin",
          payloadSha256: "barrier-orphan-sha",
          state: "committed",
          uploadExpiresAt,
          createdAt: 1,
          updatedAt: 1,
        },
      );
      return {
        petId,
        petLocatorId,
        releaseId,
        storeLocatorId,
        orphanLocatorId,
      };
    });
    const lease = {
      fromOwnerId,
      toOwnerId,
      leaseId: "external-media-barrier-lease",
      leaseGeneration: claim.leaseGeneration!,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const active = (await t.query(getMigrationBatch, {
        ownerId: fromOwnerId,
        now: 1_001,
      })) as {
        targets: unknown[];
        activeReservation?: { uploadId: string; uploadExpiresAt: number };
      };
      expect(active.targets).toEqual([]);
      expect(active.activeReservation?.uploadExpiresAt).toBe(uploadExpiresAt);

      await expect(
        t.mutation(migrateExternalMedia, { ...lease, leaseNow: 1_001 }),
      ).resolves.toEqual({ hasMore: true });
      await expect(
        t.mutation(migrateStoreContent, { ...lease, leaseNow: 1_001 }),
      ).resolves.toEqual({ hasMore: true });
      const beforeExpiry = await t.run(async (ctx) => ({
        pet: await ctx.db.get(seeded.petId),
        petLocator: await ctx.db.get(seeded.petLocatorId),
        release: await ctx.db.get(seeded.releaseId),
        storeLocator: await ctx.db.get(seeded.storeLocatorId),
        orphanLocator: await ctx.db.get(seeded.orphanLocatorId),
      }));
      expect(beforeExpiry.pet?.ownerId).toBe(fromOwnerId);
      expect(beforeExpiry.petLocator?.ownerId).toBe(fromOwnerId);
      expect(beforeExpiry.release?.ownerId).toBe(fromOwnerId);
      expect(beforeExpiry.storeLocator?.ownerId).toBe(fromOwnerId);
      expect(beforeExpiry.orphanLocator?.ownerId).toBe(fromOwnerId);
      expect(fetchSpy).not.toHaveBeenCalled();

      // The exact expiry is the first instant at which the old signed PUT can
      // no longer recreate bytes under a locator already owned by the target.
      await expect(
        t.mutation(migrateExternalMedia, {
          ...lease,
          leaseNow: uploadExpiresAt,
        }),
      ).resolves.toEqual({ hasMore: true });
      await expect(
        t.mutation(migrateStoreContent, {
          ...lease,
          leaseNow: uploadExpiresAt,
        }),
      ).resolves.toEqual({ hasMore: true });
      await expect(
        t.mutation(migrateExternalMedia, {
          ...lease,
          leaseNow: uploadExpiresAt,
        }),
      ).resolves.toEqual({ hasMore: true });
      const atExpiry = await t.run(async (ctx) => ({
        pet: await ctx.db.get(seeded.petId),
        petLocator: await ctx.db.get(seeded.petLocatorId),
        release: await ctx.db.get(seeded.releaseId),
        storeLocator: await ctx.db.get(seeded.storeLocatorId),
        orphanLocator: await ctx.db.get(seeded.orphanLocatorId),
      }));
      expect(atExpiry.pet?.ownerId).toBe(toOwnerId);
      expect(atExpiry.petLocator?.ownerId).toBe(toOwnerId);
      expect(atExpiry.release?.ownerId).toBe(toOwnerId);
      expect(atExpiry.storeLocator?.ownerId).toBe(toOwnerId);
      expect(atExpiry.orphanLocator?.ownerId).toBe(toOwnerId);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("removes only expired migration reservation debt under the exact ABA-fenced lease", async () => {
    const t = createTest();
    const fromOwnerId = "anonymous-owner";
    const toOwnerId = "permanent-owner";
    await t.mutation(reserve, {
      ownerId: fromOwnerId,
      ownerGeneration: "legacy",
      uploadId: "migration-upload",
      uploadExpiresAt: 200,
      objects: [
        rawObject("spritesheet", "user-pets/anonymous/pet/u/sheet.webp"),
      ],
      now: 100,
    });
    const migrationId = await t.run(async (ctx) =>
      ctx.db.insert("auth_owner_migrations", {
        fromOwnerId,
        toOwnerId,
        status: "running",
        leaseId: "migration-lease",
        leaseGeneration: 7,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 3,
        leaseExpiresAt: 10_000,
        createdAt: 100,
        updatedAt: 100,
      }),
    );
    const batch = (await t.query(getMigrationBatch, {
      ownerId: fromOwnerId,
      now: 201,
    })) as {
      targets: Array<{
        id: Id<"account_external_media_objects">;
        storageKind: "raw-r2";
        bucket: string;
        r2Key: string;
      }>;
    };
    expect(batch.targets).toHaveLength(1);
    const lease = {
      fromOwnerId,
      toOwnerId,
      migrationId,
      leaseId: "migration-lease",
      leaseGeneration: 7,
      fromOwnerGeneration: "legacy",
      toOwnerGeneration: "legacy",
      planRevision: 3,
      now: 201,
    };
    await expect(
      t.mutation(acknowledgeMigrationCleanup, {
        ...lease,
        planRevision: 4,
        refs: batch.targets,
      }),
    ).rejects.toThrow(/no longer owns the migration lease/i);
    expect(await t.query(remaining, { ownerId: fromOwnerId })).toEqual([
      "external_media_reserved:migration-upload:spritesheet",
    ]);

    expect(
      await t.mutation(acknowledgeMigrationCleanup, {
        ...lease,
        refs: batch.targets,
      }),
    ).toBe(1);
    expect(await t.query(remaining, { ownerId: fromOwnerId })).toEqual([]);
  });
});
