import { describe, expect, it } from "vitest";

import {
  probeBackendIntegrationConnection,
  waitForBackendIntegrationConnection,
} from "@stella/desktop/electron/ipc/backend-integration-status.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchSequence = (responses: Array<() => Response>) => {
  let index = 0;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
};

/**
 * A fetch that never settles on its own — it only rejects when the
 * request's AbortSignal fires. Models the hung request (half-open
 * socket, stalled body) that used to wedge the completion wait, and
 * with it the connect card, forever.
 */
const hangingFetch = () => {
  const seenSignals: AbortSignal[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    const signal = init?.signal ?? null;
    if (signal) seenSignals.push(signal);
    return new Promise<Response>((_, reject) => {
      if (!signal) return;
      const fail = () =>
        reject(new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;
  return { fetchImpl, seenSignals };
};

const baseOptions = {
  siteUrl: "https://backend.example/",
  authToken: "token-1",
  id: "notion",
};

describe("probeBackendIntegrationConnection", () => {
  it("reports connected only on an explicit true", async () => {
    const { fetchImpl } = fetchSequence([() => jsonResponse({ connected: true })]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("connected");
    const { fetchImpl: notYet } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    expect(
      await probeBackendIntegrationConnection({
        ...baseOptions,
        fetchImpl: notYet,
      }),
    ).toBe("not_connected");
  });

  it("treats a missing endpoint as unsupported (older backend)", async () => {
    const { fetchImpl } = fetchSequence([() => jsonResponse({}, 404)]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("unsupported");
  });

  it("reports transient failures as errors", async () => {
    const { fetchImpl } = fetchSequence([() => jsonResponse({}, 500)]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("error");
  });

  it("bounds a hung request with the per-attempt timeout", async () => {
    const { fetchImpl, seenSignals } = hangingFetch();
    expect(
      await probeBackendIntegrationConnection({
        ...baseOptions,
        fetchImpl,
        probeTimeoutMs: 5,
      }),
    ).toBe("error");
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(true);
  });
});

describe("waitForBackendIntegrationConnection", () => {
  it("polls until the backend confirms the connection", async () => {
    const { fetchImpl, calls } = fetchSequence([
      () => jsonResponse({ connected: false }),
      () => jsonResponse({ connected: false }),
      () => jsonResponse({ connected: true }),
    ]);
    const result = await waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 1,
    });
    expect(result).toBe("connected");
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain("/api/native-integrations/status?id=notion");
  });

  it("short-circuits to unsupported so callers can degrade gracefully", async () => {
    const { fetchImpl, calls } = fetchSequence([() => jsonResponse({}, 404)]);
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("unsupported");
    expect(calls.length).toBe(1);
  });

  it("times out when the user never completes OAuth", async () => {
    const { fetchImpl } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    let clock = 0;
    const result = await waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 10,
      now: () => {
        clock += 6;
        return clock;
      },
    });
    expect(result).toBe("timeout");
  });

  it("fails closed when auth is unavailable — never polls, never reports connected", async () => {
    // Transient auth loss between connect-link creation and polling must
    // surface as a failure, not degrade into an optimistic success.
    const { fetchImpl, calls } = fetchSequence([
      () => jsonResponse({ connected: true }),
    ]);
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        authToken: "",
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("auth_unavailable");
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        siteUrl: "   ",
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("auth_unavailable");
    expect(calls.length).toBe(0);
  });

  it("cancels immediately when the abort signal fires", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    const pending = waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe("cancelled");
  });

  it("cannot be wedged past its deadline by requests that never settle", async () => {
    // Regression: the deadline is only checked between probes, so an
    // unbounded in-flight request used to stall the wait — and the
    // connect card stuck on "Waiting for …" — indefinitely.
    const { fetchImpl, seenSignals } = hangingFetch();
    let clock = 0;
    const result = await waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      probeTimeoutMs: 5,
      intervalMs: 1,
      timeoutMs: 10,
      now: () => {
        clock += 6;
        return clock;
      },
    });
    expect(result).toBe("timeout");
    expect(seenSignals.length).toBeGreaterThan(0);
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("aborts the in-flight request when the wait is cancelled", async () => {
    const controller = new AbortController();
    const { fetchImpl, seenSignals } = hangingFetch();
    const pending = waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 1,
      signal: controller.signal,
    });
    // Let the first probe start before cancelling it mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await pending).toBe("cancelled");
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(true);
  });
});
