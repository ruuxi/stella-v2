/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Proves that voice/TTS defaults are server-authoritative: when the client
// omits `voice` and `model` (the new client behavior — send only explicit user
// selections), the backend applies its own default voice (Brooke) and model
// (inworld-tts-2-flash) on the outbound Inworld request. This is the omitted-
// field path the ownership refactor depends on, exercised end-to-end through
// the real `/api/voice/tts` httpAction with a mocked Inworld provider call.

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "https://issuer.test|voice-default-owner";

const ensureEnv = () => {
  const values: Record<string, string> = {
    OPENAI_API_KEY: "test-openai-key",
    INWORLD_API_KEY: "test-inworld-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_SECRETS_MASTER_KEYS_JSON: JSON.stringify({
      "1": Buffer.alloc(32, 7).toString("base64"),
    }),
    STELLA_SECRETS_MASTER_KEY_VERSION: "1",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
};

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const asOwner = async (t: ReturnType<typeof createTest>) => {
  await t.mutation(internal.billing.setAdminBillingPlan, {
    ownerId: OWNER_ID,
    plan: "go",
  });
  return t.withIdentity({
    issuer: "https://issuer.test",
    subject: "voice-default-owner",
    tokenIdentifier: OWNER_ID,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.STELLA_TTS_DAILY_CHARS_GO;
});

describe("voice/tts server-authoritative defaults", () => {
  it("returns the quota code and UTC-midnight retry header before provider I/O", async () => {
    ensureEnv();
    process.env.STELLA_TTS_DAILY_CHARS_GO = "5";
    const t = createTest();
    const owner = await asOwner(t);
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "123456", voiceProvider: "inworld" }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "tts_quota" });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("applies the Brooke voice + flash model when the client omits them", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);

    const inworldCalls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.inworld.ai/tts/v1/voice")) {
          inworldCalls.push({
            url,
            body:
              typeof init?.body === "string"
                ? JSON.parse(init.body)
                : init?.body,
          });
        }
        return new Response(
          JSON.stringify({
            audioContent: Buffer.from([1, 2, 3]).toString("base64"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    // Client sends only the genuine selection (provider) + text — no voice, no
    // model — exactly as the refactored read-aloud clients now do.
    const response = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", voiceProvider: "inworld" }),
    });

    expect(response.status).toBe(200);
    expect(inworldCalls).toHaveLength(1);
    const sent = inworldCalls[0]?.body as {
      voiceId?: string;
      modelId?: string;
    };
    expect(sent.voiceId).toBe("Brooke");
    expect(sent.modelId).toBe("inworld-tts-2-flash");
  }, 30_000);

  it("still honors an explicit user voice/model (backward compatible)", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);

    const inworldCalls: Array<{ body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.inworld.ai/tts/v1/voice")) {
          inworldCalls.push({
            body:
              typeof init?.body === "string"
                ? JSON.parse(init.body)
                : ({} as Record<string, unknown>),
          });
        }
        return new Response(
          JSON.stringify({
            audioContent: Buffer.from([1, 2, 3]).toString("base64"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const response = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hello",
        voiceProvider: "inworld",
        voice: "Ashley",
        model: "inworld-tts-2",
      }),
    });

    expect(response.status).toBe(200);
    expect(inworldCalls[0]?.body.voiceId).toBe("Ashley");
    expect(inworldCalls[0]?.body.modelId).toBe("inworld-tts-2");
  }, 30_000);

  it("aborts in-flight provider work and retains pessimistic debt until its fixed quiescence bound", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);
    let providerStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      providerStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected the TTS dispatch abort signal."));
            return;
          }
          providerStarted(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const responsePromise = owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "cancel me", voiceProvider: "inworld" }),
    });
    const signal = await started;
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: OWNER_ID,
        operationId: "delete-during-tts",
        mode: "delete",
        now: Date.now(),
      },
    );
    const leaseId = "delete-during-tts-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId: OWNER_ID,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: Date.now(),
    });
    const canceled = await t.mutation(
      internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId,
        mode: "delete",
        now: Date.now(),
      },
    );
    expect(canceled.ready).toBe(false);

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(signal.aborted).toBe(true);
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual(["tts_provider_dispatch_debt"]);

    const debt = await t.run(
      async (ctx) =>
        await ctx.db
          .query("tts_provider_dispatch_leases")
          .withIndex("by_ownerId_and_state", (q) =>
            q.eq("ownerId", OWNER_ID).eq("state", "cancel_requested"),
          )
          .unique(),
    );
    expect(debt).not.toBeNull();
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("internal_tts_usage")
            .withIndex("by_dispatchId_and_attemptId", (q) =>
              q
                .eq("dispatchId", debt!.dispatchId)
                .eq("attemptId", debt!.attemptId),
            )
            .unique(),
      ),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      synthesizedChars: "cancel me".length,
    });
    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        {
          ownerId: OWNER_ID,
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId,
          mode: "delete",
          now: debt!.quiescentAfterAt,
        },
      ),
    ).resolves.toMatchObject({ ready: true, reaped: 1 });
  }, 30_000);

  it("blocks one-shot fallback while the same logical stream operation is ambiguous", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("provider response was lost"));
    const operationId = "logical_operation_1234567890";

    const streamed = await owner.fetch("/api/voice/tts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "speak once", operationId }),
    });
    expect(streamed.status).toBe(502);

    const fallback = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "speak once",
        voiceProvider: "inworld",
        operationId,
      }),
    });
    expect(fallback.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual(["tts_provider_dispatch_debt"]);
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("internal_tts_usage")
            .withIndex("by_dispatchId_and_attemptId", (q) =>
              q.eq("dispatchId", `tts-operation:${operationId}`),
            )
            .unique(),
      ),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      synthesizedChars: "speak once".length,
    });
  }, 30_000);

  it("uses a completed receipt as the response-loss replay tombstone", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          audioContent: Buffer.from([1, 2, 3]).toString("base64"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const body = JSON.stringify({
      text: "do not synthesize twice",
      voiceProvider: "inworld",
      operationId: "response_loss_operation_1234",
    });

    const first = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);
    const replay = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(replay.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  }, 30_000);
});
