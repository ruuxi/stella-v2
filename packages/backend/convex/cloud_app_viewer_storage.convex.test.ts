/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "app-storage-owner";
const OWNER_GENERATION = "app-storage-generation";

const createTest = async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    for (const [appId, slug] of [
      ["app-storage-a", "storage-a"],
      ["app-storage-b", "storage-b"],
    ] as const) {
      await ctx.db.insert("cloud_apps", {
        appId,
        ownerId: OWNER_ID,
        slug,
        title: slug,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
  return t;
};

const principal = (appId: string, userId: string, viewerNamespace: string) => ({
  appId,
  ownerId: OWNER_ID,
  ownerGeneration: OWNER_GENERATION,
  userId,
  viewerNamespace,
});

describe("cloud app viewer storage isolation", () => {
  it("isolates owner, other-account, anonymous, and cross-app namespaces in the real Convex database", async () => {
    const t = await createTest();
    const viewers = [
      {
        principal: principal("app-storage-a", OWNER_ID, "ns-owner-app-a"),
        value: "owner-a",
      },
      {
        principal: principal(
          "app-storage-a",
          "account-other",
          "ns-other-app-a",
        ),
        value: "other-a",
      },
      {
        principal: principal(
          "app-storage-a",
          "anonymous:visitor-a",
          "ns-anonymous-app-a",
        ),
        value: "anonymous-a",
      },
      {
        principal: principal("app-storage-b", OWNER_ID, "ns-owner-app-b"),
        value: "owner-b",
      },
    ] as const;

    for (const viewer of viewers) {
      await t.mutation(internal.cloud_apps.setStorageInternal, {
        ...viewer.principal,
        key: "shared-key",
        valueJson: JSON.stringify(viewer.value),
        sizeBytes: viewer.value.length + 2,
        now: 2,
      });
    }

    for (const viewer of viewers) {
      const row = await t.query(internal.cloud_apps.getStorageInternal, {
        ...viewer.principal,
        key: "shared-key",
      });
      if (!row) throw new Error(`Missing storage row for ${viewer.value}.`);
      expect(JSON.parse(row.valueJson)).toBe(viewer.value);
    }

    await t.mutation(internal.cloud_apps.deleteStorageInternal, {
      ...viewers[1].principal,
      key: "shared-key",
    });
    expect(
      await t.query(internal.cloud_apps.getStorageInternal, {
        ...viewers[1].principal,
        key: "shared-key",
      }),
    ).toBeNull();
    const remainingOwnerRow = await t.query(
      internal.cloud_apps.getStorageInternal,
      {
        ...viewers[0].principal,
        key: "shared-key",
      },
    );
    if (!remainingOwnerRow) throw new Error("Missing owner storage row.");
    expect(JSON.parse(remainingOwnerRow.valueJson)).toBe("owner-a");
  });

  it("lazily upgrades a legacy account row without duplicating it", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_app_storage", {
        appId: "app-storage-a",
        ownerId: OWNER_ID,
        userId: "account-other",
        key: "legacy-key",
        valueJson: '"legacy"',
        sizeBytes: 8,
        updatedAt: 1,
      });
    });
    const viewer = principal(
      "app-storage-a",
      "account-other",
      "ns-other-app-a",
    );
    const legacyRow = await t.query(internal.cloud_apps.getStorageInternal, {
      ...viewer,
      key: "legacy-key",
    });
    if (!legacyRow) throw new Error("Missing legacy storage row.");
    expect(JSON.parse(legacyRow.valueJson)).toBe("legacy");

    await t.mutation(internal.cloud_apps.setStorageInternal, {
      ...viewer,
      key: "legacy-key",
      valueJson: '"upgraded"',
      sizeBytes: 10,
      now: 2,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId", (q) =>
          q.eq("appId", "app-storage-a").eq("userId", "account-other"),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.viewerNamespace).toBe("ns-other-app-a");
    expect(rows[0]?.valueJson).toBe('"upgraded"');
  });
});
