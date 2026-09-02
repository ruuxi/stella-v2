import { describe, expect, it } from "bun:test";
import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
} from "@stella/contracts/gateway/capability";
import {
  generateCapabilityKeyPair,
  importCapabilitySigningKey,
  signCapability,
} from "@stella/contracts/gateway/jwt";
import {
  capabilityAllowsAgentType,
  verifyControlPlaneCapability,
} from "../../convex/lib/capability_verify";

const turn = {
  turnId: "turn-1",
  conversationId: "conv-1",
  execution: {
    engine: "stella" as const,
    provider: "stella" as const,
    model: "stella/default",
    reasoningEffort: "default" as const,
  },
};

const setup = async () => {
  const pair = await generateCapabilityKeyPair();
  const signingKey = await importCapabilitySigningKey(pair.privateKeyPem, "builder-1");
  const env = {
    CAPABILITY_JWKS: JSON.stringify({
      keys: [{ kid: "builder-1", issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder, jwk: pair.publicJwk }],
    }),
  };
  const mint = (claims: Record<string, unknown>) =>
    signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        aud: CONTROL_PLANE_CAPABILITY_AUDIENCE,
        sub: "owner-1",
        gen: "gen-1",
        kind: "turn",
        audience: "pro",
        budgetMicroCents: 10,
        turn,
        ...claims,
      } as never,
      signingKey,
      { ttlMs: 60_000 },
    ).then((signed) => signed.token);
  return { env, mint };
};

describe("verifyControlPlaneCapability", () => {
  it("returns the turn authority for a builder control-plane turn capability", async () => {
    const { env, mint } = await setup();
    const result = await verifyControlPlaneCapability(await mint({ agentTypes: ["orchestrator"] }), { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authority).toMatchObject({
      ownerId: "owner-1",
      ownerGeneration: "gen-1",
      turnId: "turn-1",
      conversationId: "conv-1",
      execution: turn.execution,
      agentTypes: ["orchestrator"],
    });
    expect(capabilityAllowsAgentType(result.authority, "orchestrator")).toBe(true);
    expect(capabilityAllowsAgentType(result.authority, "general")).toBe(false);
    expect(capabilityAllowsAgentType({}, "general")).toBe(true);
  });

  it("refuses the model-gateway audience, session capabilities, and other issuers", async () => {
    const { env, mint } = await setup();
    expect(await verifyControlPlaneCapability(await mint({ aud: GATEWAY_CAPABILITY_AUDIENCE }), { env })).toEqual({
      ok: false,
      reason: "audience_mismatch",
    });
    expect(
      await verifyControlPlaneCapability(await mint({ kind: "session", turn: undefined }), { env }),
    ).toEqual({ ok: false, reason: "not_turn" });
    expect(
      await verifyControlPlaneCapability(await mint({ iss: GATEWAY_CAPABILITY_ISSUERS.convex }), { env }),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
    expect(await verifyControlPlaneCapability("", { env })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyControlPlaneCapability("abc", { env: {} })).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("re-imports keys when the JWKS env changes", async () => {
    const first = await setup();
    const second = await setup();
    const token = await first.mint({});
    expect((await verifyControlPlaneCapability(token, { env: first.env })).ok).toBe(true);
    // Same kid, rotated key: the cache must not keep verifying with the old
    // material once the env changed.
    expect(await verifyControlPlaneCapability(token, { env: second.env })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect((await verifyControlPlaneCapability(token, { env: first.env })).ok).toBe(true);
  });
});
