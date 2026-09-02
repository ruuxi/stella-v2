import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS,
  GatewaySessionExchangeError,
  STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE,
  STELLA_GATEWAY_UNCONFIGURED_MESSAGE,
  createGatewaySessionClient,
  getRememberedStellaGatewayOrigin,
  normalizeGatewayOrigin,
  rememberStellaGatewayOrigin,
  resetGatewaySessionState,
} from "@stella/runtime/kernel/gateway-session";

const GATEWAY = "https://gateway.example.test";

const jwtFor = (claims: Record<string, unknown>) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
};

type ExchangeCall = {
  url: string;
  authorization: string | null;
  body: unknown;
};

const exchangeFetch = (
  respond: (call: ExchangeCall, index: number) => Response | Promise<Response>,
) => {
  const calls: ExchangeCall[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const call = {
        url,
        authorization: headers.get("authorization"),
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  ) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const capabilityResponse = (capability: string, expiresAt: number) =>
  new Response(
    JSON.stringify({
      capability,
      expiresAt,
      audience: "pro",
      budgetMicroCents: -1,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

afterEach(() => {
  resetGatewaySessionState();
});

describe("gateway origin memory", () => {
  it("normalizes and remembers the catalog-advertised origin per site", () => {
    rememberStellaGatewayOrigin(
      "https://stella.example.test/api/stella/models",
      `${GATEWAY}/`,
    );
    expect(
      getRememberedStellaGatewayOrigin("https://stella.example.test"),
    ).toBe(GATEWAY);
    expect(
      getRememberedStellaGatewayOrigin("https://other.example.test"),
    ).toBeNull();
    expect(getRememberedStellaGatewayOrigin(null)).toBeNull();
  });

  it("rejects origins that are not absolute http(s) URLs", () => {
    expect(normalizeGatewayOrigin("gateway.example.test")).toBeNull();
    expect(normalizeGatewayOrigin("ftp://gateway.example.test")).toBeNull();
    expect(normalizeGatewayOrigin(`${GATEWAY}?x=1`)).toBeNull();
    expect(normalizeGatewayOrigin("")).toBeNull();
    expect(normalizeGatewayOrigin(42)).toBeNull();
    expect(normalizeGatewayOrigin(`${GATEWAY}/prefix/`)).toBe(
      `${GATEWAY}/prefix`,
    );
    expect(() =>
      rememberStellaGatewayOrigin("https://stella.example.test", "nope"),
    ).toThrow(/invalid stella model gateway origin/i);
  });
});

describe("session capability cache", () => {
  it("exchanges the Better Auth JWT once and caches until 60 s before expiry", async () => {
    let now = 1_000_000;
    const expiresAt = now + 10 * 60_000;
    const { calls, fetchImpl } = exchangeFetch(() =>
      capabilityResponse("cap-1", expiresAt),
    );
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => jwtFor({ sub: "user-1", exp: 9_999_999_999 }),
      fetch: fetchImpl,
      now: () => now,
    });

    await expect(client.getCapability()).resolves.toBe("cap-1");
    await expect(client.getCapability()).resolves.toBe("cap-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: `${GATEWAY}/v1/capabilities/session`,
      authorization: `Bearer ${jwtFor({ sub: "user-1", exp: 9_999_999_999 })}`,
      body: {},
    });

    // Just inside the refresh skew: still cached.
    now = expiresAt - GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS - 1;
    await expect(client.getCapability()).resolves.toBe("cap-1");
    expect(calls).toHaveLength(1);

    // At the skew boundary: re-exchanged.
    now = expiresAt - GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS;
    await expect(client.getCapability()).resolves.toBe("cap-1");
    expect(calls).toHaveLength(2);
  });

  it("shares one in-flight exchange between concurrent callers", async () => {
    const { calls, fetchImpl } = exchangeFetch(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(capabilityResponse("cap-shared", Date.now() + 3_600_000)),
            5,
          ),
        ),
    );
    const make = () =>
      createGatewaySessionClient({
        gatewayOrigin: () => GATEWAY,
        getAuthToken: () => jwtFor({ sub: "user-1" }),
        fetch: fetchImpl,
      });

    const results = await Promise.all([
      make().getCapability(),
      make().getCapability(),
      make().getCapability(),
    ]);
    expect(results).toEqual(["cap-shared", "cap-shared", "cap-shared"]);
    expect(calls).toHaveLength(1);
  });

  it("reuses the capability across JWT rotations for the same owner but never across owners", async () => {
    const { calls, fetchImpl } = exchangeFetch((_call, index) =>
      capabilityResponse(`cap-${index}`, Date.now() + 3_600_000),
    );
    let token = jwtFor({ iss: "stella", sub: "user-1", exp: 1 });
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => token,
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).resolves.toBe("cap-0");
    token = jwtFor({ iss: "stella", sub: "user-1", exp: 2 });
    await expect(client.getCapability()).resolves.toBe("cap-0");
    expect(calls).toHaveLength(1);

    token = jwtFor({ iss: "stella", sub: "user-2", exp: 2 });
    await expect(client.getCapability()).resolves.toBe("cap-1");
    expect(calls).toHaveLength(2);
  });

  it("refreshCapability drops the cache and exchanges again", async () => {
    const { calls, fetchImpl } = exchangeFetch((_call, index) =>
      capabilityResponse(`cap-${index}`, Date.now() + 3_600_000),
    );
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => jwtFor({ sub: "user-1" }),
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).resolves.toBe("cap-0");
    await expect(client.refreshCapability()).resolves.toBe("cap-1");
    await expect(client.getCapability()).resolves.toBe("cap-1");
    await client.invalidate();
    await expect(client.getCapability()).resolves.toBe("cap-2");
    expect(calls).toHaveLength(3);
  });

  it("retries the exchange once with a refreshed JWT when the gateway answers 401", async () => {
    const { calls, fetchImpl } = exchangeFetch((call) =>
      call.authorization === "Bearer fresh-jwt"
        ? capabilityResponse("cap-fresh", Date.now() + 3_600_000)
        : new Response(
            JSON.stringify({
              error: {
                code: "unauthorized",
                message: "bad jwt",
                retryable: false,
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
    );
    const refreshAuthToken = vi.fn(async () => "fresh-jwt");
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => "stale-jwt",
      refreshAuthToken,
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).resolves.toBe("cap-fresh");
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer stale-jwt",
      "Bearer fresh-jwt",
    ]);
  });

  it("answers challenge_required with one fresh token and re-exchanges once", async () => {
    const { calls, fetchImpl } = exchangeFetch((call) =>
      call.body &&
      typeof call.body === "object" &&
      "turnstileToken" in call.body
        ? capabilityResponse("cap-verified", Date.now() + 3_600_000)
        : new Response(
            JSON.stringify({
              error: {
                code: "challenge_required",
                message: "verify",
                retryable: true,
              },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
    );
    const getChallengeToken = vi.fn(async () => "turnstile-token");
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => "jwt",
      getChallengeToken,
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).resolves.toBe("cap-verified");
    expect(getChallengeToken).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.body)).toEqual([
      {},
      { turnstileToken: "turnstile-token" },
    ]);
  });

  it("uses the human-verification copy when no challenge token is available", async () => {
    const { calls, fetchImpl } = exchangeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "challenge_required",
              message: "verify",
              retryable: true,
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => "jwt",
      getChallengeToken: async () => undefined,
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).rejects.toThrow(
      STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE,
    );
    expect(calls).toHaveLength(1);
  });

  it("surfaces gateway rejections with status and code", async () => {
    const { fetchImpl } = exchangeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "generation_stale",
              message: "sign in again",
              retryable: false,
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => "jwt",
      fetch: fetchImpl,
    });

    const error = await client.getCapability().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GatewaySessionExchangeError);
    expect(error).toMatchObject({ status: 403, code: "generation_stale" });
    expect((error as Error).message).toContain("sign in again");
  });

  it("rejects malformed capability payloads", async () => {
    const { fetchImpl } = exchangeFetch(
      () =>
        new Response(JSON.stringify({ capability: "", expiresAt: "soon" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => "jwt",
      fetch: fetchImpl,
    });

    await expect(client.getCapability()).rejects.toThrow(
      /malformed session capability/i,
    );
  });

  it("returns undefined without a JWT and fails closed without a gateway origin", async () => {
    const { calls, fetchImpl } = exchangeFetch(() =>
      capabilityResponse("cap", Date.now() + 3_600_000),
    );
    const noToken = createGatewaySessionClient({
      gatewayOrigin: () => GATEWAY,
      getAuthToken: () => undefined,
      fetch: fetchImpl,
    });
    await expect(noToken.getCapability()).resolves.toBeUndefined();

    const noOrigin = createGatewaySessionClient({
      gatewayOrigin: () => null,
      getAuthToken: () => "jwt",
      fetch: fetchImpl,
    });
    await expect(noOrigin.getCapability()).rejects.toThrow(
      STELLA_GATEWAY_UNCONFIGURED_MESSAGE,
    );
    expect(calls).toHaveLength(0);
  });
});
