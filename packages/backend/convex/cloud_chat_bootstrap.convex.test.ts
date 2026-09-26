/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const getMyChatBootstrap = makeFunctionReference<"query">(
  "cloud_apps:getMyChatBootstrap",
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

const identity = (t: TestHarness, subject: string) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject,
    tokenIdentifier: ownerIdFor(subject),
    iat: 1_000,
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

const CLIENT_CREATE_ID = "mobile-placement:cloud";

const bootstrapArgs = (subject: string) => ({
  expectedSubject: subject,
  expectedOwnerId: ownerIdFor(subject),
  identityRevision: 1,
  clientCreateId: CLIENT_CREATE_ID,
});

const previousBuilderUrl = process.env.CLOUD_BUILDER_URL;
beforeEach(() => {
  process.env.CLOUD_BUILDER_URL = "https://builder.test/";
});
afterEach(() => {
  if (previousBuilderUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
  else process.env.CLOUD_BUILDER_URL = previousBuilderUrl;
});

describe("getMyChatBootstrap", () => {
  it("reports no chat until it is created, then the created chat, without writing", async () => {
    const t = createTest();
    const subject = "bootstrap-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-1");

    await expect(
      identity(t, subject).query(getMyChatBootstrap, bootstrapArgs(subject)),
    ).resolves.toEqual({
      status: "ready",
      ownerId,
      ownerGeneration: "generation-1",
      conversationId: null,
      realtime: {
        httpOrigin: "https://builder.test",
        socketOrigin: "wss://builder.test",
        protocol: 1,
      },
    });
    await expect(
      t.run((ctx) => ctx.db.query("cloud_conversations").collect()),
    ).resolves.toEqual([]);

    const created = await identity(t, subject).mutation(createMyConversation, {
      clientCreateId: CLIENT_CREATE_ID,
      expectedOwnerGeneration: "generation-1",
      title: "Chat",
    });
    await expect(
      identity(t, subject).query(getMyChatBootstrap, bootstrapArgs(subject)),
    ).resolves.toMatchObject({
      status: "ready",
      conversationId: created.conversationId,
    });
  });

  it("stays pending until the connection holds the expected account", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("current-owner"), "generation-1");

    await expect(
      t.query(getMyChatBootstrap, bootstrapArgs("current-owner")),
    ).resolves.toEqual({ status: "identity_pending" });
    await expect(
      identity(t, "previous-owner").query(
        getMyChatBootstrap,
        bootstrapArgs("current-owner"),
      ),
    ).resolves.toEqual({ status: "identity_pending" });
    await expect(
      identity(t, "current-owner").query(getMyChatBootstrap, {
        ...bootstrapArgs("current-owner"),
        identityRevision: 1.5,
      }),
    ).resolves.toEqual({ status: "identity_pending" });
  });

  it("rejects a session whose owner id differs from the one the client expects", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner"), "generation-1");

    await expect(
      identity(t, "owner").query(getMyChatBootstrap, {
        ...bootstrapArgs("owner"),
        expectedOwnerId: ownerIdFor("someone-else"),
      }),
    ).rejects.toThrow(/session changed/iu);
  });

  it("never returns another owner's chat for the same client create id", async () => {
    const t = createTest();
    await seedGeneration(t, ownerIdFor("owner-a"), "generation-a");
    await seedGeneration(t, ownerIdFor("owner-b"), "generation-b");
    await identity(t, "owner-a").mutation(createMyConversation, {
      clientCreateId: CLIENT_CREATE_ID,
      expectedOwnerGeneration: "generation-a",
    });

    await expect(
      identity(t, "owner-b").query(getMyChatBootstrap, bootstrapArgs("owner-b")),
    ).resolves.toMatchObject({
      ownerGeneration: "generation-b",
      conversationId: null,
    });
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
      identity(t, subject).query(getMyChatBootstrap, bootstrapArgs(subject)),
    ).resolves.toMatchObject({ ownerGeneration: "generation-2" });
  });

  it("refuses a deleted chat the same way createMyConversation does", async () => {
    const t = createTest();
    const subject = "deleted-chat-owner";
    await seedGeneration(t, ownerIdFor(subject), "generation-1");
    const created = await identity(t, subject).mutation(createMyConversation, {
      clientCreateId: CLIENT_CREATE_ID,
      expectedOwnerGeneration: "generation-1",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", created.conversationId),
        )
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: 5 });
    });

    await expect(
      identity(t, subject).query(getMyChatBootstrap, bootstrapArgs(subject)),
    ).rejects.toThrow(/Conversation not found/u);
  });
});
