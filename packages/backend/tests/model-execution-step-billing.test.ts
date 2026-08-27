import { afterEach, describe, expect, it } from "bun:test";

import {
  deriveManagedModelBillingContext,
  streamTextWithFailover,
} from "../convex/agent/model_execution";
import type {
  ManagedDispatchBillingEnvelope,
  ManagedDispatchCapturedUsage,
} from "../convex/lib/managed_dispatch";
import type {
  ManagedDispatchGuard,
  ManagedDispatchOutcome,
} from "../convex/runtime_ai/managed";

const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

const anthropicToolCallBody = [
  {
    type: "message_start",
    message: { usage: { input_tokens: 12, output_tokens: 0 } },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "tool_call_expand_context",
      name: "expand_context",
      input: {},
    },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");

type ManagedUsageEnvelope = Extract<
  ManagedDispatchBillingEnvelope,
  { kind: "managed_usage" }
>;

describe("per-step managed model billing", () => {
  it("re-prices response-loss fallback from appended tool results and settles every receipt once", async () => {
    process.env.ANTHROPIC_API_KEY = "model-step-billing-test-key";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(anthropicToolCallBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const error = new Error("network response disappeared after admission");
      (
        error as Error & {
          providerOutcomeUnknown?: boolean;
        }
      ).providerOutcomeUnknown = true;
      throw error;
    }) as typeof fetch;

    const billingEnvelopes: ManagedUsageEnvelope[] = [];
    const capturedUsage: ManagedDispatchCapturedUsage[] = [];
    const physicalOutcomes: ManagedDispatchOutcome[] = [];
    const executionOutcomes: ManagedDispatchOutcome[] = [];
    const runController = new AbortController();
    const signal = runController.signal;
    const guard: ManagedDispatchGuard = {
      signal,
      beginDispatch: async (billing) => {
        if (billing?.kind !== "managed_usage") {
          throw new Error("Expected exact managed usage billing authority.");
        }
        billingEnvelopes.push(billing);
        let settled = false;
        return {
          signal,
          deadlineAt: Date.now() + 10_000,
          markMayHaveDispatched: async () => undefined,
          captureUsage: async (usage) => {
            capturedUsage.push(usage);
          },
          requiresUsageCapture: true,
          settle: async (outcome) => {
            if (settled) throw new Error("physical receipt settled twice");
            settled = true;
            physicalOutcomes.push(outcome);
            if (outcome === "outcome_unknown") {
              runController.abort(
                new Error("stop after the response-loss receipt finalized"),
              );
            }
          },
        };
      },
      finishExecution: async (outcome) => {
        executionOutcomes.push(outcome);
      },
    };
    const config = {
      model: "anthropic/claude-sonnet-4",
      managedGatewayProvider: "anthropic" as const,
      api: "anthropic-messages" as const,
      maxOutputTokens: 128,
    };
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Use the tool." }],
      },
    ];
    const baseBilling = deriveManagedModelBillingContext({
      identity: {
        requestFingerprint: "connector-agent-turn:logical-request",
        agentType: "proxy:offline_responder",
        conversationId: "conversation-step-billing" as never,
      },
      system: "Use tools before answering.",
      messages,
      tools: {
        expand_context: {
          name: "expand_context",
          description: "Return a large deterministic result.",
          parameters: { type: "object", properties: {} },
          execute: async () => "x".repeat(90_000),
        },
      },
      configs: [config],
    });

    await expect(
      streamTextWithFailover({
        resolvedConfig: config,
        sharedArgs: {
          system: "Use tools before answering.",
          messages,
          tools: {
            expand_context: {
              name: "expand_context",
              description: "Return a large deterministic result.",
              parameters: { type: "object", properties: {} },
              execute: async () => "x".repeat(90_000),
            },
          },
          maxSteps: 2,
          modelDispatchGuard: guard,
          modelBilling: baseBilling,
        },
      }),
    ).rejects.toThrow(/response-loss receipt|network response|aborted/iu);

    expect(billingEnvelopes.length).toBeGreaterThan(1);
    const firstStep = billingEnvelopes[0]!;
    const laterAttempts = billingEnvelopes.slice(1);
    expect(firstStep.requestFingerprint.startsWith("managed-model-step:")).toBe(
      true,
    );
    expect(firstStep.requestFingerprint).not.toBe(
      baseBilling.requestFingerprint,
    );
    expect(
      laterAttempts.every(
        (billing) =>
          billing.requestFingerprint === laterAttempts[0]!.requestFingerprint,
      ),
    ).toBe(true);
    expect(laterAttempts[0]!.requestFingerprint).not.toBe(
      firstStep.requestFingerprint,
    );
    expect(laterAttempts[0]!.fallbackCostMicroCents).toBeGreaterThan(
      firstStep.fallbackCostMicroCents,
    );
    expect(capturedUsage).toHaveLength(1);
    expect(capturedUsage[0]).toMatchObject({
      success: true,
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
    expect(physicalOutcomes).toHaveLength(billingEnvelopes.length);
    expect(physicalOutcomes[0]).toBe("succeeded");
    expect(
      physicalOutcomes.slice(1).every((value) => value === "outcome_unknown"),
    ).toBe(true);
    expect(executionOutcomes).toEqual(["aborted"]);
  });
});
