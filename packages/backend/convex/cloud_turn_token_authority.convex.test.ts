/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { internal } from "./_generated/api";
import {
  MANAGED_USAGE_BILLING_KIND,
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
} from "./lib/managed_dispatch";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const OWNER_ID = "owner:cloud-turn-authority";
const OWNER_GENERATION = "cloud-turn-generation";
const TURN_ID = "turn:cloud-turn-authority";
const THREAD_ID = "thread:cloud-turn-authority";
const OTHER_THREAD_ID = "thread:cloud-turn-forgery-target";
const TOKEN_A = "cloud-turn-token-a";
const TOKEN_B = "cloud-turn-token-b";
const BUILD_TURN_ID = "turn:cloud-build-authority";
const BUILD_SESSION_ID = "session:cloud-build-authority";
const BUILD_CONVERSATION_ID = "conversation:cloud-build-authority";
const BUILD_APP_ID = "app:cloud-build-authority";
const BUILD_TOKEN = "cloud-build-token";
const originalParallelApiKey = process.env.PARALLEL_API_KEY;

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_FREE_LIFETIME_LIMIT_USD: "0.5",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

beforeEach(() => {
  process.env.PARALLEL_API_KEY = "parallel-turn-authority-test-key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalParallelApiKey === undefined) {
    delete process.env.PARALLEL_API_KEY;
  } else {
    process.env.PARALLEL_API_KEY = originalParallelApiKey;
  }
});

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const seedActiveTurn = async (token = TOKEN_A) => {
  const t = createTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    for (const [threadId, description] of [
      [THREAD_ID, "Authorized thread"],
      [OTHER_THREAD_ID, "Forgery target"],
    ] as const) {
      await ctx.db.insert("cloud_agent_threads", {
        threadId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 1,
        conversationId: "conversation:cloud-turn-authority",
        description,
        workspace: "cloud",
        agentType: "general",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
    }
    await ctx.db.insert("agent_turns", {
      turnId: TURN_ID,
      sessionId: "session:cloud-turn-authority",
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      conversationId: "conversation:cloud-turn-authority",
      prompt: "Keep this transcript trustworthy",
      status: "running",
      kind: "agent",
      threadId: THREAD_ID,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
    tokenHash: await sha256Hex(token),
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: TURN_ID,
    agentType: "general",
    // HTTP actions validate expiry with the wall clock, so mint this synthetic
    // capability on that same clock rather than at Unix epoch + 10ms.
    now: Date.now(),
  });
  return t;
};

const seedActiveBuildTurn = async () => {
  const t = createTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_apps", {
      appId: BUILD_APP_ID,
      ownerId: OWNER_ID,
      slug: "cloud-build-authority",
      title: "Cloud Build Authority",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId: BUILD_TURN_ID,
      sessionId: BUILD_SESSION_ID,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      conversationId: BUILD_CONVERSATION_ID,
      appId: BUILD_APP_ID,
      prompt: "Keep stale builds fenced",
      status: "running",
      kind: "build",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
    tokenHash: await sha256Hex(BUILD_TOKEN),
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: BUILD_TURN_ID,
    agentType: "general",
    now: Date.now(),
  });
  return t;
};

const messageRequest = (token: string, threadId = THREAD_ID) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-stella-turn-token": token,
  },
  body: JSON.stringify({
    conversationId: threadId,
    turnId: TURN_ID,
    messages: [
      {
        ordinal: 0,
        role: "assistant",
        payloadJson: '{"role":"assistant","content":"durable"}',
      },
    ],
  }),
});

const webSearchRequest = (token: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-stella-turn-token": token,
  },
  body: JSON.stringify({ query: "transactional cloud turn authority" }),
});

const terminalize = async (t: ReturnType<typeof createTest>) =>
  await t.mutation(internal.cloud_apps.appendEventInternal, {
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: TURN_ID,
    attemptGeneration: 1,
    sessionId: "session:cloud-turn-authority",
    seq: 0,
    autoSeq: true,
    kind: "completed",
    payloadJson: '{"finalText":"done"}',
    terminal: true,
    now: 100,
  });

const rotateTurnToken = async (t: ReturnType<typeof createTest>) =>
  await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
    tokenHash: await sha256Hex(TOKEN_B),
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    turnId: TURN_ID,
    agentType: "general",
    now: Date.now(),
  });

const transcriptRows = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) =>
    ctx.db
      .query("cloud_thread_messages")
      .withIndex("by_conversationId_and_seq", (q) =>
        q.eq("conversationId", THREAD_ID),
      )
      .collect(),
  );

const agentThread = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) =>
    ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
      .unique(),
  );

const billingSnapshot = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) => ({
    usage: await ctx.db
      .query("billing_usage_windows")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
      .unique(),
    logs: await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
      .collect(),
    dispatches: await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
      .collect(),
  }));

describe("cloud turn-token authority", () => {
  it("atomically persists a complete transcript larger than the former 50-row boundary", async () => {
    const rows = Array.from({ length: 51 }, (_, ordinal) => ({
      ordinal,
      role: "assistant",
      payloadJson: JSON.stringify({
        role: "assistant",
        content: `row-${ordinal}`,
      }),
    }));
    const t = await seedActiveTurn();
    const response = await t.fetch("/api/cloud/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stella-turn-token": TOKEN_A,
      },
      body: JSON.stringify({
        conversationId: THREAD_ID,
        turnId: TURN_ID,
        messages: rows,
      }),
    });
    expect(response.status).toBe(200);
    expect(await transcriptRows(t)).toHaveLength(51);

    const rejected = await seedActiveTurn();
    const invalid = rows.map((row) => ({ ...row }));
    invalid[50] = { ...invalid[50]!, role: "forged" };
    expect(
      (
        await rejected.fetch("/api/cloud/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-turn-token": TOKEN_A,
          },
          body: JSON.stringify({
            conversationId: THREAD_ID,
            turnId: TURN_ID,
            messages: invalid,
          }),
        })
      ).status,
    ).toBe(409);
    expect(await transcriptRows(rejected)).toEqual([]);
  });

  it("accepts the final transcript flush before terminal and rejects its replay after terminal", async () => {
    const t = await seedActiveTurn();
    const flush = await t.fetch("/api/cloud/messages", messageRequest(TOKEN_A));
    expect(flush.status).toBe(200);
    expect(await transcriptRows(t)).toHaveLength(1);

    await terminalize(t);
    const replay = await t.fetch(
      "/api/cloud/messages",
      messageRequest(TOKEN_A),
    );
    expect(replay.status).toBe(401);
    expect(await transcriptRows(t)).toHaveLength(1);
    await expect(
      t.query(internal.cloud_apps.getTurnTokenByHashInternal, {
        tokenHash: await sha256Hex(TOKEN_A),
        now: 101,
        requireActive: true,
      }),
    ).resolves.toBeNull();
  });

  it("deduplicates a lost transcript response by turn ordinal and rejects a conflicting replay", async () => {
    const t = await seedActiveTurn();
    const request = messageRequest(TOKEN_A);
    expect((await t.fetch("/api/cloud/messages", request)).status).toBe(200);
    expect(
      (await t.fetch("/api/cloud/messages", messageRequest(TOKEN_A))).status,
    ).toBe(200);
    expect(await transcriptRows(t)).toHaveLength(1);

    const conflict = messageRequest(TOKEN_A);
    const conflictBody = JSON.parse(conflict.body) as {
      messages: Array<{ payloadJson: string }>;
    };
    conflictBody.messages[0]!.payloadJson =
      '{"role":"assistant","content":"different"}';
    const response = await t.fetch(
      "/api/cloud/messages",
      {
        ...conflict,
        body: JSON.stringify(conflictBody),
      },
    );
    expect(response.status).toBe(409);
    expect(await transcriptRows(t)).toHaveLength(1);
  });

  it("fails closed when authoritative thread history contains a malformed row", async () => {
    const t = await seedActiveTurn();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_thread_messages", {
        conversationId: THREAD_ID,
        ownerId: OWNER_ID,
        seq: 0,
        ordinal: 0,
        role: "assistant",
        payloadJson: "{",
        turnId: "turn:prior",
        createdAt: 1,
      });
    });
    await expect(
      t.query(internal.cloud_apps.listThreadMessagesInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        threadId: THREAD_ID,
        excludeTurnId: TURN_ID,
      }),
    ).rejects.toThrow(/invalid JSON/iu);
  });

  it("binds already-running executor authority to token and attempt generation", async () => {
    const t = await seedActiveTurn();
    const authority = (tokenHash: string, attemptGeneration = 1) =>
      t.query(
        internal.cloud_apps.isCloudAgentTurnAttemptAuthoritativeInternal,
        {
          tokenHash,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          attemptGeneration,
          now: Date.now(),
        },
      );
    const tokenAHash = await sha256Hex(TOKEN_A);
    await expect(authority(tokenAHash)).resolves.toBe(true);
    await expect(authority(tokenAHash, 2)).resolves.toBe(false);
    await rotateTurnToken(t);
    await expect(authority(tokenAHash)).resolves.toBe(false);
    await expect(authority(await sha256Hex(TOKEN_B))).resolves.toBe(true);
  });

  it("rejects stale build admission authority after owner generation rotation", async () => {
    const t = await seedActiveBuildTurn();
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    const authorityRequest = () =>
      t.fetch("/api/cloud/app-turn-authority", {
        method: "POST",
        headers: {
          authorization: "Bearer builder-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tokenHash: awaitableBuildTokenHash,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          conversationId: BUILD_CONVERSATION_ID,
          appId: BUILD_APP_ID,
          turnId: BUILD_TURN_ID,
          sessionId: BUILD_SESSION_ID,
        }),
      });
    const awaitableBuildTokenHash = await sha256Hex(BUILD_TOKEN);
    try {
      const active = await authorityRequest();
      expect(active.status).toBe(200);
      expect(await active.json()).toEqual({ authoritative: true });

      await t.run(async (ctx) => {
        const lifecycle = await ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
          .unique();
        await ctx.db.patch(lifecycle!._id, {
          generation: "cloud-turn-generation-reopened",
          updatedAt: 2,
        });
      });
      const stale = await authorityRequest();
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ authoritative: false });
    } finally {
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
    }
  });

  it("rejects an event receipt with a mismatched attempt or session", async () => {
    const t = await seedActiveTurn();
    const base = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      sessionId: "session:cloud-turn-authority",
      seq: 0,
      autoSeq: true,
      kind: "progress",
      payloadJson: "{}",
      terminal: false,
      now: Date.now(),
    } as const;
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...base,
        attemptGeneration: 2,
      }),
    ).rejects.toThrow(/attempt/iu);
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...base,
        attemptGeneration: 1,
        sessionId: "session:forged",
      }),
    ).rejects.toThrow(/unknown cloud turn/iu);
  });

  it("rotates the exact turn capability and rejects a forged thread target", async () => {
    const t = await seedActiveTurn();
    await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
      tokenHash: await sha256Hex(TOKEN_B),
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      agentType: "general",
      now: Date.now(),
    });

    expect(
      (await t.fetch("/api/cloud/messages", messageRequest(TOKEN_A))).status,
    ).toBe(401);
    expect(
      (
        await t.fetch(
          "/api/cloud/messages",
          messageRequest(TOKEN_B, OTHER_THREAD_ID),
        )
      ).status,
    ).toBe(409);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("cloud_thread_messages")
          .withIndex("by_conversationId_and_seq", (q) =>
            q.eq("conversationId", OTHER_THREAD_ID),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  it("serializes token-authenticated event appends against token rotation", async () => {
    const t = await seedActiveTurn();
    const staleTokenHash = await sha256Hex(TOKEN_A);
    await t.mutation(internal.cloud_apps.storeTurnTokenInternal, {
      tokenHash: await sha256Hex(TOKEN_B),
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      agentType: "general",
      now: Date.now(),
    });

    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        tokenHash: staleTokenHash,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        turnId: TURN_ID,
        attemptGeneration: 1,
        sessionId: "session:cloud-turn-authority",
        seq: 0,
        autoSeq: true,
        kind: "progress",
        payloadJson: '{"text":"stale"}',
        terminal: false,
        now: Date.now(),
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", TURN_ID))
          .collect(),
      ),
    ).resolves.toEqual([]);
  });

  it("accepts one token-authenticated terminal event and idempotently replays its exact receipt", async () => {
    const t = await seedActiveTurn();
    const args = {
      tokenHash: await sha256Hex(TOKEN_A),
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      attemptGeneration: 1,
      sessionId: "session:cloud-turn-authority",
      seq: 0,
      autoSeq: true,
      kind: "completed",
      payloadJson: '{"finalText":"done"}',
      terminal: true,
      now: Date.now(),
    } as const;

    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, args),
    ).resolves.toEqual({ inserted: true, terminalAccepted: true });
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...args,
        now: args.now + 1,
      }),
    ).resolves.toEqual({ inserted: false, terminalAccepted: false });
  });

  it("rejects a rotated service callback but admits the exact current hash", async () => {
    const t = await seedActiveTurn();
    const staleHash = await sha256Hex(TOKEN_A);
    await rotateTurnToken(t);
    const base = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      attemptGeneration: 1,
      sessionId: "session:cloud-turn-authority",
      seq: 0,
      autoSeq: true,
      kind: "completed",
      payloadJson: '{"finalText":"done"}',
      terminal: true,
      now: Date.now(),
    } as const;
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...base,
        tokenHash: staleHash,
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...base,
        tokenHash: await sha256Hex(TOKEN_B),
      }),
    ).resolves.toEqual({ inserted: true, terminalAccepted: true });
  });

  it("converges exact terminal delivery before or after token expiry without reviving a rotated hash", async () => {
    const t = await seedActiveTurn();
    const tokenHash = await sha256Hex(TOKEN_A);
    await t.run(async (ctx) => {
      const token = await ctx.db
        .query("cloud_turn_tokens")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
        .unique();
      await ctx.db.delete(token!._id);
    });
    const terminal = {
      tokenHash,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      attemptGeneration: 1,
      sessionId: "session:cloud-turn-authority",
      seq: 0,
      autoSeq: true,
      kind: "completed",
      payloadJson: '{"finalText":"done"}',
      terminal: true,
      now: Date.now() + 31 * 60_000,
    } as const;
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, terminal),
    ).resolves.toEqual({ inserted: true, terminalAccepted: true });
    await expect(
      t.mutation(internal.cloud_apps.appendEventInternal, {
        ...terminal,
        now: terminal.now + 31 * 60_000,
      }),
    ).resolves.toEqual({ inserted: false, terminalAccepted: false });
    await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
      tokenHash,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      threadId: THREAD_ID,
      callerTurnId: TURN_ID,
      completingTurnId: TURN_ID,
      status: "completed",
      resultJson: '{"finalText":"done"}',
      wake: false,
      now: terminal.now + 31 * 60_000 + 1,
    });
    expect(await agentThread(t)).toMatchObject({ status: "completed" });
  });

  it("keeps a durable exact dispatch successor across a lost admission response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const t = await seedActiveTurn();
    const priorUrl = process.env.CLOUD_BUILDER_URL;
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    const priorSite = process.env.CONVEX_SITE_URL;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    process.env.CONVEX_SITE_URL = "https://convex.example.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("202 response lost"));
    const actionArgs = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      conversationId: "conversation:cloud-turn-authority",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      prompt: "Keep this transcript trustworthy",
      workspace: "cloud",
      turnToken: TOKEN_A,
      attemptGeneration: 1,
      execution: {
        engine: "stella" as const,
        provider: "stella" as const,
        model: "stella/standard",
        reasoningEffort: "high" as const,
      },
      convexCallbackBase: "https://convex.example.test",
    };
    try {
      await t.action(internal.cloud_apps.runCloudAgentTurnInternal, actionArgs);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((await agentThread(t))?.status).toBe("running");
      const turn = await t.run(async (ctx) =>
        ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
          .unique(),
      );
      expect(turn?.status).toBe("running");
      expect(turn?.terminalKind).toBeUndefined();
      const scheduled = await t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (entry) =>
            typeof entry.args[0] === "object" &&
            entry.args[0] !== null &&
            (entry.args[0] as { turnId?: unknown }).turnId === TURN_ID,
        ),
      );
      expect(scheduled).toHaveLength(1);

      await t.mutation(internal.cloud_apps.appendEventInternal, {
        tokenHash: await sha256Hex(TOKEN_A),
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        turnId: TURN_ID,
        attemptGeneration: 1,
        sessionId: "session:cloud-turn-authority",
        seq: 0,
        autoSeq: true,
        kind: "completed",
        payloadJson: '{"finalText":"real terminal"}',
        terminal: true,
        now: Date.now(),
      });
      await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
        tokenHash: await sha256Hex(TOKEN_A),
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        threadId: THREAD_ID,
        attemptGeneration: 1,
        callerTurnId: TURN_ID,
        completingTurnId: TURN_ID,
        status: "completed",
        resultJson: '{"finalText":"real terminal"}',
        wake: false,
        now: Date.now(),
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (priorUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = priorUrl;
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
      if (priorSite === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = priorSite;
    }
  });

  it("keeps a chat dispatch retry durable when its admission response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:30:00Z"));
    const t = await seedActiveTurn();
    const chatTurnId = "turn:chat-lost-admission-response";
    const chatSessionId = "chat:lost-admission-response";
    const chatToken = "chat-lost-admission-token";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId: "conversation:chat-lost-admission-response",
        ownerId: OWNER_ID,
        title: "Lost admission response",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("agent_turns", {
        turnId: chatTurnId,
        sessionId: chatSessionId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        conversationId: "conversation:chat-lost-admission-response",
        prompt: "Do not lose this chat admission",
        status: "running",
        kind: "chat",
        lane: "chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const priorUrl = process.env.CLOUD_BUILDER_URL;
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    const priorSite = process.env.CONVEX_SITE_URL;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    process.env.CONVEX_SITE_URL = "https://convex.example.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("202 response lost"));
    const actionArgs = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      conversationId: "conversation:chat-lost-admission-response",
      turnId: chatTurnId,
      sessionId: chatSessionId,
      prompt: "Do not lose this chat admission",
      turnToken: chatToken,
      execution: {
        engine: "stella" as const,
        provider: "stella" as const,
        model: "stella/standard",
        reasoningEffort: "high" as const,
      },
      convexCallbackBase: "https://convex.example.test",
    };
    try {
      await t.action(internal.cloud_apps.runOrchestratorTurnInternal, actionArgs);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const running = await t.run(async (ctx) =>
        ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", chatTurnId))
          .unique(),
      );
      expect(running?.status).toBe("running");
      const scheduled = await t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (entry) =>
            typeof entry.args[0] === "object" &&
            entry.args[0] !== null &&
            (entry.args[0] as { turnId?: unknown }).turnId === chatTurnId,
        ),
      );
      expect(scheduled).toHaveLength(1);

      await t.mutation(internal.cloud_apps.appendEventInternal, {
        tokenHash: await sha256Hex(chatToken),
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        turnId: chatTurnId,
        sessionId: chatSessionId,
        seq: 0,
        autoSeq: true,
        kind: "completed",
        payloadJson: '{"finalText":"done"}',
        terminal: true,
        now: Date.now(),
      });
      await t.action(internal.cloud_apps.runOrchestratorTurnInternal, {
        ...actionArgs,
        dispatchAttempt: 1,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (priorUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = priorUrl;
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
      if (priorSite === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = priorSite;
    }
  });

  it("atomically fails both turn and thread on a definitive pre-admission rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T13:00:00Z"));
    const t = await seedActiveTurn();
    await t.run(async (ctx) => {
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      await ctx.db.patch(thread!._id, {
        originDeviceId: "device",
        originConversationId: "local-conversation",
      });
    });
    const priorUrl = process.env.CLOUD_BUILDER_URL;
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    const priorSite = process.env.CONVEX_SITE_URL;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    process.env.CONVEX_SITE_URL = "https://convex.example.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rejected", { status: 409 }));
    try {
      await t.action(internal.cloud_apps.runCloudAgentTurnInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        conversationId: "conversation:cloud-turn-authority",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        prompt: "Keep this transcript trustworthy",
        workspace: "cloud",
        turnToken: TOKEN_A,
        attemptGeneration: 1,
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/standard",
          reasoningEffort: "high",
        },
        convexCallbackBase: "https://convex.example.test",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((await agentThread(t))?.status).toBe("failed");
      const snapshot = await t.run(async (ctx) => ({
        turn: await ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
          .unique(),
        events: await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", TURN_ID))
          .collect(),
      }));
      expect(snapshot.turn?.status).toBe("failed");
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0]?.kind).toBe("failed");
      await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (priorUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = priorUrl;
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
      if (priorSite === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = priorSite;
    }
  });

  it.each(["old-generation", "migration"] as const)(
    "rejects thread-message appends after the %s fence",
    async (fence) => {
      const t = await seedActiveTurn();
      await t.run(async (ctx) => {
        if (fence === "old-generation") {
          const lifecycle = await ctx.db
            .query("cloud_owner_lifecycles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
            .unique();
          await ctx.db.patch(lifecycle!._id, {
            generation: "generation-after-reset",
            updatedAt: 50,
          });
          return;
        }
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: "owner:cloud-turn-source",
          toOwnerId: OWNER_ID,
          status: "pending",
          leaseGeneration: 0,
          fromOwnerGeneration: "legacy",
          toOwnerGeneration: OWNER_GENERATION,
          planRevision: 1,
          createdAt: 50,
          updatedAt: 50,
        });
      });

      const response = await t.fetch(
        "/api/cloud/messages",
        messageRequest(TOKEN_A),
      );
      expect(response.status).toBe(401);
      expect(await transcriptRows(t)).toEqual([]);
    },
  );

  it("serializes a concurrent final flush against completion", async () => {
    const t = await seedActiveTurn();
    const tokenHash = await sha256Hex(TOKEN_A);
    const [flush, terminal] = await Promise.allSettled([
      t.mutation(internal.cloud_apps.appendThreadMessagesInternal, {
        tokenHash,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        messages: [
          {
            ordinal: 0,
            role: "assistant",
            payloadJson: '{"role":"assistant","content":"final flush"}',
          },
        ],
        now: 99,
      }),
      terminalize(t),
    ]);
    expect(terminal.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(flush.status);
    expect((await transcriptRows(t)).length).toBeLessThanOrEqual(1);
    await expect(
      t.mutation(internal.cloud_apps.appendThreadMessagesInternal, {
        tokenHash,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        messages: [
          {
            ordinal: 0,
            role: "assistant",
            payloadJson: '{"role":"assistant","content":"late replay"}',
          },
        ],
        now: 101,
      }),
    ).rejects.toThrow("no longer active");
  });

  it.each(["old-generation", "migration"] as const)(
    "invalidates the token on %s before web-search I/O or billing",
    async (fence) => {
      const t = await seedActiveTurn();
      await t.run(async (ctx) => {
        if (fence === "old-generation") {
          const lifecycle = await ctx.db
            .query("cloud_owner_lifecycles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
            .unique();
          await ctx.db.patch(lifecycle!._id, {
            generation: "generation-after-reset",
            updatedAt: 50,
          });
          return;
        }
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: "owner:cloud-turn-source",
          toOwnerId: OWNER_ID,
          status: "pending",
          leaseGeneration: 0,
          fromOwnerGeneration: "legacy",
          toOwnerGeneration: OWNER_GENERATION,
          planRevision: 1,
          createdAt: 50,
          updatedAt: 50,
        });
      });
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("fenced turn must not reach Parallel"));

      const response = await t.fetch(
        "/api/cloud/web-search",
        webSearchRequest(TOKEN_A),
      );
      expect(response.status).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      const snapshot = await billingSnapshot(t);
      expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
      expect(snapshot.logs).toEqual([]);
      expect(snapshot.dispatches).toEqual([]);
    },
  );

  it("rechecks the exact token and running turn inside the billable dispatch marker", async () => {
    const t = await seedActiveTurn();
    const tokenHash = await sha256Hex(TOKEN_A);
    const attempt = {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      executionId: "turn-authority-execution",
      attemptId: "turn-authority-attempt",
      leaseId: "turn-authority-lease",
      billing: {
        kind: PARALLEL_SEARCH_FAST_BILLING_KIND,
        requestFingerprint: "turn-authority-fingerprint",
        chargeMicroCents: PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
      } as const,
      now: 50,
    };
    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      attempt,
    );
    await terminalize(t);
    await expect(
      t.mutation(
        internal.billing.markManagedProviderDispatchMayHaveStartedInternal,
        {
          ...attempt,
          turnAuthority: { tokenHash, turnId: TURN_ID },
          now: 101,
        },
      ),
    ).rejects.toThrow(/no longer active/iu);
    await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      executionId: attempt.executionId,
      attemptId: attempt.attemptId,
      leaseId: attempt.leaseId,
      outcome: "aborted",
      now: 102,
    });

    const snapshot = await billingSnapshot(t);
    expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
    expect(snapshot.usage?.totalUsageMicroCents ?? 0).toBe(0);
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.dispatches[0]?.billing).toMatchObject({
      providerState: "reserved",
      billingState: "not_chargeable",
    });
  });

  it.each(["rotation", "terminal"] as const)(
    "blocks a %s-stale connected-account relay at its last pre-provider marker",
    async (fence) => {
      const t = await seedActiveTurn();
      const tokenHash = await sha256Hex(TOKEN_A);
      if (fence === "rotation") await rotateTurnToken(t);
      else await terminalize(t);
      const provider = vi.fn();

      await expect(
        (async () => {
          await t.mutation(
            internal.cloud_apps.assertActiveTurnTokenDispatchInternal,
            {
              tokenHash,
              ownerId: OWNER_ID,
              ownerGeneration: OWNER_GENERATION,
              turnId: TURN_ID,
              now: Date.now(),
            },
          );
          provider();
        })(),
      ).rejects.toThrow(/no longer active/iu);
      expect(provider).not.toHaveBeenCalled();
      expect((await billingSnapshot(t)).dispatches).toEqual([]);
    },
  );

  it.each(["rotation", "terminal"] as const)(
    "blocks a %s-stale managed relay before provider I/O or billing",
    async (fence) => {
      const t = await seedActiveTurn();
      const tokenHash = await sha256Hex(TOKEN_A);
      const attempt = {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        executionId: `relay-${fence}-execution`,
        attemptId: `relay-${fence}-attempt`,
        leaseId: `relay-${fence}-lease`,
        billing: {
          kind: MANAGED_USAGE_BILLING_KIND,
          requestFingerprint: `relay-${fence}-fingerprint`,
          agentType: "proxy:general",
          model: "stella/anthropic/claude-sonnet-4-6",
          fallbackCostMicroCents: 1_000,
        } as const,
        now: 50,
      };
      await t.mutation(
        internal.billing.acquireManagedProviderDispatchInternal,
        attempt,
      );
      if (fence === "rotation") await rotateTurnToken(t);
      else await terminalize(t);
      const provider = vi.fn();

      await expect(
        (async () => {
          await t.mutation(
            internal.billing.markManagedProviderDispatchMayHaveStartedInternal,
            {
              ...attempt,
              turnAuthority: { tokenHash, turnId: TURN_ID },
              now: Date.now(),
            },
          );
          provider();
        })(),
      ).rejects.toThrow(/no longer active|already closed/iu);
      expect(provider).not.toHaveBeenCalled();
      await t.mutation(
        internal.billing.settleManagedProviderDispatchInternal,
        {
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          executionId: attempt.executionId,
          attemptId: attempt.attemptId,
          leaseId: attempt.leaseId,
          outcome: "aborted",
          now: Date.now(),
        },
      );
      const snapshot = await billingSnapshot(t);
      expect(snapshot.usage?.totalRequestCount ?? 0).toBe(0);
      expect(snapshot.usage?.totalUsageMicroCents ?? 0).toBe(0);
      expect(snapshot.logs).toEqual([]);
      expect(snapshot.dispatches[0]?.billing).toMatchObject({
        providerState: "reserved",
        billingState: "not_chargeable",
      });
    },
  );

  it.each(["rotation", "terminal"] as const)(
    "rejects %s-stale produced-file metadata and records immutable-object cleanup debt",
    async (fence) => {
      const t = await seedActiveTurn();
      const tokenHash = await sha256Hex(TOKEN_A);
      if (fence === "rotation") await rotateTurnToken(t);
      else await terminalize(t);
      const r2Key = `drive/test/${fence}/already-put.txt`;

      const result = await t.mutation(
        internal.cloud_drive.recordDriveFilesInternal,
        {
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          turnAuthority: { tokenHash, turnId: TURN_ID },
          files: [
            {
              path: `reports/${fence}.txt`,
              r2Key,
              name: `${fence}.txt`,
              sizeBytes: 12,
              contentType: "text/plain",
              source: "agent",
            },
            {
              path: `reports/${fence}-workspace.txt`,
              r2Key: `drive/test/${fence}/workspace-only.txt`,
              name: `${fence}-workspace.txt`,
              sizeBytes: 50_000_000,
              contentType: "text/plain",
              source: "workspace",
            },
          ],
          now: Date.now(),
        },
      );
      expect(result.authorityAccepted).toBe(false);
      expect(result.files).toEqual([]);
      const snapshot = await t.run(async (ctx) => ({
        files: await ctx.db
          .query("cloud_drive_files")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
        cleanup: await ctx.db
          .query("cloud_drive_uploads")
          .withIndex("by_ownerId_and_path", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
      }));
      expect(snapshot.files).toEqual([]);
      expect(snapshot.cleanup).toHaveLength(1);
      expect(snapshot.cleanup[0]).toMatchObject({
        r2Key,
        status: "cleanup",
        ownerGeneration: OWNER_GENERATION,
      });
    },
  );

  it("ignores a late T0 completion behind more than ten terminal successors and lets the exact latest turn finish", async () => {
    const t = await seedActiveTurn();
    const latestTurnId = "turn:terminal-successor:11";
    await t.run(async (ctx) => {
      const original = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      await ctx.db.patch(original!._id, {
        status: "completed",
        terminalKind: "completed",
        updatedAt: 2,
      });
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      await ctx.db.patch(thread!._id, {
        attemptGeneration: 12,
        updatedAt: 13,
      });
      for (let index = 1; index <= 11; index += 1) {
        await ctx.db.insert("agent_turns", {
          turnId: `turn:terminal-successor:${index}`,
          sessionId: `session:terminal-successor:${index}`,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptGeneration: index + 1,
          prompt: `Continuation ${index}`,
          status: "completed",
          terminalKind: "completed",
          kind: "agent",
          threadId: THREAD_ID,
          // The first successor intentionally ties T0's application timestamp.
          createdAt: index,
          updatedAt: index + 2,
        });
      }
    });

    await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      threadId: THREAD_ID,
      completingTurnId: TURN_ID,
      status: "failed",
      errorMessage: "late T0 must not win",
      now: 50,
    });
    const afterLateCompletion = await agentThread(t);
    expect(afterLateCompletion?.status).toBe("running");
    expect(afterLateCompletion).not.toHaveProperty("resultJson");
    expect(afterLateCompletion).not.toHaveProperty("errorMessage");

    await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 12,
      threadId: THREAD_ID,
      completingTurnId: latestTurnId,
      status: "completed",
      resultJson: '{"finalText":"latest wins"}',
      wake: false,
      now: 51,
    });
    const afterLatestCompletion = await agentThread(t);
    expect(afterLatestCompletion).toMatchObject({
      status: "completed",
      resultJson: '{"finalText":"latest wins"}',
    });
    expect(afterLatestCompletion).not.toHaveProperty("errorMessage");
  });

  it("uses the index tiebreaker when a successor shares T0's createdAt", async () => {
    const t = await seedActiveTurn();
    const successorTurnId = "turn:equal-created-at-successor";
    await t.run(async (ctx) => {
      const original = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      await ctx.db.patch(original!._id, {
        status: "completed",
        terminalKind: "completed",
        updatedAt: 2,
      });
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      await ctx.db.patch(thread!._id, {
        attemptGeneration: 2,
        updatedAt: 3,
      });
      await ctx.db.insert("agent_turns", {
        turnId: successorTurnId,
        sessionId: "session:equal-created-at-successor",
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 2,
        prompt: "Equal timestamp continuation",
        status: "completed",
        terminalKind: "completed",
        kind: "agent",
        threadId: THREAD_ID,
        createdAt: 1,
        updatedAt: 3,
      });
    });

    await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      threadId: THREAD_ID,
      completingTurnId: TURN_ID,
      status: "failed",
      errorMessage: "equal-time T0 must not win",
      now: 50,
    });
    expect((await agentThread(t))?.status).toBe("running");

    await t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 2,
      threadId: THREAD_ID,
      completingTurnId: successorTurnId,
      status: "completed",
      resultJson: '{"finalText":"equal-time successor wins"}',
      wake: false,
      now: 51,
    });
    expect(await agentThread(t)).toMatchObject({
      status: "completed",
      resultJson: '{"finalText":"equal-time successor wins"}',
    });
  });

  it("rejects a rotation-stale token inside thread completion", async () => {
    const t = await seedActiveTurn();
    const staleTokenHash = await sha256Hex(TOKEN_A);
    await rotateTurnToken(t);

    await expect(
      t.mutation(internal.cloud_apps.completeAgentThreadInternal, {
        tokenHash: staleTokenHash,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 1,
        threadId: THREAD_ID,
        callerTurnId: TURN_ID,
        completingTurnId: TURN_ID,
        status: "completed",
        resultJson: '{"finalText":"stale token"}',
        now: Date.now(),
      }),
    ).rejects.toThrow(/no longer active/iu);
    expect((await agentThread(t))?.status).toBe("running");
  });

  it("admits an active token through the exact marker and bills one provider call", async () => {
    const t = await seedActiveTurn();
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await t.fetch(
      "/api/cloud/web-search",
      webSearchRequest(TOKEN_A),
    );
    expect(response.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    const snapshot = await billingSnapshot(t);
    expect(snapshot.usage?.totalRequestCount).toBe(1);
    expect(snapshot.usage?.totalUsageMicroCents).toBe(
      PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    );
    expect(snapshot.usage?.activeReservedMicroCents ?? 0).toBe(0);
    expect(snapshot.dispatches).toHaveLength(1);
    expect(snapshot.dispatches[0]?.billing).toMatchObject({
      providerState: "may_have_dispatched",
      billingState: "billed",
    });
  });
});
