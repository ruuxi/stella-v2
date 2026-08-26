/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeAll(() => {
  const env = {
    XAI_API_KEY: "test-xai-key",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "50",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
});

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("mobile and CarPlay cloud dictation", () => {
  it("sends the shared transcription route directly to xAI without a model field", async () => {
    const t = createTest();
    const upstreamCalls: Array<{ url: string; init?: RequestInit }> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        upstreamCalls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({ text: "Shared mobile transcript", duration: 1.5 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const response = await t.fetch("/api/mobile/transcribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stella-mobile-device-id": "mobile-xai-stt-test",
      },
      body: JSON.stringify({
        audio: btoa("test audio"),
        format: "m4a",
        language: "en",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "Shared mobile transcript",
    });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe("https://api.x.ai/v1/stt");

    const form = upstreamCalls[0]?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("language")).toBe("en");
    expect(form.get("format")).toBe("true");
    expect(form.get("model")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.m4a");
    expect(file.type).toBe("audio/mp4");
  });
});
