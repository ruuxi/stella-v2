import { describe, expect, it } from "bun:test";

import { resolveModelConfig } from "../../convex/agent/model_resolver";
import { AGENT_IDS } from "../../convex/lib/agent_constants";

// resolveModelConfig only touches ctx.runQuery (modalities lookup); null → text-only.
const ctx = { runQuery: async () => null } as never;

describe("resolveModelConfig overrides route through the override's own gateway", () => {
  it("routes a mode override through the mode's provider, not the agent default", async () => {
    // orchestrator's pro default is Kimi on Fireworks; a designer override must
    // resolve to Opus on Anthropic (not Opus mis-routed through Fireworks).
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("anthropic/claude-opus-4.8");
    expect(resolved.managedGatewayProvider).toBe("anthropic");
  });

  it("infers the gateway for an explicit upstream override", async () => {
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/anthropic/claude-opus-4.8",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("anthropic/claude-opus-4.8");
    expect(resolved.managedGatewayProvider).toBe("anthropic");
  });

  it("ignores a mode override a restricted tier may not pick", async () => {
    // free can't override designer → falls back to orchestrator's backend
    // default (Kimi on Fireworks).
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "free",
      },
    );
    expect(resolved.model).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(resolved.managedGatewayProvider).toBe("fireworks");
  });
});
