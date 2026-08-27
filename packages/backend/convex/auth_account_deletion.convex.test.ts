/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { components, internal } from "./_generated/api";
import { makeFunctionReference } from "convex/server";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};

type TestHarness = ReturnType<typeof createTest>;
const authCreateTriggerRef = makeFunctionReference<
  "mutation",
  { model: string; doc: Record<string, unknown> },
  null
>("auth:onBetterAuthComponentCreate");

beforeAll(() => {
  process.env.SITE_URL = "https://stella.test";
  process.env.CONVEX_SITE_URL = "https://stella.test";
  process.env.BETTER_AUTH_SECRET =
    "test-only-better-auth-secret-at-least-32-bytes";
  process.env.RESEND_FROM = "Stella Test <test@stella.test>";
});

const beginDelete = async (
  t: TestHarness,
  args: {
    ownerId: string;
    authUserId: string;
    authUserEmail?: string;
    operationId?: string;
    now?: number;
  },
) =>
  await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
    ownerId: args.ownerId,
    authUserId: args.authUserId,
    authUserEmail: args.authUserEmail,
    operationId: args.operationId ?? "delete-operation",
    mode: "delete",
    // convex-test assigns fractional creation times within one millisecond.
    // Production beforeDelete runs long after these seeded auth rows; one
    // millisecond models that ordering without widening the production fence.
    now: args.now ?? Date.now() + 1,
  });

const markDeleteJobComplete = async (t: TestHarness, ownerId: string) => {
  await t.run(async (ctx) => {
    const [job, finalizer] = await Promise.all([
      ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    ]);
    if (!job || !finalizer) throw new Error("missing delete job/finalizer");
    await ctx.db.patch(job._id, {
      stage: "complete",
      leaseId: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch(finalizer._id, {
      phase: "ready",
      nextAttemptAt: 0,
    });
  });
};

const readFinalizer = async (t: TestHarness, ownerId: string) =>
  await t.run(
    async (ctx) =>
      await ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
  );

const runFinalizerUntilComplete = async (
  t: TestHarness,
  identity: { ownerId: string; operationId: string; generation: string },
  maxPasses = 10,
) => {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", identity.ownerId))
        .unique();
      if (row) await ctx.db.patch(row._id, { nextAttemptAt: 0 });
    });
    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      identity,
    );
    if (!(await readFinalizer(t, identity.ownerId))) return;
  }
  throw new Error("auth deletion finalizer did not complete in test budget");
};

const findAuthRow = async (
  t: TestHarness,
  model:
    | "user"
    | "session"
    | "account"
    | "verification"
    | "twoFactor"
    | "oauthApplication"
    | "oauthAccessToken"
    | "oauthConsent",
  field: string,
  value: string,
) =>
  await t.query(components.betterAuth.adapter.findOne, {
    model,
    where: [{ field, value }],
  });

const seedBetterAuthOwner = async (t: TestHarness, key = "delete") => {
  const now = 10_000;
  const email = `${key}-me@stella.test`;
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Delete Me",
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  const userId = user._id;
  if (!userId) throw new Error("Better Auth test adapter did not return an id");

  await Promise.all([
    t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          userId,
          token: `${key}-session-token`,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "account",
        data: {
          userId,
          accountId: `${key}-account`,
          providerId: "credential",
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "verification",
        data: {
          identifier: "reset-password:token",
          value: userId,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "verification",
        data: {
          identifier: email,
          value: "email-verification-value",
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "twoFactor",
        data: {
          userId,
          secret: "secret",
          backupCodes: "codes",
        },
      },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: { model: "oauthApplication", data: { userId } },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: { model: "oauthAccessToken", data: { userId } },
    }),
    t.mutation(components.betterAuth.adapter.create, {
      input: { model: "oauthConsent", data: { userId } },
    }),
  ]);
  return { userId, email };
};

describe("durable Better Auth account deletion finalization", () => {
  it("publishes one exact auth-user locator in the lifecycle-fence transaction", async () => {
    const t = createTest();
    const ownerId = "https://stella.test|auth-user-atomic";
    const lifecycle = await beginDelete(t, {
      ownerId,
      authUserId: "auth-user-atomic",
      operationId: "atomic-operation",
      now: 5_000,
    });

    const snapshot = await t.run(async (ctx) => {
      const [owner, job, finalizer] = await Promise.all([
        ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("cloud_owner_purge_jobs")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("auth_account_deletion_finalizers")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ]);
      return { owner, job, finalizer };
    });
    expect(snapshot.owner).toMatchObject({
      state: "deleting",
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    });
    expect(snapshot.job).toMatchObject({
      mode: "delete",
      stage: "core",
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    });
    expect(snapshot.finalizer).toMatchObject({
      ownerId,
      authUserId: "auth-user-atomic",
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
      phase: "waiting_for_purge",
      attempts: 0,
      nextAttemptAt: 5_000,
    });

    const joined = await beginDelete(t, {
      ownerId,
      authUserId: "auth-user-atomic",
      operationId: "ignored-duplicate-operation",
      now: 6_000,
    });
    expect(joined).toEqual(lifecycle);
    await expect(
      beginDelete(t, {
        ownerId,
        authUserId: "different-auth-user",
        operationId: "conflict",
        now: 7_000,
      }),
    ).rejects.toThrow(/locator changed/u);
    expect(await readFinalizer(t, ownerId)).toMatchObject({
      authUserId: "auth-user-atomic",
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    });
  });

  it("waits for exact purge completion and uses reclaimable, fenced leases", async () => {
    const t = createTest();
    const ownerId = "https://stella.test|auth-user-lease";
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: "auth-user-lease",
      now: 1_000,
    });
    const identity = {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    };

    expect(
      await t.mutation(
        internal.auth_account_deletion
          .claimAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-a", now: 2_000 },
      ),
    ).toEqual({ claimed: false });

    await markDeleteJobComplete(t, ownerId);
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .claimAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-a", now: 2_000 },
      ),
    ).toMatchObject({ claimed: true, authUserId: "auth-user-lease" });
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .claimAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-b", now: 2_001 },
      ),
    ).toEqual({ claimed: false });

    expect(
      await t.mutation(
        internal.auth_account_deletion
          .retryAuthAccountDeletionFinalizerInternal,
        {
          ...identity,
          leaseId: "lease-a",
          error: "transient component failure",
          now: 2_002,
        },
      ),
    ).toBe(true);
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .claimAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-b", now: 3_000 },
      ),
    ).toEqual({ claimed: false });
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .claimAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-b", now: 5_000 },
      ),
    ).toMatchObject({ claimed: true });
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .completeAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-a" },
      ),
    ).toBe(false);
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .retryAuthAccountDeletionFinalizerInternal,
        {
          ...identity,
          leaseId: "lease-a",
          error: "stale worker",
          now: 5_001,
        },
      ),
    ).toBe(false);
    expect(await readFinalizer(t, ownerId)).toMatchObject({
      leaseId: "lease-b",
      attempts: 1,
      lastError: "transient component failure",
    });
    expect(
      await t.mutation(
        internal.auth_account_deletion
          .completeAuthAccountDeletionFinalizerInternal,
        { ...identity, leaseId: "lease-b" },
      ),
    ).toBe(true);
    expect(await readFinalizer(t, ownerId)).toBeNull();
  });

  it("removes all owner-linked Better Auth rows only after the delete job completes", async () => {
    const t = createTest();
    const { userId, email } = await seedBetterAuthOwner(t);
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: userId,
      authUserEmail: email,
    });
    const identity = {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    };

    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      identity,
    );
    expect(await findAuthRow(t, "user", "_id", userId)).not.toBeNull();
    expect(await readFinalizer(t, ownerId)).not.toBeNull();

    await markDeleteJobComplete(t, ownerId);
    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      identity,
    );
    expect(await readFinalizer(t, ownerId)).toBeNull();

    for (const [model, field, value] of [
      ["user", "_id", userId],
      ["session", "userId", userId],
      ["account", "userId", userId],
      ["verification", "value", userId],
      ["verification", "identifier", email],
      ["twoFactor", "userId", userId],
      ["oauthApplication", "userId", userId],
      ["oauthAccessToken", "userId", userId],
      ["oauthConsent", "userId", userId],
    ] as const) {
      expect(await findAuthRow(t, model, field, value)).toBeNull();
    }
  });

  it("keeps the durable locator when Better Auth's after-delete hook wakes cleanup", async () => {
    const t = createTest();
    const { userId, email } = await seedBetterAuthOwner(t);
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: userId,
      authUserEmail: email,
    });
    const identity = {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    };
    await markDeleteJobComplete(t, ownerId);

    // Model Better Auth's ordinary route winning the race and deleting the
    // user before the durable finalizer runs. Email-keyed verification rows do
    // not carry userId, so the persisted email locator is the only safe retry.
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "user", where: [{ field: "_id", value: userId }] },
    });
    expect(await findAuthRow(t, "user", "_id", userId)).toBeNull();

    expect(
      await t.mutation(
        internal.auth_account_deletion.acknowledgeAuthAccountDeletedInternal,
        { ownerId, authUserId: userId },
      ),
    ).toBe(true);
    expect(await readFinalizer(t, ownerId)).toMatchObject(identity);
    expect(
      await findAuthRow(t, "verification", "identifier", email),
    ).not.toBeNull();

    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      identity,
    );

    expect(await readFinalizer(t, ownerId)).toBeNull();
    expect(
      await findAuthRow(t, "verification", "identifier", email),
    ).toBeNull();
  });

  it("retains the locator and user between bounded auxiliary-table pages", async () => {
    const t = createTest();
    const { userId } = await seedBetterAuthOwner(t);
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        t.mutation(components.betterAuth.adapter.create, {
          input: {
            model: "oauthAccessToken",
            data: { userId, accessToken: `access-token-${index}` },
          },
        }),
      ),
    );
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, { ownerId, authUserId: userId });
    const identity = {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    };
    await markDeleteJobComplete(t, ownerId);

    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      identity,
    );
    expect(await findAuthRow(t, "user", "_id", userId)).not.toBeNull();
    expect(await readFinalizer(t, ownerId)).toMatchObject({
      attempts: 1,
      lastError: "Better Auth child deletion has additional bounded pages.",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (!row) throw new Error("missing finalizer retry debt");
      await ctx.db.patch(row._id, { nextAttemptAt: 0 });
    });
    await runFinalizerUntilComplete(t, identity);

    expect(await findAuthRow(t, "user", "_id", userId)).toBeNull();
    expect(
      await findAuthRow(t, "oauthAccessToken", "userId", userId),
    ).toBeNull();
    expect(await readFinalizer(t, ownerId)).toBeNull();
  });

  it("uses the verification value index beyond an unrelated component page", async () => {
    const t = createTest();
    for (let index = 0; index < 220; index += 1) {
      await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: "verification",
          data: {
            identifier: `unrelated-${index}@stella.test`,
            value: `unrelated-value-${index}`,
            expiresAt: 100_000,
            createdAt: index,
            updatedAt: index,
          },
        },
      });
    }
    const { userId, email } = await seedBetterAuthOwner(t);
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: userId,
      authUserEmail: email,
    });
    await markDeleteJobComplete(t, ownerId);
    await runFinalizerUntilComplete(t, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    });

    expect(await findAuthRow(t, "user", "_id", userId)).toBeNull();
    expect(await findAuthRow(t, "verification", "value", userId)).toBeNull();
    expect(await readFinalizer(t, ownerId)).toBeNull();
  });

  it("removes legacy magic-link JSON and cross-domain session-token verifications", async () => {
    const t = createTest();
    const { userId, email } = await seedBetterAuthOwner(t);
    await Promise.all([
      t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: "verification",
          data: {
            identifier: "magic-link",
            value: JSON.stringify({ email, name: "Delete Me" }),
            expiresAt: Date.now() + 60_000,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      }),
      t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: "verification",
          data: {
            identifier: "cross-domain",
            value: "delete-session-token",
            expiresAt: Date.now() + 60_000,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      }),
    ]);
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: userId,
      authUserEmail: email,
    });
    await markDeleteJobComplete(t, ownerId);
    await runFinalizerUntilComplete(t, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    });

    expect(
      await findAuthRow(t, "verification", "identifier", "magic-link"),
    ).toBeNull();
    expect(
      await findAuthRow(t, "verification", "identifier", "cross-domain"),
    ).toBeNull();
    expect(await findAuthRow(t, "session", "userId", userId)).toBeNull();
  });

  it("preserves a same-email verification created after the deletion fence", async () => {
    const t = createTest();
    const { userId, email } = await seedBetterAuthOwner(t);
    const ownerId = `https://stella.test|${userId}`;
    const fence = await beginDelete(t, {
      ownerId,
      authUserId: userId,
      authUserEmail: email,
      now: Date.now() + 1,
    });
    await markDeleteJobComplete(t, ownerId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "verification",
        data: {
          identifier: email,
          value: "new-principal-verification",
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    await runFinalizerUntilComplete(t, {
      ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
    });
    expect(await findAuthRow(t, "user", "_id", userId)).toBeNull();
    expect(
      await findAuthRow(
        t,
        "verification",
        "value",
        "new-principal-verification",
      ),
    ).not.toBeNull();
  });

  it("deletes a migrated source principal without touching the destination principal", async () => {
    const t = createTest();
    const source = await seedBetterAuthOwner(t, "linked-source");
    const destination = await seedBetterAuthOwner(t, "linked-destination");
    const fromOwnerId = `https://stella.test|${source.userId}`;
    const toOwnerId = `https://stella.test|${destination.userId}`;
    const operationId = "migrated-source-auth-delete:" + "b".repeat(64);
    const migrationId = await t.run(async (ctx) =>
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId,
        toOwnerId,
        sourceAuthUserId: source.userId,
        sourceAuthUserEmail: source.email,
        sourceAuthDeletionOperationId: operationId,
        sourceAuthDeletionState: "pending",
        status: "complete",
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 1,
        cloudProductStage: "complete",
        completedAt: 1_000,
        createdAt: 500,
        updatedAt: 1_000,
      }),
    );
    const sourceFence = await beginDelete(t, {
      ownerId: fromOwnerId,
      authUserId: source.userId,
      authUserEmail: source.email,
      operationId,
    });
    expect(
      await t.mutation(
        internal.auth_migration.recordMigratedSourceIdentityDeletionInternal,
        {
          migrationId,
          fromOwnerId,
          toOwnerId,
          authUserId: source.userId,
          requestedOperationId: operationId,
          operationId: sourceFence.operationId,
          generation: sourceFence.generation,
          now: Date.now(),
        },
      ),
    ).toBe(true);

    // The migration fence and then the permanent lifecycle fence both make a
    // delayed source-session create unusable before any deletion pass runs.
    await expect(
      t.mutation(authCreateTriggerRef, {
        model: "session",
        doc: {
          _id: "stale-linked-source-session",
          userId: source.userId,
          ownerGeneration: "legacy",
        },
      }),
    ).rejects.toThrow(/OWNERSHIP_MIGRATED|being deleted|generation/u);

    // A simultaneous destination teardown owns a separate lifecycle/job. It
    // must not redirect the source finalizer to the destination auth user.
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: toOwnerId,
      operationId: "destination-delete-operation",
      mode: "delete",
      now: Date.now(),
    });
    await markDeleteJobComplete(t, fromOwnerId);
    await runFinalizerUntilComplete(t, {
      ownerId: fromOwnerId,
      operationId: sourceFence.operationId,
      generation: sourceFence.generation,
    });

    expect(await findAuthRow(t, "user", "_id", source.userId)).toBeNull();
    expect(
      await findAuthRow(t, "session", "userId", source.userId),
    ).toBeNull();
    expect(
      await findAuthRow(t, "account", "userId", source.userId),
    ).toBeNull();
    expect(
      await findAuthRow(t, "user", "_id", destination.userId),
    ).not.toBeNull();
    expect(
      await findAuthRow(t, "session", "userId", destination.userId),
    ).not.toBeNull();
    expect(
      await findAuthRow(t, "account", "userId", destination.userId),
    ).not.toBeNull();
  });

  it("retains retry debt and auth rows when finalization fails closed", async () => {
    const t = createTest();
    const { userId } = await seedBetterAuthOwner(t);
    const ownerId = "https://stella.test|different-user";
    const fence = await beginDelete(t, { ownerId, authUserId: userId });
    await markDeleteJobComplete(t, ownerId);

    await t.action(
      internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
      {
        ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
      },
    );

    expect(await findAuthRow(t, "user", "_id", userId)).not.toBeNull();
    expect(await readFinalizer(t, ownerId)).toMatchObject({
      authUserId: userId,
      attempts: 1,
      lastError: "Better Auth deletion locator owner mismatch.",
    });
    expect((await readFinalizer(t, ownerId))?.leaseId).toBeUndefined();
  });
});
