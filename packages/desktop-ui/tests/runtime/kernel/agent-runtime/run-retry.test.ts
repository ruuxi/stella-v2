import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RUN_MAX_ATTEMPTS,
  classifyAgentRunFailure,
  executeAgentRunWithRetry,
} from "@stella/runtime/kernel/agent-runtime/run-retry";

describe("agent run transient retry", () => {
  it.each([
    ["HTTP 5xx", "500 Server Error", "server-error"],
    ["429 relay quota", "429 Transient relay buffer quota exceeded", "quota"],
    ["lost relay stream", "relay_stream_lost", "relay-stream-lost"],
    [
      "missing relay response",
      "404 Relay response not found",
      "relay-response-missing",
    ],
    ["transport EOF", "unexpected EOF while reading response", "transport"],
    ["transport timeout", "ETIMEDOUT while awaiting upstream", "transport"],
    ["connection reset", "read ECONNRESET", "transport"],
  ])("retries %s and resumes to success", async (_name, message, category) => {
    const execute = vi
      .fn<
        (
          resume: boolean,
        ) => Promise<{ finalText: string; errorMessage?: string }>
      >()
      .mockResolvedValueOnce({
        finalText: "partial output",
        errorMessage: message,
      })
      .mockResolvedValueOnce({ finalText: "complete output" });
    const prepareResume = vi.fn(() => true);
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    const result = await executeAgentRunWithRetry({
      state: { retriesUsed: 0 },
      execute,
      prepareResume,
      sleep,
      onRetry,
      random: () => 0.5,
    });

    expect(result).toEqual({ finalText: "complete output" });
    expect(execute.mock.calls.map(([resume]) => resume)).toEqual([false, true]);
    expect(prepareResume).toHaveBeenCalledWith(message);
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        retryNumber: 1,
        nextAttempt: 2,
        maxAttempts: AGENT_RUN_MAX_ATTEMPTS,
        category,
      }),
    );
  });

  it("retries a thrown transport failure, then succeeds", async () => {
    const transportError = Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
    });
    const execute = vi
      .fn<
        (
          resume: boolean,
        ) => Promise<{ finalText: string; errorMessage?: string }>
      >()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce({ finalText: "recovered" });

    await expect(
      executeAgentRunWithRetry({
        state: { retriesUsed: 0 },
        execute,
        prepareResume: () => true,
        sleep: async () => undefined,
        random: () => 0.5,
      }),
    ).resolves.toEqual({ finalText: "recovered" });
    expect(execute.mock.calls.map(([resume]) => resume)).toEqual([false, true]);
  });

  it("exhausts after four total attempts with 1s, 2.5s, and 6s backoff", async () => {
    const execute = vi.fn(async () => ({
      finalText: "truncated partial",
      errorMessage: "503 Server Error",
    }));
    const sleep = vi.fn(async () => undefined);

    const result = await executeAgentRunWithRetry({
      state: { retriesUsed: 0 },
      execute,
      prepareResume: () => true,
      sleep,
      random: () => 0.5,
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_500, 6_000,
    ]);
    expect(result.finalText).toBe("truncated partial");
    expect(result.errorMessage).toBe(
      "Agent run failed after 4 attempts (3 automatic retries): 503 Server Error",
    );
  });

  it.each([
    ["auth 401", "401 Unauthorized", "auth"],
    ["auth 403", "403 Forbidden", "auth"],
    [
      "invalid model",
      "Invalid model route: missing-model",
      "invalid-model-route",
    ],
    ["generic route 404", "404 Route not found", "invalid-model-route"],
    ["cancellation", "Request was aborted", "canceled"],
  ])("fails fast for %s", async (_name, message, category) => {
    expect(classifyAgentRunFailure(message)).toEqual({
      retryable: false,
      category,
    });
    const execute = vi.fn(async () => ({
      finalText: "",
      errorMessage: message,
    }));
    const sleep = vi.fn(async () => undefined);

    const result = await executeAgentRunWithRetry({
      state: { retriesUsed: 0 },
      execute,
      prepareResume: () => true,
      sleep,
    });

    expect(result.errorMessage).toBe(message);
    expect(execute).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("resumes after prior side effects instead of replaying the prompt", async () => {
    const reportSideEffect = vi.fn();
    const retainedState = ["user prompt", "report accepted"];
    const execute = vi.fn(async (resume: boolean) => {
      if (!resume) {
        reportSideEffect("stable-report-id");
        return { finalText: "", errorMessage: "relay_stream_lost" };
      }
      expect(retainedState).toEqual(["user prompt", "report accepted"]);
      return { finalText: "done" };
    });

    const result = await executeAgentRunWithRetry({
      state: { retriesUsed: 0 },
      execute,
      prepareResume: () => true,
      sleep: async () => undefined,
      random: () => 0.5,
    });

    expect(result.finalText).toBe("done");
    expect(reportSideEffect).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([resume]) => resume)).toEqual([false, true]);
  });

  it("fails clearly instead of accepting a partial model error as success", async () => {
    const result = await executeAgentRunWithRetry({
      state: { retriesUsed: 3 },
      execute: async () => ({
        finalText: "truncated result",
        errorMessage: "relay_stream_lost",
      }),
      prepareResume: () => true,
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      finalText: "truncated result",
      errorMessage:
        "Agent run failed after 4 attempts (3 automatic retries): relay_stream_lost",
    });
  });
});
