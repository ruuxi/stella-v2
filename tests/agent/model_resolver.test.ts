import { describe, expect, it } from "bun:test";

import { resolveModelConfig } from "../../convex/agent/model_resolver";
import { AGENT_IDS } from "../../convex/lib/agent_constants";

// resolveModelConfig only touches ctx.runQuery (modalities lookup); null → text-only.
const ctx = { runQuery: async () => null } as never;

describe("resolveModelConfig overrides route through the override's own gateway", () => {
  it("uses DeepSeek Light for free, anonymous, and Go General defaults", async () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "go_fallback",
    ] as const) {
      const resolved = await resolveModelConfig(
        ctx,
        AGENT_IDS.GENERAL,
        undefined,
        { audience },
      );
      expect(resolved.model).toBe(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      );
      expect(resolved.managedGatewayProvider).toBe("fireworks");
    }
  });

  it("routes a mode override through the mode's provider, not the agent default", async () => {
    // A designer override must resolve to Opus on Anthropic rather than using
    // the orchestrator's direct-xAI default provider.
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("anthropic/claude-opus-5");
    expect(resolved.managedGatewayProvider).toBe("anthropic");
  });

  it("infers the gateway for an explicit upstream override", async () => {
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/anthropic/claude-opus-5",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("anthropic/claude-opus-5");
    expect(resolved.managedGatewayProvider).toBe("anthropic");
  });

  it("ignores a mode override a restricted tier may not pick", async () => {
    // free can't override designer → falls back to the primary agent's
    // backend default (DeepSeek V4 Flash on Fireworks).
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "free",
      },
    );
    expect(resolved.model).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );
    expect(resolved.managedGatewayProvider).toBe("fireworks");
  });
});
