/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
type TestHarness = ReturnType<typeof createTest>;

const OWNER_ID = "https://issuer.test|voice-generation-owner";

beforeAll(() => {
  const values: Record<string, string> = {
    OPENAI_API_KEY: "test-openai-key",
    XAI_API_KEY: "test-xai-key",
    INWORLD_API_KEY: "test-inworld-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "50",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const asOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "voice-generation-owner",
    tokenIdentifier: OWNER_ID,
  });

const readGeneration = async (t: TestHarness, ownerId = OWNER_ID) =>
  (
    await t.query(internal.owner_lifecycle.getOwnerDataAccessStateInternal, {
      ownerId,
    })
  ).generation;

const reopenOwnerAfterReset = async (
  t: TestHarness,
  ownerId: string,
  nextGeneration: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `reset-${ownerId}`,
      mode: "reset",
      now: 10_000,
    },
  );
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: "voice-core-lease",
    now: 10_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    nextStage: "cloud",
    leaseId: "voice-core-lease",
    now: 10_002,
  });
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: "voice-cloud-lease",
    now: 10_003,
  });
  expect(
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: "voice-cloud-lease",
      nextGeneration,
      now: 10_004,
    }),
  ).toBe(true);
};

const beginVoiceResetCore = async (
  t: TestHarness,
  args: { operationId: string; leaseId: string; now: number },
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId: OWNER_ID,
      operationId: args.operationId,
      mode: "reset",
      now: args.now,
    },
  );
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId: OWNER_ID,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: args.leaseId,
    now: args.now,
  });
  return purge;
};

const prepareVoiceLease = async (
  t: TestHarness,
  args: {
    ownerId?: string;
    ownerGeneration: string;
    provider: "openai" | "xai" | "inworld";
    stellaSessionId: string;
  },
) =>
  await t.mutation(internal.billing.prepareVoiceRealtimeLease, {
    ownerId: args.ownerId ?? OWNER_ID,
    ownerGeneration: args.ownerGeneration,
    provider: args.provider,
    model: `${args.provider}-test-model`,
    voice: "test-voice",
    stellaSessionId: args.stellaSessionId,
    ...(args.provider === "openai"
      ? {
          providerSessionConfigJson: JSON.stringify({
            type: "realtime",
            model: "openai-test-model",
          }),
        }
      : {}),
  });

type VoiceDispatchKind =
  | "xai_client_secret"
  | "openai_client_secret"
  | "openai_call"
  | "inworld_ice_servers"
  | "inworld_sdp";

const reserveVoiceAttempt = async (
  t: TestHarness,
  args: {
    ownerId?: string;
    ownerGeneration: string;
    stellaSessionId: string;
    kind: VoiceDispatchKind;
    attemptId?: string;
    now?: number;
  },
) => {
  const dispatchId = `voice:${args.kind}:${args.stellaSessionId}`;
  const attemptId = args.attemptId ?? `attempt:${args.stellaSessionId}`;
  const result = await t.mutation(
    internal.voice_dispatch.reserveVoiceProviderDispatchInternal,
    {
      ownerId: args.ownerId ?? OWNER_ID,
      ownerGeneration: args.ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      dispatchId,
      attemptId,
      kind: args.kind,
      now: args.now ?? Date.now(),
    },
  );
  return { ...result, dispatchId, attemptId };
};

const activatePreparedVoiceLease = async (
  t: TestHarness,
  args: {
    ownerId?: string;
    ownerGeneration: string;
    stellaSessionId: string;
    kind: Exclude<VoiceDispatchKind, "inworld_sdp">;
  },
) => {
  const attempt = await reserveVoiceAttempt(t, args);
  expect(attempt).toMatchObject({ acquired: true, status: "reserved" });
  const activation = await t.mutation(
    internal.billing.activateVoiceRealtimeLease,
    {
      ownerId: args.ownerId ?? OWNER_ID,
      ownerGeneration: args.ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      dispatchId: attempt.dispatchId,
      attemptId: attempt.attemptId,
    },
  );
  if (!activation.activated) throw new Error("voice activation failed");
  return { ...attempt, activation };
};

const usageArgs = (
  ownerGeneration: string,
  stellaSessionId: string,
  attempt: {
    dispatchId: string;
    attemptId: string;
    activation: { authorityLeaseId: string; authorityEpoch: number };
  },
) => ({
  ownerId: OWNER_ID,
  ownerGeneration,
  providerDispatchId: attempt.dispatchId,
  providerAttemptId: attempt.attemptId,
  authorityLeaseId: attempt.activation.authorityLeaseId,
  authorityEpoch: attempt.activation.authorityEpoch,
  responseId: `response-${stellaSessionId}`,
  model: "gpt-realtime-test",
  stellaSessionId,
  inputTokens: 3,
  outputTokens: 5,
  totalTokens: 8,
  textInputTokens: 3,
  textCachedInputTokens: 0,
  textOutputTokens: 5,
  audioInputTokens: 0,
  audioCachedInputTokens: 0,
  audioOutputTokens: 0,
  imageInputTokens: 0,
  imageCachedInputTokens: 0,
});

describe("realtime voice owner-generation fencing", () => {
  it("rejects every delayed pre-reset writer after reopen and accepts only the rotated generation", async () => {
    const t = createTest();
    const staleGeneration = await readGeneration(t);
    const staleSessionId = "voice-before-reset";
    const admitted = await prepareVoiceLease(t, {
      ownerGeneration: staleGeneration,
      provider: "openai",
      stellaSessionId: staleSessionId,
    });
    expect(admitted).toMatchObject({
      allowed: true,
      ownerGeneration: staleGeneration,
    });
    expect(
      await t.mutation(
        internal.billing.assertVoiceRealtimeProviderDispatchAllowed,
        {
          ownerId: OWNER_ID,
          ownerGeneration: staleGeneration,
          stellaSessionId: staleSessionId,
          provider: "openai",
          phase: "minting",
        },
      ),
    ).toBe(true);
    const staleAttempt = await reserveVoiceAttempt(t, {
      ownerGeneration: staleGeneration,
      stellaSessionId: staleSessionId,
      kind: "openai_client_secret",
    });
    expect(staleAttempt.acquired).toBe(true);
    const staleActivation = await t.mutation(
      internal.billing.activateVoiceRealtimeLease,
      {
        ownerId: OWNER_ID,
        ownerGeneration: staleGeneration,
        stellaSessionId: staleSessionId,
        dispatchId: staleAttempt.dispatchId,
        attemptId: staleAttempt.attemptId,
      },
    );
    if (!staleActivation.activated) throw new Error("voice activation failed");
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration: staleGeneration,
        dispatchId: staleAttempt.dispatchId,
        attemptId: staleAttempt.attemptId,
      },
    );

    const nextGeneration = "voice-generation-after-reset";
    await reopenOwnerAfterReset(t, OWNER_ID, nextGeneration);

    const staleWriters = [
      () =>
        t.mutation(
          internal.billing.assertVoiceRealtimeProviderDispatchAllowed,
          {
            ownerId: OWNER_ID,
            ownerGeneration: staleGeneration,
            stellaSessionId: staleSessionId,
            provider: "openai",
            phase: "minting",
          },
        ),
      () =>
        t.mutation(internal.billing.activateVoiceRealtimeLease, {
          ownerId: OWNER_ID,
          ownerGeneration: staleGeneration,
          stellaSessionId: staleSessionId,
          dispatchId: staleAttempt.dispatchId,
          attemptId: staleAttempt.attemptId,
        }),
      () =>
        t.mutation(internal.billing.failVoiceRealtimeLease, {
          ownerId: OWNER_ID,
          ownerGeneration: staleGeneration,
          stellaSessionId: staleSessionId,
          dispatchId: staleAttempt.dispatchId,
          attemptId: staleAttempt.attemptId,
          reason: "late-provider-failure",
        }),
    ];
    for (const write of staleWriters) {
      await expect(write()).rejects.toThrow(
        /started before the account data was reset/u,
      );
    }
    const staleMetering = usageArgs(staleGeneration, staleSessionId, {
      ...staleAttempt,
      activation: staleActivation,
    });
    // Exact provider usage remains receipt-authorized while reset is waiting
    // for this physical session's authority to close.
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, staleMetering),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
        ownerId: OWNER_ID,
        ownerGeneration: staleGeneration,
        stellaSessionId: staleSessionId,
        authorityLeaseId: staleActivation.authorityLeaseId,
        authorityEpoch: staleActivation.authorityEpoch,
        event: "heartbeat",
      }),
    ).resolves.toMatchObject({
      recorded: false,
      directive: "cancel",
      authorityEpoch: staleActivation.authorityEpoch + 1,
    });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
        ownerId: OWNER_ID,
        ownerGeneration: staleGeneration,
        stellaSessionId: staleSessionId,
        authorityLeaseId: staleActivation.authorityLeaseId,
        authorityEpoch: staleActivation.authorityEpoch + 1,
        event: "cancel_ack",
        usageDisposition: "drained",
        transportClosedAt: Date.now(),
      }),
    ).resolves.toMatchObject({ recorded: true, directive: "closed" });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...staleMetering,
        responseId: `${staleMetering.responseId}-after-close`,
      }),
    ).rejects.toThrow(/authority is closed/u);

    const newSessionId = "voice-after-reset";
    await expect(
      prepareVoiceLease(t, {
        ownerGeneration: nextGeneration,
        provider: "openai",
        stellaSessionId: newSessionId,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      ownerGeneration: nextGeneration,
    });
    const newAttempt = await activatePreparedVoiceLease(t, {
      ownerGeneration: nextGeneration,
      stellaSessionId: newSessionId,
      kind: "openai_client_secret",
    });
    expect(newAttempt.activation).toMatchObject({ activated: true });
    await expect(
      t.mutation(
        internal.billing.recordVoiceRealtimeUsage,
        usageArgs(nextGeneration, newSessionId, newAttempt),
      ),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });

    const state = await t.run(async (ctx) => ({
      staleReceipts: await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_responseId", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("responseId", `response-${staleSessionId}`),
        )
        .take(1),
      newReceipt: await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_responseId", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("responseId", `response-${newSessionId}`),
        )
        .unique(),
    }));
    expect(state.staleReceipts).toHaveLength(1);
    expect(state.newReceipt).toMatchObject({
      ownerGeneration: nextGeneration,
      providerDispatchId: newAttempt.dispatchId,
      providerAttemptId: newAttempt.attemptId,
    });
  });

  it("binds activation and delayed terminal-session metering to one immutable exact attempt", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-exact-attempt";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    expect(attempt.acquired).toBe(true);

    await expect(
      t.mutation(internal.billing.activateVoiceRealtimeLease, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        dispatchId: attempt.dispatchId,
        attemptId: "different-attempt",
      }),
    ).resolves.toEqual({ activated: false });
    await expect(
      t.mutation(internal.billing.failVoiceRealtimeLease, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        dispatchId: attempt.dispatchId,
        attemptId: "different-attempt",
        reason: "wrong-attempt",
      }),
    ).resolves.toEqual({ updated: false });

    const activation = await t.mutation(
      internal.billing.activateVoiceRealtimeLease,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      },
    );
    if (!activation.activated) throw new Error("voice activation failed");
    await expect(
      t.mutation(internal.voice_dispatch.settleVoiceProviderDispatchInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      }),
    ).resolves.toBe(true);
    const args = usageArgs(ownerGeneration, stellaSessionId, {
      ...attempt,
      activation,
    });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...args,
        providerAttemptId: "different-attempt",
      }),
    ).rejects.toThrow(/authority is closed/u);
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, args),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });
    await t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      authorityLeaseId: activation.authorityLeaseId,
      authorityEpoch: activation.authorityEpoch,
      event: "ended",
      usageDisposition: "drained",
      transportClosedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, args),
    ).resolves.toMatchObject({ recorded: false, duplicate: true });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...args,
        inputTokens: args.inputTokens + 1,
      }),
    ).rejects.toThrow(/different usage receipt/u);
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...args,
        responseId: `${args.responseId}-after-close`,
      }),
    ).rejects.toThrow(/authority is closed/u);

    const receipt = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_voice_usage_receipts")
          .withIndex("by_ownerId_and_responseId", (q) =>
            q
              .eq("ownerId", OWNER_ID)
              .eq("responseId", `response-${stellaSessionId}`),
          )
          .unique(),
    );
    expect(receipt).toMatchObject({
      ownerGeneration,
      providerDispatchId: attempt.dispatchId,
      providerAttemptId: attempt.attemptId,
    });
  });

  it("keeps ambiguous attempts as durable debt and serializes retries until quiescence", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-ambiguous-attempt";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const now = Date.now();
    const first = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
      attemptId: "attempt-one",
      now,
    });
    expect(first).toMatchObject({ acquired: true, status: "reserved" });
    expect(first.providerDeadlineAt).toBeLessThan(first.leaseExpiresAt);
    expect(first.leaseExpiresAt).toBeLessThan(first.quiescentAfterAt);

    await expect(
      t.mutation(internal.voice_dispatch.abandonVoiceProviderDispatchInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: first.dispatchId,
        attemptId: first.attemptId,
        now: now + 1,
      }),
    ).resolves.toBe(true);
    const blockedRetry = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
      attemptId: "attempt-two",
      now: now + 2,
    });
    expect(blockedRetry).toMatchObject({
      acquired: false,
      status: "canceled",
    });
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toContain("voice_provider_dispatch_debt");

    const retry = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
      attemptId: "attempt-three",
      now: first.quiescentAfterAt,
    });
    expect(retry).toMatchObject({ acquired: true, status: "reserved" });
    expect(retry.attemptId).not.toBe(first.attemptId);
  });

  it.each(["xai", "inworld"] as const)(
    "fails managed %s closed before reservation or provider I/O",
    async (provider) => {
      const t = createTest();
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);
      const response = await asOwner(t).fetch("/api/voice/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "Unsupported managed provider.",
          voiceProvider: provider,
        }),
      });
      expect(response.status).toBe(503);
      expect(providerFetch).not.toHaveBeenCalled();
      const state = await t.run(async (ctx) => ({
        sessions: await ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .collect(),
        usage: await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
          .unique(),
      }));
      expect(state.sessions).toEqual([]);
      expect(state.usage?.activeReservedMicroCents ?? 0).toBe(0);
    },
  );

  it("issues managed OpenAI authority without provider I/O or a provider secret", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const response = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Server-created OpenAI call." }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      voiceProvider: "openai",
      clientSecret: "stella-server-created-call",
      providerDispatchId: expect.stringContaining("voice:openai_call:"),
      providerAttemptId: expect.any(String),
      authorityLeaseId: expect.any(String),
      authorityEpoch: 1,
      authorityExpiresAt: expect.any(Number),
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("creates the OpenAI call with SDP plus session and durably binds Location before returning the answer", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const session = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: "Use the server-created call boundary.",
        model: "gpt-realtime-test",
        voice: "marin",
      }),
    });
    expect(session.status).toBe(200);
    const token = (await session.json()) as {
      stellaSessionId: string;
      ownerGeneration: string;
      providerDispatchId: string;
      providerAttemptId: string;
    };
    const sdpOffer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.openai.com/v1/realtime/calls");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-openai-key",
          "X-Client-Request-Id": token.providerAttemptId,
        });
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("sdp")).toBe(sdpOffer);
        expect(JSON.parse(String(form.get("session")))).toMatchObject({
          type: "realtime",
          model: "gpt-realtime-test",
          instructions: "Use the server-created call boundary.",
          audio: { output: { voice: "marin" } },
        });
        return new Response("v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n", {
          status: 201,
          headers: {
            "content-type": "application/sdp",
            location: "/v1/realtime/calls/call_durable_location",
          },
        });
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const answer = await asOwner(t).fetch("/api/voice/openai/sdp", {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        "x-stella-voice-session-id": token.stellaSessionId,
        "x-stella-owner-generation": token.ownerGeneration,
        "x-stella-provider-dispatch-id": token.providerDispatchId,
        "x-stella-provider-attempt-id": token.providerAttemptId,
      },
      body: sdpOffer,
    });
    expect(answer.status).toBe(200);
    await expect(answer.text()).resolves.toContain("o=- 2 2");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const bound = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
    );
    expect(bound).toMatchObject({
      providerCallId: "call_durable_location",
      providerHangupState: "open",
      usageDisposition: "pending",
      usageReservationState: "active",
    });
  });

  it("releases the exact reservation when OpenAI proves the call was not created", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const session = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Known non-create." }),
    });
    const token = (await session.json()) as {
      stellaSessionId: string;
      ownerGeneration: string;
      providerDispatchId: string;
      providerAttemptId: string;
    };
    const providerFetch = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error("diagnostic body lost"));
        },
      });
      return new Response(body, { status: 429 });
    });
    vi.stubGlobal("fetch", providerFetch);
    const headers = {
      "content-type": "application/sdp",
      "x-stella-voice-session-id": token.stellaSessionId,
      "x-stella-owner-generation": token.ownerGeneration,
      "x-stella-provider-dispatch-id": token.providerDispatchId,
      "x-stella-provider-attempt-id": token.providerAttemptId,
    };
    const first = await asOwner(t).fetch("/api/voice/openai/sdp", {
      method: "POST",
      headers,
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    });
    expect(first.status).toBe(429);
    const second = await asOwner(t).fetch("/api/voice/openai/sdp", {
      method: "POST",
      headers,
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    });
    expect(second.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const state = await t.run(async (ctx) => ({
      session: await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    }));
    expect(state.session).toMatchObject({
      status: "failed",
      usageDisposition: "exact",
      usageReservationState: "released",
    });
    expect(state.usage?.activeReservedMicroCents ?? 0).toBe(0);
  });

  it("never repeats an ambiguous OpenAI create after dispatch quiescence", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const session = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "One physical call attempt." }),
    });
    const token = (await session.json()) as {
      stellaSessionId: string;
      ownerGeneration: string;
      providerDispatchId: string;
      providerAttemptId: string;
    };
    const providerFetch = vi.fn(async () => {
      throw new TypeError("response lost");
    });
    vi.stubGlobal("fetch", providerFetch);
    const request = {
      method: "POST" as const,
      headers: {
        "content-type": "application/sdp",
        "x-stella-voice-session-id": token.stellaSessionId,
        "x-stella-owner-generation": token.ownerGeneration,
        "x-stella-provider-dispatch-id": token.providerDispatchId,
        "x-stella-provider-attempt-id": token.providerAttemptId,
      },
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    };
    expect(
      (await asOwner(t).fetch("/api/voice/openai/sdp", request)).status,
    ).toBe(502);
    // Simulate the exact dispatch debt's scheduled quiescence cleanup. The
    // durable session-level may-have-created marker must still forbid replay.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("voice_provider_dispatch_leases")
        .withIndex("by_ownerId_and_stellaSessionId_and_createdAt", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("stellaSessionId", token.stellaSessionId),
        )
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    expect(
      (await asOwner(t).fetch("/api/voice/openai/sdp", request)).status,
    ).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      providerCallCreateStartedAt: expect.any(Number),
      usageReservationState: "active",
    });
  });

  it("rejects a non-OpenAI Location locator and keeps the physical create ambiguous", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const session = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Reject foreign call locators." }),
    });
    const token = (await session.json()) as {
      stellaSessionId: string;
      ownerGeneration: string;
      providerDispatchId: string;
      providerAttemptId: string;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n", {
            status: 201,
            headers: {
              location:
                "https://example.invalid/v1/realtime/calls/call_foreign",
            },
          }),
      ),
    );
    const response = await asOwner(t).fetch("/api/voice/openai/sdp", {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        "x-stella-voice-session-id": token.stellaSessionId,
        "x-stella-owner-generation": token.ownerGeneration,
        "x-stella-provider-dispatch-id": token.providerDispatchId,
        "x-stella-provider-attempt-id": token.providerAttemptId,
      },
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    });
    expect(response.status).toBe(502);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      providerCallCreateStartedAt: expect.any(Number),
      usageReservationState: "active",
    });
    expect(row?.providerCallId).toBeUndefined();
  });

  it("does not trust a lying renderer to release a live OpenAI call", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-lying-renderer";
    const prepared = await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    expect(prepared).toMatchObject({ allowed: true });
    const providerDispatchId = `voice:openai_call:${stellaSessionId}`;
    const providerAttemptId = "lying-renderer-attempt";
    const authority = await t.mutation(
      internal.billing.issueOpenAiVoiceRealtimeAuthority,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      },
    );
    if (!authority.activated) throw new Error("authority issuance failed");
    const dispatch = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_call",
      attemptId: providerAttemptId,
    });
    expect(dispatch.acquired).toBe(true);
    expect(
      await t.mutation(internal.billing.markOpenAiVoiceProviderCallStarted, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      }),
    ).toBe(true);
    const startedState = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(
      (startedState?.providerHardExpiresAt ?? 0) -
        (startedState?.providerCallCreateStartedAt ?? 0),
    ).toBe(60 * 60 * 1_000);
    expect(
      await t.mutation(internal.billing.bindOpenAiVoiceProviderCall, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
        providerCallId: "call-lying-renderer",
      }),
    ).toEqual({ bound: true, deliveryAllowed: true });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: providerDispatchId,
        attemptId: providerAttemptId,
      },
    );
    await t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      authorityLeaseId: authority.authorityLeaseId,
      authorityEpoch: authority.authorityEpoch,
      event: "ended",
      usageDisposition: "drained",
      transportClosedAt: Date.now(),
    });
    const pending = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(pending).toMatchObject({
      usageDisposition: "revocation_pending",
      usageReservationState: "active",
      providerHangupState: "requested",
    });
    const hangupFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", hangupFetch);
    const hangupArgs = {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerCallId: "call-lying-renderer",
    };
    await t.action(internal.billing.hangupOpenAiVoiceCallInternal, hangupArgs);
    await t.action(internal.billing.hangupOpenAiVoiceCallInternal, hangupArgs);
    expect(hangupFetch).toHaveBeenCalledTimes(1);
    const settled = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(settled).toMatchObject({
      providerHangupState: "confirmed",
      usageDisposition: "conservative_fallback",
      usageReservationState: "released",
    });
  });

  it("serializes concurrent hangup actions and recovers an abandoned attempt after its lease", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-hangup-serialization";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const providerDispatchId = `voice:openai_call:${stellaSessionId}`;
    const providerAttemptId = "hangup-serialization-create";
    const authority = await t.mutation(
      internal.billing.issueOpenAiVoiceRealtimeAuthority,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      },
    );
    if (!authority.activated) throw new Error("authority issuance failed");
    await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_call",
      attemptId: providerAttemptId,
    });
    expect(
      await t.mutation(internal.billing.markOpenAiVoiceProviderCallStarted, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.billing.bindOpenAiVoiceProviderCall, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
        providerCallId: "call_hangup_serialized",
      }),
    ).toEqual({ bound: true, deliveryAllowed: true });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: providerDispatchId,
        attemptId: providerAttemptId,
      },
    );
    await t.mutation(internal.billing.requestOpenAiVoiceHangupInternal, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerCallId: "call_hangup_serialized",
      reason: "test_concurrent_hangup",
    });

    const abandonedAt = Date.now();
    await expect(
      t.mutation(internal.billing.acquireOpenAiVoiceHangupCommandInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerCallId: "call_hangup_serialized",
        attemptId: "abandoned-hangup",
        now: abandonedAt,
      }),
    ).resolves.toEqual({ providerCallId: "call_hangup_serialized" });
    await expect(
      t.mutation(internal.billing.acquireOpenAiVoiceHangupCommandInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerCallId: "call_hangup_serialized",
        attemptId: "too-early-hangup",
        now: abandonedAt + 19_999,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.billing.acquireOpenAiVoiceHangupCommandInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerCallId: "call_hangup_serialized",
        attemptId: "recovered-hangup",
        now: abandonedAt + 20_000,
      }),
    ).resolves.toEqual({ providerCallId: "call_hangup_serialized" });
    // Clear the synthetic recovery acquisition with an ambiguous receipt so
    // the actual action pair below competes through the normal lock path.
    await t.mutation(internal.billing.recordOpenAiVoiceHangupAttemptInternal, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerCallId: "call_hangup_serialized",
      attemptId: "recovered-hangup",
      terminal: false,
      error: "synthetic recovery",
      now: abandonedAt + 20_001,
    });

    let providerStarted!: () => void;
    let resolveProvider!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerResponse = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    const hangupFetch = vi.fn(async () => {
      providerStarted();
      return await providerResponse;
    });
    vi.stubGlobal("fetch", hangupFetch);
    const hangupArgs = {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerCallId: "call_hangup_serialized",
    };
    const first = t.action(
      internal.billing.hangupOpenAiVoiceCallInternal,
      hangupArgs,
    );
    await started;
    await t.action(internal.billing.hangupOpenAiVoiceCallInternal, hangupArgs);
    expect(hangupFetch).toHaveBeenCalledTimes(1);
    resolveProvider(new Response(null, { status: 204 }));
    await first;
    const settled = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(settled).toMatchObject({
      providerHangupState: "confirmed",
      usageReservationState: "released",
    });
    expect(settled?.providerHangupActiveAttemptId).toBeUndefined();
    expect(settled?.providerHangupLeaseExpiresAt).toBeUndefined();
  });

  it("reaps prepare crashes and ignores the stale mint wake after activation", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const crashedSessionId = "voice-prepare-crash";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: crashedSessionId,
    });
    const crashed = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", crashedSessionId),
        )
        .unique();
      if (!row) throw new Error("missing crashed session");
      await ctx.db.patch(row._id, { sessionReapAt: 1 });
      return row;
    });
    expect(
      await t.mutation(internal.billing.reapVoiceRealtimeSessionInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: crashedSessionId,
        reapAt: 1,
      }),
    ).toBe(true);
    const released = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", crashedSessionId),
        )
        .unique(),
    );
    expect(released).toMatchObject({
      usageDisposition: "exact",
      usageReservationState: "released",
    });

    const liveSessionId = "voice-stale-mint-wake";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: liveSessionId,
    });
    const mintReapAt = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", liveSessionId),
        )
        .unique();
      return row?.sessionReapAt ?? 0;
    });
    const authority = await t.mutation(
      internal.billing.issueOpenAiVoiceRealtimeAuthority,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: liveSessionId,
        providerDispatchId: `voice:openai_call:${liveSessionId}`,
        providerAttemptId: "live-attempt",
      },
    );
    expect(authority).toMatchObject({ activated: true });
    expect(
      await t.mutation(internal.billing.reapVoiceRealtimeSessionInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: liveSessionId,
        reapAt: mintReapAt,
      }),
    ).toBe(false);
    const live = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", liveSessionId),
        )
        .unique(),
    );
    expect(live).toMatchObject({
      status: "active",
      usageDisposition: "pending",
      usageReservationState: "active",
    });
    expect(crashed.sessionReapAt).not.toBe(live?.sessionReapAt);
  });

  it("reaps a pre-create provider reservation but conservatively settles a lost create response", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const makeActiveAttempt = async (stellaSessionId: string) => {
      await prepareVoiceLease(t, {
        ownerGeneration,
        provider: "openai",
        stellaSessionId,
      });
      const providerDispatchId = `voice:openai_call:${stellaSessionId}`;
      const providerAttemptId = `attempt:${stellaSessionId}`;
      const authority = await t.mutation(
        internal.billing.issueOpenAiVoiceRealtimeAuthority,
        {
          ownerId: OWNER_ID,
          ownerGeneration,
          stellaSessionId,
          providerDispatchId,
          providerAttemptId,
        },
      );
      expect(authority).toMatchObject({ activated: true });
      await reserveVoiceAttempt(t, {
        ownerGeneration,
        stellaSessionId,
        kind: "openai_call",
        attemptId: providerAttemptId,
      });
      return { providerDispatchId, providerAttemptId };
    };

    const reservedSessionId = "voice-provider-reserved-crash";
    const reserved = await makeActiveAttempt(reservedSessionId);
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: reserved.providerDispatchId,
        attemptId: reserved.providerAttemptId,
      },
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", reservedSessionId),
        )
        .unique();
      if (row) await ctx.db.patch(row._id, { sessionReapAt: 1 });
    });
    expect(
      await t.mutation(internal.billing.reapVoiceRealtimeSessionInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: reservedSessionId,
        reapAt: 1,
      }),
    ).toBe(true);
    const reservedFinal = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", reservedSessionId),
        )
        .unique(),
    );
    expect(reservedFinal).toMatchObject({
      usageDisposition: "exact",
      usageReservationState: "released",
    });

    const lostSessionId = "voice-create-response-lost";
    const lost = await makeActiveAttempt(lostSessionId);
    expect(
      await t.mutation(internal.billing.markOpenAiVoiceProviderCallStarted, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: lostSessionId,
        providerDispatchId: lost.providerDispatchId,
        providerAttemptId: lost.providerAttemptId,
      }),
    ).toBe(true);
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: lost.providerDispatchId,
        attemptId: lost.providerAttemptId,
      },
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", lostSessionId),
        )
        .unique();
      if (row) {
        await ctx.db.patch(row._id, {
          providerHardExpiresAt: 1,
          sessionReapAt: 1,
        });
      }
    });
    expect(
      await t.mutation(internal.billing.reapVoiceRealtimeSessionInternal, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId: lostSessionId,
        reapAt: 1,
      }),
    ).toBe(true);
    const lostFinal = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", lostSessionId),
        )
        .unique(),
    );
    expect(lostFinal).toMatchObject({
      usageDisposition: "conservative_fallback",
      usageReservationState: "released",
      providerHangupState: "confirmed",
    });
  });

  it("fails closed on wrong authority tuples at the HTTP route without disclosing or adopting the live tuple", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-authority-invalid-wire";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await activatePreparedVoiceLease(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      },
    );

    for (const tuple of [
      {
        authorityLeaseId: "wrong-authority-lease",
        authorityEpoch: attempt.activation.authorityEpoch,
      },
      {
        authorityLeaseId: attempt.activation.authorityLeaseId,
        authorityEpoch: attempt.activation.authorityEpoch + 7,
      },
    ]) {
      const response = await asOwner(t).fetch("/api/voice/lease", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stellaSessionId,
          event: "heartbeat",
          ...tuple,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        recorded: false,
        directive: "invalid",
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      });
    }

    const unchanged = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_stellaSessionId", (q) =>
            q.eq("stellaSessionId", stellaSessionId),
          )
          .unique(),
    );
    expect(unchanged).toMatchObject({
      authorityLeaseId: attempt.activation.authorityLeaseId,
      authorityEpoch: attempt.activation.authorityEpoch,
      authorityExpiresAt: attempt.activation.authorityExpiresAt,
      authorityState: "active",
      heartbeatCount: 0,
    });

    const renewedResponse = await asOwner(t).fetch("/api/voice/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stellaSessionId,
        event: "heartbeat",
        authorityLeaseId: attempt.activation.authorityLeaseId,
        authorityEpoch: attempt.activation.authorityEpoch,
      }),
    });
    expect(renewedResponse.status).toBe(200);
    const renewed = (await renewedResponse.json()) as {
      recorded: boolean;
      directive: string;
      authorityEpoch: number;
      authorityExpiresAt: number;
    };
    expect(renewed).toMatchObject({
      recorded: true,
      directive: "continue",
      authorityEpoch: attempt.activation.authorityEpoch,
    });
    expect(renewed.authorityExpiresAt).toBeGreaterThanOrEqual(
      attempt.activation.authorityExpiresAt,
    );
  });

  it("cancels a connected renderer immediately and accepts only the exact new-epoch acknowledgement", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-authority-connected-cancel";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await activatePreparedVoiceLease(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      },
    );

    const cancelAt = Date.now();
    const purge = await beginVoiceResetCore(t, {
      operationId: "voice-authority-connected-operation",
      leaseId: "voice-authority-connected-lease",
      now: cancelAt,
    });
    const requested = await t.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "voice-authority-connected-lease",
        mode: "reset",
        now: cancelAt,
      },
    );
    expect(requested).toMatchObject({
      ready: false,
      canceled: 1,
      pending: expect.arrayContaining([
        `authority_cancel_requested:${stellaSessionId}`,
        `usage_reserved:${stellaSessionId}`,
      ]),
    });
    const cancelEpoch = attempt.activation.authorityEpoch + 1;

    for (const event of ["heartbeat", "cancel_ack"] as const) {
      await expect(
        t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
          ownerId: OWNER_ID,
          ownerGeneration,
          stellaSessionId,
          authorityLeaseId: attempt.activation.authorityLeaseId,
          authorityEpoch: attempt.activation.authorityEpoch,
          event,
        }),
      ).resolves.toMatchObject({
        recorded: false,
        directive: "cancel",
        authorityEpoch: cancelEpoch,
        authorityExpiresAt: attempt.activation.authorityExpiresAt,
      });
    }
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        authorityLeaseId: attempt.activation.authorityLeaseId,
        authorityEpoch: cancelEpoch + 1,
        event: "heartbeat",
      }),
    ).resolves.toEqual({
      recorded: false,
      directive: "invalid",
      authorityEpoch: null,
      authorityExpiresAt: null,
      cancelReason: null,
    });

    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        authorityLeaseId: attempt.activation.authorityLeaseId,
        authorityEpoch: cancelEpoch,
        event: "cancel_ack",
      }),
    ).resolves.toMatchObject({
      recorded: true,
      directive: "closed",
      authorityEpoch: cancelEpoch,
    });
    await expect(
      t.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: "voice-authority-connected-lease",
          mode: "reset",
          now: cancelAt + 1,
        },
      ),
    ).resolves.toMatchObject({ ready: true, pending: [] });
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual([]);
  });

  it("waits through offline authority expiry plus margin and bounds a legacy restarted client", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-authority-offline";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await activatePreparedVoiceLease(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      },
    );
    const firstNow = Date.now();
    const purge = await beginVoiceResetCore(t, {
      operationId: "voice-authority-offline-operation",
      leaseId: "voice-authority-offline-lease",
      now: firstNow,
    });
    const first = await t.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "voice-authority-offline-lease",
        mode: "reset",
        now: firstNow,
      },
    );
    const quiescentAt = attempt.activation.authorityExpiresAt + 2_000;
    expect(first).toMatchObject({ ready: false });
    expect(first.retryAt).toBeLessThanOrEqual(quiescentAt);
    await expect(
      t.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: "voice-authority-offline-lease",
          mode: "reset",
          now: quiescentAt - 1,
        },
      ),
    ).resolves.toMatchObject({ ready: false });
    await expect(
      t.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: "voice-authority-offline-lease",
          mode: "reset",
          now: quiescentAt,
        },
      ),
    ).resolves.toMatchObject({ ready: true, reaped: 1, pending: [] });

    const expired = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_stellaSessionId", (q) =>
            q.eq("stellaSessionId", stellaSessionId),
          )
          .unique(),
    );
    expect(expired).toMatchObject({
      status: "client_expired",
      authorityState: "expired",
      authorityEpoch: attempt.activation.authorityEpoch + 1,
    });

    const legacy = createTest();
    const legacyGeneration = await readGeneration(legacy);
    const legacyNow = 50_000;
    await legacy.run(async (ctx) => {
      await ctx.db.insert("billing_voice_sessions", {
        ownerId: OWNER_ID,
        ownerGeneration: legacyGeneration,
        providerDispatchId: "voice:openai_client_secret:legacy-restart",
        providerAttemptId: "legacy-attempt",
        stellaSessionId: "legacy-restart",
        provider: "openai",
        model: "gpt-realtime-test",
        voice: "test-voice",
        status: "active",
        leaseStartedAt: legacyNow - 1_000,
        leaseExpiresAt: legacyNow + 300_000,
        heartbeatCount: 1,
        responseCount: 0,
        estimatedCostMicroCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        realtimeAudioSeconds: 0,
        sttAudioSeconds: 0,
        createdAt: legacyNow - 1_000,
        updatedAt: legacyNow - 1_000,
      });
    });
    const legacyPurge = await beginVoiceResetCore(legacy, {
      operationId: "voice-authority-legacy-operation",
      leaseId: "voice-authority-legacy-lease",
      now: legacyNow,
    });
    const legacyFirst = await legacy.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: legacyPurge.operationId,
        generation: legacyPurge.generation,
        leaseId: "voice-authority-legacy-lease",
        mode: "reset",
        now: legacyNow,
      },
    );
    expect(legacyFirst).toMatchObject({
      ready: false,
      canceled: 1,
      retryAt: legacyNow + 12_000,
    });
    await expect(
      legacy.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: legacyPurge.operationId,
          generation: legacyPurge.generation,
          leaseId: "voice-authority-legacy-lease",
          mode: "reset",
          now: legacyNow + 12_000,
        },
      ),
    ).resolves.toMatchObject({ ready: true, reaped: 1 });
  });

  it("accepts exact late receipts only until the terminal authority ACK", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-authority-late-meter";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await activatePreparedVoiceLease(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: attempt.dispatchId,
        attemptId: attempt.attemptId,
      },
    );
    const metering = usageArgs(ownerGeneration, stellaSessionId, attempt);
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, metering),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });

    await beginVoiceResetCore(t, {
      operationId: "voice-authority-late-meter-operation",
      leaseId: "voice-authority-late-meter-lease",
      now: Date.now(),
    });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, metering),
    ).resolves.toMatchObject({ recorded: false, duplicate: true });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...metering,
        responseId: `${metering.responseId}-late-new`,
      }),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });
    const cancel = await t.mutation(
      internal.billing.recordVoiceRealtimeLeaseEvent,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        authorityLeaseId: attempt.activation.authorityLeaseId,
        authorityEpoch: attempt.activation.authorityEpoch,
        event: "heartbeat",
      },
    );
    expect(cancel).toMatchObject({ directive: "cancel" });
    await t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      authorityLeaseId: attempt.activation.authorityLeaseId,
      authorityEpoch: attempt.activation.authorityEpoch + 1,
      event: "cancel_ack",
      usageDisposition: "drained",
      transportClosedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.billing.recordVoiceRealtimeUsage, {
        ...metering,
        responseId: `${metering.responseId}-after-ack`,
      }),
    ).rejects.toThrow(/authority is closed/u);
  });

  it("makes reset wait for provider-confirmed hangup even after an exact renderer cancel acknowledgement", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-reset-bound-openai-call";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const providerDispatchId = `voice:openai_call:${stellaSessionId}`;
    const providerAttemptId = "reset-bound-call-attempt";
    const authority = await t.mutation(
      internal.billing.issueOpenAiVoiceRealtimeAuthority,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      },
    );
    if (!authority.activated) throw new Error("authority issuance failed");
    await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_call",
      attemptId: providerAttemptId,
    });
    await t.mutation(internal.billing.markOpenAiVoiceProviderCallStarted, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerDispatchId,
      providerAttemptId,
    });
    expect(
      await t.mutation(internal.billing.bindOpenAiVoiceProviderCall, {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
        providerCallId: "call_reset_bound",
      }),
    ).toEqual({ bound: true, deliveryAllowed: true });
    await t.mutation(
      internal.voice_dispatch.settleVoiceProviderDispatchInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        dispatchId: providerDispatchId,
        attemptId: providerAttemptId,
      },
    );
    const purge = await beginVoiceResetCore(t, {
      operationId: "voice-reset-bound-operation",
      leaseId: "voice-reset-bound-lease",
      now: Date.now(),
    });
    const canceled = await t.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "voice-reset-bound-lease",
        mode: "reset",
        now: Date.now(),
      },
    );
    expect(canceled.ready).toBe(false);
    expect(canceled.pending).toEqual(
      expect.arrayContaining([
        expect.stringContaining("provider_hangup_requested"),
        expect.stringContaining("authority_cancel_requested"),
        expect.stringContaining("usage_reserved"),
      ]),
    );
    await t.mutation(internal.billing.recordVoiceRealtimeLeaseEvent, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      authorityLeaseId: authority.authorityLeaseId,
      authorityEpoch: authority.authorityEpoch + 1,
      event: "cancel_ack",
      usageDisposition: "drained",
      transportClosedAt: Date.now(),
    });
    const afterAck = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(afterAck).toMatchObject({
      authorityState: "acknowledged",
      usageDisposition: "revocation_pending",
      usageReservationState: "active",
      providerHangupState: "requested",
    });
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        "voice_provider_hangup_pending",
        "voice_usage_reserved",
      ]),
    );

    const hangupFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", hangupFetch);
    await t.action(internal.billing.hangupOpenAiVoiceCallInternal, {
      ownerId: OWNER_ID,
      ownerGeneration,
      stellaSessionId,
      providerCallId: "call_reset_bound",
    });
    expect(hangupFetch).toHaveBeenCalledTimes(1);
    await expect(
      t.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: "voice-reset-bound-lease",
          mode: "reset",
          now: Date.now(),
        },
      ),
    ).resolves.toMatchObject({ ready: true, pending: [] });
  });

  it("makes reset wait for exact voice cancellation debt and clears strict readback only after quiescence", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "voice-reset-quiescence";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const attempt = await reserveVoiceAttempt(t, {
      ownerGeneration,
      stellaSessionId,
      kind: "openai_client_secret",
    });
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: OWNER_ID,
        operationId: "voice-reset-quiescence-operation",
        mode: "reset",
        now: Date.now(),
      },
    );
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId: OWNER_ID,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId: "voice-reset-quiescence-lease",
      now: Date.now(),
    });

    const canceled = await t.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "voice-reset-quiescence-lease",
        mode: "reset",
        now: Date.now(),
      },
    );
    expect(canceled).toMatchObject({ ready: false, canceled: 2 });
    expect(canceled.retryAt).toBeLessThanOrEqual(attempt.quiescentAfterAt);
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual([
      "voice_provider_dispatch_debt",
      "voice_usage_reserved",
    ]);

    const reaped = await t.mutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "voice-reset-quiescence-lease",
        mode: "reset",
        now: attempt.quiescentAfterAt,
      },
    );
    expect(reaped).toMatchObject({ ready: true, reaped: 1, pending: [] });
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual([]);
  });

  it("drains more than twenty prepare-to-provider reservations without leaking the aggregate", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const firstSessionId = "voice-bulk-reservation-0";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: firstSessionId,
    });
    await t.run(async (ctx) => {
      const original = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", firstSessionId),
        )
        .unique();
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      if (!original || !usage) throw new Error("missing reservation fixture");
      const {
        _id: _ignoredId,
        _creationTime: _ignoredTime,
        ...base
      } = original;
      for (let index = 1; index < 25; index += 1) {
        await ctx.db.insert("billing_voice_sessions", {
          ...base,
          stellaSessionId: `voice-bulk-reservation-${index}`,
          createdAt: original.createdAt + index,
          updatedAt: original.updatedAt + index,
        });
      }
      const perSession = Math.max(
        1,
        Math.floor(original.usageReservedMicroCents ?? 0),
      );
      await ctx.db.patch(usage._id, {
        activeReservedMicroCents: perSession * 25,
      });
    });
    const purge = await beginVoiceResetCore(t, {
      operationId: "voice-bulk-reservation-operation",
      leaseId: "voice-bulk-reservation-lease",
      now: Date.now(),
    });
    let result:
      | {
          ready: boolean;
          canceled: number;
          reaped: number;
          pending: string[];
          retryAt: number | null;
        }
      | undefined;
    let passes = 0;
    while (!result?.ready && passes < 5) {
      result = await t.mutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId: "voice-bulk-reservation-lease",
          mode: "reset",
          now: Date.now(),
          limit: 7,
        },
      );
      passes += 1;
    }
    expect(passes).toBe(4);
    expect(result).toMatchObject({ ready: true, pending: [] });
    const state = await t.run(async (ctx) => ({
      reserved: await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_usageReservationState_and_createdAt", (q) =>
          q.eq("ownerId", OWNER_ID).eq("usageReservationState", "active"),
        )
        .take(1),
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    }));
    expect(state.reserved).toEqual([]);
    expect(state.usage?.activeReservedMicroCents ?? 0).toBe(0);
    await expect(
      t.query(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual([]);
  });

  it("quiesces both source and destination voice attempts for one exact owner migration", async () => {
    const t = createTest();
    const fromOwnerId = OWNER_ID;
    const toOwnerId = "https://issuer.test|voice-migration-destination";
    const fromGeneration = await readGeneration(t, fromOwnerId);
    const toGeneration = "voice-destination-generation";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: toOwnerId,
        generation: toGeneration,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await prepareVoiceLease(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fromGeneration,
      provider: "openai",
      stellaSessionId: "voice-migration-source-session",
    });
    await prepareVoiceLease(t, {
      ownerId: toOwnerId,
      ownerGeneration: toGeneration,
      provider: "openai",
      stellaSessionId: "voice-migration-destination-session",
    });
    const sourceAttempt = await reserveVoiceAttempt(t, {
      ownerId: fromOwnerId,
      ownerGeneration: fromGeneration,
      stellaSessionId: "voice-migration-source-session",
      kind: "openai_client_secret",
    });
    const destinationAttempt = await reserveVoiceAttempt(t, {
      ownerId: toOwnerId,
      ownerGeneration: toGeneration,
      stellaSessionId: "voice-migration-destination-session",
      kind: "openai_client_secret",
    });
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId,
          toOwnerId,
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );

    for (const ownerId of [fromOwnerId, toOwnerId]) {
      const firstPass = await t.mutation(
        internal.voice_dispatch
          .cancelOwnerVoiceProviderDispatchesForMigrationInternal,
        { migrationId, ownerId, now: Date.now() },
      );
      expect(firstPass).toMatchObject({ ready: false, canceled: 2 });
    }
    for (const [ownerId, retryAt] of [
      [fromOwnerId, sourceAttempt.quiescentAfterAt],
      [toOwnerId, destinationAttempt.quiescentAfterAt],
    ] as const) {
      const finalPass = await t.mutation(
        internal.voice_dispatch
          .cancelOwnerVoiceProviderDispatchesForMigrationInternal,
        { migrationId, ownerId, now: retryAt },
      );
      expect(finalPass).toMatchObject({ ready: true, pending: [] });
      await expect(
        t.query(
          internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
          { ownerId },
        ),
      ).resolves.toEqual([]);
    }
  });

  it("quiesces renderer authority for both migration owners before moving voice sessions", async () => {
    const t = createTest();
    const fromOwnerId = OWNER_ID;
    const toOwnerId = "https://issuer.test|voice-authority-destination";
    const fromGeneration = await readGeneration(t, fromOwnerId);
    const toGeneration = "voice-authority-destination-generation";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: toOwnerId,
        generation: toGeneration,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const sessions = [
      {
        ownerId: fromOwnerId,
        ownerGeneration: fromGeneration,
        provider: "openai" as const,
        stellaSessionId: "voice-authority-migration-source",
        kind: "openai_client_secret" as const,
      },
      {
        ownerId: toOwnerId,
        ownerGeneration: toGeneration,
        provider: "openai" as const,
        stellaSessionId: "voice-authority-migration-destination",
        kind: "openai_client_secret" as const,
      },
    ];
    const activated = [];
    for (const session of sessions) {
      await prepareVoiceLease(t, session);
      const attempt = await activatePreparedVoiceLease(t, session);
      await t.mutation(
        internal.voice_dispatch.settleVoiceProviderDispatchInternal,
        {
          ownerId: session.ownerId,
          ownerGeneration: session.ownerGeneration,
          dispatchId: attempt.dispatchId,
          attemptId: attempt.attemptId,
        },
      );
      activated.push({ ...session, attempt });
    }
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId,
          toOwnerId,
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );

    for (const session of activated) {
      const first = await t.mutation(
        internal.voice_dispatch
          .cancelOwnerVoiceProviderDispatchesForMigrationInternal,
        { migrationId, ownerId: session.ownerId, now: Date.now() },
      );
      expect(first).toMatchObject({
        ready: false,
        canceled: 1,
      });
      expect(first.retryAt).toBeLessThanOrEqual(
        session.attempt.activation.authorityExpiresAt + 2_000,
      );
      const final = await t.mutation(
        internal.voice_dispatch
          .cancelOwnerVoiceProviderDispatchesForMigrationInternal,
        {
          migrationId,
          ownerId: session.ownerId,
          now: session.attempt.activation.authorityExpiresAt + 2_000,
        },
      );
      expect(final).toMatchObject({ ready: true, reaped: 1, pending: [] });
      await expect(
        t.query(
          internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
          { ownerId: session.ownerId },
        ),
      ).resolves.toEqual([]);
    }
  });

  it("releases an exactly-undispatched prepare before superseding it", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const first = await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: "reserved-openai",
    });
    expect(first).toMatchObject({ allowed: true });
    const replacement = await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: "replacement-openai",
    });
    expect(replacement).toMatchObject({
      allowed: true,
      stellaSessionId: "replacement-openai",
    });
    const state = await t.run(async (ctx) => ({
      oldSession: await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", "reserved-openai"),
        )
        .unique(),
      replacement: await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", "replacement-openai"),
        )
        .unique(),
      usage: await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    }));
    expect(state.oldSession).toMatchObject({
      usageDisposition: "exact",
      usageReservationState: "released",
      usageReservedMicroCents: 0,
    });
    expect(state.replacement).toMatchObject({
      usageDisposition: "pending",
      usageReservationState: "active",
    });
    expect(state.usage?.activeReservedMicroCents).toBe(
      state.replacement?.usageReservedMicroCents,
    );
  });

  it("does not supersede an in-flight physical OpenAI call attempt", async () => {
    const t = createTest();
    const ownerGeneration = await readGeneration(t);
    const stellaSessionId = "in-flight-openai";
    await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId,
    });
    const providerDispatchId = `voice:openai_call:${stellaSessionId}`;
    const providerAttemptId = "in-flight-attempt";
    const authority = await t.mutation(
      internal.billing.issueOpenAiVoiceRealtimeAuthority,
      {
        ownerId: OWNER_ID,
        ownerGeneration,
        stellaSessionId,
        providerDispatchId,
        providerAttemptId,
      },
    );
    expect(authority).toMatchObject({ activated: true });
    expect(
      await reserveVoiceAttempt(t, {
        ownerGeneration,
        stellaSessionId,
        kind: "openai_call",
        attemptId: providerAttemptId,
      }),
    ).toMatchObject({ acquired: true });

    const replacement = await prepareVoiceLease(t, {
      ownerGeneration,
      provider: "openai",
      stellaSessionId: "replacement-after-in-flight",
    });
    expect(replacement).toMatchObject({
      allowed: false,
      blockedSessionId: stellaSessionId,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", stellaSessionId),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      usageDisposition: "unresolved",
      usageReservationState: "active",
    });
  });

  it("captures and hangs up an OpenAI call whose SDP answer loses the lifecycle race", async () => {
    const t = createTest();
    await t.mutation(internal.billing.setAdminBillingPlan, {
      ownerId: OWNER_ID,
      plan: "pro",
    });
    const sessionResponse = await asOwner(t).fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Fence the returned SDP." }),
    });
    expect(sessionResponse.status).toBe(200);
    const token = (await sessionResponse.json()) as {
      stellaSessionId: string;
      ownerGeneration: string;
      providerDispatchId: string;
      providerAttemptId: string;
    };

    let resolveProvider!: (response: Response) => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerResponse = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith("/hangup")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        markProviderStarted();
        return providerResponse;
      }),
    );

    const pendingResponse = asOwner(t).fetch("/api/voice/openai/sdp", {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        "x-stella-voice-session-id": token.stellaSessionId,
        "x-stella-owner-generation": token.ownerGeneration,
        "x-stella-provider-dispatch-id": token.providerDispatchId,
        "x-stella-provider-attempt-id": token.providerAttemptId,
      },
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    });
    await providerStarted;
    await reopenOwnerAfterReset(t, OWNER_ID, "voice-sdp-reopened");
    resolveProvider(
      new Response("v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n", {
        status: 201,
        headers: {
          "content-type": "application/sdp",
          location: "/v1/realtime/calls/call-reset-race",
        },
      }),
    );

    const response = await pendingResponse;
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.not.toContain("o=- 2 2");
    const captured = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
    );
    expect(captured).toMatchObject({
      providerCallId: "call-reset-race",
      usageDisposition: "revocation_pending",
      usageReservationState: "active",
    });
    await t.action(internal.billing.hangupOpenAiVoiceCallInternal, {
      ownerId: OWNER_ID,
      ownerGeneration: token.ownerGeneration,
      stellaSessionId: token.stellaSessionId,
      providerCallId: "call-reset-race",
    });
    const settled = await t.run(async (ctx) =>
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", token.stellaSessionId),
        )
        .unique(),
    );
    expect(settled).toMatchObject({
      providerHangupState: "confirmed",
      usageDisposition: "conservative_fallback",
      usageReservationState: "released",
    });
  });

  it("rebinds terminal voice receipts and sessions to the destination migration generation", async () => {
    const t = createTest();
    const fromOwnerId = "anonymous-voice-owner";
    const toOwnerId = "connected-voice-owner";
    const toOwnerGeneration = "connected-voice-generation";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: toOwnerId,
        generation: toOwnerGeneration,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("billing_voice_usage_receipts", {
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        responseId: "migrated-response",
        model: "gpt-realtime-test",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        textInputTokens: 1,
        textCachedInputTokens: 0,
        textOutputTokens: 1,
        audioInputTokens: 0,
        audioCachedInputTokens: 0,
        audioOutputTokens: 0,
        imageInputTokens: 0,
        imageCachedInputTokens: 0,
        costMicroCents: 1,
        createdAt: 1,
      });
      await ctx.db.insert("billing_voice_sessions", {
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        stellaSessionId: "migrated-session",
        provider: "openai",
        model: "gpt-realtime-test",
        voice: "test-voice",
        status: "ended",
        leaseStartedAt: 1,
        leaseExpiresAt: 2,
        heartbeatCount: 1,
        lastHeartbeatAt: 1,
        lastUsageAt: 1,
        responseCount: 1,
        estimatedCostMicroCents: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        realtimeAudioSeconds: 0,
        sttAudioSeconds: 0,
        endedAt: 2,
        endReason: "ended",
        createdAt: 1,
        updatedAt: 2,
      });
    });

    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const claim = await t.mutation(
      internal.auth_migration.claimOwnershipMigration,
      { fromOwnerId, toOwnerId, leaseId: "voice-migration", now: 100 },
    );
    expect(claim).toMatchObject({
      claimed: true,
      fromOwnerGeneration: "legacy",
      toOwnerGeneration,
    });
    if (!("leaseGeneration" in claim) || !claim.leaseGeneration)
      throw new Error("migration lease was not bound");

    for (let pass = 0; pass < 8; pass += 1) {
      const result = await t.mutation(
        internal.auth_migration.migrateUsageAccountingBatch,
        {
          fromOwnerId,
          toOwnerId,
          leaseId: "voice-migration",
          leaseGeneration: claim.leaseGeneration,
          leaseNow: 101 + pass,
        },
      );
      if (!result.hasMore) break;
    }

    const migrated = await t.run(async (ctx) => ({
      receipt: await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_responseId", (q) =>
          q.eq("ownerId", toOwnerId).eq("responseId", "migrated-response"),
        )
        .unique(),
      session: await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_stellaSessionId", (q) =>
          q.eq("stellaSessionId", "migrated-session"),
        )
        .unique(),
    }));
    expect(migrated.receipt).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: toOwnerGeneration,
    });
    expect(migrated.session).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: toOwnerGeneration,
    });
  });
});
