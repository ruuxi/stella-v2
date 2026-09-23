/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Proves that voice/TTS defaults are server-authoritative: when the client
// omits `voice` (the client sends only explicit user selections), the backend
// applies its own default voice (Kore) and model (gemini-3.8-flash-lite-tts)
// on the outbound Gemini request, exercised end-to-end through the real
// `/api/voice/tts` httpAction with a mocked Gemini provider call.

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "https://issuer.test|voice-default-owner";

const ensureEnv = () => {
  const values: Record<string, string> = {
    OPENAI_API_KEY: "test-openai-key",
    GOOGLE_AI_API_KEY: "test-gemini-key",
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

const geminiUnaryResponse = () =>
  new Response(
    JSON.stringify({
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "audio",
              mime_type: "audio/wav",
              data: Buffer.from([1, 2, 3]).toString("base64"),
            },
          ],
        },
      ],
      usage: {
        total_input_tokens: 2,
        output_tokens_by_modality: [{ modality: "audio", tokens: 40 }],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

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
      body: JSON.stringify({ text: "123456", voiceProvider: "gemini" }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "tts_quota" });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("applies the Kore voice + flash-lite model when the client omits them", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);

    const geminiCalls: Array<{ url: string; body: Record<string, unknown> }> =
      [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiCalls.push({
            url,
            body:
              typeof init?.body === "string" ? JSON.parse(init.body) : {},
          });
        }
        return geminiUnaryResponse();
      },
    );

    const response = await owner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", voiceProvider: "gemini" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.body).toMatchObject({
      model: "gemini-3.8-flash-lite-tts",
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
    const usage = await t.run(
      async (ctx) => await ctx.db.query("internal_tts_usage").first(),
    );
    expect(usage).toMatchObject({
      provider: "gemini",
      status: "completed",
      textInputTokens: 2,
      audioOutputTokens: 40,
    });
  }, 30_000);

  it("honors a known Gemini voice and ignores unknown voices and client models", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);

    const sentBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBodies.push(
          typeof init?.body === "string" ? JSON.parse(init.body) : {},
        );
        return geminiUnaryResponse();
      },
    );

    // "inworld" is what pre-Gemini desktop builds still send.
    for (const [voice, voiceProvider] of [
      ["Puck", "gemini"],
      ["Brooke", "inworld"],
    ]) {
      const response = await owner.fetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `hello ${voice}`,
          voiceProvider,
          voice,
          model: "inworld-tts-2",
        }),
      });
      expect(response.status).toBe(200);
    }

    expect(sentBodies.map((body) => body.generation_config)).toEqual([
      { speech_config: [{ voice: "Puck" }] },
      { speech_config: [{ voice: "Kore" }] },
    ]);
    expect(sentBodies.every((body) => body.model === "gemini-3.8-flash-lite-tts")).toBe(true);
  }, 30_000);

  it("relays Gemini PCM as a progressive MP3 stream and settles usage", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await asOwner(t);
    const sse = [
      {
        event_type: "step.delta",
        delta: {
          mime_type: "audio/l16",
          data: Buffer.alloc(48_000).toString("base64"),
        },
      },
      {
        event_type: "interaction.complete",
        interaction: {
          status: "completed",
          usage: {
            total_input_tokens: 4,
            output_tokens_by_modality: [{ modality: "audio", tokens: 39 }],
          },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(sse, { status: 200 }));

    const response = await owner.fetch("/api/voice/tts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stream me", voice: "Puck" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    const mp3 = new Uint8Array(await response.arrayBuffer());
    expect(mp3.length).toBeGreaterThan(0);
    expect(mp3[0]).toBe(0xff);
    expect(String(providerFetch.mock.calls[0]?.[0])).toContain("alt=sse");
    const usage = await t.run(
      async (ctx) => await ctx.db.query("internal_tts_usage").first(),
    );
    expect(usage).toMatchObject({
      provider: "gemini",
      voice: "Puck",
      streaming: true,
      providerDispatchOutcome: "settled",
      status: "completed",
      textInputTokens: 4,
      audioOutputTokens: 39,
      audioBytes: mp3.length,
    });
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
      body: JSON.stringify({ text: "cancel me", voiceProvider: "gemini" }),
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
        voiceProvider: "gemini",
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
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(geminiUnaryResponse());
    const body = JSON.stringify({
      text: "do not synthesize twice",
      voiceProvider: "gemini",
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
