import { describe, expect, it } from "bun:test";
import {
  decodeCapabilityUnverified,
  generateCapabilityKeyPair,
  importCapabilitySigningKey as importContractsSigningKey,
  importCapabilityVerificationKeys,
  signCapability as signWithContracts,
  verifyCapability,
} from "@stella/contracts/gateway/jwt";
import {
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
} from "@stella/contracts/gateway/capability";
import {
  importCapabilitySigningKey,
  signCapability,
} from "../../convex/lib/capability_signing";

const KID = "convex-test";

const claims = {
  iss: GATEWAY_CAPABILITY_ISSUERS.convex,
  sub: "https://convex.test|owner",
  gen: "generation-1",
  kind: "session" as const,
  audience: "free" as const,
  budgetMicroCents: 500_000_000,
  maxRequests: 3,
  jti: "fixed-jti",
  iat: 1_700_000_000,
  exp: 1_700_003_600,
};

describe("Convex capability signing (jose) against contracts verification", () => {
  it("mints tokens the contracts verifier accepts with the same claims", async () => {
    const pair = await generateCapabilityKeyPair();
    const signingKey = await importCapabilitySigningKey(pair.privateKeyPem, KID);
    const { token } = await signCapability(claims, signingKey, {
      ttlMs: GATEWAY_SESSION_CAPABILITY_TTL_MS,
    });
    const keys = await importCapabilityVerificationKeys({
      keys: [{ kid: KID, issuer: GATEWAY_CAPABILITY_ISSUERS.convex, jwk: pair.publicJwk }],
    });
    const verified = await verifyCapability(token, keys, {
      now: claims.iat * 1000 + 1_000,
      expectedIssuer: GATEWAY_CAPABILITY_ISSUERS.convex,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.kid).toBe(KID);
    expect(verified.claims).toEqual({ ...claims, aud: "stella-model-gateway" });
  });

  it("produces the same signing input (header and payload bytes) as the contracts signer", async () => {
    const pair = await generateCapabilityKeyPair();
    const [joseKey, contractsKey] = await Promise.all([
      importCapabilitySigningKey(pair.privateKeyPem, KID),
      importContractsSigningKey(pair.privateKeyPem, KID),
    ]);
    const [jose, contracts] = await Promise.all([
      signCapability(claims, joseKey, { ttlMs: 1 }),
      signWithContracts(claims, contractsKey, { ttlMs: 1 }),
    ]);
    const [joseHeader, josePayload] = jose.token.split(".");
    const [contractsHeader, contractsPayload] = contracts.token.split(".");
    expect(joseHeader).toBe(contractsHeader);
    expect(josePayload).toBe(contractsPayload);
    expect(decodeCapabilityUnverified(jose.token)?.header).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: KID,
    });
  });

  it("is rejected by the verifier under an unknown key id", async () => {
    const pair = await generateCapabilityKeyPair();
    const other = await generateCapabilityKeyPair();
    const signingKey = await importCapabilitySigningKey(pair.privateKeyPem, KID);
    const { token } = await signCapability(claims, signingKey, { ttlMs: 1 });
    const keys = await importCapabilityVerificationKeys({
      keys: [{ kid: KID, issuer: GATEWAY_CAPABILITY_ISSUERS.convex, jwk: other.publicJwk }],
    });
    const verified = await verifyCapability(token, keys, { now: claims.iat * 1000 });
    expect(verified).toEqual({ ok: false, reason: "bad_signature" });
  });
});
