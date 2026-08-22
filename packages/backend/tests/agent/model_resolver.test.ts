import { describe, expect, it } from "bun:test";

import { resolveModelConfig } from "../../convex/agent/model_resolver";
import { AGENT_IDS } from "../../convex/lib/agent_constants";

// resolveModelConfig only touches ctx.runQuery (modalities lookup); null → text-only.
const ctx = { runQuery: async () => null } as never;

describe("resolveModelConfig single-model enforcement", () => {
  it("uses Muse Spark 1.2 Contributor for every audience's General default", async () => {
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
      expect(resolved.model).toBe("meta/muse-spark-1.2-contributor");
      expect(resolved.managedGatewayProvider).toBe("openrouter");
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
    expect(resolved.model).toBe("meta/muse-spark-1.2-contributor");
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
    expect(resolved.model).toBe("meta/muse-spark-1.2-contributor");
    expect(resolved.managedGatewayProvider).toBe("openrouter");
  });

  it("ignores a mode override a restricted tier may not pick", async () => {
    // free can't override designer → falls back to the primary agent's
    // backend default (Muse Spark 1.2 Contributor on OpenRouter).
    const resolved = await resolveModelConfig(
      ctx,
      AGENT_IDS.ORCHESTRATOR,
      undefined,
      {
        modelOverride: "stella/designer",
        audience: "free",
      },
    );
    expect(resolved.model).toBe("meta/muse-spark-1.2-contributor");
    expect(resolved.managedGatewayProvider).toBe("openrouter");
  });
});
