import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { makeFunctionReference } from "convex/server";

const benchmarkPrompt =
  "Build a polished responsive habit tracker named Orbit. It needs a warm editorial visual style, a daily progress ring, four useful habit cards, and an encouraging focus panel. Make it feel like a real product, not a generic dashboard.";

const createTurnRef = makeFunctionReference<"mutation", any, any>("cloud_apps:createTurnInternal");
const getAppRef = makeFunctionReference<"query", { appId: string }, any>("cloud_apps:getAppInternal");
const getBuildRef = makeFunctionReference<"query", { buildId: string }, any>("cloud_apps:getBuildInternal");
const activateBuildRef = makeFunctionReference<"mutation", any, any>("cloud_apps:activateBuildInternal");
const checkQuotaRef = makeFunctionReference<"query", { ownerId: string }, { allowed: boolean; reason?: string }>("cloud_apps:checkQuotaInternal");

export const createTurnInternal = internalMutation({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    ownerId: v.string(),
    appId: v.string(),
    prompt: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app) {
      await ctx.db.insert("cloud_apps", {
        appId: args.appId,
        ownerId: args.ownerId,
        slug: "orbit-habits",
        title: "Orbit",
        status: "building",
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("agent_turns", {
      turnId: args.turnId,
      sessionId: args.sessionId,
      ownerId: args.ownerId,
      appId: args.appId,
      prompt: args.prompt,
      status: "running",
      createdAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});

export const getAppInternal = internalQuery({
  args: { appId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db.query("cloud_apps").withIndex("by_appId", (q) => q.eq("appId", args.appId)).unique(),
});

export const getBuildInternal = internalQuery({
  args: { buildId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db.query("cloud_app_builds").withIndex("by_buildId", (q) => q.eq("buildId", args.buildId)).unique(),
});

export const checkQuotaInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ allowed: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const dayStart = Date.now() - 24 * 60 * 60 * 1_000;
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gte("createdAt", dayStart),
      )
      .take(10);
    if (turns.some((turn) => turn.status === "running")) {
      return { allowed: false, reason: "Your plan allows one active build at a time. Wait for it to finish or cancel it." };
    }
    if (turns.length >= 10) {
      return { allowed: false, reason: "Daily cloud-build quota reached. Try again after the rolling 24-hour window resets." };
    }
    return { allowed: true };
  },
});

export const getStorageInternal = internalQuery({
  args: { appId: v.string(), userId: v.string(), key: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId_and_key", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId).eq("key", args.key),
      )
      .unique(),
});

export const listStorageInternal = internalQuery({
  args: { appId: v.string(), userId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101),
});

export const setStorageInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    userId: v.string(),
    key: v.string(),
    valueJson: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.key.length < 1 || args.key.length > 128) {
      throw new ConvexError("Storage keys must be 1–128 characters.");
    }
    if (args.sizeBytes > 16 * 1024) {
      throw new ConvexError("Storage value exceeds the 16 KB per-key limit.");
    }
    const rows = await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101);
    const existing = rows.find((row) => row.key === args.key);
    if (!existing && rows.length >= 100) {
      throw new ConvexError("Storage quota reached: maximum 100 keys.");
    }
    const total = rows.reduce((sum, row) => sum + row.sizeBytes, 0)
      - (existing?.sizeBytes ?? 0)
      + args.sizeBytes;
    if (total > 64 * 1024) {
      throw new ConvexError("Storage quota reached: maximum 64 KB per app.");
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        valueJson: args.valueJson,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("cloud_app_storage", {
        appId: args.appId,
        ownerId: args.ownerId,
        userId: args.userId,
        key: args.key,
        valueJson: args.valueJson,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const deleteStorageInternal = internalMutation({
  args: { appId: v.string(), userId: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId_and_key", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId).eq("key", args.key),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const appendEventInternal = internalMutation({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    kind: v.string(),
    payloadJson: v.string(),
    terminal: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ inserted: v.boolean(), terminalAccepted: v.boolean() }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) =>
        q.eq("turnId", args.turnId).eq("seq", args.seq),
      )
      .unique();
    if (duplicate) {
      return { inserted: false, terminalAccepted: false };
    }
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) throw new ConvexError("Unknown cloud turn.");
    if (turn.terminalKind) {
      return { inserted: false, terminalAccepted: false };
    }
    await ctx.db.insert("agent_events", {
      turnId: args.turnId,
      sessionId: args.sessionId,
      seq: args.seq,
      kind: args.kind,
      payloadJson: args.payloadJson,
      createdAt: args.now,
    });
    if (args.terminal) {
      await ctx.db.patch(turn._id, {
        status: ["completed", "failed", "canceled", "timeout"].includes(args.kind)
          ? args.kind
          : "failed",
        terminalKind: args.kind,
        resultJson: args.kind === "completed" ? args.payloadJson : undefined,
        errorMessage: args.kind === "completed" ? undefined : args.payloadJson,
        updatedAt: args.now,
      });
    }
    return { inserted: true, terminalAccepted: args.terminal };
  },
});

export const recordBuildInternal = internalMutation({
  args: {
    buildId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    artifactPrefix: v.string(),
    previewUrl: v.string(),
    metricsJson: v.string(),
    slug: v.string(),
    autoActivate: v.boolean(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("cloud_app_builds", {
      buildId: args.buildId,
      appId: args.appId,
      ownerId: args.ownerId,
      status: args.autoActivate ? "active" : "pending",
      artifactPrefix: args.artifactPrefix,
      previewUrl: args.previewUrl,
      slug: args.slug,
      metricsJson: args.metricsJson,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app && args.autoActivate) {
      await ctx.db.patch(app._id, {
        status: "active",
        activeBuildId: args.buildId,
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const activateBuildInternal = internalMutation({
  args: { appId: v.string(), buildId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db.query("cloud_apps").withIndex("by_appId", (q) => q.eq("appId", args.appId)).unique();
    const build = await ctx.db.query("cloud_app_builds").withIndex("by_buildId", (q) => q.eq("buildId", args.buildId)).unique();
    if (!app || !build || build.appId !== app.appId) throw new ConvexError("Build is not available for this app.");
    if (app.activeBuildId) {
      const old = await ctx.db.query("cloud_app_builds").withIndex("by_buildId", (q) => q.eq("buildId", app.activeBuildId!)).unique();
      if (old) await ctx.db.patch(old._id, { status: "superseded", updatedAt: args.now });
    }
    await ctx.db.patch(build._id, { status: "active", updatedAt: args.now });
    await ctx.db.patch(app._id, { activeBuildId: build.buildId, status: "active", updatedAt: args.now });
    return null;
  },
});

export const startBenchmarkTurn = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !builderSecret) {
      throw new ConvexError("Cloud builder is not configured.");
    }
    const turnId = crypto.randomUUID();
    const sessionId = `m1-${turnId.slice(0, 8)}`;
    const appId = `orbit-${turnId.slice(0, 8)}`;
    const ownerId = "benchmark:cloud-m1";
    const quota = await ctx.runQuery(checkQuotaRef, { ownerId });
    if (!quota.allowed) throw new ConvexError(quota.reason ?? "Build quota exceeded.");
    await ctx.runMutation(createTurnRef, {
      turnId,
      sessionId,
      ownerId,
      appId,
      prompt: benchmarkPrompt,
      now: Date.now(),
    });
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const turnToken = Array.from(tokenBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await fetch(
      `${builderUrl.replace(/\/+$/, "")}/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builderSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId,
          appId,
          turnId,
          prompt: benchmarkPrompt,
          turnToken,
          convexCallbackBase: process.env.CONVEX_SITE_URL,
          autoActivate: true,
        }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      throw new ConvexError(`Builder failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  },
});

export const startLifecycleTurn = action({
  args: { appId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    if (!app) throw new ConvexError("Lifecycle app was not found.");
    const quota = await ctx.runQuery(checkQuotaRef, { ownerId: app.ownerId });
    if (!quota.allowed) throw new ConvexError(quota.reason ?? "Build quota exceeded.");
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !builderSecret) throw new ConvexError("Cloud builder is not configured.");
    const turnId = crypto.randomUUID();
    const sessionId = `m2-${turnId.slice(0, 8)}`;
    const prompt = "Iterate Orbit with a calmer blue palette and add a fifth-minute breathing cue to the focus panel while preserving the habit layout.";
    await ctx.runMutation(createTurnRef, {
      turnId, sessionId, ownerId: app.ownerId, appId: app.appId, prompt, now: Date.now(),
    });
    const turnToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const response = await fetch(`${builderUrl.replace(/\/+$/, "")}/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${builderSecret}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: app.ownerId,
        appId: app.appId,
        turnId,
        prompt,
        turnToken,
        convexCallbackBase: process.env.CONVEX_SITE_URL,
        autoActivate: false,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new ConvexError(`Builder failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  },
});

export const applyBuild = action({
  args: { buildId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const build = await ctx.runQuery(getBuildRef, args);
    if (!build?.artifactPrefix) throw new ConvexError("Build cannot be applied.");
    const slug = build.slug ?? `orbit-${build.appId.slice(-8)}`;
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret) throw new ConvexError("Cloud builder is not configured.");
    const response = await fetch(`${builderUrl}/routes/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        slug, appId: build.appId, ownerId: build.ownerId,
        buildId: build.buildId, artifactPrefix: build.artifactPrefix,
      }),
    });
    if (!response.ok) throw new ConvexError("Route activation failed.");
    await ctx.runMutation(activateBuildRef, {
      appId: build.appId, buildId: build.buildId, now: Date.now(),
    });
    return { ok: true, buildId: build.buildId, previewUrl: build.previewUrl };
  },
});

export const startLifecycleProbe = action({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    appId: v.string(),
    preflightDelayMs: v.number(),
    watchdogMs: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    if (!app) throw new ConvexError("Lifecycle app was not found.");
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret) throw new ConvexError("Cloud builder is not configured.");
    const prompt = "Lifecycle probe: preserve the app and wait for orchestration.";
    await ctx.runMutation(createTurnRef, {
      turnId: args.turnId, sessionId: args.sessionId, ownerId: app.ownerId,
      appId: app.appId, prompt, now: Date.now(),
    });
    const response = await fetch(`${builderUrl}/sessions/${args.sessionId}/turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: app.ownerId, appId: app.appId, turnId: args.turnId, prompt,
        turnToken: crypto.randomUUID().replaceAll("-", ""),
        convexCallbackBase: process.env.CONVEX_SITE_URL,
        autoActivate: false,
        preflightDelayMs: args.preflightDelayMs,
        watchdogMs: args.watchdogMs,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new ConvexError(`Lifecycle probe ended (${response.status}): ${JSON.stringify(body)}`);
    return body;
  },
});

export const getBenchmarkTurn = query({
  args: { turnId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) return null;
    const events = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", args.turnId))
      .take(100);
    return { turn, events };
  },
});
