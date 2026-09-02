import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_TURN_CAPABILITY_TTL_MS,
} from "@stella/contracts/gateway/capability";
import {
  decodeCapabilityUnverified,
  generateCapabilityKeyPair,
  importCapabilityVerificationKeys,
  verifyCapability,
} from "@stella/contracts/gateway/jwt";
import {
  capabilitySigningKey,
  mintTurnCapabilities,
  mintTurnCapability,
  resetCapabilitySigningKeyCache,
  type TurnCapabilityInput,
} from "../src/capability-signer.js";

const pair = await generateCapabilityKeyPair();
const otherPair = await generateCapabilityKeyPair();
const KID = "builder-test";
const env = {
  CAPABILITY_SIGNING_KEY: pair.privateKeyPem,
  CAPABILITY_SIGNING_KID: KID,
};
const verificationKeys = await importCapabilityVerificationKeys({
  keys: [
    {
      kid: KID,
      jwk: pair.publicJwk,
      issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
    },
  ],
});

const NOW = 1_800_000_000_000;

const input = (
  overrides: Partial<TurnCapabilityInput> = {},
): TurnCapabilityInput => ({
  ownerId: "better-auth|owner-1",
  ownerGeneration: "generation-7",
  turnId: "turn-9",
  conversationId: "conversation-3",
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/default",
    reasoningEffort: "default",
  },
  audience: "pro",
  budgetMicroCents: 250_000_000,
  agentTypes: ["orchestrator"],
  now: NOW,
  ...overrides,
});

afterEach(() => {
  resetCapabilitySigningKeyCache();
});

describe("turn capability signer", () => {
  test("mints an ES256 turn capability the gateway verifies against the builder key", async () => {
    const minted = await mintTurnCapability(env, input());
    const verified = await verifyCapability(minted.token, verificationKeys, {
      now: NOW + 5_000,
      expectedIssuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.kid).toBe(KID);
    expect(verified.claims).toEqual(minted.claims);
    expect(verified.claims).toMatchObject({
      iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
      aud: GATEWAY_CAPABILITY_AUDIENCE,
      sub: "better-auth|owner-1",
      gen: "generation-7",
      kind: "turn",
      audience: "pro",
      agentTypes: ["orchestrator"],
      budgetMicroCents: 250_000_000,
      turn: {
        turnId: "turn-9",
        conversationId: "conversation-3",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "default",
        },
      },
    });
    expect(verified.claims.credential).toBeUndefined();
    expect(verified.claims.maxRequests).toBeUndefined();
    expect(verified.claims.iat).toBe(Math.floor(NOW / 1000));
    expect(verified.claims.exp).toBe(
      Math.floor(NOW / 1000) + GATEWAY_TURN_CAPABILITY_TTL_MS / 1000,
    );
    expect(minted.expiresAt).toBe(verified.claims.exp * 1000);
    expect(decodeCapabilityUnverified(minted.token)?.header).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: KID,
    });
  });

  test("mints a model and a control-plane capability that differ only in audience", async () => {
    const pairMinted = await mintTurnCapabilities(env, input());
    expect(pairMinted.model.claims.aud).toBe(GATEWAY_CAPABILITY_AUDIENCE);
    expect(pairMinted.controlPlane.claims.aud).toBe(
      CONTROL_PLANE_CAPABILITY_AUDIENCE,
    );
    expect(pairMinted.model.claims.jti).not.toBe(
      pairMinted.controlPlane.claims.jti,
    );
    const strip = (claims: Record<string, unknown>) => {
      const { aud, jti, ...rest } = claims;
      void aud;
      void jti;
      return rest;
    };
    expect(strip(pairMinted.model.claims)).toEqual(
      strip(pairMinted.controlPlane.claims),
    );
    const gatewayVerdict = await verifyCapability(
      pairMinted.controlPlane.token,
      verificationKeys,
      { now: NOW },
    );
    expect(gatewayVerdict).toEqual({ ok: false, reason: "audience_mismatch" });
    const controlVerdict = await verifyCapability(
      pairMinted.controlPlane.token,
      verificationKeys,
      { now: NOW, expectedAudience: CONTROL_PLANE_CAPABILITY_AUDIENCE },
    );
    expect(controlVerdict.ok).toBe(true);
    const modelVerdict = await verifyCapability(
      pairMinted.model.token,
      verificationKeys,
      { now: NOW, expectedAudience: CONTROL_PLANE_CAPABILITY_AUDIENCE },
    );
    expect(modelVerdict).toEqual({ ok: false, reason: "audience_mismatch" });
  });

  test("mints a fresh jti per turn so the gateway ledger never collides", async () => {
    const first = await mintTurnCapability(env, input());
    const second = await mintTurnCapability(env, input());
    expect(first.claims.jti).not.toBe(second.claims.jti);
    expect(first.token).not.toBe(second.token);
  });

  test("selects the native credential lane from a connected engine", async () => {
    const anthropic = await mintTurnCapability(
      env,
      input({
        execution: {
          engine: "anthropic",
          provider: "anthropic",
          model: "claude-opus-4-6",
          reasoningEffort: "high",
        },
        agentTypes: ["general"],
      }),
    );
    expect(anthropic.claims.credential).toBe("anthropic");
    const codex = await mintTurnCapability(
      env,
      input({
        execution: {
          engine: "openai-codex",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
        agentTypes: ["general"],
      }),
    );
    expect(codex.claims.credential).toBe("openai-codex");
    const verified = await verifyCapability(codex.token, verificationKeys, {
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    await expect(
      mintTurnCapability(env, input({ credential: "anthropic" })),
    ).rejects.toThrow("credential must match");
  });

  test("carries an unlimited budget sentinel unchanged", async () => {
    const minted = await mintTurnCapability(
      env,
      input({ budgetMicroCents: GATEWAY_BUDGET_UNLIMITED }),
    );
    expect(minted.claims.budgetMicroCents).toBe(GATEWAY_BUDGET_UNLIMITED);
  });

  test("refuses to mint without a complete, well-typed turn binding", async () => {
    for (const [overrides, message] of [
      [{ ownerId: " " }, "requires ownerId"],
      [{ conversationId: "" }, "requires conversationId"],
      [{ audience: "enterprise" as never }, "managed model audience"],
      [{ budgetMicroCents: Number.NaN }, "finite budget"],
      [{ agentTypes: [] }, "at least one agent type"],
      [
        {
          execution: {
            engine: "stella",
            provider: "anthropic",
            model: "stella/default",
            reasoningEffort: "default",
          } as never,
        },
        "admitted execution",
      ],
    ] as const) {
      await expect(mintTurnCapability(env, input(overrides))).rejects.toThrow(
        message,
      );
    }
  });

  test("fails closed when signing is not configured and caches an imported key", async () => {
    await expect(
      mintTurnCapability({ CAPABILITY_SIGNING_KID: KID }, input()),
    ).rejects.toThrow("not configured");
    await expect(
      mintTurnCapability(
        { CAPABILITY_SIGNING_KEY: pair.privateKeyPem, CAPABILITY_SIGNING_KID: "" },
        input(),
      ),
    ).rejects.toThrow("not configured");
    await expect(
      capabilitySigningKey({
        CAPABILITY_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----",
        CAPABILITY_SIGNING_KID: KID,
      }),
    ).rejects.toThrow();

    const first = await capabilitySigningKey(env);
    const second = await capabilitySigningKey(env);
    expect(second).toBe(first);
    const rotated = await capabilitySigningKey({
      CAPABILITY_SIGNING_KEY: otherPair.privateKeyPem,
      CAPABILITY_SIGNING_KID: "builder-2",
    });
    expect(rotated).not.toBe(first);
    expect(rotated.kid).toBe("builder-2");
  });

  test("a capability signed by another key is rejected by the gateway's JWKS", async () => {
    const minted = await mintTurnCapability(
      {
        CAPABILITY_SIGNING_KEY: otherPair.privateKeyPem,
        CAPABILITY_SIGNING_KID: KID,
      },
      input(),
    );
    const verified = await verifyCapability(minted.token, verificationKeys, {
      now: NOW,
    });
    expect(verified).toEqual({ ok: false, reason: "bad_signature" });
  });
});
