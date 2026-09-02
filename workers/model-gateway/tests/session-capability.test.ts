import { beforeEach, describe, expect, test } from "bun:test";
import { resetJwksCacheForTests } from "../src/auth-jwt.js";
import { handleRequest } from "../src/router.js";
import {
  CONVEX_SITE,
  createFetchMock,
  createTestEnv,
  fakeExecutionContext,
  json,
  readError,
  SERVICE_SECRET,
} from "./helpers/env.js";

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encodeJson = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const rsa = await (async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid: "ba-k1", alg: "RS256", use: "sig" },
  };
})();

const signJwt = async (
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
) => {
  const encodedHeader = encodeJson({
    alg: "RS256",
    typ: "JWT",
    kid: "ba-k1",
    ...header,
  });
  const encodedPayload = encodeJson(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      rsa.privateKey,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    ),
  );
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  iss: CONVEX_SITE,
  aud: "convex",
  sub: "user_ba_1",
  iat: nowSeconds() - 5,
  exp: nowSeconds() + 600,
  sessionId: "sess_1",
  ...overrides,
});

const issued = {
  capability: "signed.capability.token",
  expiresAt: 1_756_000_000_000,
  audience: "pro",
  budgetMicroCents: 50_000_000,
};

const setup = () => {
  resetJwksCacheForTests();
  const harness = createTestEnv();
  const fetchMock = createFetchMock()
    .on(
      (call) => call.url.pathname === "/api/auth/convex/jwks",
      () => json({ keys: [rsa.jwk] }),
    )
    .on(
      (call) => call.url.pathname === "/api/gateway/session-capability",
      () => json(issued),
    );
  const run = (request: Request) =>
    handleRequest(
      request,
      harness.env,
      fakeExecutionContext(),
      harness.deps(fetchMock.fetch),
    );
  return { harness, fetchMock, run };
};

const sessionRequest = (token: string | null, body?: unknown) =>
  new Request("https://gateway.test/v1/capabilities/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /v1/capabilities/session", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("exchanges a Better Auth JWT for a session capability, verbatim from Convex", async () => {
    const token = await signJwt(validPayload());
    const response = await ctx.run(sessionRequest(token, {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(issued);
    const jwksCall = ctx.fetchMock.calls.find(
      (call) => call.url.pathname === "/api/auth/convex/jwks",
    )!;
    expect(jwksCall.url.origin).toBe(CONVEX_SITE);
    const convexCall = ctx.fetchMock.calls.find(
      (call) => call.url.pathname === "/api/gateway/session-capability",
    )!;
    expect(convexCall.headers.get("authorization")).toBe(
      `Bearer ${SERVICE_SECRET}`,
    );
    expect(JSON.parse(convexCall.body ?? "{}")).toEqual({
      ownerId: `${CONVEX_SITE}|user_ba_1`,
      isAnonymous: false,
      ipHash: "631f08140b24b7274d12df3c37a1a80c",
    });
  });

  test("anonymous accounts are flagged from the JWT and an empty body is fine", async () => {
    const token = await signJwt(
      validPayload({ isAnonymous: true, sub: "anon_7" }),
    );
    const response = await ctx.run(sessionRequest(token));
    expect(response.status).toBe(200);
    const convexCall = ctx.fetchMock.calls.find(
      (call) => call.url.pathname === "/api/gateway/session-capability",
    )!;
    expect(JSON.parse(convexCall.body ?? "{}")).toEqual({
      ownerId: `${CONVEX_SITE}|anon_7`,
      isAnonymous: true,
      ipHash: "631f08140b24b7274d12df3c37a1a80c",
    });
    expect(ctx.harness.networkGate.objects.size).toBe(1);
  });

  test("rejects a missing, expired, wrong-issuer, wrong-audience, or non-RS256 token with 401", async () => {
    const cases = [
      null,
      await signJwt(validPayload({ exp: nowSeconds() - 600 })),
      await signJwt(validPayload({ iss: "https://evil.example" })),
      await signJwt(validPayload({ aud: "other" })),
      await signJwt(validPayload(), { alg: "none" }),
    ];
    for (const token of cases) {
      const response = await ctx.run(sessionRequest(token, {}));
      expect(response.status).toBe(401);
      expect((await readError(response)).error.code).toBe("unauthorized");
    }
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/session-capability",
      ),
    ).toHaveLength(0);
  });

  test("a bad signature is 401; an unreachable JWKS or Convex is 503 retryable", async () => {
    const [header, payload] = (await signJwt(validPayload())).split(".");
    const forged = await ctx.run(
      sessionRequest(
        `${header}.${payload}.${base64Url(new Uint8Array(256))}`,
        {},
      ),
    );
    expect(forged.status).toBe(401);

    resetJwksCacheForTests();
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/auth/convex/jwks",
      () => new Response("down", { status: 500 }),
    );
    const noJwks = await ctx.run(
      sessionRequest(await signJwt(validPayload()), {}),
    );
    expect(noJwks.status).toBe(503);
    expect((await readError(noJwks)).error).toMatchObject({
      code: "internal",
      retryable: true,
    });

    resetJwksCacheForTests();
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/auth/convex/jwks",
      () => json({ keys: [rsa.jwk] }),
    );
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/session-capability",
      () => new Response("down", { status: 502 }),
    );
    const noConvex = await ctx.run(
      sessionRequest(await signJwt(validPayload()), {}),
    );
    expect(noConvex.status).toBe(503);
    expect((await readError(noConvex)).error).toMatchObject({
      code: "internal",
      retryable: true,
    });
  });

  test("refuses a suspended owner from KV before mint admission or Convex", async () => {
    ctx.harness.enforcementValues.set(
      `${CONVEX_SITE}|user_ba_1`,
      JSON.stringify({ status: "suspended", updatedAt: Date.now() }),
    );
    const response = await ctx.run(
      sessionRequest(await signJwt(validPayload()), {}),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("owner_suspended");
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/session-capability",
      ),
    ).toHaveLength(0);
  });

  test("maps Convex's flat owner_suspended refusal", async () => {
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/session-capability",
      () => json({ error: "owner_suspended" }, 403),
    );
    const response = await ctx.run(
      sessionRequest(await signJwt(validPayload()), {}),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("owner_suspended");
  });

  test("passes throttled enforcement to the owner mint gate", async () => {
    ctx.harness.enforcementValues.set(
      `${CONVEX_SITE}|user_ba_1`,
      JSON.stringify({ status: "throttled", updatedAt: Date.now() }),
    );
    const token = await signJwt(validPayload());
    for (let index = 0; index < 6; index += 1) {
      expect((await ctx.run(sessionRequest(token, {}))).status).toBe(200);
    }
    const refused = await ctx.run(sessionRequest(token, {}));
    expect(refused.status).toBe(429);
    expect((await readError(refused)).error).toMatchObject({
      code: "rate_limited",
      quota: { scope: "owner" },
    });
    expect(refused.headers.get("retry-after")).toBeTruthy();
  });
});
