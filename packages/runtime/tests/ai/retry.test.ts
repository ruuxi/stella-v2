import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRetryableConnectionError,
  isTransientTransportError,
  retryWithBackoff,
} from "@stella/runtime/ai/utils/retry";

describe("provider retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Stella's fixed-then-exponential delays for retryable provider failures", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limit"), { status: 429 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("temporarily unavailable"), { status: 503 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("network"), { code: "ECONNRESET" }),
      )
      .mockResolvedValueOnce("ok");

    const result = retryWithBackoff(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("caps provider retries at 10 total attempts", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        Object.assign(new Error("temporarily unavailable"), { status: 503 }),
      );

    await expect(retryWithBackoff(fn, { baseDelayMs: 0 })).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it("honors provider retry-after headers", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("too many requests"), {
          status: 429,
          headers: { "retry-after-ms": "1500" },
        }),
      )
      .mockResolvedValueOnce("ok");

    const result = retryWithBackoff(fn);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry context overflow errors", () => {
    expect(
      isRetryableConnectionError(new Error("context_length_exceeded")),
    ).toBe(false);
  });

  it("recognizes Node's bare undici termination without broadening provider retries", () => {
    expect(isTransientTransportError(new TypeError("terminated"))).toBe(true);
    expect(isTransientTransportError(new Error("terminated"))).toBe(false);
    expect(
      isTransientTransportError(
        Object.assign(new TypeError("terminated"), { status: 500 }),
      ),
    ).toBe(false);
    const aborted = new TypeError("terminated");
    aborted.name = "AbortError";
    expect(isTransientTransportError(aborted)).toBe(false);
  });
});
