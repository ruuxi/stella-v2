/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  deriveManagedModelBillingContext,
  streamTextWithFailover,
} from "./agent/model_execution";
import type {
  ManagedDispatchBillingEnvelope,
  ManagedDispatchCapturedUsage,
} from "./lib/managed_dispatch";
import type {
  ManagedDispatchGuard,
  ManagedDispatchOutcome,
} from "./runtime_ai/managed";

const modules = import.meta.glob("./**/*.ts");
const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

const anthropicSuccessBody = [
  {
    type: "message_start",
    message: { usage: { input_tokens: 11, output_tokens: 0 } },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: '{"ok":true}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 4 },
  },
  { type: "message_stop" },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");

describe("agent invoke owner authority", () => {
  it("requires a conversation before any managed provider I/O", async () => {
    const t = convexTest(schema, modules);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ownerless invoke must not dispatch"));

    await expect(
      t.action(internal.agent.invoke.invoke, {
        agentType: "assistant",
      } as never),
    ).rejects.toThrow(/conversationId/iu);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("has no noop or optional-owner managed dispatch branch", () => {
    const source = readFileSync(
      new URL("./agent/invoke.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('conversationId: v.id("conversations")');
    expect(source).toContain("returns: agentInvokeResultValidator");
    expect(source).toContain("createManagedUsageDispatchGuard(ctx");
    expect(source).toContain("spanExecution: true");
    expect(source).toContain("finishExecution: undefined");
    expect(source.indexOf("deriveManagedModelBillingContext({")).toBeLessThan(
      source.indexOf("streamTextWithFailover({"),
    );
    expect(source.indexOf("await result.text")).toBeLessThan(
      source.indexOf("managedExecutionGuard.finishExecution?."),
    );
    expect(source).not.toContain("recordManagedUsage");
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("createManagedFenceDispatchGuard");
    expect(source).not.toContain("ownerId && modelAccess");
  });

  it("captures and settles exactly one physical invoke receipt before execution settlement", async () => {
    process.env.ANTHROPIC_API_KEY = "invoke-receipt-test-key";
    const trace: string[] = [];
    const billingEnvelopes: Array<ManagedDispatchBillingEnvelope | undefined> =
      [];
    const capturedUsage: ManagedDispatchCapturedUsage[] = [];
    const physicalOutcomes: ManagedDispatchOutcome[] = [];
    const executionOutcomes: ManagedDispatchOutcome[] = [];

    globalThis.fetch = vi.fn(async () => {
      trace.push("provider-body");
      return new Response(anthropicSuccessBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const guard: ManagedDispatchGuard = {
      signal: controller.signal,
      beginDispatch: async (billing) => {
        trace.push("receipt-acquired");
        billingEnvelopes.push(billing);
        return {
          signal: controller.signal,
          deadlineAt: Date.now() + 5_000,
          markMayHaveDispatched: async () => {
            trace.push("may-have-dispatched");
          },
          captureUsage: async (usage) => {
            trace.push("usage-captured");
            capturedUsage.push(usage);
          },
          requiresUsageCapture: true,
          settle: async (outcome) => {
            trace.push(`receipt-settled:${outcome}`);
            physicalOutcomes.push(outcome);
          },
        };
      },
      finishExecution: async (outcome) => {
        trace.push(`execution-settled:${outcome}`);
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
        content: [{ type: "text" as const, text: "return json" }],
      },
    ];
    const modelBilling = deriveManagedModelBillingContext({
      identity: {
        requestFingerprint: "agent-invoke:test-request",
        agentType: "invoke:assistant",
        conversationId: "conversation-test" as never,
      },
      system: "Invoke exactly once.",
      messages,
      tools: {},
      configs: [config],
    });

    const result = await streamTextWithFailover({
      resolvedConfig: config,
      sharedArgs: {
        system: "Invoke exactly once.",
        messages,
        tools: {},
        maxSteps: 1,
        modelDispatchGuard: guard,
        modelBilling,
      },
    });

    expect(await result.text).toBe('{"ok":true}');
    expect(billingEnvelopes).toHaveLength(1);
    const billingEnvelope = billingEnvelopes[0];
    if (billingEnvelope?.kind !== "managed_usage") {
      throw new Error("Expected one exact managed usage billing envelope.");
    }
    expect(billingEnvelope).toMatchObject({
      kind: "managed_usage",
      agentType: "invoke:assistant",
      conversationId: "conversation-test",
      model: config.model,
    });
    expect(
      billingEnvelope.requestFingerprint.startsWith("managed-model-step:"),
    ).toBe(true);
    expect(billingEnvelope.requestFingerprint).not.toBe(
      modelBilling.requestFingerprint,
    );
    expect(billingEnvelope.fallbackCostMicroCents).toBeGreaterThan(0);
    expect(capturedUsage).toHaveLength(1);
    expect(capturedUsage[0]).toMatchObject({
      success: true,
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    });
    expect(physicalOutcomes).toEqual(["succeeded"]);
    expect(executionOutcomes).toEqual(["succeeded"]);
    expect(trace).toEqual([
      "receipt-acquired",
      "may-have-dispatched",
      "provider-body",
      "usage-captured",
      "receipt-settled:succeeded",
      "execution-settled:succeeded",
    ]);
  });
});
