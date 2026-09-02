/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { hashSha256Hex } from "./lib/crypto_utils";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "cloud-app-build-owner";
const OWNER_GENERATION = "cloud-app-build-generation";
const APP_ID = "cloud-app-build-app";
const TURN_ID = "cloud-app-build-turn";
const BUILD_ID = "build_candidate1";

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
    await ctx.db.insert("cloud_apps", {
      appId: APP_ID,
      ownerId: OWNER_ID,
      slug: "candidate-app",
      title: "Old Title",
      status: "building",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId: TURN_ID,
      sessionId: "cloud-app-build-session",
      ownerId: OWNER_ID,
      appId: APP_ID,
      prompt: "Build me a habit tracker.",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return t;
};

const callbackArgs = async () => ({
  buildId: BUILD_ID,
  appId: APP_ID,
  ownerId: OWNER_ID,
  ownerGeneration: OWNER_GENERATION,
  turnId: TURN_ID,
  artifactPrefix: `builds/${await hashSha256Hex(OWNER_ID)}/${BUILD_ID}`,
  previewUrl: "https://apps.example.test/apps/candidate-app/",
  metricsJson: '{"wallClockMs":42,"uploadedBytes":1024}',
  slug: "candidate-app",
  title: "Habit Tracker",
  now: 2,
});

const state = async (t: Awaited<ReturnType<typeof createTest>>) =>
  await t.run(async (ctx) => ({
    app: await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", APP_ID))
      .unique(),
    builds: await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_appId_and_createdAt", (q) => q.eq("appId", APP_ID))
      .collect(),
  }));

describe("cloud app build callback", () => {
  it("records a candidate and never routes traffic to it", async () => {
    const t = await createTest();
    expect(
      await t.mutation(
        internal.cloud_apps.recordBuildInternal,
        await callbackArgs(),
      ),
    ).toBeNull();

    const after = await state(t);
    expect(after.builds).toHaveLength(1);
    expect(after.builds[0]?.status).toBe("pending");
    expect(after.app?.status).toBe("building");
    expect(after.app?.activeBuildId).toBeUndefined();
    expect(after.app?.title).toBe("Habit Tracker");
  });

  it("treats an exact redelivery as the same candidate", async () => {
    const t = await createTest();
    const args = await callbackArgs();
    await t.mutation(internal.cloud_apps.recordBuildInternal, args);
    expect(
      await t.mutation(internal.cloud_apps.recordBuildInternal, args),
    ).toBeNull();
    expect((await state(t)).builds).toHaveLength(1);
  });

  it("refuses a second payload reusing the same build id", async () => {
    const t = await createTest();
    const args = await callbackArgs();
    await t.mutation(internal.cloud_apps.recordBuildInternal, args);
    await expect(
      t.mutation(internal.cloud_apps.recordBuildInternal, {
        ...args,
        previewUrl: "https://apps.example.test/apps/other/",
      }),
    ).rejects.toThrow(/already bound to different artifacts/);
  });
});
