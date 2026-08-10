import { describe, expect, it } from "bun:test";

import { resolveModelConfig } from "../../convex/agent/model_resolver";
import { AGENT_IDS } from "../../convex/lib/agent_constants";

// resolveModelConfig only touches ctx.runQuery (modalities lookup); null → text-only.
const ctx = { runQuery: async () => null } as never;

describe("resolveModelConfig single-model enforcement", () => {
  it("uses DeepSeek V4 Flash for every audience's General default", async () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "pro",
      "go_fallback",
      "pro_fallback",
    ] as const) {
      const resolved = await resolveModelConfig(
        ctx,
        AGENT_IDS.GENERAL,
        undefined,
        { audience },
      );
      expect(resolved.model).toBe("deepseek/deepseek-v4-flash");
      expect(resolved.managedGatewayProvider).toBe("deepseek");
    }
  });

  it("rejects a retired mode override even for Pro", async () => {
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.managedGatewayProvider).toBe("deepseek");
  });

  it("rejects a retired explicit upstream override even for Pro", async () => {
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/anthropic/claude-opus-5",
        audience: "pro",
      },
    );
    expect(resolved.model).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.managedGatewayProvider).toBe("deepseek");
  });

  it("ignores a mode override a restricted tier may not pick", async () => {
    // free can't override designer → falls back to the primary agent's
    // backend default (DeepSeek V4 Flash, direct).
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "free",
      },
    );
    expect(resolved.model).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.managedGatewayProvider).toBe("deepseek");
  });
});
