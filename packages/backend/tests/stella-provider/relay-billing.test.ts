import { describe, expect, it } from "bun:test";

import {
  mergeRelayBillingFinalization,
  normalizeRelayBillingUsage,
  relayBillingUsageForDelivery,
} from "../../convex/stella_provider/relay_billing";

describe("resumable relay billing receipts", () => {
  it("charges only estimated prompt work for pre-header and accepted cancellations without usage", () => {
    for (const phase of ["pre-header", "post-header-pre-activation"] as const) {
      expect(
        relayBillingUsageForDelivery({
          estimatedInputTokens: 120,
          estimatedOutputTokens: 900,
          success: false,
          hasActualUsage: false,
        }),
        phase,
      ).toEqual({ inputTokens: 120, outputTokens: 0, totalTokens: 120 });
    }
  });

  it("uses the full conservative estimate for a successful response with no terminal usage", () => {
    expect(
      relayBillingUsageForDelivery({
        estimatedInputTokens: 120,
        estimatedOutputTokens: 900,
        success: true,
        hasActualUsage: false,
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 900, totalTokens: 1_020 });
  });

  it("uses provider-reported mid-stream usage instead of either estimate", () => {
    const actualUsage = {
      inputTokens: 71,
      outputTokens: 19,
      totalTokens: 90,
      cachedInputTokens: 30,
      reasoningTokens: 7,
      costMicroCents: 55,
    };
    expect(
      relayBillingUsageForDelivery({
        estimatedInputTokens: 120,
        estimatedOutputTokens: 900,
        success: false,
        hasActualUsage: true,
        actualUsage,
      }),
    ).toEqual(actualUsage);
  });

  it("projects provider diagnostics out of Convex billing payloads", () => {
    const parsedUsage = {
      inputTokens: 71,
      outputTokens: 19,
      totalTokens: 90,
      cachedInputTokens: 30,
      reasoningTokens: 7,
      model: "meta/muse-spark-1.2-contributor",
    };

    expect(normalizeRelayBillingUsage(parsedUsage)).toEqual({
      inputTokens: 71,
      outputTokens: 19,
      totalTokens: 90,
      cachedInputTokens: 30,
      reasoningTokens: 7,
    });
    expect(
      relayBillingUsageForDelivery({
        estimatedInputTokens: 120,
        estimatedOutputTokens: 900,
        success: true,
        hasActualUsage: true,
        actualUsage: parsedUsage,
      }),
    ).not.toHaveProperty("model");
  });

  it("keeps the first terminal result while allowing one unbilled actual-usage upgrade", () => {
    const first = mergeRelayBillingFinalization(
      { hasActualUsage: false },
      {
        terminalStatus: "canceled",
        success: false,
        durationMs: 80,
      },
    );
    expect(first).toEqual({
      terminalStatus: "canceled",
      success: false,
      durationMs: 80,
      hasActualUsage: false,
      actualUsage: undefined,
    });

    const actualUsage = { inputTokens: 50, outputTokens: 4, totalTokens: 54 };
    expect(
      mergeRelayBillingFinalization(
        {
          terminalStatus: "canceled",
          success: false,
          durationMs: 80,
          hasActualUsage: false,
        },
        {
          terminalStatus: "completed",
          success: true,
          durationMs: 100,
          actualUsage,
        },
      ),
    ).toEqual({
      durationMs: 100,
      hasActualUsage: true,
      actualUsage,
    });
  });

  it("makes duplicate and post-billing finalizers no-ops", () => {
    const terminal = {
      terminalStatus: "completed" as const,
      success: true,
      durationMs: 100,
      hasActualUsage: true,
      actualUsage: { inputTokens: 10, outputTokens: 5 },
    };
    expect(
      mergeRelayBillingFinalization(terminal, {
        terminalStatus: "completed",
        success: true,
        durationMs: 100,
        actualUsage: terminal.actualUsage,
      }),
    ).toBeNull();
    expect(
      mergeRelayBillingFinalization(
        { ...terminal, billedAt: 123 },
        {
          terminalStatus: "canceled",
          success: false,
          durationMs: 200,
          actualUsage: { inputTokens: 999 },
        },
      ),
    ).toBeNull();
  });
});
