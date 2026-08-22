/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  inspectStaticJwks,
  resolveJwksRuntimeConfig,
} from "../lib/jwks_config";
import {
  writeJwksAuditRecord,
  type JwksRotationSummary,
} from "../lib/jwks_rotation";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type TestKey = {
  publicKey: string;
  privateKey: string;
  privateJwk: JWK;
};

let oldKey: TestKey;
let candidateKey: TestKey;

const generateTestKey = async (): Promise<TestKey> => {
  const pair = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const publicJwk = await exportJWK(pair.publicKey);
  const privateJwk = await exportJWK(pair.privateKey);
  return {
    publicKey: JSON.stringify(publicJwk),
    // Component lifecycle tests use ephemeral keys and do not exercise Better
    // Auth's encryption layer. Production generation encrypts before insert.
    privateKey: JSON.stringify(privateJwk),
    privateJwk,
  };
};

beforeAll(async () => {
  [oldKey, candidateKey] = await Promise.all([
    generateTestKey(),
    generateTestKey(),
  ]);
});

const createTest = () => convexTest(schema, modules);

const seedKey = async (
  t: ReturnType<typeof createTest>,
  key: TestKey,
  createdAt: number,
) =>
  await t.run(
    async (ctx) =>
      await ctx.db.insert("jwks", {
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        createdAt,
      }),
  );

const collectKeys = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) => await ctx.db.query("jwks").collect());

const publicKeyset = async (t: ReturnType<typeof createTest>) => ({
  keys: (await collectKeys(t)).map((key) => ({
    ...(JSON.parse(key.publicKey) as JWK),
    kid: String(key._id),
    alg: "RS256",
    use: "sig",
  })),
});

const sign = async (key: TestKey, kid: string, subject: string) => {
  const importedKey = await importJWK(key.privateJwk, "RS256");
  return await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(importedKey);
};

const signWithDatabaseKey = async (
  t: ReturnType<typeof createTest>,
  subject: string,
) => {
  const keys = await collectKeys(t);
  const signingKey = [...keys].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!signingKey) {
    throw new Error("test signing key is missing");
  }
  const privateJwk = JSON.parse(signingKey.privateKey) as JWK;
  const importedKey = await importJWK(privateJwk, "RS256");
  const token = await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: "RS256", kid: String(signingKey._id) })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(importedKey);
  return { token, kid: String(signingKey._id) };
};

const verify = async (token: string, t: ReturnType<typeof createTest>) =>
  await jwtVerify(token, createLocalJWKSet(await publicKeyset(t)));

describe("overlapping JWKS rotation", () => {
  it("activates the candidate for signing while old tokens still verify", async () => {
    const t = createTest();
    const oldKeyId = await seedKey(t, oldKey, 1_000);
    const oldToken = await sign(oldKey, String(oldKeyId), "old-token");

    const prepared = await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-overlap",
      nowMs: 10_000,
      publicKey: candidateKey.publicKey,
      privateKey: candidateKey.privateKey,
    });
    const beforeActivation = await signWithDatabaseKey(t, "before-activation");
    expect(beforeActivation.kid).toBe(String(oldKeyId));

    const active = await t.mutation(api.jwksRotation.activateRotation, {
      operationId: "rotation-overlap",
      nowMs: 11_000,
      overlapMs: 60_000,
    });
    const afterActivation = await signWithDatabaseKey(t, "after-activation");

    expect(active.state).toBe("active");
    expect(afterActivation.kid).toBe(prepared.newKeyId);
    expect(afterActivation.kid).not.toBe(String(oldKeyId));
    await expect(verify(oldToken, t)).resolves.toMatchObject({
      payload: { sub: "old-token" },
    });
    await expect(verify(afterActivation.token, t)).resolves.toMatchObject({
      payload: { sub: "after-activation" },
    });
    expect(await collectKeys(t)).toHaveLength(2);
  });

  it("refuses retirement until the complete overlap has elapsed", async () => {
    const t = createTest();
    const oldKeyId = await seedKey(t, oldKey, 1_000);
    const oldToken = await sign(oldKey, String(oldKeyId), "old-token");
    await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-retirement",
      nowMs: 10_000,
      publicKey: candidateKey.publicKey,
      privateKey: candidateKey.privateKey,
    });
    await t.mutation(api.jwksRotation.activateRotation, {
      operationId: "rotation-retirement",
      nowMs: 10_000,
      overlapMs: 60_000,
    });

    await expect(
      t.mutation(api.jwksRotation.retireRotation, {
        operationId: "rotation-retirement",
        nowMs: 69_999,
      }),
    ).rejects.toThrow("Retirement is not yet allowed");
    await expect(verify(oldToken, t)).resolves.toBeDefined();

    const retired = await t.mutation(api.jwksRotation.retireRotation, {
      operationId: "rotation-retirement",
      nowMs: 70_000,
    });
    expect(retired.state).toBe("retired");
    expect(await collectKeys(t)).toHaveLength(1);
    await expect(verify(oldToken, t)).rejects.toThrow();

    const retry = await t.mutation(api.jwksRotation.retireRotation, {
      operationId: "rotation-retirement",
      nowMs: 70_001,
    });
    expect(retry).toEqual(retired);
  });

  it("makes preparation, activation, rollback, and retry recoverable", async () => {
    const t = createTest();
    const oldKeyId = await seedKey(t, oldKey, 1_000);
    const prepared = await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-retry",
      nowMs: 10_000,
      publicKey: candidateKey.publicKey,
      privateKey: candidateKey.privateKey,
    });
    const prepareRetry = await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-retry",
      nowMs: 10_001,
      publicKey: oldKey.publicKey,
      privateKey: oldKey.privateKey,
    });
    expect(prepareRetry).toEqual(prepared);
    expect(await collectKeys(t)).toHaveLength(2);

    const active = await t.mutation(api.jwksRotation.activateRotation, {
      operationId: "rotation-retry",
      nowMs: 11_000,
      overlapMs: 60_000,
    });
    const activationRetry = await t.mutation(
      api.jwksRotation.activateRotation,
      {
        operationId: "rotation-retry",
        nowMs: 11_001,
        overlapMs: 60_000,
      },
    );
    expect(activationRetry).toEqual(active);
    const candidateToken = await signWithDatabaseKey(t, "candidate-token");
    expect(candidateToken.kid).toBe(prepared.newKeyId);

    const rolledBack = await t.mutation(api.jwksRotation.rollbackRotation, {
      operationId: "rotation-retry",
      nowMs: 20_000,
      overlapMs: 60_000,
    });
    const rollbackRetry = await t.mutation(api.jwksRotation.rollbackRotation, {
      operationId: "rotation-retry",
      nowMs: 20_001,
      overlapMs: 60_000,
    });
    expect(rollbackRetry).toEqual(rolledBack);
    expect((await signWithDatabaseKey(t, "restored")).kid).toBe(
      String(oldKeyId),
    );
    await expect(verify(candidateToken.token, t)).resolves.toBeDefined();

    await expect(
      t.mutation(api.jwksRotation.retireRotation, {
        operationId: "rotation-retry",
        nowMs: 79_999,
      }),
    ).rejects.toThrow("Retirement is not yet allowed");
    await t.mutation(api.jwksRotation.retireRotation, {
      operationId: "rotation-retry",
      nowMs: 80_000,
    });
    expect((await collectKeys(t)).map((key) => String(key._id))).toEqual([
      String(oldKeyId),
    ]);

    const terminalRetry = await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-retry",
      nowMs: 90_000,
      publicKey: candidateKey.publicKey,
      privateKey: candidateKey.privateKey,
    });
    expect(terminalRetry.state).toBe("retired");
    expect(await collectKeys(t)).toHaveLength(1);
  });

  it("keeps operator responses and audit logs free of key material", async () => {
    const t = createTest();
    await seedKey(t, oldKey, 1_000);
    const prepared = await t.mutation(api.jwksRotation.prepareRotation, {
      operationId: "rotation-safe-log",
      nowMs: 10_000,
      publicKey: candidateKey.publicKey,
      privateKey: candidateKey.privateKey,
    });
    const serialized = JSON.stringify(prepared);
    const candidatePublicJwk = JSON.parse(candidateKey.publicKey) as JWK;
    expect(serialized).not.toContain("publicKey");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain(candidatePublicJwk.n ?? "public-n");
    expect(serialized).not.toContain(candidateKey.privateJwk.d ?? "private-d");

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    writeJwksAuditRecord("rotation", prepared as JwksRotationSummary);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("rotation-safe-log");
    expect(logged).not.toContain("publicKey");
    expect(logged).not.toContain("privateKey");
    expect(logged).not.toContain(candidatePublicJwk.n ?? "public-n");
    expect(logged).not.toContain(candidateKey.privateJwk.d ?? "private-d");
    log.mockRestore();
  });

  it("keeps legacy static behavior, supports a dormant fallback, and fails closed", () => {
    const staticJwks = JSON.stringify([
      {
        id: "legacy-key",
        alg: "RS256",
        createdAt: "2025-01-01T00:00:00.000Z",
        publicKey: oldKey.publicKey,
        privateKey: "encrypted-test-value",
      },
    ]);

    expect(resolveJwksRuntimeConfig({ JWKS: staticJwks })).toEqual({
      mode: "static",
      staticJwks,
    });
    expect(
      resolveJwksRuntimeConfig({
        JWKS: staticJwks,
        STELLA_JWKS_MODE: "dynamic",
      }),
    ).toEqual({ mode: "dynamic" });
    expect(() =>
      resolveJwksRuntimeConfig({ STELLA_JWKS_MODE: "static" }),
    ).toThrow("requires JWKS");
    expect(() =>
      resolveJwksRuntimeConfig({
        JWKS: "not-json",
        STELLA_JWKS_MODE: "static",
      }),
    ).toThrow("JWKS is invalid");
    expect(() =>
      resolveJwksRuntimeConfig({
        JWKS: JSON.stringify([
          {
            ...JSON.parse(staticJwks)[0],
            publicKey: JSON.stringify({
              ...(JSON.parse(oldKey.publicKey) as JWK),
              d: "private-material-does-not-belong-in-a-public-jwk",
            }),
          },
        ]),
      }),
    ).toThrow("JWKS is invalid");
    expect(() =>
      resolveJwksRuntimeConfig({ STELLA_JWKS_MODE: "surprise" }),
    ).toThrow("Refusing to guess");
  });

  it("blocks phase 1 on malformed static JWKS without exposing values", () => {
    const encryptedSentinel = "encrypted-private-jwk-must-not-escape";
    const publicSentinel = "malformed-public-jwk-must-not-escape";
    const malformedStaticJwks = JSON.stringify([
      {
        id: "legacy-key",
        alg: "RS256",
        createdAt: "2025-01-01T00:00:00.000Z",
        publicKey: publicSentinel,
        privateKey: encryptedSentinel,
      },
    ]);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    let failure: unknown;
    try {
      resolveJwksRuntimeConfig({
        JWKS: malformedStaticJwks,
        STELLA_JWKS_MODE: "static",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(message).toBe(
      "JWKS is invalid. Refusing to start with an ambiguous static signing keyset.",
    );
    expect(message).not.toContain(publicSentinel);
    expect(message).not.toContain(encryptedSentinel);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();

    const validStaticJwks = JSON.stringify([
      {
        id: "legacy-key",
        alg: "RS256",
        createdAt: "2025-01-01T00:00:00.000Z",
        publicKey: oldKey.publicKey,
        privateKey: encryptedSentinel,
      },
    ]);
    const metadata = inspectStaticJwks(validStaticJwks);
    expect(metadata).toMatchObject({
      signingKeyId: "legacy-key",
      keys: [{ id: "legacy-key" }],
    });
    expect(JSON.stringify(metadata)).not.toContain(encryptedSentinel);
    expect(metadata?.keys[0]).not.toHaveProperty("privateKey");
  });

  it("refuses ambiguous signing order and non-exact migration keysets", async () => {
    const t = createTest();
    const oldKeyId = await seedKey(t, oldKey, 1_000);
    const candidateKeyId = await seedKey(t, candidateKey, 1_000);
    const staticKeys = [
      { id: String(oldKeyId), publicKey: oldKey.publicKey },
      { id: String(candidateKeyId), publicKey: candidateKey.publicKey },
    ];

    const status = await t.query(api.jwksRotation.getKeysetStatus, {});
    expect(status.signingKeyUsable).toBe(false);

    const ambiguous = await t.query(
      api.jwksRotation.checkStaticKeysetMatch,
      {
        staticKeys,
        staticSigningKeyId: status.signingKeyId!,
      },
    );
    expect(ambiguous.allStaticKeysMatch).toBe(true);
    expect(ambiguous.signingKeyMatches).toBe(false);

    const incomplete = await t.query(
      api.jwksRotation.checkStaticKeysetMatch,
      {
        staticKeys: staticKeys.slice(0, 1),
        staticSigningKeyId: String(oldKeyId),
      },
    );
    expect(incomplete.allStaticKeysMatch).toBe(false);
    expect(incomplete.signingKeyMatches).toBe(false);
  });
});
