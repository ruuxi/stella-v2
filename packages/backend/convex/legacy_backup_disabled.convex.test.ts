/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|retired-backup-owner";
const getSyncMode = makeFunctionReference<
  "query",
  Record<string, never>,
  string
>("data/preferences:getSyncMode");
const setSyncMode = makeFunctionReference<
  "mutation",
  { mode: "on" | "off" },
  string
>("data/preferences:setSyncMode");

const retiredBackupPaths = [
  "/api/backups/key",
  "/api/backups/list",
  "/api/backups/prepare-upload",
  "/api/backups/finalize-upload",
  "/api/backups/restore-manifest",
  "/api/backups/object-downloads",
] as const;

const createOwner = () =>
  convexTest(schema, modules).withIdentity({
    issuer: "https://issuer.test",
    subject: "retired-backup-owner",
    tokenIdentifier: ownerId,
  });

describe("retired legacy backup preference", () => {
  it("always reads off and cannot be re-enabled", async () => {
    const owner = createOwner();
    await owner.run(async (ctx) => {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key: "sync_mode",
        value: "on",
        updatedAt: 1,
      });
    });

    await expect(owner.query(getSyncMode, {})).resolves.toBe("off");
    await expect(owner.mutation(setSyncMode, { mode: "on" })).rejects.toThrow(
      /Legacy backups are disabled/u,
    );
    await expect(owner.mutation(setSyncMode, { mode: "off" })).resolves.toBe(
      "off",
    );

    const stored = await owner.run(async (ctx) =>
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", ownerId).eq("key", "sync_mode"),
        )
        .unique(),
    );
    expect(stored?.value).toBe("on");
  });

  it("leaves every legacy HTTP route unregistered without touching stored rows", async () => {
    const owner = createOwner();
    await owner.run(async (ctx) => {
      await ctx.db.insert("backup_key_escrows", {
        ownerId,
        ownerGeneration: "generation-1",
        encryptedKey: "dormant-encrypted-key",
        keyFingerprint: "dormant-key-fingerprint",
        isCurrent: true,
        keyVersion: 1,
        sourceDeviceId: "dormant-device",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("backup_objects", {
        ownerId,
        ownerGeneration: "generation-1",
        keyFingerprint: "dormant-key-fingerprint",
        objectId: "dormant-object",
        r2Key: "backups/dormant-object",
        algorithm: "AES-256-GCM",
        ciphertextSha256: "a".repeat(64),
        plaintextSha256: "b".repeat(64),
        plaintextSize: 1,
        ivBase64Url: "dormant-iv",
        authTagBase64Url: "dormant-tag",
        sourceDeviceId: "dormant-device",
        createdAt: 1,
      });
    });

    const readStoredRows = () =>
      owner.run(async (ctx) => ({
        escrows: await ctx.db.query("backup_key_escrows").collect(),
        objects: await ctx.db.query("backup_objects").collect(),
      }));
    const before = await readStoredRows();

    for (const path of retiredBackupPaths) {
      for (const method of ["GET", "POST", "OPTIONS"] as const) {
        const response = await owner.fetch(path, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: "https://stella.test",
            "X-Device-ID": "dormant-device",
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }

    expect(await readStoredRows()).toEqual(before);
  });
});
