import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";

const benchmarkPrompt =
  "Build a polished responsive habit tracker named Orbit. It needs a warm editorial visual style, a daily progress ring, four useful habit cards, and an encouraging focus panel. Make it feel like a real product, not a generic dashboard.";

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
        status: args.kind === "completed" ? "completed" : "failed",
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
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("cloud_app_builds", {
      buildId: args.buildId,
      appId: args.appId,
      ownerId: args.ownerId,
      status: "active",
      artifactPrefix: args.artifactPrefix,
      previewUrl: args.previewUrl,
      metricsJson: args.metricsJson,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app) {
      await ctx.db.patch(app._id, {
        status: "active",
        activeBuildId: args.buildId,
        updatedAt: args.now,
      });
    }
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
    await ctx.runMutation(internal.cloud_apps.createTurnInternal, {
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
