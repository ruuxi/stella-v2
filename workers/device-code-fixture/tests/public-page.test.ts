import { describe, expect, test } from "bun:test";
import { handlePublicRequest } from "../src/public-page.js";
import type { DeviceCodeFixtureEnv } from "../src/authorization-session.js";

const origin =
  "https://stella-v2-device-code-fixture-basic-nightingale-118.lolruuxi.workers.dev";

const env = (
  options: { limited?: boolean; outcome?: string } = {},
): DeviceCodeFixtureEnv =>
  ({
    PUBLIC_ORIGIN: origin,
    ACTIVATION_PAGE_RATE_LIMITER: {
      limit: async () => ({ success: !options.limited }),
    },
    ACTIVATION_DECISION_RATE_LIMITER: {
      limit: async () => ({ success: !options.limited }),
    },
    DEVICE_AUTHORIZATIONS: {
      getByName: () => ({
        publicDecision: async () => ({
          outcome: options.outcome ?? "approved",
        }),
      }),
    },
  }) as unknown as DeviceCodeFixtureEnv;

describe("public activation page", () => {
  test("serves only public code fields with strict no-store browser policy", async () => {
    const response = await handlePublicRequest(
      new Request(`${origin}/activate?user_code=BCDF-2345`, {
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }),
      env(),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(html).toContain('value="BCDF-2345"');
    expect(html).not.toContain("deviceCode");
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("refresh_token");
    expect(html).not.toContain("<script");
  });

  test("requires same-origin form posts and accepts a public decision", async () => {
    const body = new URLSearchParams({
      user_code: "BCDF-2345",
      decision: "approve",
    });
    const accepted = await handlePublicRequest(
      new Request(`${origin}/activate`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body,
      }),
      env(),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain(
      "Approved. Return to Stella and choose Done.",
    );

    const crossSite = await handlePublicRequest(
      new Request(`${origin}/activate`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.invalid",
        },
        body,
      }),
      env(),
    );
    expect(crossSite.status).toBe(403);
  });

  test("rate limiting fails closed", async () => {
    const response = await handlePublicRequest(
      new Request(`${origin}/activate`),
      env({ limited: true }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  test("unexpected Durable Object failures remain secret-free and no-store", async () => {
    const failingEnv = env() as unknown as {
      DEVICE_AUTHORIZATIONS: { getByName(): unknown };
    };
    failingEnv.DEVICE_AUTHORIZATIONS.getByName = () => ({
      publicDecision: async () => {
        throw new Error("sensitive upstream details");
      },
    });
    const response = await handlePublicRequest(
      new Request(`${origin}/activate`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({
          user_code: "BCDF-2345",
          decision: "approve",
        }),
      }),
      failingEnv as unknown as DeviceCodeFixtureEnv,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.text()).not.toContain("sensitive upstream details");
  });
});
