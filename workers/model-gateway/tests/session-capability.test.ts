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
  TEST_DEVICE_KEY_HASH,
  testDeviceKeyProof,
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
  const run = async (request: Request | Promise<Request>) =>
    handleRequest(
      await request,
      harness.env,
      fakeExecutionContext(),
      harness.deps(fetchMock.fetch),
    );
  return { harness, fetchMock, run };
};

const ownerIdFromJwt = (token: string | null): string => {
  if (!token) return `${CONVEX_SITE}|user_ba_1`;
  try {
    const encoded = token.split(".")[1] ?? "";
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "iss" in parsed &&
      "sub" in parsed &&
      typeof parsed.iss === "string" &&
      typeof parsed.sub === "string"
    ) {
      return `${parsed.iss}|${parsed.sub}`;
    }
  } catch {
    // Authentication rejects a malformed token before the proof matters.
  }
  return `${CONVEX_SITE}|user_ba_1`;
};

const sessionRequest = async (
  token: string | null,
  body?: unknown,
  cf?: { asn: number; asOrganization?: string },
): Promise<Request> => {
  const requestBody =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "deviceKey" in body
      ? body
      : {
          ...(body && typeof body === "object" && !Array.isArray(body)
            ? body
            : {}),
          deviceKey: await testDeviceKeyProof({
            ownerId: ownerIdFromJwt(token),
          }),
        };
  const request = new Request("https://gateway.test/v1/capabilities/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(requestBody),
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
};

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
      networkClass: "unknown",
      deviceKeyHash: TEST_DEVICE_KEY_HASH,
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
      networkClass: "unknown",
      deviceKeyHash: TEST_DEVICE_KEY_HASH,
    });
    expect(ctx.harness.networkGate.objects.size).toBe(1);
  });

  test("refuses an anonymous hosting network before any admission gate", async () => {
    const token = await signJwt(
      validPayload({ isAnonymous: true, sub: "anon_hosting" }),
    );
    const response = await ctx.run(
      sessionRequest(token, {}, { asn: 16_509, asOrganization: "Amazon" }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error).toEqual({
      code: "sign_in_required",
      message: "Sign in to Stella to continue from this network.",
      retryable: false,
    });
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.harness.networkGate.objects.size).toBe(0);
    expect(ctx.harness.asnPolicyCalls).toEqual([
      { key: "16509", cacheTtl: 300 },
    ]);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/session-capability",
      ),
    ).toHaveLength(0);
  });

  test("passes the edge class and bounded Turnstile token to Convex", async () => {
    const token = await signJwt(validPayload());
    const response = await ctx.run(
      sessionRequest(
        token,
        { turnstileToken: "turnstile-token" },
        { asn: 16_509, asOrganization: "Amazon" },
      ),
    );
    expect(response.status).toBe(200);
    const convexCall = ctx.fetchMock.calls.find(
      (call) => call.url.pathname === "/api/gateway/session-capability",
    )!;
    expect(JSON.parse(convexCall.body ?? "{}")).toEqual({
      ownerId: `${CONVEX_SITE}|user_ba_1`,
      isAnonymous: false,
      ipHash: "631f08140b24b7274d12df3c37a1a80c",
      networkClass: "hosting",
      turnstileToken: "turnstile-token",
      deviceKeyHash: TEST_DEVICE_KEY_HASH,
    });

    for (const turnstileToken of [42, "x".repeat(4_097)]) {
      const invalid = await ctx.run(sessionRequest(token, { turnstileToken }));
      expect(invalid.status).toBe(400);
      expect((await readError(invalid)).error.code).toBe("bad_request");
    }
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

  test("requires a fresh device proof for the public gateway origin", async () => {
    const token = await signJwt(validPayload());
    const ownerId = `${CONVEX_SITE}|user_ba_1`;
    const cases = [
      { deviceKey: null },
      {
        deviceKey: await testDeviceKeyProof({
          ownerId,
          now: Date.now() - 6 * 60_000,
        }),
      },
      {
        deviceKey: await testDeviceKeyProof({
          ownerId,
          gatewayOrigin: "https://other-gateway.test",
        }),
      },
      {
        deviceKey: {
          ...(await testDeviceKeyProof({ ownerId })),
          signature: "A".repeat(256),
        },
      },
      {
        deviceKey: {
          ...(await testDeviceKeyProof({ ownerId })),
          publicKey: "A".repeat(129),
        },
      },
    ];
    for (const body of cases) {
      const response = await ctx.run(sessionRequest(token, body));
      expect(response.status).toBe(400);
      const error = (await readError(response)).error;
      expect(error.code).toBe("dpop_invalid");
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/missing|malformed|stale|bad_signature/u);
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

  test("maps Convex challenge and sign-in refusals", async () => {
    const token = await signJwt(validPayload());
    for (const code of ["challenge_required", "sign_in_required"] as const) {
      ctx.fetchMock.on(
        (call) => call.url.pathname === "/api/gateway/session-capability",
        () => json({ error: code }, 403),
      );
      const response = await ctx.run(
        sessionRequest(
          token,
          {},
          code === "challenge_required"
            ? { asn: 16_509, asOrganization: "Amazon.com, Inc." }
            : undefined,
        ),
      );
      expect(response.status).toBe(403);
      expect((await readError(response)).error).toEqual({
        code,
        message:
          code === "challenge_required"
            ? "Complete the verification challenge and try again."
            : "Sign in to Stella to continue.",
        retryable: false,
      });
    }
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
