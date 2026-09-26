/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const getMyShellBootstrap = makeFunctionReference<"query">(
  "cloud_apps:getMyShellBootstrap",
);
const confirmMySessionIdentity = makeFunctionReference<"query">(
  "cloud_apps:confirmMySessionIdentity",
);
const listMyConversations = makeFunctionReference<"query">(
  "cloud_apps:listMyConversations",
);
const getMyCloudConversationIdentity = makeFunctionReference<"query">(
  "cloud_apps:getMyCloudConversationIdentity",
);
const getMyConversation = makeFunctionReference<"query">(
  "cloud_apps:getMyConversation",
);
const getMyOwnershipMigrationStatus = makeFunctionReference<"query">(
  "auth_migration:getMyOwnershipMigrationStatus",
);
const createMyConversation = makeFunctionReference<"mutation">(
  "cloud_apps:createMyConversation",
);

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

type TestHarness = ReturnType<typeof createTest>;

const ownerIdFor = (subject: string) => `https://issuer.test|${subject}`;

const identity = (
  t: TestHarness,
  subject: string,
  options: { anonymous?: boolean } = {},
) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject,
    tokenIdentifier: ownerIdFor(subject),
    iat: 1_000,
    ...(options.anonymous ? { isAnonymous: true } : {}),
  });

const seedGeneration = async (
  t: TestHarness,
  ownerId: string,
  generation: string,
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const createConversation = async (
  t: TestHarness,
  subject: string,
  generation: string,
  title: string,
): Promise<string> => {
  const created = (await identity(t, subject).mutation(createMyConversation, {
    clientCreateId: `client-create-${title}`,
    expectedOwnerGeneration: generation,
    title,
  })) as { conversationId: string };
  return created.conversationId;
};

const seedMigration = async (
  t: TestHarness,
  toSubject: string,
  status: "pending" | "running" | "failed" | "complete",
  extra: { lastError?: string; updatedAt?: number } = {},
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("auth_owner_migrations", {
      fromOwnerId: ownerIdFor(`anonymous-${toSubject}-${status}`),
      toOwnerId: ownerIdFor(toSubject),
      status,
      createdAt: 1,
      updatedAt: extra.updatedAt ?? 10,
      ...(extra.lastError ? { lastError: extra.lastError } : {}),
    });
  });
};

const shellArgs = (
  subject: string,
  lookups: { routeConversationId?: string; cachedConversationId?: string } = {},
) => ({
  expectedSubject: subject,
  expectedOwnerId: ownerIdFor(subject),
  identityRevision: 1,
  ...lookups,
});

describe("getMyShellBootstrap", () => {
  it("stays pending until the connection holds the expected account", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("current-owner"), "generation-1");

    await expect(
      t.query(getMyShellBootstrap, shellArgs("current-owner")),
    ).resolves.toEqual({ status: "identity_pending" });
    await expect(
      identity(t, "previous-owner").query(
        getMyShellBootstrap,
        shellArgs("current-owner"),
      ),
    ).resolves.toEqual({ status: "identity_pending" });
    await expect(
      identity(t, "current-owner").query(getMyShellBootstrap, {
        ...shellArgs("current-owner"),
        identityRevision: 1.5,
      }),
    ).resolves.toEqual({ status: "identity_pending" });
    await expect(
      identity(t, "current-owner").query(getMyShellBootstrap, {
        ...shellArgs("current-owner"),
        expectedSubject: "   ",
      }),
    ).resolves.toEqual({ status: "identity_pending" });
  });

  it("is pending exactly when confirmMySessionIdentity reports false", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner"), "generation-1");
    for (const [caller, expected] of [
      [t, "owner"],
      [identity(t, "other"), "owner"],
      [identity(t, "owner"), "owner"],
    ] as const) {
      const confirmed = await caller.query(confirmMySessionIdentity, {
        expectedSubject: expected,
        identityRevision: 1,
      });
      const bootstrap = (await caller.query(
        getMyShellBootstrap,
        shellArgs(expected),
      )) as { status: string };
      expect(bootstrap.status === "ready").toBe(confirmed);
    }
  });

  it("never returns another owner's data when the expected owner id differs", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner"), "generation-1");
    await createConversation(t, "owner", "generation-1", "private");

    await expect(
      identity(t, "owner").query(getMyShellBootstrap, {
        ...shellArgs("owner"),
        expectedOwnerId: ownerIdFor("someone-else"),
      }),
    ).resolves.toEqual({ status: "identity_pending" });
  });

  it("matches the functions it replaces field for field", async () => {
    const t = createTest();
    const subject = "parity-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-1");
    const first = await createConversation(t, subject, "generation-1", "first");
    const second = await createConversation(
      t,
      subject,
      "generation-1",
      "second",
    );
    const owner = identity(t, subject);

    const bootstrap = await owner.query(
      getMyShellBootstrap,
      shellArgs(subject, {
        routeConversationId: first,
        cachedConversationId: second,
      }),
    );
    const [list, conversationIdentity, route, cached, migration] =
      await Promise.all([
        owner.query(listMyConversations, {}),
        owner.query(getMyCloudConversationIdentity, {}),
        owner.query(getMyConversation, { conversationId: first }),
        owner.query(getMyConversation, { conversationId: second }),
        owner.query(getMyOwnershipMigrationStatus, {}),
      ]);

    expect(bootstrap).toEqual({
      status: "ready",
      ownerId: conversationIdentity.ownerId,
      migration,
      selection: {
        ownerGeneration: conversationIdentity.ownerGeneration,
        conversations: list,
        routeConversation: route,
        cachedConversation: cached,
      },
    });
    expect(list).toHaveLength(2);
    expect(migration).toBeNull();
    expect(conversationIdentity).toEqual({
      ownerId,
      ownerGeneration: "generation-1",
    });
  });

  it("omits lookups the client did not ask for", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner"), "generation-1");

    await expect(
      identity(t, "owner").query(getMyShellBootstrap, shellArgs("owner")),
    ).resolves.toMatchObject({
      status: "ready",
      selection: {
        conversations: [],
        routeConversation: null,
        cachedConversation: null,
      },
    });
  });

  it.each(["pending", "running", "failed"] as const)(
    "hides every owner-fenced read while a %s migration blocks selection",
    async (status) => {
      const t = createTest();
      const subject = `migrating-${status}`;
      await seedGeneration(t, ownerIdFor(subject), "generation-1");
      const conversationId = await createConversation(
        t,
        subject,
        "generation-1",
        "before-link",
      );
      await seedMigration(t, subject, status, { lastError: "boom" });
      const owner = identity(t, subject);

      const bootstrap = await owner.query(
        getMyShellBootstrap,
        shellArgs(subject, { routeConversationId: conversationId }),
      );
      expect(bootstrap).toEqual({
        status: "ready",
        ownerId: ownerIdFor(subject),
        migration: await owner.query(getMyOwnershipMigrationStatus, {}),
        selection: null,
      });
      expect(bootstrap).toMatchObject({ migration: { status } });
      // The generation read it replaces refuses outright during a transfer.
      await expect(
        owner.query(getMyCloudConversationIdentity, {}),
      ).rejects.toThrow();
    },
  );

  it("reports a failed migration's error exactly as the status query does", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("failed-owner"), "generation-1");
    await seedMigration(t, "failed-owner", "failed", {
      lastError: "worker unavailable",
      updatedAt: 20,
    });

    await expect(
      identity(t, "failed-owner").query(
        getMyShellBootstrap,
        shellArgs("failed-owner"),
      ),
    ).resolves.toMatchObject({
      migration: {
        status: "failed",
        updatedAt: 20,
        error:
          "Account linking stopped because source and destination data could not be merged safely.",
      },
      selection: null,
    });
  });

  it("selects once the migration completes", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("linked-owner"), "generation-1");
    await createConversation(t, "linked-owner", "generation-1", "moved");
    await seedMigration(t, "linked-owner", "complete");

    const bootstrap = await identity(t, "linked-owner").query(
      getMyShellBootstrap,
      shellArgs("linked-owner"),
    );
    expect(bootstrap).toMatchObject({
      status: "ready",
      migration: { status: "complete", updatedAt: 10 },
      selection: { ownerGeneration: "generation-1" },
    });
    expect(
      (bootstrap as { selection: { conversations: unknown[] } }).selection
        .conversations,
    ).toHaveLength(1);
  });

  it("gives an anonymous owner a null migration and its own conversations", async () => {
    const t = createTest();
    const subject = "anonymous-owner";
    await seedGeneration(t, ownerIdFor(subject), "generation-1");
    const conversationId = await createConversation(
      t,
      subject,
      "generation-1",
      "anon",
    );

    await expect(
      identity(t, subject, { anonymous: true }).query(
        getMyShellBootstrap,
        shellArgs(subject),
      ),
    ).resolves.toMatchObject({
      migration: null,
      selection: { conversations: [{ conversationId }] },
    });
  });

  it("scopes route and cached lookups to the caller", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner-a"), "generation-a");
    await seedGeneration(t, ownerIdFor("owner-b"), "generation-b");
    const foreign = await createConversation(
      t,
      "owner-a",
      "generation-a",
      "foreign",
    );
    const own = await createConversation(t, "owner-b", "generation-b", "own");

    await expect(
      identity(t, "owner-b").query(
        getMyShellBootstrap,
        shellArgs("owner-b", {
          routeConversationId: foreign,
          cachedConversationId: foreign,
        }),
      ),
    ).resolves.toMatchObject({
      selection: {
        ownerGeneration: "generation-b",
        conversations: [{ conversationId: own }],
        routeConversation: null,
        cachedConversation: null,
      },
    });
    await expect(
      identity(t, "owner-b").query(
        getMyShellBootstrap,
        shellArgs("owner-b", {
          routeConversationId: "00000000-0000-4000-8000-000000000000",
          cachedConversationId: own,
        }),
      ),
    ).resolves.toMatchObject({
      selection: {
        routeConversation: null,
        cachedConversation: { conversationId: own, ownerId: ownerIdFor("owner-b") },
      },
    });
  });

  it("drops deleted conversations from the list and the lookups", async () => {
    const t = createTest();
    const subject = "deleting-owner";
    await seedGeneration(t, ownerIdFor(subject), "generation-1");
    const kept = await createConversation(t, subject, "generation-1", "kept");
    const deleted = await createConversation(
      t,
      subject,
      "generation-1",
      "deleted",
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", deleted),
        )
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: 5 });
    });
    const owner = identity(t, subject);

    const bootstrap = await owner.query(
      getMyShellBootstrap,
      shellArgs(subject, {
        routeConversationId: deleted,
        cachedConversationId: deleted,
      }),
    );
    expect(bootstrap).toMatchObject({
      selection: {
        conversations: [{ conversationId: kept }],
        routeConversation: null,
        cachedConversation: null,
      },
    });
    expect(
      (bootstrap as { selection: { conversations: unknown[] } }).selection
        .conversations,
    ).toEqual(await owner.query(listMyConversations, {}));
    await expect(
      owner.query(getMyConversation, { conversationId: deleted }),
    ).resolves.toBeNull();
  });

  it("reports the current generation after an account reset", async () => {
    const t = createTest();
    const subject = "reset-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-1");
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: "generation-2",
        updatedAt: 2,
      });
    });

    await expect(
      identity(t, subject).query(getMyShellBootstrap, shellArgs(subject)),
    ).resolves.toMatchObject({
      selection: { ownerGeneration: "generation-2" },
    });
  });
});
