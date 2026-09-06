/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateCapabilityKeyPair } from "@stella/contracts/gateway/jwt";
import { internal } from "./_generated/api";
import schema from "./schema";
import { CAPABILITIES, type CapabilityAudience } from "./capability_contract";

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "https://issuer.test|capability-owner";
const OWNER_GENERATION = "capability-generation";
const DEVICE_KEY_HASH = "A".repeat(43);

// Session capabilities are ES256-signed; mint a throwaway key the way
// gateway_capabilities.convex.test.ts does so signing can run in-process.
beforeAll(async () => {
  const { privateKeyPem } = await generateCapabilityKeyPair();
  process.env.CAPABILITY_SIGNING_KEY = privateKeyPem;
  process.env.CAPABILITY_SIGNING_KID = "media-gate-test";
});

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "capability-owner",
    tokenIdentifier: OWNER_ID,
  });

const ensureEnv = () => {
  const values: Record<string, string> = {
    FAL_KEY: "test-fal-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    GEMINI_API_KEY: "test-gemini-key",
    OPENAI_API_KEY: "test-openai-key",
    INWORLD_API_KEY: "test-inworld-key",
    CLOUD_BUILDER_URL: "https://cloud-builder.test",
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

const onPlan = async (
  t: ReturnType<typeof createTest>,
  plan: "free" | "go" | "pro",
) => {
  await t.mutation(internal.billing.setAdminBillingPlan, {
    ownerId: OWNER_ID,
    plan,
  });
  return asOwner(t);
};

/** Open the owner's data lifecycle so generation-bound gateway paths admit them. */
const openOwnerLifecycle = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: now,
      updatedAt: now,
    });
  });
};

type DenialBody = {
  error: string;
  code: string;
  capability: string;
  audience: CapabilityAudience;
  minimumPlan: CapabilityAudience | null;
  action: string;
};

const expectDenial = async (
  response: Response,
  capability: string,
  audience: CapabilityAudience,
) => {
  expect(response.status).toBe(402);
  const body = (await response.json()) as DenialBody;
  expect(body).toMatchObject({
    code: "CAPABILITY_REQUIRED",
    capability,
    audience,
    minimumPlan: "pro",
  });
  expect(body.error).toContain(`[capability/${capability}]`);
  expect(typeof body.action).toBe("string");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media capability gating", () => {
  it("denies image generation on Go with a structured 402 and no provider call", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "go");
    const providerFetch = vi.spyOn(globalThis, "fetch");

    const response = await owner.fetch("/api/media/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "text_to_image", prompt: "a cabin" }),
    });

    await expectDenial(response, "image_generation", "go");
    expect(providerFetch).not.toHaveBeenCalled();
    // Entitlement is checked before reservation, so a denial leaves no
    // half-created job behind for the cost accounting to reconcile.
    expect(
      await t.run(async (ctx) => await ctx.db.query("media_jobs").collect()),
    ).toEqual([]);
  });

  it("names the denied capability per media category", async () => {
    ensureEnv();
    for (const [mediaCapability, capability] of [
      ["text_to_video", "video_generation"],
      ["audio_generation", "audio_generation"],
      ["text_to_3d", "three_d_generation"],
    ] as const) {
      const t = createTest();
      const owner = await onPlan(t, "free");
      const response = await owner.fetch("/api/media/v1/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: mediaCapability,
          prompt: "something",
        }),
      });
      await expectDenial(response, capability, "free");
    }
  });

  it("leaves transcription open to every plan", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "free");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "hello",
          usage: { seconds: 1.5, cost: 0.0000375 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const response = await owner.fetch("/api/media/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "speech_to_text",
        sourceUrl:
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
      }),
    });
    // Whatever happens downstream, it must not be an entitlement denial.
    expect(response.status).not.toBe(402);
  });

  it("lets Pro past the gate", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "pro");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ request_id: "fal-req-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await owner.fetch("/api/media/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "text_to_image", prompt: "a cabin" }),
    });

    expect(response.status).not.toBe(402);
  });

  it("denies music generation but leaves read-aloud open to every plan", async () => {
    ensureEnv();
    const musicTest = createTest();
    const musicOwner = await onPlan(musicTest, "go");
    const musicResponse = await musicOwner.fetch("/api/music/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a slow waltz" }),
    });
    await expectDenial(musicResponse, "audio_generation", "go");

    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    const ttsTest = createTest();
    const ttsOwner = await onPlan(ttsTest, "go");
    const ttsResponse = await ttsOwner.fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(ttsResponse.status).not.toBe(402);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("denies a realtime voice session before minting an upstream session", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "free");
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const response = await owner.fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "be helpful" }),
    });
    await expectDenial(response, "audio_generation", "free");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("starts realtime voice without treating a mobile thread key as a Convex ID", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "pro");
    const providerFetch = vi.spyOn(globalThis, "fetch");

    const response = await owner.fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "cloud",
        instructions: "Be helpful.",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      clientSecret: "stella-server-created-call",
      sdpEndpoint: "/api/voice/openai/sdp",
      voiceProvider: "openai",
    });
    expect(providerFetch).not.toHaveBeenCalled();
    const leases = await t.run(
      async (ctx) => await ctx.db.query("billing_voice_sessions").take(2),
    );
    expect(leases).toHaveLength(1);
    expect(leases[0]?.conversationId).toBeUndefined();
  });

  it("leaves dictation open to every plan", async () => {
    ensureEnv();
    const t = createTest();
    const owner = await onPlan(t, "free");
    const response = await owner.fetch("/api/dictation/realtime-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  it("allows a verified anonymous session to configure dictation", async () => {
    ensureEnv();
    const t = createTest();
    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "anonymous-dictation-owner",
      tokenIdentifier: "https://issuer.test|anonymous-dictation-owner",
      isAnonymous: true,
    });
    const response = await anonymous.fetch("/api/dictation/realtime-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      relayOrigin: process.env.CLOUD_BUILDER_URL,
      modelId: "muse-voice-transcribe-1.0",
    });
  });

  it("still requires an authenticated owner and trusted dictation control plane", async () => {
    ensureEnv();
    const t = createTest();
    const response = await t.fetch("/api/dictation/realtime-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "auth_required" });
    for (const route of ["prepare", "settle"]) {
      const control = await asOwner(t).fetch(`/api/cloud/dictation/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerId: OWNER_ID }),
      });
      expect(control.status).toBe(401);
    }
  });
});

describe("orchestration is not a capability", () => {
  // The owner decided orchestration stays open to every plan: it costs
  // more usage, which is why Pro suits it, but usage is the billing axis and
  // this table is the entitlement one. Pro lists it as marketing copy only.
  //
  // This test exists to keep it that way. Model access is now granted by a
  // session capability the model gateway meters locally, so the invariant is
  // that a free-plan owner's allowance is positive and a capability can be
  // minted for them — with no agent-type restriction, so `orchestrator` (what
  // every ordinary desktop chat sends) is never locked out. Anyone who wires
  // the string into the capability path would silently lock Free and Go out
  // of chat entirely — a failure that would otherwise surface as a support
  // ticket rather than a red test.
  it("never denies model access on the free plan for orchestrator", async () => {
    ensureEnv();
    const t = createTest();
    await openOwnerLifecycle(t);
    await onPlan(t, "free");

    const allowance = await t.mutation(
      internal.gateway_capabilities.getOwnerModelAllowanceInternal,
      { ownerId: OWNER_ID, ownerGeneration: OWNER_GENERATION },
    );
    expect(allowance.audience).toBe("free");
    expect(allowance.unlimited || allowance.budgetMicroCents > 0).toBe(true);

    const session = await t.action(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      {
        ownerId: OWNER_ID,
        isAnonymous: false,
        deviceKeyHash: DEVICE_KEY_HASH,
      },
    );
    expect(session.audience).toBe("free");
    expect(session.budgetMicroCents).toBe(allowance.budgetMicroCents);
    expect(session.maxRequests).toBeUndefined();

    const [, payload] = session.capability.split(".");
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: OWNER_ID,
      gen: OWNER_GENERATION,
      kind: "session",
      audience: "free",
    });
    // No agent-type claim: the capability acts as any agent type, orchestrator included.
    expect(claims.agentTypes).toBeUndefined();
  });

  it("has no orchestrator row to enforce", () => {
    expect(CAPABILITIES as readonly string[]).not.toContain("orchestrator");
  });
});
