import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeLogger } from "@stella/runtime/kernel/debug";

describe("runtime logger field sanitization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves finite numeric token metrics while redacting credentials", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    createRuntimeLogger("context-telemetry").info("compaction.completed", {
      tokensBefore: 8_200,
      measuredTokens: 8_100,
      tokensAfter: 3_100,
      estimatedTokens: 3_050,
      middleTokens: 2_400,
      imageTokens: 765,
      maxTokens: 16_000,
      accessToken: "credential-value",
      nested: {
        totalTokens: 11_300,
        sessionToken: "nested-credential",
      },
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toEqual({
      tokensBefore: 8_200,
      measuredTokens: 8_100,
      tokensAfter: 3_100,
      estimatedTokens: 3_050,
      middleTokens: 2_400,
      imageTokens: 765,
      maxTokens: 16_000,
      accessToken: "[REDACTED]",
      nested: {
        totalTokens: 11_300,
        sessionToken: "[REDACTED]",
      },
    });
  });

  it("does not exempt non-finite or string-valued token fields", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    createRuntimeLogger("context-telemetry").info("compaction.completed", {
      tokensBefore: "8200",
      tokensAfter: Number.POSITIVE_INFINITY,
      accessToken: 123456,
    });

    expect(consoleError.mock.calls[0]?.[1]).toEqual({
      tokensBefore: "[REDACTED]",
      tokensAfter: "[REDACTED]",
      accessToken: "[REDACTED]",
    });
  });
});
