/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|canvas-owner";

const createTest = () => convexTest(schema, modules);
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "canvas-owner",
    tokenIdentifier: ownerId,
  });

describe("canvas share listing", () => {
  it("uses the caller snapshot and returns a bounded newest-first page", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      const insert = async (
        slug: string,
        values: {
          createdAt: number;
          expiresAt: number;
          revoked?: boolean;
          publicationState?: "uploading" | "published";
          rowOwnerId?: string;
        },
      ) =>
        ctx.db.insert("canvas_shares", {
          slug,
          ownerUserId: values.rowOwnerId ?? ownerId,
          r2Key: `shares/${slug}.html`,
          createdAt: values.createdAt,
          expiresAt: values.expiresAt,
          revoked: values.revoked ?? false,
          ...(values.publicationState
            ? { publicationState: values.publicationState }
            : {}),
        });

      await insert("legacy-old", { createdAt: 100, expiresAt: 2_000 });
      await insert("legacy-middle", { createdAt: 200, expiresAt: 2_500 });
      await insert("published-new", {
        createdAt: 300,
        expiresAt: 3_000,
        publicationState: "published",
      });
      await insert("expired-newer", { createdAt: 400, expiresAt: 1_000 });
      await insert("revoked-newer", {
        createdAt: 500,
        expiresAt: 5_000,
        revoked: true,
      });
      await insert("uploading-newer", {
        createdAt: 600,
        expiresAt: 5_000,
        publicationState: "uploading",
      });
      await insert("foreign-newer", {
        createdAt: 700,
        expiresAt: 5_000,
        rowOwnerId: "https://issuer.test|other-owner",
      });
    });

    const firstPage = await asOwner(t).query(api.data.canvas_shares.listMine, {
      snapshotAt: 1_000,
      limit: 2,
    });
    expect(firstPage.map((share) => share.slug)).toEqual([
      "published-new",
      "legacy-middle",
    ]);

    const laterSnapshot = await asOwner(t).query(
      api.data.canvas_shares.listMine,
      { snapshotAt: 2_600, limit: 10 },
    );
    expect(laterSnapshot.map((share) => share.slug)).toEqual(["published-new"]);
  });

  it("returns an empty page for signed-out callers", async () => {
    const t = createTest();
    expect(
      await t.query(api.data.canvas_shares.listMine, { snapshotAt: 1_000 }),
    ).toEqual([]);
  });
});
