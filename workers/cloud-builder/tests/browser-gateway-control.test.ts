import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
}));
const worker = (await import("../src/index.js")).default;
mock.restore();

const secret = "builder-service-secret";
const request = (
  path: string,
  body: string,
  authorization = `Bearer ${secret}`,
): Request =>
  new Request(`https://builder.example${path}`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body,
  });

describe("private Browser Gateway control proxy", () => {
  test("forwards only an authenticated bounded JSON body without the Builder secret", async () => {
    let forwarded: Request | undefined;
    const body = JSON.stringify({ schemaVersion: 1, interactionId: "safe" });
    const env = {
      BUILDER_SERVICE_SECRET: secret,
      BROWSER_GATEWAY: {
        fetch: async (input: string | Request, init?: RequestInit) => {
          forwarded =
            input instanceof Request ? input : new Request(input, init);
          return Response.json({ schemaVersion: 1, state: "pending" });
        },
      },
    };

    const response = await worker.fetch(
      request("/internal/interactions/status", body),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forwarded?.url).toBe(
      "https://browser-gateway/internal/interactions/status",
    );
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("content-type")).toBe("application/json");
    expect(forwarded?.redirect).toBe("manual");
    expect(await forwarded?.text()).toBe(body);
  });

  test("rejects unauthorized, oversized, and unbound requests before forwarding", async () => {
    let calls = 0;
    const gateway = {
      fetch: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    };
    const env = {
      BUILDER_SERVICE_SECRET: secret,
      BROWSER_GATEWAY: gateway,
    };

    expect(
      (
        await worker.fetch(
          request(
            "/internal/interactions/decision",
            "{}",
            "Bearer wrong",
          ),
          env as never,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          request(
            "/internal/interactions/live-view",
            "x".repeat(64 * 1024 + 1),
          ),
          env as never,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await worker.fetch(
          request("/internal/owners/profile/reset", "{}"),
          { BUILDER_SERVICE_SECRET: secret } as never,
        )
      ).status,
    ).toBe(503);
    expect(calls).toBe(0);
  });

  test("does not relay redirects or unbounded capability responses", async () => {
    const redirect = await worker.fetch(
      request("/internal/interactions/live-view", "{}"),
      {
        BUILDER_SERVICE_SECRET: secret,
        BROWSER_GATEWAY: {
          fetch: async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://live.browser.run/secret" },
            }),
        },
      } as never,
    );
    // A service binding must return a final JSON response. Never send a
    // capability-bearing Location header through Builder.
    expect(redirect.status).toBe(502);
    expect(redirect.headers.get("location")).toBeNull();

    const oversized = await worker.fetch(
      request("/internal/interactions/live-view", "{}"),
      {
        BUILDER_SERVICE_SECRET: secret,
        BROWSER_GATEWAY: {
          fetch: async () => new Response("x".repeat(64 * 1024 + 1)),
        },
      } as never,
    );
    expect(oversized.status).toBe(502);
  });
});
