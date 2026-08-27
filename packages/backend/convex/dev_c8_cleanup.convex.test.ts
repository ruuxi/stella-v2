/// <reference types="vite/client" />

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const deployment = "dev:impartial-crab-34" as const;
const confirmation = "DELETE C8 DATA FROM impartial-crab-34" as const;
const armConfirmation = "ARM C8 RETIRED WRITERS ON impartial-crab-34" as const;
const barrierMs = 20 * 60_000;

const arm = makeFunctionReference<"mutation">(
  "dev_c8_cleanup:armWriterCutoverInternal",
);
const getCutover = makeFunctionReference<"query">(
  "dev_c8_cleanup:getDurableCutoverStateInternal",
);
const runBatch = makeFunctionReference<"mutation">(
  "dev_c8_cleanup:runDatabaseBatchInternal",
);
const getStoreLocatorPage = makeFunctionReference<"query">(
  "dev_c8_cleanup:getStoreLocatorManifestPageInternal",
);
const deleteStoreLocator = makeFunctionReference<"mutation">(
  "dev_c8_cleanup:deleteManifestedStoreLocatorInternal",
);

const stubExactEnvironment = () => {
  vi.stubEnv("CONVEX_CLOUD_URL", "https://impartial-crab-34.convex.cloud");
  vi.stubEnv("CONVEX_SITE_URL", "https://impartial-crab-34.convex.site");
  vi.stubEnv("STELLA_C8_RETIRED_WRITES_DISABLED", "1");
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
  stubExactEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("c8 Phase-1 cleanup", () => {
  it("persists a restart-safe cutover and enforces the exact quiet boundary", async () => {
    const t = createTest();
    const first = await t.mutation(arm, {
      deployment,
      confirmation: armConfirmation,
    });
    expect(first.closed).toBe(false);

    vi.advanceTimersByTime(barrierMs / 2);
    const rearmed = await t.mutation(arm, {
      deployment,
      confirmation: armConfirmation,
    });
    expect(rearmed.armedAt).toBe(first.armedAt);
    expect(rearmed.barrierClosesAt).toBe(first.barrierClosesAt);

    vi.setSystemTime(first.barrierClosesAt - 1);
    await expect(
      t.mutation(runBatch, {
        deployment,
        phase: "stella_session_file_ops",
        limit: 1,
        dryRun: false,
        confirmation,
      }),
    ).rejects.toThrow(/quiet barrier/u);

    vi.setSystemTime(first.barrierClosesAt);
    await expect(
      t.mutation(runBatch, {
        deployment,
        phase: "stella_session_file_ops",
        limit: 1,
        dryRun: false,
        confirmation,
      }),
    ).resolves.toMatchObject({ deletedRows: 0 });
    await expect(t.query(getCutover, { deployment })).resolves.toMatchObject({
      armedAt: first.armedAt,
      closed: true,
    });
  });

  it("deletes Convex storage before its retired locator row", async () => {
    const t = createTest();
    const cutover = await t.mutation(arm, {
      deployment,
      confirmation: armConfirmation,
    });
    vi.setSystemTime(cutover.barrierClosesAt);
    const seeded = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const sessionId = await ctx.db.insert("stella_sessions", {
        roomId,
        hostDeviceId: "host",
        workspaceSlug: "workspace",
        workspaceFolderName: "Workspace",
        conversationId: "conversation",
        status: "active",
        latestTurnOrdinal: 0,
        latestFileOpOrdinal: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const storageId = await ctx.storage.store(new Blob(["retired"]));
      const rowId = await ctx.db.insert("stella_session_file_ops", {
        sessionId,
        ordinal: 1,
        type: "upsert",
        relativePath: "file.txt",
        actorOwnerId: "owner",
        storageId,
        createdAt: Date.now(),
      });
      return { rowId, storageId };
    });

    await expect(
      t.mutation(runBatch, {
        deployment,
        phase: "stella_session_file_ops",
        limit: 1,
        dryRun: false,
        confirmation,
      }),
    ).resolves.toMatchObject({ deletedRows: 1, deletedStorageObjects: 1 });
    await expect(
      t.run(async (ctx) => ({
        row: await ctx.db.get(seeded.rowId),
        url: await ctx.storage.getUrl(seeded.storageId),
      })),
    ).resolves.toEqual({ row: null, url: null });
  });

  it("hash-binds canonical Store locator debt and never performs a physical delete", async () => {
    const t = createTest();
    const cutover = await t.mutation(arm, {
      deployment,
      confirmation: armConfirmation,
    });
    vi.setSystemTime(cutover.barrierClosesAt);
    const locatorId = await t.run(
      async (ctx) =>
        await ctx.db.insert("account_external_media_objects", {
          ownerId: "owner",
          ownerGeneration: "generation",
          uploadId: "11111111-1111-4111-8111-111111111111",
          objectRole: "store-diff",
          storageKind: "component-r2",
          r2Key:
            "store/git-diffs/owner/package/11111111-1111-4111-8111-111111111111-aaaaaaaaaaaaaaaa.diff",
          payloadSha256: `sha256:${"a".repeat(64)}`,
          state: "reserved",
          uploadExpiresAt: cutover.armedAt,
          createdAt: cutover.armedAt,
          updatedAt: cutover.armedAt,
        }),
    );
    const page = await t.query(getStoreLocatorPage, {
      deployment,
      cursor: null,
      numItems: 8,
    });
    expect(page.manifests).toHaveLength(1);
    const entry = page.manifests[0]!;
    expect(entry.manifest.locatorId).toBe(locatorId);
    expect(entry.manifest.policy).toBe("retain-shared-stella-files-object");

    await expect(
      t.mutation(deleteStoreLocator, {
        deployment,
        confirmation,
        locatorId,
        manifestSha256: "0".repeat(64),
        manifestPersisted: true,
      }),
    ).rejects.toThrow(/changed after/u);
    await expect(
      t.mutation(deleteStoreLocator, {
        deployment,
        confirmation,
        locatorId,
        manifestSha256: entry.manifestSha256,
        manifestPersisted: true,
      }),
    ).resolves.toMatchObject({ retainedSharedR2Objects: 1 });
    await expect(
      t.run(async (ctx) => await ctx.db.get(locatorId)),
    ).resolves.toBeNull();
  });
});
