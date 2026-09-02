import { describe, expect, it } from "bun:test";

import {
  resolveFallbackConfig,
  resolveModelConfig,
} from "../../convex/agent/model_resolver";
import { AGENT_IDS } from "../../convex/lib/agent_constants";

// resolveModelConfig only touches ctx.runQuery (modalities lookup); null → text-only.
const ctx = { runQuery: async () => null } as never;

describe("resolveModelConfig single-model enforcement", () => {
  it("uses Muse with a DeepSeek fallback for every audience's General default", async () => {
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
      expect(resolved.model).toBe("meta/muse-spark-1.3-contributor");
      expect(resolved.managedGatewayProvider).toBe("openrouter");
      expect(resolved.api).toBe("openai-responses");

      const fallback = await resolveFallbackConfig(
        ctx,
        AGENT_IDS.GENERAL,
        undefined,
        { audience },
      );
      expect(fallback).toMatchObject({
        model: "crof/deepseek-v4-flash-0731",
        managedGatewayProvider: "crof",
      });
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
    expect(resolved.model).toBe("meta/muse-spark-1.3-contributor");
    expect(resolved.managedGatewayProvider).toBe("openrouter");
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
    expect(resolved.model).toBe("meta/muse-spark-1.3-contributor");
    expect(resolved.managedGatewayProvider).toBe("openrouter");
  });

  it("ignores a mode override a restricted tier may not pick", async () => {
    // free can't override designer, so it uses the primary agent's Muse
    // default. DeepSeek remains the execution fallback, not the default.
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "free",
      },
    );
    expect(resolved.model).toBe("meta/muse-spark-1.3-contributor");
    expect(resolved.managedGatewayProvider).toBe("openrouter");
  });
});
