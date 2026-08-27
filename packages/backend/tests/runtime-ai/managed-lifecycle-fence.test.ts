import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  composeManagedDispatchGuards,
  completeManagedChat,
  openManagedDispatchAttempt,
  runManagedDispatchAttempt,
  streamManagedChat,
  type ManagedDispatchGuard,
  type ManagedDispatchOutcome,
  type ManagedModelConfig,
} from "../../convex/runtime_ai/managed";
import type { Context } from "../../convex/runtime_ai/types";
import { executeBackendToolWithManagedGuard } from "../../convex/agent/model_execution";
import { createManagedUsageDispatchGuard } from "../../convex/lib/managed_billing";
import {
  MANAGED_USAGE_BILLING_KIND,
  type ManagedDispatchBillingEnvelope,
} from "../../convex/lib/managed_dispatch";

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

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const managedBillingEnvelope: ManagedDispatchBillingEnvelope = {
  kind: MANAGED_USAGE_BILLING_KIND,
  requestFingerprint: "managed-stream-body-fingerprint",
  agentType: "proxy:test",
  model: "test/model",
  fallbackCostMicroCents: 100,
};

const anthropicSuccessBody = [
  {
    type: "message_start",
    message: { usage: { input_tokens: 1, output_tokens: 0 } },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");

const recordingDispatchGuard = (args: {
  onBegin: () => void;
  outcomes: ManagedDispatchOutcome[];
  deadlineMs?: number;
}): ManagedDispatchGuard => {
  const signal = new AbortController().signal;
  return {
    signal,
    beginDispatch: async () => {
      args.onBegin();
      return {
        signal: new AbortController().signal,
        deadlineAt: Date.now() + (args.deadlineMs ?? 5_000),
        settle: async (outcome) => {
          args.outcomes.push(outcome);
        },
      };
    },
  };
};

describe("managed provider lifecycle fence", () => {
  it("pins the Google SDK to one physical attempt per durable lease", () => {
    const source = readFileSync(
      new URL("../../convex/runtime_ai/google.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/retryOptions:\s*\{\s*attempts:\s*1\s*\}/u);
  });

  it("joins a hanging tool to the durable enclosing execution deadline", async () => {
    let mutationCall = 0;
    const now = Date.now();
    const ctx = {
      runMutation: async () => {
        mutationCall += 1;
        if (mutationCall === 1) {
          return {
            leaseExpiresAt: now + 30,
            hardExpiresAt: now + 1_000,
            quiescentAfterAt: now + 45,
          };
        }
        if (mutationCall === 2) {
          return {
            providerDeadlineAt: now + 500,
            leaseExpiresAt: now + 700,
            quiescentAfterAt: now + 800,
          };
        }
        return true;
      },
    };
    const guard = createManagedUsageDispatchGuard(ctx as never, {
      ownerId: "managed-execution-test-owner",
      ownerGeneration: "managed-execution-test-generation",
      executionId: "managed-execution-test-id",
      spanExecution: true,
    });
    await runManagedDispatchAttempt({
      dispatchGuard: guard,
      run: async () => "provider completed",
    });
    let joined = false;
    const execution = executeBackendToolWithManagedGuard({
      dispatchGuard: guard,
      toolArgs: {},
      tool: {
        name: "durably-hanging-tool",
        description: "hangs until the enclosing execution lease closes",
        parameters: { type: "object", properties: {} },
        execute: async (_args, options) => {
          try {
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              );
            });
            return "late result";
          } finally {
            joined = true;
          }
        },
      },
    });

    await expect(execution).rejects.toThrow(/authority expired/iu);
    expect(joined).toBe(true);
    await guard.finishExecution?.("aborted");
    expect(mutationCall).toBe(4);
  });

  it("propagates enclosing cancellation into a hanging nested tool and joins it", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let joined = false;
    let wroteLateResult = false;
    const guard: ManagedDispatchGuard = {
      signal: controller.signal,
      beginDispatch: async () => {
        throw new Error("provider dispatch is not part of this tool test");
      },
    };
    const execution = executeBackendToolWithManagedGuard({
      dispatchGuard: guard,
      toolArgs: {},
      tool: {
        name: "hanging-offline-responder",
        description: "waits until owner authority closes",
        parameters: { type: "object", properties: {} },
        execute: async (_args, options) => {
          receivedSignal = options.signal;
          try {
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              );
            });
            wroteLateResult = true;
            return "late result";
          } finally {
            joined = true;
          }
        },
      },
    });
    await Promise.resolve();
    controller.abort(new Error("owner reset fenced execution"));

    await expect(execution).rejects.toThrow(/owner reset fenced/iu);
    expect(receivedSignal).toBe(controller.signal);
    expect(joined).toBe(true);
    expect(wroteLateResult).toBe(false);
  });

  it("settles acquired component leases when composite admission fails", async () => {
    const outcomes: ManagedDispatchOutcome[] = [];
    const first = recordingDispatchGuard({
      onBegin: () => undefined,
      outcomes,
    });
    const second: ManagedDispatchGuard = {
      signal: new AbortController().signal,
      beginDispatch: async () => {
        throw new Error("remote turn lease closed");
      },
    };

    await expect(
      composeManagedDispatchGuards(first, second).beginDispatch(),
    ).rejects.toThrow(/remote turn lease closed/iu);
    expect(outcomes).toEqual(["aborted"]);
  });

  it("settles every component of a composite physical attempt exactly once", async () => {
    const firstOutcomes: ManagedDispatchOutcome[] = [];
    const secondOutcomes: ManagedDispatchOutcome[] = [];
    const guard = composeManagedDispatchGuards(
      recordingDispatchGuard({
        onBegin: () => undefined,
        outcomes: firstOutcomes,
        deadlineMs: 5_000,
      }),
      recordingDispatchGuard({
        onBegin: () => undefined,
        outcomes: secondOutcomes,
        deadlineMs: 1_000,
      }),
    );
    const before = Date.now();
    const lease = await guard.beginDispatch();

    expect(lease.deadlineAt).toBeGreaterThanOrEqual(before + 900);
    expect(lease.deadlineAt).toBeLessThanOrEqual(before + 1_100);
    await lease.settle("succeeded");
    expect(firstOutcomes).toEqual(["succeeded"]);
    expect(secondOutcomes).toEqual(["succeeded"]);
    await expect(lease.settle("succeeded")).rejects.toThrow(/settled twice/iu);
  });

  it("preserves every metered pre-I/O marker through guard composition", async () => {
    const order: string[] = [];
    const meteredGuard = (name: string): ManagedDispatchGuard => ({
      signal: new AbortController().signal,
      beginDispatch: async () => ({
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 5_000,
        markMayHaveDispatched: async () => {
          order.push(`${name}:marked`);
        },
        settle: async (outcome) => {
          order.push(`${name}:${outcome}`);
        },
      }),
    });

    await runManagedDispatchAttempt({
      dispatchGuard: composeManagedDispatchGuards(
        meteredGuard("billing"),
        meteredGuard("remote"),
      ),
      run: async () => {
        order.push("provider");
        return "ok";
      },
    });

    expect(order.slice(0, 3)).toEqual([
      "billing:marked",
      "remote:marked",
      "provider",
    ]);
    expect(order.slice(3).sort()).toEqual([
      "billing:succeeded",
      "remote:succeeded",
    ]);
  });

  it("keeps an open physical lease through a hanging response body and joins reset cancellation", async () => {
    const leaseController = new AbortController();
    const outcomes: ManagedDispatchOutcome[] = [];
    const captured: unknown[] = [];
    let bodyJoined = false;
    let deliveredLate = false;
    const guard: ManagedDispatchGuard = {
      signal: leaseController.signal,
      beginDispatch: async (billing) => {
        expect(billing).toEqual(managedBillingEnvelope);
        return {
          signal: leaseController.signal,
          deadlineAt: Date.now() + 5_000,
          markMayHaveDispatched: async () => undefined,
          requiresUsageCapture: true,
          captureUsage: async (usage) => {
            captured.push(usage);
          },
          settle: async (outcome) => {
            outcomes.push(outcome);
          },
        };
      },
    };
    const attempt = await openManagedDispatchAttempt({
      dispatchGuard: guard,
      billing: managedBillingEnvelope,
    });
    await attempt.markMayHaveDispatched();

    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          attempt.signal.addEventListener(
            "abort",
            () => controller.error(attempt.signal.reason),
            { once: true },
          );
        },
      }),
    )
      .text()
      .then(() => {
        deliveredLate = true;
      })
      .finally(() => {
        bodyJoined = true;
      });

    await Promise.resolve();
    expect(outcomes).toEqual([]);
    leaseController.abort(new Error("owner reset fenced relay body"));
    await expect(body).rejects.toThrow(/owner reset fenced/iu);
    await attempt.settleFromError(leaseController.signal.reason);

    expect(bodyJoined).toBe(true);
    expect(deliveredLate).toBe(false);
    expect(captured).toEqual([]);
    expect(outcomes).toEqual(["aborted"]);
  });

  it("routes one exact usage capture authority through a composite attempt", async () => {
    const seenBilling: Array<ManagedDispatchBillingEnvelope | undefined> = [];
    const captures: unknown[] = [];
    const outcomes: ManagedDispatchOutcome[] = [];
    const billingGuard: ManagedDispatchGuard = {
      signal: new AbortController().signal,
      beginDispatch: async (billing) => {
        seenBilling.push(billing);
        return {
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 5_000,
          markMayHaveDispatched: async () => undefined,
          requiresUsageCapture: true,
          captureUsage: async (usage) => {
            captures.push(usage);
          },
          settle: async (outcome) => {
            outcomes.push(outcome);
          },
        };
      },
    };
    const lifecycleGuard: ManagedDispatchGuard = {
      signal: new AbortController().signal,
      beginDispatch: async (billing) => {
        seenBilling.push(billing);
        return {
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 5_000,
          settle: async (outcome) => {
            outcomes.push(outcome);
          },
        };
      },
    };

    const attempt = await openManagedDispatchAttempt({
      dispatchGuard: composeManagedDispatchGuards(billingGuard, lifecycleGuard),
      billing: managedBillingEnvelope,
    });
    await attempt.markMayHaveDispatched();
    await attempt.captureUsage({
      durationMs: 10,
      success: true,
      inputTokens: 2,
      outputTokens: 3,
    });
    await attempt.settle("succeeded");

    expect(seenBilling).toEqual([
      managedBillingEnvelope,
      managedBillingEnvelope,
    ]);
    expect(captures).toHaveLength(1);
    expect(outcomes.sort()).toEqual(["succeeded", "succeeded"]);
  });

  it("retains explicit ambiguous provider outcomes as unknown debt", async () => {
    const outcomes: ManagedDispatchOutcome[] = [];
    const error = new Error("provider accepted but omitted its locator");
    (
      error as Error & {
        providerOutcomeUnknown?: boolean;
      }
    ).providerOutcomeUnknown = true;

    await expect(
      runManagedDispatchAttempt({
        dispatchGuard: recordingDispatchGuard({
          onBegin: () => undefined,
          outcomes,
        }),
        run: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(/omitted its locator/iu);
    expect(outcomes).toEqual(["outcome_unknown"]);
  });

  it("cancels retry backoff when the enclosing lifecycle guard closes", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const runController = new AbortController();
    const outcomes: ManagedDispatchOutcome[] = [];
    let fetchCalls = 0;
    let fenceCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      setTimeout(
        () => runController.abort(new Error("owner lifecycle closed")),
        10,
      );
      throw new Error("fetch failed");
    }) as typeof fetch;
    const guard: ManagedDispatchGuard = {
      signal: runController.signal,
      beginDispatch: async () => {
        fenceCalls += 1;
        return {
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 5_000,
          settle: async (outcome) => {
            outcomes.push(outcome);
          },
        };
      },
    };
    const config: ManagedModelConfig = {
      model: "anthropic/claude-sonnet-4",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };

    await expect(
      completeManagedChat({ config, context, dispatchGuard: guard }),
    ).rejects.toThrow(/lifecycle closed/iu);
    expect(fetchCalls).toBe(1);
    expect(fenceCalls).toBe(1);
    expect(outcomes).toEqual(["outcome_unknown"]);
  });

  it("rechecks the fence before an Anthropic retry instead of retrying inside the transport", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    let fetchCalls = 0;
    let fenceCalls = 0;
    const outcomes: ManagedDispatchOutcome[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error("fetch failed");
      }
      return new Response(anthropicSuccessBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config: ManagedModelConfig = {
      model: "anthropic/claude-sonnet-4",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };

    for await (const event of streamManagedChat({
      config,
      context,
      dispatchGuard: recordingDispatchGuard({
        onBegin: () => {
          fenceCalls += 1;
        },
        outcomes,
      }),
    })) {
      if (event.type === "error") {
        throw new Error(event.error.errorMessage || event.reason);
      }
    }

    expect(fetchCalls).toBe(2);
    expect(fenceCalls).toBe(2);
    expect(outcomes).toEqual(["outcome_unknown", "succeeded"]);
  });

  it("rechecks the fence before a non-stream completion retry", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    let fetchCalls = 0;
    let fenceCalls = 0;
    const outcomes: ManagedDispatchOutcome[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error("fetch failed");
      }
      return new Response(anthropicSuccessBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config: ManagedModelConfig = {
      model: "anthropic/claude-sonnet-4",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };
    const result = await completeManagedChat({
      config,
      context,
      dispatchGuard: recordingDispatchGuard({
        onBegin: () => {
          fenceCalls += 1;
        },
        outcomes,
      }),
    });

    expect(result.stopReason).toBe("stop");
    expect(fetchCalls).toBe(2);
    expect(fenceCalls).toBe(2);
    expect(outcomes).toEqual(["outcome_unknown", "succeeded"]);
  });

  it("rechecks the fence before a non-stream fallback dispatch", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    let fetchCalls = 0;
    let fenceCalls = 0;
    const outcomes: ManagedDispatchOutcome[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response("invalid request", { status: 400 });
      }
      return new Response(anthropicSuccessBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config: ManagedModelConfig = {
      model: "anthropic/primary",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };
    const result = await completeManagedChat({
      config,
      fallbackConfig: { ...config, model: "anthropic/fallback" },
      context,
      dispatchGuard: recordingDispatchGuard({
        onBegin: () => {
          fenceCalls += 1;
        },
        outcomes,
      }),
    });

    expect(result.model).toBe("anthropic/fallback");
    expect(fetchCalls).toBe(2);
    expect(fenceCalls).toBe(2);
    expect(outcomes).toEqual(["failed", "succeeded"]);
  });

  it("rechecks the fence before a streaming fallback dispatch", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    let fetchCalls = 0;
    let fenceCalls = 0;
    const outcomes: ManagedDispatchOutcome[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response("invalid request", { status: 400 });
      }
      return new Response(anthropicSuccessBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config: ManagedModelConfig = {
      model: "anthropic/primary",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };
    for await (const event of streamManagedChat({
      config,
      fallbackConfig: { ...config, model: "anthropic/fallback" },
      context,
      dispatchGuard: recordingDispatchGuard({
        onBegin: () => {
          fenceCalls += 1;
        },
        outcomes,
      }),
    })) {
      if (event.type === "error") {
        throw new Error(event.error.errorMessage || event.reason);
      }
    }

    expect(fetchCalls).toBe(2);
    expect(fenceCalls).toBe(2);
    expect(outcomes).toEqual(["failed", "succeeded"]);
  });

  it("keeps lease cancellation attached through the Anthropic SSE body", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const outcomes: ManagedDispatchOutcome[] = [];
    let fenceCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected a provider abort signal");
      }
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "message_start",
                  message: { usage: { input_tokens: 1, output_tokens: 0 } },
                })}\n\n`,
              ),
            );
            signal.addEventListener(
              "abort",
              () => {
                controller.error(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("provider body aborted"),
                );
              },
              { once: true },
            );
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as typeof fetch;

    const config: ManagedModelConfig = {
      model: "anthropic/claude-sonnet-4",
      managedGatewayProvider: "anthropic",
      api: "anthropic-messages",
      maxOutputTokens: 128,
    };
    const drain = async () => {
      for await (const _event of streamManagedChat({
        config,
        context,
        dispatchGuard: recordingDispatchGuard({
          onBegin: () => {
            fenceCalls += 1;
          },
          outcomes,
          deadlineMs: 25,
        }),
      })) {
        // The stream starts, then its body remains pending until the dispatch
        // deadline aborts the exact physical attempt.
      }
    };

    await expect(drain()).rejects.toThrow(/timed out|abort/i);
    expect(fenceCalls).toBe(1);
    expect(outcomes).toEqual(["timed_out"]);
  });
});
