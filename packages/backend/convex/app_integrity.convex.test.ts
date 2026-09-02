/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import {
  APP_INTEGRITY_CHALLENGE_PATH,
  APP_INTEGRITY_HEADER,
  APP_INTEGRITY_NONCE_TTL_MS,
  encodeAppIntegrityProof,
} from "@stella/contracts/app-integrity";
import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import type { IntegrityProofVerifier } from "./lib/app_integrity";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const issueNonceRef = makeFunctionReference<
  "mutation",
  {
    nonce: string;
    purpose: "anonymous-sign-in" | "magic-link";
    createdAt: number;
    expiresAt: number;
  },
  null
>(
  "app_integrity:issueAppIntegrityNonceInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    nonce: string;
    purpose: "anonymous-sign-in" | "magic-link";
    createdAt: number;
    expiresAt: number;
  },
  null
>;

const consumeNonceRef = makeFunctionReference<
  "mutation",
  {
    nonce: string;
    purpose: "anonymous-sign-in" | "magic-link";
    now: number;
  },
  "valid" | "missing" | "consumed" | "expired" | "purpose_mismatch"
>(
  "app_integrity:consumeAppIntegrityNonceInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    nonce: string;
    purpose: "anonymous-sign-in" | "magic-link";
    now: number;
  },
  "valid" | "missing" | "consumed" | "expired" | "purpose_mismatch"
>;

const storeAppAttestKeyRef = makeFunctionReference<
  "mutation",
  { keyId: string; publicKey: string; now: number },
  boolean
>("app_integrity:storeAppAttestKeyInternal") as unknown as FunctionReference<
  "mutation",
  "internal",
  { keyId: string; publicKey: string; now: number },
  boolean
>;

const purgeExpiredNoncesRef = makeFunctionReference<
  "mutation",
  { now?: number; limit?: number },
  { deleted: number; hasMore: boolean }
>("app_integrity:purgeExpiredNoncesInternal") as unknown as FunctionReference<
  "mutation",
  "internal",
  { now?: number; limit?: number },
  { deleted: number; hasMore: boolean }
>;

const advanceSignCountRef = makeFunctionReference<
  "mutation",
  {
    keyId: string;
    expectedSignCount: number;
    signCount: number;
    now: number;
  },
  boolean
>(
  "app_integrity:advanceAppAttestSignCountInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    keyId: string;
    expectedSignCount: number;
    signCount: number;
    now: number;
  },
  boolean
>;

const createTest = () => {
  const test = convexTest(schema, modules);
  test.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  registerRateLimiter(test);
  return test;
};

const createNonce = async (
  test: ReturnType<typeof createTest>,
  nonce: string,
  now = Date.now(),
) => {
  await test.mutation(issueNonceRef, {
    nonce,
    purpose: "anonymous-sign-in",
    createdAt: now,
    expiresAt: now + APP_INTEGRITY_NONCE_TTL_MS,
  });
};

const requestAnonymousSignIn = (
  test: ReturnType<typeof createTest>,
  headers: HeadersInit = {},
  verifyIntegrityProof?: IntegrityProofVerifier,
) =>
  test.action(async (ctx) => {
    const auth = createAuth(
      ctx,
      verifyIntegrityProof ? { verifyIntegrityProof } : {},
    );
    const response = await auth.handler(
      new Request("https://convex.test/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.42",
          ...Object.fromEntries(new Headers(headers)),
        },
        body: "{}",
      }),
    );
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Some successful Better Auth responses have no JSON body.
    }
    return { status: response.status, body };
  });

afterEach(() => {
  delete process.env.APPLE_APP_ATTEST_TEAM_ID;
  delete process.env.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON;
  delete process.env.STELLA_APP_INTEGRITY_MODE;
  delete process.env.STELLA_APP_ATTEST_ALLOW_DEVELOPMENT;
  delete process.env.STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.restoreAllMocks();
});

describe("app integrity nonce lifecycle", () => {
  it("issues a 32-byte nonce from the public challenge route", async () => {
    const test = createTest();
    const before = Date.now();
    const response = await test.fetch(APP_INTEGRITY_CHALLENGE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.40",
      },
      body: JSON.stringify({ purpose: "magic-link" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    const body: unknown = await response.json();
    expect(body).toMatchObject({ expiresAt: expect.any(Number) });
    if (
      typeof body !== "object" ||
      body === null ||
      !("nonce" in body) ||
      typeof body.nonce !== "string" ||
      !("expiresAt" in body) ||
      typeof body.expiresAt !== "number"
    ) {
      throw new Error("Challenge route returned an invalid response.");
    }
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBeGreaterThanOrEqual(
      before + APP_INTEGRITY_NONCE_TTL_MS,
    );
    const nonce = body.nonce;

    const row = await test.run(async (ctx) =>
      ctx.db
        .query("app_integrity_nonces")
        .withIndex("by_nonce", (query) => query.eq("nonce", nonce))
        .unique(),
    );
    expect(row).toMatchObject({
      nonce,
      purpose: "magic-link",
      expiresAt: body.expiresAt,
    });
  });

  it("consumes a nonce once", async () => {
    const test = createTest();
    const nonce = "n".repeat(43);
    const now = Date.now();
    await createNonce(test, nonce, now);

    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "anonymous-sign-in",
        now: now + 1,
      }),
    ).resolves.toBe("valid");
    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "anonymous-sign-in",
        now: now + 2,
      }),
    ).resolves.toBe("consumed");
  });

  it("rejects and burns an expired nonce", async () => {
    const test = createTest();
    const nonce = "e".repeat(43);
    const now = Date.now();
    await test.mutation(issueNonceRef, {
      nonce,
      purpose: "anonymous-sign-in",
      createdAt: now - APP_INTEGRITY_NONCE_TTL_MS - 1,
      expiresAt: now - 1,
    });

    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "anonymous-sign-in",
        now,
      }),
    ).resolves.toBe("expired");
    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "anonymous-sign-in",
        now: now + 1,
      }),
    ).resolves.toBe("consumed");
  });

  it("rejects and burns a nonce issued for another purpose", async () => {
    const test = createTest();
    const nonce = "p".repeat(43);
    const now = Date.now();
    await createNonce(test, nonce, now);

    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "magic-link",
        now: now + 1,
      }),
    ).resolves.toBe("purpose_mismatch");
    await expect(
      test.mutation(consumeNonceRef, {
        nonce,
        purpose: "anonymous-sign-in",
        now: now + 2,
      }),
    ).resolves.toBe("consumed");
  });

  it("purges expired nonces while retaining live ones", async () => {
    const test = createTest();
    const now = Date.now();
    await test.mutation(issueNonceRef, {
      nonce: "x".repeat(43),
      purpose: "anonymous-sign-in",
      createdAt: now - APP_INTEGRITY_NONCE_TTL_MS,
      expiresAt: now,
    });
    await createNonce(test, "l".repeat(43), now);

    await expect(
      test.mutation(purgeExpiredNoncesRef, { now }),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    const rows = await test.run(async (ctx) =>
      ctx.db.query("app_integrity_nonces").collect(),
    );
    expect(rows.map((row) => row.nonce)).toEqual(["l".repeat(43)]);
  });

  it("only advances an App Attest key counter", async () => {
    const test = createTest();
    const now = Date.now();
    await expect(
      test.mutation(storeAppAttestKeyRef, {
        keyId: "app-attest-key",
        publicKey: "public-key",
        now,
      }),
    ).resolves.toBe(true);
    await expect(
      test.mutation(advanceSignCountRef, {
        keyId: "app-attest-key",
        expectedSignCount: 0,
        signCount: 1,
        now: now + 1,
      }),
    ).resolves.toBe(true);
    await expect(
      test.mutation(advanceSignCountRef, {
        keyId: "app-attest-key",
        expectedSignCount: 0,
        signCount: 2,
        now: now + 2,
      }),
    ).resolves.toBe(false);
    await expect(
      test.mutation(advanceSignCountRef, {
        keyId: "app-attest-key",
        expectedSignCount: 1,
        signCount: 1,
        now: now + 3,
      }),
    ).resolves.toBe(false);
  });
});

describe("Better Auth verification hook", () => {
  it("accepts a valid Turnstile proof", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true }),
    );
    const test = createTest();

    const response = await requestAnonymousSignIn(test, {
      "x-captcha-response": "captcha-token",
    });

    expect(response.status).toBe(200);
    const origin = await test.run(async (ctx) =>
      ctx.db.query("owner_origins").take(1),
    );
    expect(origin[0]?.platform).toBe("web");
  });

  it("accepts a valid integrity proof from the mocked Node verifier", async () => {
    process.env.STELLA_APP_INTEGRITY_MODE = "enforce";
    process.env.APPLE_APP_ATTEST_TEAM_ID = "TEAM123";
    const test = createTest();
    const nonce = "i".repeat(43);
    await createNonce(test, nonce);
    const verifyIntegrityProof = vi.fn(async () => ({
      ok: true as const,
      platform: "ios" as const,
    }));
    const proof = encodeAppIntegrityProof({
      platform: "ios",
      purpose: "anonymous-sign-in",
      nonce,
      keyId: "a2V5LWlk",
      attestation: "YXR0ZXN0YXRpb24=",
    });

    const response = await requestAnonymousSignIn(
      test,
      { [APP_INTEGRITY_HEADER]: proof },
      verifyIntegrityProof,
    );

    expect(response.status).toBe(200);
    expect(verifyIntegrityProof).toHaveBeenCalledOnce();
    const [nonceRow, ownerOrigin] = await test.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("app_integrity_nonces")
          .withIndex("by_nonce", (query) => query.eq("nonce", nonce))
          .unique(),
        ctx.db.query("owner_origins").first(),
      ]),
    );
    expect(nonceRow?.consumedAt).toEqual(expect.any(Number));
    expect(ownerOrigin?.platform).toBe("ios");
  });

  it("returns integrity_required when no proof is present", async () => {
    process.env.STELLA_APP_INTEGRITY_MODE = "enforce";
    process.env.APPLE_APP_ATTEST_TEAM_ID = "TEAM123";

    const response = await requestAnonymousSignIn(createTest());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "integrity_required",
      message: "This request needs a verification proof.",
    });
  });

  it("returns integrity_invalid for malformed and unknown-nonce proofs", async () => {
    process.env.STELLA_APP_INTEGRITY_MODE = "enforce";
    process.env.APPLE_APP_ATTEST_TEAM_ID = "TEAM123";
    const malformed = await requestAnonymousSignIn(createTest(), {
      [APP_INTEGRITY_HEADER]: "not-a-proof",
    });
    expect(malformed.status).toBe(403);
    expect(malformed.body).toMatchObject({ code: "integrity_invalid" });

    const verifier = vi.fn(async () => ({
      ok: true as const,
      platform: "ios" as const,
    }));
    const unknownNonce = encodeAppIntegrityProof({
      platform: "ios",
      purpose: "anonymous-sign-in",
      nonce: "u".repeat(43),
      keyId: "a2V5LWlk",
      assertion: "YXNzZXJ0aW9u",
    });
    const unknown = await requestAnonymousSignIn(
      createTest(),
      { [APP_INTEGRITY_HEADER]: unknownNonce },
      verifier,
    );
    expect(unknown.status).toBe(403);
    expect(unknown.body).toMatchObject({ code: "integrity_invalid" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("returns integrity_key_unknown from the Node verifier", async () => {
    process.env.STELLA_APP_INTEGRITY_MODE = "enforce";
    process.env.APPLE_APP_ATTEST_TEAM_ID = "TEAM123";
    const test = createTest();
    const nonce = "k".repeat(43);
    await createNonce(test, nonce);
    const proof = encodeAppIntegrityProof({
      platform: "ios",
      purpose: "anonymous-sign-in",
      nonce,
      keyId: "dW5rbm93bi1rZXk=",
      assertion: "YXNzZXJ0aW9u",
    });

    const response = await requestAnonymousSignIn(
      test,
      { [APP_INTEGRITY_HEADER]: proof },
      async () => ({ ok: false, code: "integrity_key_unknown" }),
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "integrity_key_unknown",
      message: "The app integrity key is not registered.",
    });
  });

  it("allows requests without verification when mode is off", async () => {
    process.env.STELLA_APP_INTEGRITY_MODE = "off";
    process.env.APPLE_APP_ATTEST_TEAM_ID = "TEAM123";
    const verifier = vi.fn(async () => {
      throw new Error("mode off must not call platform verification");
    });
    const proof = encodeAppIntegrityProof({
      platform: "ios",
      purpose: "anonymous-sign-in",
      nonce: "o".repeat(43),
      keyId: "a2V5LWlk",
      assertion: "YXNzZXJ0aW9u",
    });

    const missing = await requestAnonymousSignIn(createTest());
    const present = await requestAnonymousSignIn(
      createTest(),
      { [APP_INTEGRITY_HEADER]: proof },
      verifier,
    );

    expect(missing.status).toBe(200);
    expect(present.status).toBe(200);
    expect(verifier).not.toHaveBeenCalled();
  });
});
