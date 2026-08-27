import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const convexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const guardedExports: Record<string, readonly string[]> = {
  "data/store_packages.ts": [
    "createFirstReleaseRecord",
    "createUpdateReleaseRecord",
    "backfillPackageVisibility",
    "setPackageVisibility",
    "deletePackage",
    "deletePackageReleasesBatch",
    "recordPackageInstall",
    "createFirstRelease",
    "createUpdateRelease",
  ],
  "data/store_admin.ts": ["approveSubmission", "rejectSubmission"],
  "data/store_git_artifacts.ts": [
    "prepareGitObjectUploads",
    "prepareDiffUpload",
    "deleteDiffRef",
  ],
  "social/profiles.ts": [
    "ensureProfileInternal",
    "ensureProfileForOwnerInternal",
    "recomputeBadgeForOwnerInternal",
    "setPartnerBadgeForOwnerInternal",
    "ensureProfile",
    "claimUsername",
    "updateMyAvatar",
  ],
  "social/relationships.ts": [
    "markIncomingFriendRequestsSeen",
    "sendFriendRequest",
    "respondToFriendRequest",
    "removeFriend",
  ],
  "social/rooms.ts": [
    "getOrJoinGlobalRoom",
    "getOrCreateDmRoom",
    "createGroupRoom",
    "addGroupMembers",
    "markRoomRead",
  ],
  "social/communities.ts": [
    "createCommunity",
    "joinCommunity",
    "renameCommunity",
    "removeCommunityMember",
    "leaveCommunity",
    "deleteCommunity",
    "purgeCommunityRoomBatchInternal",
  ],
  "social/messages.ts": [
    "applyMessageModerationInternal",
    "assertMessageModerationDispatchInternal",
    "moderateRoomMessageInternal",
    "sendRoomMessage",
  ],
  "social/sessions.ts": [
    "assertSessionFileUploadDispatchInternal",
    "recordFileUploadInternal",
    "createSession",
    "updateSessionStatus",
    "queueTurn",
    "claimTurn",
    "completeTurn",
    "failTurn",
    "releaseTurn",
    "markFileOpsApplied",
    "createDirectory",
    "markSnapshotCreated",
    "acknowledgeFileOps",
    "deleteFile",
    "uploadFile",
  ],
  "data/pets.ts": ["incrementDownloads", "upsertMany", "deleteByPetId"],
  "data/user_pets.ts": [
    "patchGeneratedMetadata",
    "createPet",
    "createGeneratedPet",
    "setVisibility",
    "deletePet",
    "recordInstall",
  ],
  "data/user_pet_uploads.ts": ["createUploadUrl"],
  "data/user_pet_generation.ts": ["reservePetGenerationJob", "generatePet"],
  "data/store_asset_metadata.ts": ["enrichUserPet"],
  "admin_deletes.ts": [
    "deleteStorePackage",
    "deleteUserPet",
    "deleteSocialMessage",
    "deleteStellaSessionBatch",
    "deleteSocialRoomBatch",
  ],
};

const exportSegment = (source: string, name: string): string => {
  const startToken = `export const ${name}`;
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1, `missing inventory entry ${name}`);
  const next = source.indexOf("\nexport const ", start + startToken.length);
  return source.slice(start, next === -1 ? source.length : next);
};

describe("c8 retired writer cutover inventory", () => {
  test("every inventoried public/internal writer and reservation entry is guarded", () => {
    for (const [relativePath, exports] of Object.entries(guardedExports)) {
      const source = readFileSync(resolve(convexRoot, relativePath), "utf8");
      for (const name of exports) {
        assert.match(
          exportSegment(source, name),
          /assertC8RetiredSurfaceUnavailable\(/u,
          `${relativePath}:${name} is not fail-closed`,
        );
      }
    }
  });

  test("all retired presigned/server upload sites sit inside guarded entries", () => {
    const cases = [
      [
        "data/store_git_artifacts.ts",
        "prepareGitObjectUploads",
        "generateUploadUrl(",
      ],
      [
        "data/store_git_artifacts.ts",
        "prepareDiffUpload",
        "generateUploadUrl(",
      ],
      ["data/user_pet_uploads.ts", "createUploadUrl", "signR2Put("],
      ["data/user_pet_generation.ts", "generatePet", "uploadR2Object("],
    ] as const;
    for (const [relativePath, name, sideEffect] of cases) {
      const source = readFileSync(resolve(convexRoot, relativePath), "utf8");
      const segment = exportSegment(source, name);
      assert.ok(
        segment.includes(sideEffect),
        `${relativePath}:${name} lost ${sideEffect}`,
      );
      assert.ok(
        segment.indexOf("assertC8RetiredSurfaceUnavailable(") <
          segment.indexOf(sideEffect),
        `${relativePath}:${name} guards after ${sideEffect}`,
      );
    }
  });

  test("retained emoji creation no longer writes the retired social author field", () => {
    const source = readFileSync(
      resolve(convexRoot, "data/emoji_packs.ts"),
      "utf8",
    );
    const segment = exportSegment(source, "createGeneratedPack");
    assert.ok(!segment.includes("internal.social.profiles"));
    assert.ok(!segment.includes("authorUsername"));
  });

  test("Store cleanup is metadata-only and cannot delete or sweep shared R2", () => {
    const cleanup = readFileSync(
      resolve(convexRoot, "dev_c8_cleanup.ts"),
      "utf8",
    );
    assert.ok(cleanup.includes("retain-shared-stella-files-object"));
    assert.ok(cleanup.includes("retain-shared-stella-files-objects"));
    assert.ok(!cleanup.includes("r2.deleteObject"));
    assert.ok(!cleanup.includes("deleteR2Object"));
    assert.ok(!cleanup.includes("listObjects"));

    const rawCleanup = readFileSync(
      resolve(convexRoot, "dev_c8_cleanup_raw_r2.ts"),
      "utf8",
    );
    assert.ok(rawCleanup.includes('bucketEnv: "R2_PETS_BUCKET"'));
    assert.ok(!rawCleanup.includes("component-r2"));
    assert.ok(!rawCleanup.includes("store/git-"));
  });
});
