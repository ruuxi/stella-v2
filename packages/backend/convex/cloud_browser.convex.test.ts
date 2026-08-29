/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { isConnectedOwnerIdAction } from "./auth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
type TestHarness = ReturnType<typeof createTest>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const OWNER_ID = "https://issuer.test|browser-owner";
const OWNER_GENERATION = "generation:browser-owner";
const CONVERSATION_ID = "conversation:browser";
const THREAD_ID = "thread:browser";
const TURN_ID = "turn:browser";
const TOKEN = "browser-turn-token";
const NOW = 10_000;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const suspension = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  outcome: "waiting_for_user" as const,
  interactionId: "interaction:browser",
  interactionRevision: 1,
  interactionKind: "login_takeover" as const,
  toolCallId: "tool-call:browser",
  requestDigest: "a".repeat(64),
  profileId: "default",
  profileEpoch: 7,
  displayOrigin: "https://accounts.example",
  displayTitle: "Sign in to Example",
  expiresAt: NOW + 60_000,
  ...overrides,
});

const waitingPayload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    suspension: suspension(overrides),
    usage: { inputTokens: 10, outputTokens: 2, llmCalls: 1 },
    wallClockMs: 250,
  });

const seedActiveTurn = async (t: TestHarness) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_agent_threads", {
      threadId: THREAD_ID,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      conversationId: CONVERSATION_ID,
      description: "Browser proof",
      placement: "cloud",
      agentType: "general",
      attemptGeneration: 1,
      sandboxLeaseExpiresAt: NOW + 60_000,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId: TURN_ID,
      sessionId: THREAD_ID,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      conversationId: CONVERSATION_ID,
      prompt: "Open the protected site",
      status: "running",
      lane: "agent",
      kind: "agent",
      agentType: "general",
      placement: "cloud",
      threadId: THREAD_ID,
      hidden: true,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
    tokenHash: await sha256Hex(TOKEN),
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: TURN_ID,
    agentType: "general",
    now: NOW,
  });
};

const projectWait = async (t: TestHarness, payloadJson = waitingPayload()) =>
  await t.mutation(internal.cloud_apps.appendEventInternal, {
    tokenHash: await sha256Hex(TOKEN),
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: TURN_ID,
    attemptGeneration: 1,
    sessionId: THREAD_ID,
    seq: 0,
    autoSeq: true,
    kind: "waiting_for_user",
    payloadJson,
    terminal: false,
    connectedAccount: true,
    now: NOW,
  });

const approvedReceipt = () => ({
  schemaVersion: 1 as const,
  interactionId: "interaction:browser",
  interactionRevision: 1,
  profileId: "default",
  profileEpoch: 7,
  toolCallId: "tool-call:browser",
  requestDigest: "a".repeat(64),
  result: "approved" as const,
  safeMessage: "Sign-in completed securely.",
});

describe("cloud browser control projection", () => {
  it("resolves service-route account status by the Better Auth user id", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "https://issuer.test");
    const runQuery = vi.fn().mockResolvedValue({
      _id: "browser-owner",
      isAnonymous: false,
    });

    await expect(
      isConnectedOwnerIdAction(
        { runQuery } as Parameters<typeof isConnectedOwnerIdAction>[0],
        OWNER_ID,
      ),
    ).resolves.toBe(true);
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      model: "user",
      where: [{ field: "_id", value: "browser-owner" }],
    });
  });

  it("atomically projects a wait, revokes its token, and admits only an exact replay", async () => {
    const t = createTest();
    await seedActiveTurn(t);

    expect(await projectWait(t)).toEqual({
      inserted: true,
      terminalAccepted: false,
    });
    expect(await projectWait(t)).toEqual({
      inserted: false,
      terminalAccepted: false,
    });

    await t.run(async (ctx) => {
      const interaction = await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", "interaction:browser"),
        )
        .unique();
      expect(interaction).toMatchObject({
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        profileId: "default",
        profileEpoch: 7,
        state: "pending",
        revision: 1,
      });
      const serialized = JSON.stringify(interaction);
      expect(serialized).not.toContain("userCode");
      expect(serialized).not.toContain("verificationUri");
      expect(serialized).not.toContain("live.browser.run");

      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      expect(turn?.status).toBe("waiting_for_user");
      expect(turn?.activeTokenHash).toBeUndefined();
      expect(thread).toMatchObject({
        status: "waiting_for_user",
        sandboxLeaseExpiresAt: 0,
      });
      expect(
        await ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_turnId_and_ownerId", (q) =>
            q.eq("turnId", TURN_ID).eq("ownerId", OWNER_ID),
          )
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", TURN_ID))
          .collect(),
      ).toHaveLength(1);
    });

    await expect(
      projectWait(
        t,
        waitingPayload({ interactionId: "interaction:different" }),
      ),
    ).rejects.toThrow("no longer active");
  });

  it("rejects a new browser wait from a turn capability invalidated by session revocation", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_session_policies", {
        ownerId: OWNER_ID,
        minIssuedAtSec: Math.floor(NOW / 1000) + 1,
        updatedAt: NOW + 1,
      });
    });

    await expect(projectWait(t)).rejects.toThrow("Session has been revoked");
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_interactionId", (q) =>
            q.eq("interactionId", "interaction:browser"),
          )
          .unique(),
      ).toBeNull();
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      expect(turn).toMatchObject({ status: "running" });
      expect(turn?.activeTokenHash).toBe(await sha256Hex(TOKEN));
    });
  });

  it("creates one fresh resuming turn with a new attempt and exact decision replay", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    const args = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      interactionId: "interaction:browser",
      expectedRevision: 1,
      requestId: "decision:browser-approved",
      decision: "done" as const,
      receipt: approvedReceipt(),
      now: NOW + 1,
    };

    const first = await t.mutation(
      internal.cloud_browser.claimBrowserInteractionResumeInternal,
      args,
    );
    expect(first).toMatchObject({
      state: "resuming",
      revision: 2,
      turnId: TURN_ID,
    });
    expect(
      await t.mutation(
        internal.cloud_browser.claimBrowserInteractionResumeInternal,
        args,
      ),
    ).toEqual(first);

    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_threadId_and_createdAt", (q) =>
          q.eq("threadId", THREAD_ID),
        )
        .collect();
      expect(turns).toHaveLength(2);
      const original = turns.find((turn) => turn.turnId === TURN_ID);
      const resumed = turns.find((turn) => turn.turnId !== TURN_ID);
      expect(original?.status).toBe("waiting_for_user");
      expect(resumed).toMatchObject({
        status: "resuming",
        attemptGeneration: 2,
        source: "browser-resume",
        browserResume: approvedReceipt(),
      });
      expect(resumed?.turnId).not.toBe(TURN_ID);
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      expect(thread).toMatchObject({
        status: "resuming",
        attemptGeneration: 2,
      });
    });

    await expect(
      t.mutation(internal.cloud_browser.claimBrowserInteractionResumeInternal, {
        ...args,
        requestId: "decision:conflict",
      }),
    ).rejects.toThrow("reused differently");
  });

  it("finalizes the interaction on the resumed turn's first authorized event", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    await t.mutation(
      internal.cloud_browser.claimBrowserInteractionResumeInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        interactionId: "interaction:browser",
        expectedRevision: 1,
        requestId: "decision:browser-complete",
        decision: "done",
        receipt: approvedReceipt(),
        now: NOW + 1,
      },
    );
    const resumeTurn = await t.run(async (ctx) => {
      const interaction = await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", "interaction:browser"),
        )
        .unique();
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) =>
          q.eq("turnId", interaction!.resumeTurnId!),
        )
        .unique();
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      await ctx.db.patch(turn!._id, {
        status: "running",
        updatedAt: NOW + 2,
      });
      await ctx.db.patch(thread!._id, {
        status: "running",
        updatedAt: NOW + 2,
      });
      return turn!;
    });
    const resumeTokenHash = await sha256Hex("fresh-resume-token");
    await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
      tokenHash: resumeTokenHash,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: resumeTurn.turnId,
      agentType: "general",
      now: NOW + 2,
    });
    await t.mutation(internal.cloud_apps.appendEventInternal, {
      tokenHash: resumeTokenHash,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: resumeTurn.turnId,
      attemptGeneration: 2,
      sessionId: THREAD_ID,
      seq: 0,
      autoSeq: true,
      kind: "progress",
      payloadJson: JSON.stringify({ message: "Continuing securely" }),
      terminal: false,
      now: NOW + 3,
    });
    await t.run(async (ctx) => {
      const interaction = await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", "interaction:browser"),
        )
        .unique();
      expect(interaction).toMatchObject({
        state: "completed",
        resolution: "approved",
        revision: 3,
        resumeTurnId: resumeTurn.turnId,
      });
    });
  });

  it("turns an explicit post-deadline expiry into a fresh failed-tool resume", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    const receipt = {
      ...approvedReceipt(),
      result: "expired" as const,
      safeMessage: "Browser request expired.",
    };

    await expect(
      t.mutation(internal.cloud_browser.expireBrowserInteractionInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        interactionId: "interaction:browser",
        expectedRevision: 1,
        requestId: "expiry:too-early",
        receipt,
        now: NOW + 59_999,
      }),
    ).rejects.toThrow("has not expired");

    const expiring = await t.mutation(
      internal.cloud_browser.expireBrowserInteractionInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        interactionId: "interaction:browser",
        expectedRevision: 1,
        requestId: "expiry:browser",
        receipt,
        now: NOW + 60_001,
      },
    );
    expect(expiring).toMatchObject({ state: "resuming", revision: 2 });

    const resumeTurnId = await t.run(async (ctx) => {
      const interaction = await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", "interaction:browser"),
        )
        .unique();
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) =>
          q.eq("turnId", interaction!.resumeTurnId!),
        )
        .unique();
      expect(turn).toMatchObject({
        status: "resuming",
        browserResume: receipt,
      });
      return turn!.turnId;
    });

    expect(
      await t.mutation(
        internal.cloud_browser.completeBrowserInteractionInternal,
        {
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          interactionId: "interaction:browser",
          expectedRevision: 2,
          resumeTurnId,
          now: NOW + 60_002,
        },
      ),
    ).toMatchObject({ state: "expired", revision: 3 });
  });

  it("cancels every active wait only after the Gateway reset receipt is applied", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    await t.mutation(internal.cloud_browser.applyBrowserProfileResetInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      requestId: "reset:browser",
      profileEpoch: 8,
      now: NOW + 1,
    });
    await t.run(async (ctx) => {
      const interaction = await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", "interaction:browser"),
        )
        .unique();
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      expect(interaction).toMatchObject({
        state: "canceled",
        resolution: "canceled",
        revision: 2,
      });
      expect(turn).toMatchObject({
        status: "canceled",
        terminalKind: "canceled",
      });
      expect(thread).toMatchObject({ status: "canceled" });
    });
  });

  it("keeps the owner subscription connected-only and session-revocation aware", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    const connected = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "browser-owner",
      tokenIdentifier: OWNER_ID,
      iat: 200,
    });
    expect(
      await connected.query(api.cloud_browser.listMyPendingBrowserInteractions),
    ).toHaveLength(1);

    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "browser-owner",
      tokenIdentifier: OWNER_ID,
      isAnonymous: true,
      iat: 200,
    });
    await expect(
      anonymous.query(api.cloud_browser.listMyPendingBrowserInteractions),
    ).rejects.toThrow("Sign in with an account");

    await t.run(async (ctx) => {
      await ctx.db.insert("auth_session_policies", {
        ownerId: OWNER_ID,
        minIssuedAtSec: 300,
        updatedAt: NOW,
      });
    });
    await expect(
      connected.query(api.cloud_browser.listMyPendingBrowserInteractions),
    ).rejects.toThrow("Session has been revoked");
  });

  it("rejects non-HTTPS device-code verification links from the Gateway", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t, waitingPayload({ interactionKind: "device_code" }));
    vi.stubEnv("CLOUD_BUILDER_URL", "https://builder.example.test");
    vi.stubEnv("BUILDER_SERVICE_SECRET", "browser-test-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        schemaVersion: 1,
        interaction: {
          schemaVersion: 1,
          interactionId: "interaction:browser",
          kind: "device_code",
          revision: 1,
          verificationUri: "http://device.example.test/verify",
          userCode: "ABCD-EFGH",
        },
      }),
    );
    const connected = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "browser-owner",
      tokenIdentifier: OWNER_ID,
      iat: 200,
    });

    await expect(
      connected.action(api.cloud_browser.getMyBrowserInteraction, {
        interactionId: "interaction:browser",
      }),
    ).rejects.toThrow("Invalid secure browser URL");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("blocks anonymous namespace linking when browser control residue exists", async () => {
    const t = createTest();
    await seedActiveTurn(t);
    await projectWait(t);
    expect(
      await t.query(internal.auth_migration.getOwnerNamespaceTransferBlocker, {
        fromOwnerId: OWNER_ID,
        toOwnerId: "https://issuer.test|connected-destination",
      }),
    ).toContain("browser session");
  });
});
