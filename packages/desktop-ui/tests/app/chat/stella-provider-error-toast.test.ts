import { describe, expect, it } from "vitest";

import {
  detectLlmRouteFailureKind,
  formatLlmRouteFailure,
  type LlmRouteFailure,
} from "@stella/contracts/llm-route-failure";
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from "@/features/chat/streaming/stella-provider-error-toast";

// Locks the runtime↔desktop contract: route failures are matched by their
// stable marker, not by human-readable prose. A reworded message must keep the
// marker (round-trip test) AND keep mapping to a specific toast.
describe("llm route failure → toast", () => {
  const failures: LlmRouteFailure[] = [
    {
      kind: "missing-credential",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-opus-4.8",
    },
    {
      kind: "unknown-model",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-opus-9.9",
    },
    {
      kind: "unsupported-provider",
      provider: "totallyfake",
      model: "totallyfake/some-model",
    },
    { kind: "no-stella-route" },
  ];

  it("round-trips format → detect for every failure kind", () => {
    for (const failure of failures) {
      expect(detectLlmRouteFailureKind(formatLlmRouteFailure(failure))).toBe(
        failure.kind,
      );
    }
  });

  it("maps each route failure to a specific (non-generic) toast", () => {
    for (const failure of failures) {
      const toast = resolveStellaProviderErrorToast(
        formatLlmRouteFailure(failure),
      );
      expect(toast.title).not.toBe("Stella hit a snag");
      expect(toast.variant).toBe("error");
      expect(toast.action).toBeDefined();
    }
  });

  it("missing-credential surfaces the BYOK key toast with both actions", () => {
    const toast = resolveStellaProviderErrorToast(
      formatLlmRouteFailure({
        kind: "missing-credential",
        provider: "openrouter",
        model: "openrouter/anthropic/claude-opus-4.8",
      }),
    );
    expect(toast.title).toBe("Provider key needed");
    expect(toast.action).toBeDefined();
    expect(toast.secondaryAction).toBeDefined();
  });

  it("keeps ordinary API-key failures out of the startup toast", () => {
    const reason =
      'Required models.json API key for provider "meta" could not be resolved.';

    expect(isStellaLimitOrAuthReason(reason)).toBe(true);
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title: "Provider access needed",
      variant: "error",
      action: expect.objectContaining({ label: "Choose model" }),
    });
  });

  it("surfaces Claude Code login failures with the CLI login steps", () => {
    const reason =
      "[claude-code/login-required] Claude Code needs login. Open Terminal, run `claude`, then use `/login`.";

    expect(isStellaLimitOrAuthReason(reason)).toBe(true);
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title: "Claude Code needs login",
      description:
        "Open Terminal, run claude, then use /login. Retry in Stella after Claude Code confirms you are signed in.",
      variant: "error",
      duration: 10000,
    });
  });

  it.each([
    {
      reason: "Context overflow: model context window is 128000 tokens.",
      title: "This chat is too long",
    },
    {
      reason: "Agent did not produce activity for 300s.",
      title: "The response timed out",
    },
    {
      reason: "ECONNRESET: socket connection closed unexpectedly",
      title: "Stella could not connect",
    },
    {
      reason:
        'Provider aborted the response (stop reason: "refusal"). This is a provider-side refusal.',
      title: "The model could not answer that",
    },
    {
      reason: "HTTP status 401: invalid provider credentials",
      title: "Provider access needed",
    },
    {
      reason: "HTTP status 422: request validation failed",
      title: "Stella could not send that request",
    },
    {
      reason: "HTTP status 503: upstream model unavailable",
      title: "Stella is having trouble connecting",
    },
    {
      reason: "HTTP status 429: capacity exhausted",
      title: "Model usage limit reached",
    },
    {
      reason: "Managed-model limits reached for this billing period.",
      title: "Stella needs more room",
    },
    {
      reason: "Unknown model selected-model-v9",
      title: "Model not available on your plan",
    },
    {
      reason: "Invalid token",
      title: "Please sign in again",
    },
    {
      reason: "Sign in required to continue",
      title: "Sign in to keep using Stella",
    },
  ])("maps $reason to a readable category", ({ reason, title }) => {
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title,
      variant: "error",
    });
  });

  it("shows a cleaned real reason for an unmapped error", () => {
    expect(
      resolveStellaProviderErrorToast(
        "[ERROR 409:CONFLICT] The response was already finalized.",
      ),
    ).toMatchObject({
      title: "Stella could not finish",
      description: "The response was already finalized.",
      variant: "error",
      duration: 10000,
    });
  });

  it("unwraps JSON error envelopes and redacts secrets", () => {
    const toast = resolveStellaProviderErrorToast(
      'Error: {"error":{"message":"Workspace sync failed for token=sk-supersecretvalue123."}}',
    );

    expect(toast.title).toBe("Stella could not finish");
    expect(toast.description).toBe(
      "Workspace sync failed for token=[redacted]",
    );
    expect(toast.description).not.toContain("supersecret");
  });

  it("keeps opaque unknown failures readable without inventing a cause", () => {
    expect(resolveStellaProviderErrorToast("Unknown error")).toMatchObject({
      title: "Stella could not finish",
      description: "Stella could not finish this response. Please try again.",
    });
  });
});

// The reactive half of the capability gate: the backend refused
// something the affordances could not pre-empt.
describe("capability denials → toast", () => {
  it("names the capability and the plan that unlocks it", () => {
    const toast = resolveStellaProviderErrorToast(
      "[capability/image_generation] capability_required",
      { audience: "free" },
    );

    expect(toast.title).toContain("Image generation");
    expect(toast.description).toContain("Pro");
    expect(toast.action).toMatchObject({ label: "Upgrade" });
  });

  it("asks signed-out users to sign in instead", () => {
    const toast = resolveStellaProviderErrorToast(
      "[capability/three_d_generation] capability_required",
      { audience: "anonymous" },
    );

    expect(toast.title).toContain("3D generation");
    expect(toast.action).toMatchObject({ label: "Sign in" });
  });

  it("still offers an upgrade path when no capability is named", () => {
    const toast = resolveStellaProviderErrorToast(
      "PAID_PLAN_REQUIRED: this action requires a Stella subscription",
      { audience: "pro" },
    );

    // A Pro account holds every capability, so a bare paid-plan
    // rejection can't be attributed to one — fall back to the generic
    // copy rather than telling a Pro user to buy Pro.
    expect(toast.title).toBe("Not included on your plan");
    expect(toast.action).toMatchObject({ label: "Upgrade" });
  });

  it("classifies the legacy paid-media prose as a capability denial", () => {
    const toast = resolveStellaProviderErrorToast(
      "Music generation requires a Stella subscription (audio_generation).",
      { audience: "go" },
    );

    expect(toast.title).toContain("Voice and music generation");
    expect(toast.action).toMatchObject({ label: "Upgrade" });
  });

  it("marks capability denials as limit/auth so cancelled runs still explain themselves", () => {
    expect(
      isStellaLimitOrAuthReason("[capability/video_generation] capability_required"),
    ).toBe(true);
  });
});

// The Free plan's $0.50 never refreshes, so its exhaustion must never be
// phrased as something to wait out.
describe("free allowance exhaustion → toast", () => {
  const reason =
    "free_allowance_exhausted: usage limit reached for this account.";

  it("is a terminal upgrade prompt, not a wait", () => {
    const toast = resolveStellaProviderErrorToast(reason);

    expect(toast.title).toBe("Your free allowance is used up");
    expect(toast.description).toContain("never resets");
    expect(toast.description).not.toContain("wait");
    expect(toast.description).not.toContain("try again");
    expect(toast.action).toMatchObject({ label: "Upgrade" });
  });

  it("wins over the generic billing matcher it shares prose with", () => {
    // "usage limit reached" alone still means the ordinary windowed cap.
    expect(
      resolveStellaProviderErrorToast("Usage limit reached.").title,
    ).toBe("Stella needs more room");
    expect(isStellaLimitOrAuthReason(reason)).toBe(true);
  });
});
