import { describe, expect, test } from "bun:test";
import {
  generateCapabilityKeyPair,
  importCapabilitySigningKey,
  importCapabilityVerificationKeys,
  signCapability,
  verifyCapability,
  validateCapabilityClaims,
} from "./jwt.js";
import {

  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_ISSUERS,
  type GatewayJwks,
} from "./capability.js";

const setup = async () => {
  const sessionPair = await generateCapabilityKeyPair();
  const builderPair = await generateCapabilityKeyPair();
  const jwks: GatewayJwks = {
    keys: [
      { kid: "builder-2", jwk: sessionPair.publicJwk, issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder },
      { kid: "builder-1", jwk: builderPair.publicJwk, issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder },
    ],
  };
  return {
    sessionKey: await importCapabilitySigningKey(sessionPair.privateKeyPem, "builder-2"),
    builderKey: await importCapabilitySigningKey(builderPair.privateKeyPem, "builder-1"),
    verification: await importCapabilityVerificationKeys(jwks),
  };
};

describe("capability jwt", () => {
  test("round-trips a session capability", async () => {
    const { sessionKey, verification } = await setup();
    const signed = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        sub: "user_1",
        gen: "gen-1",
        kind: "session",
        audience: "pro",
        budgetMicroCents: 5_000_000,
      },
      sessionKey,
      { ttlMs: 60_000 },
    );
    const result = await verifyCapability(signed.token, verification);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe("user_1");
    expect(result.claims.kind).toBe("session");
    expect(result.claims.jti).toBe(signed.claims.jti);
    expect(validateCapabilityClaims({ ...signed.claims, ledgerScope: "owner-relay-v2" })).toBe(true);
    expect(validateCapabilityClaims({ ...signed.claims, ledgerScope: "unsupported" })).toBe(false);
    expect(result.kid).toBe("builder-2");
  });

  test("round-trips a turn capability with execution binding", async () => {
    const { builderKey, verification } = await setup();
    const signed = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        sub: "owner",
        gen: "gen-1",
        kind: "turn",
        audience: "free",
        budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
        agentTypes: ["orchestrator"],
        turn: {
          turnId: "turn-1",
          conversationId: "conv-1",
          execution: {
            engine: "stella",
            provider: "stella",
            model: "stella/light",
            reasoningEffort: "medium",
          },
        },
      },
      builderKey,
      { ttlMs: 60_000 },
    );
    const result = await verifyCapability(signed.token, verification, {
      expectedIssuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.turn?.execution.model).toBe("stella/light");
  });

  test("rejects a token whose issuer is not a known issuer", async () => {
    const { sessionKey, verification } = await setup();
    const signed = await signCapability(
      {
        iss: "stella-retired" as never,
        sub: "owner",
        gen: "gen-1",
        kind: "session",
        audience: "pro",
        budgetMicroCents: 1,
      },
      sessionKey,
      { ttlMs: 60_000 },
    );
    const result = await verifyCapability(signed.token, verification);
    expect(result).toEqual({ ok: false, reason: "invalid_claims" });
  });

  test("rejects tampered payloads and expired tokens", async () => {
    const { sessionKey, verification } = await setup();
    const signed = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        sub: "owner",
        gen: "gen-1",
        kind: "session",
        audience: "pro",
        budgetMicroCents: 1,
      },
      sessionKey,
      { ttlMs: 60_000, now: Date.now() - 10 * 60_000 },
    );
    const expired = await verifyCapability(signed.token, verification);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    const [h, p, s] = signed.token.split(".");
    const tampered = `${h}.${p}x.${s}`;
    const bad = await verifyCapability(tampered, verification, {
      now: Date.now() - 10 * 60_000,
    });
    expect(bad.ok).toBe(false);
    const unknown = await verifyCapability(`${h}.${p}.${s}`.replace("builder-2", "nope"), verification);
    expect(unknown.ok).toBe(false);
  });
});
