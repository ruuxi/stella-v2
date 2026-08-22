/// <reference types="vite/client" />

import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { symmetricEncrypt } from "better-auth/crypto";
import { anonymous, generateExportedKeyPair } from "better-auth/plugins";
import { convexTest } from "convex-test";
import type { AuthConfig } from "convex/server";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const TEST_ISSUER = "https://jwks-rotation.test";
const TEST_SECRET =
  "test-only-better-auth-secret-that-is-long-enough-for-validation";
const OPERATION_ID = "adapter-signing-path";
const OVERLAP_MS = 60_000;
const PUBLIC_JWKS_PATH = "/api/auth/convex/jwks";
const DAY_MS = 24 * 60 * 60 * 1_000;

const authConfig = {
  providers: [
    {
      type: "customJwt",
      issuer: TEST_ISSUER,
      applicationID: "convex",
      algorithm: "RS256",
      jwks: `${TEST_ISSUER}${PUBLIC_JWKS_PATH}`,
    },
  ],
} satisfies AuthConfig;

const authComponent = createClient<DataModel, typeof betterAuthSchema>(
  components.betterAuth,
  { local: { schema: betterAuthSchema } },
);

const createTestAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: TEST_ISSUER,
    secret: TEST_SECRET,
    database: authComponent.adapter(ctx),
    plugins: [
      anonymous(),
      convex({
        authConfig,
        jwksRotateOnTokenGenerationError: false,
        jwt: { expirationSeconds: 60 * 60 },
      }),
    ],
  } satisfies BetterAuthOptions);

type StoredTestKey = {
  publicKey: string;
  privateKey: string;
};

const generateStoredTestKey = async (): Promise<StoredTestKey> => {
  const { publicWebKey, privateWebKey } = await generateExportedKeyPair({
    jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
  });
  return {
    publicKey: JSON.stringify(publicWebKey),
    privateKey: JSON.stringify(
      await symmetricEncrypt({
        key: TEST_SECRET,
        data: JSON.stringify(privateWebKey),
      }),
    ),
  };
};

let oldKey: StoredTestKey;
let candidateKey: StoredTestKey;

beforeAll(async () => {
  vi.stubEnv("CONVEX_SITE_URL", TEST_ISSUER);
  [oldKey, candidateKey] = await Promise.all([
    generateStoredTestKey(),
    generateStoredTestKey(),
  ]);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};

const insertKey = async (
  t: ReturnType<typeof createTest>,
  key: StoredTestKey,
  createdAt: number,
  expiresAt?: number,
) =>
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "jwks",
      data: {
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        createdAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    },
  });

const loadKey = async (t: ReturnType<typeof createTest>, id: string) =>
  await t.query(components.betterAuth.adapter.findOne, {
    model: "jwks",
    where: [{ field: "_id", value: id }],
    select: ["_id", "_creationTime", "createdAt"],
  });

const mintAndPublish = async (t: ReturnType<typeof createTest>) =>
  await t.action(async (ctx) => {
    const auth = createTestAuth(ctx);
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
    const setCookies = signInResponse.headers.getSetCookie();
    const cookie = setCookies
      .map((value) => {
        const separator = value.indexOf(";");
        return separator === -1 ? value : value.slice(0, separator);
      })
      .join("; ");
    if (!cookie) {
      throw new Error("Anonymous sign-in did not return a session cookie");
    }

    // /convex/token reaches the pinned getJwksAdapter().getLatestKey
    // implementation. The second HTTP request exercises the real public JWKS
    // route and its publication filter.
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
    const response = await auth.handler(
      new Request(`${TEST_ISSUER}${PUBLIC_JWKS_PATH}`),
    );
    if (!response.ok) {
      throw new Error(`JWKS endpoint failed with status ${response.status}`);
    }
    return {
      token: signed.token,
      subject: signIn.user.id,
      jwks: (await response.json()) as JSONWebKeySet,
    };
  });

const expectPublishedKeyIds = (jwks: JSONWebKeySet, expectedIds: string[]) => {
  expect(jwks.keys.map((key) => key.kid).sort()).toEqual(
    [...expectedIds].sort(),
  );
  for (const key of jwks.keys) {
    expect(key).not.toHaveProperty("privateKey");
    expect(key).not.toHaveProperty("publicKey");
    expect(key).not.toHaveProperty("createdAt");
    expect(key).not.toHaveProperty("expiresAt");
    expect(key).not.toHaveProperty("d");
  }
};

const verifyPublishedToken = async (
  token: string,
  jwks: JSONWebKeySet,
  subject: string,
) =>
  await expect(
    jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: TEST_ISSUER,
      audience: "convex",
    }),
  ).resolves.toMatchObject({ payload: { sub: subject } });

describe("Better Auth adapter JWKS rotation integration", () => {
  it("signs by stored createdAt and publishes both overlap keys", async () => {
    const t = createTest();
    const preparedAt = Date.now();
    const staleKey = await insertKey(
      t,
      oldKey,
      preparedAt - 2_000,
      preparedAt - 31 * DAY_MS,
    );
    const previousKey = await insertKey(t, oldKey, preparedAt - 1_000);

    const prepared = await t.mutation(
      components.betterAuth.jwksRotation.prepareRotation,
      {
        operationId: OPERATION_ID,
        nowMs: preparedAt,
        publicKey: candidateKey.publicKey,
        privateKey: candidateKey.privateKey,
      },
    );
    expect(prepared.state).toBe("prepared");
    const candidateDocument = await loadKey(t, prepared.newKeyId);
    expect(candidateDocument).toBeDefined();
    expect(candidateDocument._creationTime).toBeGreaterThan(
      previousKey._creationTime,
    );
    expect(candidateDocument.createdAt).toBeLessThan(previousKey.createdAt);

    const preparedState = await mintAndPublish(t);
    expect(decodeProtectedHeader(preparedState.token).kid).toBe(
      previousKey._id,
    );
    expectPublishedKeyIds(preparedState.jwks, [
      previousKey._id,
      prepared.newKeyId,
    ]);
    expect(preparedState.jwks.keys.map((key) => key.kid)).not.toContain(
      staleKey._id,
    );

    const active = await t.mutation(
      components.betterAuth.jwksRotation.activateRotation,
      {
        operationId: OPERATION_ID,
        nowMs: preparedAt + 1,
        overlapMs: OVERLAP_MS,
      },
    );
    expect(active.state).toBe("active");
    const activeState = await mintAndPublish(t);
    expect(decodeProtectedHeader(activeState.token).kid).toBe(
      prepared.newKeyId,
    );
    expectPublishedKeyIds(activeState.jwks, [
      previousKey._id,
      prepared.newKeyId,
    ]);
    await verifyPublishedToken(
      preparedState.token,
      activeState.jwks,
      preparedState.subject,
    );

    const rolledBack = await t.mutation(
      components.betterAuth.jwksRotation.rollbackRotation,
      {
        operationId: OPERATION_ID,
        nowMs: preparedAt + 2,
        overlapMs: OVERLAP_MS,
      },
    );
    expect(rolledBack.state).toBe("rolled_back");
    const rollbackState = await mintAndPublish(t);
    expect(decodeProtectedHeader(rollbackState.token).kid).toBe(
      previousKey._id,
    );
    expectPublishedKeyIds(rollbackState.jwks, [
      previousKey._id,
      prepared.newKeyId,
    ]);
    await verifyPublishedToken(
      activeState.token,
      rollbackState.jwks,
      activeState.subject,
    );
    await verifyPublishedToken(
      rollbackState.token,
      rollbackState.jwks,
      rollbackState.subject,
    );
  });
});
