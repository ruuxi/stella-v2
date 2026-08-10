import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RUN_MAX_ATTEMPTS,
  AGENT_RUN_MAX_RETRY_AFTER_MS,
  AGENT_RUN_RATE_LIMIT_RETRY_DELAYS_MS,
  AGENT_RUN_RETRY_DELAYS_MS,
  agentRunRetryDelayMs,
  classifyAgentRunFailure,
  executeAgentTurnWithRetry,
  formatAgentRunRetryStatus,
  type AgentRunFailure,
  type AgentRunRetryInfo,
  type AgentRunRetryState,
} from "@stella/runtime/kernel/agent-runtime/agent-run-retry";
import {
  anomalousStreamStopError,
  isTransientProviderStreamAnomalyMessage,
  providerAbortedStopMessage,
} from "@stella/runtime/ai/utils/provider-stop";

const noWait = async () => undefined;

describe("agent run transient retry policy", () => {
  it.each([
    {
      name: "HTTP 5xx",
      error: Object.assign(new Error("upstream failed"), { status: 500 }),
      category: "http_5xx",
      delayMs: 1_000,
    },
    {
      name: "Codex streamed server error",
      error: new Error(
        "Codex error (server_error): An error occurred while processing your request.",
      ),
      category: "http_5xx",
      delayMs: 1_000,
    },
    {
      // Rate limits get their own, slower curve: a 429 means a provider-side
      // capacity window has to drain, which the transport schedule outruns.
      name: "429 provider rate limit",
      error: Object.assign(new Error("Too many requests"), { status: 429 }),
      category: "rate_limit",
      delayMs: 5_000,
    },
    {
      name: "transport EOF",
      error: new Error("unexpected EOF while reading response stream"),
      category: "transport",
      delayMs: 1_000,
    },
    {
      name: "transport timeout",
      error: Object.assign(new Error("request timed out"), {
        code: "ETIMEDOUT",
      }),
      category: "transport",
      delayMs: 1_000,
    },
  ])(
    "retries $name and resumes the same turn",
    async ({ error, category, delayMs }) => {
      const calls: boolean[] = [];
      const prepared: AgentRunFailure[] = [];
      const retries: AgentRunRetryInfo[] = [];

      const result = await executeAgentTurnWithRetry({
        execute: async (resume) => {
          calls.push(resume);
          if (!resume) throw error;
          return { finalText: "recovered" };
        },
        prepareRetry: (failure) => {
          prepared.push(failure);
          return true;
        },
        onRetry: (info) => retries.push(info),
        random: () => 0.5,
        sleep: noWait,
      });

      expect(result).toEqual({ finalText: "recovered", attempts: 2 });
      expect(calls).toEqual([false, true]);
      expect(prepared[0]?.category).toBe(category);
      expect(retries).toEqual([
        expect.objectContaining({
          category,
          attempt: 2,
          maxAttempts: AGENT_RUN_MAX_ATTEMPTS,
          delayMs,
        }),
      ]);
    },
  );

  it("uses 4 total attempts with 1s, 2.5s, and 6s backoff", async () => {
    const calls: boolean[] = [];
    const waits: number[] = [];

    const result = await executeAgentTurnWithRetry({
      execute: async (resume) => {
        calls.push(resume);
        return { finalText: "", errorMessage: "unexpected EOF" };
      },
      prepareRetry: () => true,
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(calls).toEqual([false, true, true, true]);
    expect(waits).toEqual([...AGENT_RUN_RETRY_DELAYS_MS]);
    expect(result.attempts).toBe(4);
    expect(result.errorMessage).toContain(
      "Automatic recovery exhausted after 4 attempts (transport)",
    );
  });

  it("does not spend provider attempts on local context preflights", async () => {
    const state: AgentRunRetryState = { attemptsUsed: 0, retriesUsed: 0 };
    const prepareRetry = vi.fn(() => true);
    const preflight =
      "Context preflight context_length_exceeded before provider dispatch: estimated context exceeds the safe input budget.";

    for (let index = 0; index < AGENT_RUN_MAX_ATTEMPTS + 2; index += 1) {
      const result = await executeAgentTurnWithRetry({
        state,
        maxAttempts: 1,
        execute: async () => ({ finalText: "", errorMessage: preflight }),
        prepareRetry,
        sleep: noWait,
      });
      expect(result).toMatchObject({ errorMessage: preflight, attempts: 0 });
    }

    expect(state).toEqual({ attemptsUsed: 0, retriesUsed: 0 });
    expect(prepareRetry).not.toHaveBeenCalled();
  });

  it.each([
    ["401 auth", "401 Unauthorized", "auth"],
    ["403 auth", "403 Forbidden", "auth"],
    ["invalid model", "invalid model: missing-model", "invalid_model_or_route"],
    ["invalid route", "route not found for provider", "invalid_model_or_route"],
    ["cancellation", "Canceled by user", "canceled"],
  ])("fails fast for %s", async (_name, message, category) => {
    const prepareRetry = vi.fn(() => true);
    const onRetry = vi.fn();
    const execute = vi.fn(async () => ({
      finalText: "",
      errorMessage: message,
    }));

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry,
      onRetry,
      sleep: noWait,
    });

    expect(result).toMatchObject({ errorMessage: message, attempts: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(prepareRetry).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(classifyAgentRunFailure(message).category).toBe(category);
  });

  it("retries empty and silent-truncated completions", async () => {
    const truncated =
      "Run truncated: model hit the output-token cap while reasoning; no visible reply was produced.";
    const execute = vi
      .fn<
        (
          resume: boolean,
        ) => Promise<{ finalText: string; errorMessage?: string }>
      >()
      .mockResolvedValueOnce({ finalText: "" })
      .mockResolvedValueOnce({ finalText: "", errorMessage: truncated })
      .mockResolvedValueOnce({ finalText: "recovered" });

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry: () => true,
      random: () => 0.5,
      sleep: noWait,
    });

    expect(result).toEqual({ finalText: "recovered", attempts: 3 });
    expect(execute.mock.calls.map(([resume]) => resume)).toEqual([
      false,
      true,
      true,
    ]);
    expect(classifyAgentRunFailure(truncated)).toMatchObject({
      category: "empty_response",
      retryable: true,
    });
  });

  it("keeps retry jitter within ten percent", () => {
    expect(agentRunRetryDelayMs(0, () => 0)).toBe(900);
    expect(agentRunRetryDelayMs(1, () => 0.5)).toBe(2_500);
    expect(agentRunRetryDelayMs(2, () => 1)).toBe(6_600);
  });

  it("backs off further for rate limits than for dropped connections", () => {
    // A 429 waits out a provider capacity window; the transport curve would
    // burn all four attempts in under ten seconds against a limit that was
    // never going to clear that fast.
    for (const [
      index,
      base,
    ] of AGENT_RUN_RATE_LIMIT_RETRY_DELAYS_MS.entries()) {
      expect(
        agentRunRetryDelayMs(index, () => 0.5, { category: "rate_limit" }),
      ).toBe(base);
      expect(base).toBeGreaterThan(AGENT_RUN_RETRY_DELAYS_MS[index]!);
    }
  });

  it("honors a provider Retry-After verbatim, capped", () => {
    // No jitter: jitter de-synchronizes blind retries, and this one isn't
    // blind — the provider named the time.
    expect(
      agentRunRetryDelayMs(0, () => 0, {
        category: "rate_limit",
        retryAfterMs: 12_000,
      }),
    ).toBe(12_000);
    // Shorter than the schedule wins too — no point idling past the reopen.
    expect(
      agentRunRetryDelayMs(2, () => 0, {
        category: "rate_limit",
        retryAfterMs: 800,
      }),
    ).toBe(800);
    expect(
      agentRunRetryDelayMs(0, () => 0, {
        category: "rate_limit",
        retryAfterMs: 10 * 60 * 1_000,
      }),
    ).toBe(AGENT_RUN_MAX_RETRY_AFTER_MS);
  });

  it("carries Retry-After from a streamed failure into the delay", async () => {
    // The provider adapter parks the header value on the assistant message
    // because flattening the error to a string drops its headers.
    const retries: AgentRunRetryInfo[] = [];
    await executeAgentTurnWithRetry({
      execute: async (resume) =>
        resume
          ? { finalText: "recovered" }
          : {
              finalText: "",
              errorMessage: "429 Too many requests",
              retryAfterMs: 7_000,
            },
      prepareRetry: () => true,
      onRetry: (info) => retries.push(info),
      random: () => 0.5,
      sleep: noWait,
    });

    expect(retries[0]).toMatchObject({
      category: "rate_limit",
      delayMs: 7_000,
    });
  });

  it("reads Retry-After off a thrown error's headers", () => {
    const error = Object.assign(new Error("Too many requests"), {
      status: 429,
      headers: { "retry-after": "3" },
    });
    expect(classifyAgentRunFailure(error)).toMatchObject({
      category: "rate_limit",
      retryAfterMs: 3_000,
    });
  });

  it("names the real cause in the retry status", () => {
    // "Connection interrupted" for a 429 blames the user's network for a
    // provider-side throttle.
    expect(
      formatAgentRunRetryStatus({
        category: "rate_limit",
        message: "429",
        retryable: true,
        attempt: 2,
        maxAttempts: 4,
        delayMs: 5_000,
      }),
    ).toBe(
      "Rate limited by the model provider. Retrying in 5s (attempt 2 of 4)",
    );
    expect(
      formatAgentRunRetryStatus({
        category: "transport",
        message: "EOF",
        retryable: true,
        attempt: 2,
        maxAttempts: 4,
        delayMs: 1_000,
      }),
    ).toBe("Connection interrupted. Retrying in 1s (attempt 2 of 4)");
  });
});

describe("provider stream anomaly classification", () => {
  it("retries neutral anomalies but not deterministic content aborts", () => {
    const transientMessages = [
      anomalousStreamStopError({ stopReason: "error" }).message,
      providerAbortedStopMessage("network_error"),
      providerAbortedStopMessage("some_future_stop_reason"),
      "Anthropic stream ended before message_stop",
    ];
    for (const message of transientMessages) {
      expect(isTransientProviderStreamAnomalyMessage(message)).toBe(true);
      expect(classifyAgentRunFailure(message)).toMatchObject({
        category: "transport",
        retryable: true,
      });
    }

    const safetyAbort = providerAbortedStopMessage("refusal");
    expect(isTransientProviderStreamAnomalyMessage(safetyAbort)).toBe(false);
    expect(classifyAgentRunFailure(safetyAbort)).toMatchObject({
      category: "non_retryable",
      retryable: false,
    });
  });
});
