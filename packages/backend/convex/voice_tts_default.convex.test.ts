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
});

describe("voice/tts server-authoritative defaults", () => {
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
              typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
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
  });

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
  });
});
