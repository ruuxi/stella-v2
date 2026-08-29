/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { components, internal } from "./_generated/api";
import { createAuth } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const TEST_ISSUER = "https://jwks-rotation.test";
const TEST_SECRET =
  "test-only-better-auth-secret-that-is-long-enough-for-validation";
const PUBLIC_JWKS_PATH = "/api/auth/convex/jwks";

beforeAll(() => {
  vi.stubEnv("SITE_URL", TEST_ISSUER);
  vi.stubEnv("CONVEX_SITE_URL", TEST_ISSUER);
  vi.stubEnv("BETTER_AUTH_SECRET", TEST_SECRET);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};

type MintResult = {
  token: string;
  subject: string;
  jwks: JSONWebKeySet;
};

const mintAndPublish = async (
  t: ReturnType<typeof createTest>,
): Promise<MintResult> =>
  await t.action(async (ctx): Promise<MintResult> => {
    const auth = createAuth(ctx);
    const signInResponse = await auth.handler(
      new Request(`${TEST_ISSUER}/api/auth/sign-in/anonymous`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    if (!signInResponse.ok) {
      throw new Error(
        `Anonymous sign-in failed with status ${signInResponse.status}`,
      );
    }
    const signIn = (await signInResponse.json()) as { user: { id: string } };
    const cookie = signInResponse.headers
      .getSetCookie()
      .map((value) => {
        const separator = value.indexOf(";");
        return separator === -1 ? value : value.slice(0, separator);
      })
      .join("; ");
    if (!cookie) {
      throw new Error("Anonymous sign-in did not return a session cookie");
    }

    const tokenResponse = await auth.handler(
      new Request(`${TEST_ISSUER}/api/auth/convex/token`, {
        headers: { cookie },
      }),
    );
    if (!tokenResponse.ok) {
      throw new Error(
        `Token endpoint failed with status ${tokenResponse.status}`,
      );
    }
    const signed = (await tokenResponse.json()) as { token: string };

    const jwksResponse = await auth.handler(
      new Request(`${TEST_ISSUER}${PUBLIC_JWKS_PATH}`),
    );
    if (!jwksResponse.ok) {
      throw new Error(
        `JWKS endpoint failed with status ${jwksResponse.status}`,
      );
    }
    return {
      token: signed.token,
      subject: signIn.user.id,
      jwks: (await jwksResponse.json()) as JSONWebKeySet,
    };
  });

const loadKeyRow = async (t: ReturnType<typeof createTest>, id: string) =>
  await t.query(components.betterAuth.adapter.findOne, {
    model: "jwks",
    where: [{ field: "_id", value: id }],
    select: ["_id", "createdAt", "expiresAt"],
  });

describe("graceful JWKS rotation", () => {
  it("rotates the signer while keeping old tokens verifiable", async () => {
    const t = createTest();

    const before = await mintAndPublish(t);
    const beforeKid = decodeProtectedHeader(before.token).kid;
    expect(beforeKid).toBeTruthy();

    const summary = await t.action(internal.auth.rotateKeys, {});
    expect(summary.rotated).toBe(true);
    expect(summary.previousKeyId).toBe(beforeKid);
    expect(summary.newKeyId).not.toBe(beforeKid);

    const after = await mintAndPublish(t);
    const afterKid = decodeProtectedHeader(after.token).kid;
    expect(afterKid).toBe(summary.newKeyId);
    expect(afterKid).not.toBe(beforeKid);

    const publishedKids = after.jwks.keys.map((key) => key.kid);
    expect(publishedKids).toContain(beforeKid);
    expect(publishedKids).toContain(summary.newKeyId);

    await expect(
      jwtVerify(before.token, createLocalJWKSet(after.jwks), {
        issuer: TEST_ISSUER,
        audience: "convex",
      }),
    ).resolves.toMatchObject({ payload: { sub: before.subject } });
    await expect(
      jwtVerify(after.token, createLocalJWKSet(after.jwks), {
        issuer: TEST_ISSUER,
        audience: "convex",
      }),
    ).resolves.toMatchObject({ payload: { sub: after.subject } });
  });

  it("stamps expiresAt on the previous key only", async () => {
    const t = createTest();
    await mintAndPublish(t);

    const summary = await t.action(internal.auth.rotateKeys, {});
    expect(summary.previousKeyId).toBeTruthy();

    const previousRow = await loadKeyRow(t, summary.previousKeyId as string);
    expect(previousRow).toBeTruthy();
    expect(typeof previousRow!.expiresAt).toBe("number");

    const newRow = await loadKeyRow(t, summary.newKeyId);
    expect(newRow).toBeTruthy();
    expect(newRow!.expiresAt ?? null).toBeNull();
    expect(newRow!.createdAt as number).toBeGreaterThan(
      previousRow!.createdAt as number,
    );

    const second = await t.action(internal.auth.rotateKeys, {});
    const untouched = await loadKeyRow(t, summary.previousKeyId as string);
    expect(untouched!.expiresAt).toBe(previousRow!.expiresAt);
    const secondPrevious = await loadKeyRow(t, second.previousKeyId as string);
    expect(second.previousKeyId).toBe(summary.newKeyId);
    expect(typeof secondPrevious!.expiresAt).toBe("number");
  });

  it("bootstraps a first key when the table is empty", async () => {
    const t = createTest();
    const summary = await t.action(internal.auth.rotateKeys, {});
    expect(summary.rotated).toBe(true);
    expect(summary.previousKeyId).toBeNull();

    const minted = await mintAndPublish(t);
    expect(decodeProtectedHeader(minted.token).kid).toBe(summary.newKeyId);
  });

  it("refuses to rotate in static JWKS mode", async () => {
    const t = createTest();
    const priorJwks = process.env.JWKS;
    process.env.JWKS = '{"keys":[]}';
    try {
      await expect(
        t.action(internal.auth.rotateKeys, {}),
      ).rejects.toThrow(/static keyset mode/);
    } finally {
      if (priorJwks === undefined) {
        delete process.env.JWKS;
      } else {
        process.env.JWKS = priorJwks;
      }
    }
  });

  it("never returns key material", async () => {
    const t = createTest();
    await mintAndPublish(t);
    const summary = await t.action(internal.auth.rotateKeys, {});
    expect(Object.keys(summary).sort()).toEqual([
      "newKeyId",
      "previousKeyId",
      "rotated",
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(/privateKey|publicKey|"kty"|"n":|"d":/);
  });
});
