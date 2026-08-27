import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBackendTools, executeWebSearch } from "../convex/tools/backend";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.PARALLEL_API_KEY;

beforeEach(() => {
  process.env.PARALLEL_API_KEY = "parallel-test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.PARALLEL_API_KEY;
  else process.env.PARALLEL_API_KEY = originalApiKey;
});

describe("backend Parallel web search", () => {
  test("uses fast mode and maps ranked excerpts to search hits", async () => {
    let request: Request | undefined;
    const mutations: Array<Record<string, unknown>> = [];
    const ctx = {
      runMutation: async (
        _reference: unknown,
        args: Record<string, unknown>,
      ) => {
        mutations.push(args);
        if ("outcome" in args) return true;
        if (mutations.length > 1) return true;
        const now = Number(args.now);
        return {
          providerDeadlineAt: now + 90_000,
          leaseExpiresAt: now + 120_000,
          quiescentAfterAt: now + 135_000,
        };
      },
    };
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        results: [
          {
            title: "Parallel Search",
            url: "https://parallel.ai/products/search",
            excerpts: ["First excerpt", "Second excerpt"],
          },
        ],
        warnings: null,
      });
    }) as typeof fetch;

    const result = await executeWebSearch(ctx as never, "current search APIs", {
      ownerId: "owner:test",
      ownerGeneration: "generation:test",
      signal: new AbortController().signal,
      category: "company",
    });

    expect(request?.url).toBe("https://api.parallel.ai/v1/search");
    expect(request?.headers.get("x-api-key")).toBe("parallel-test-key");
    expect(await request?.json()).toEqual({
      search_queries: ["current search APIs"],
      objective:
        "Find information relevant to: current search APIs. Focus on company.",
      mode: "fast",
      advanced_settings: { max_results: 6 },
    });
    expect(result.results).toEqual([
      {
        title: "Parallel Search",
        url: "https://parallel.ai/products/search",
        snippet: "First excerpt ... Second excerpt",
      },
    ]);
    expect(mutations).toHaveLength(3);
    expect(mutations[0]).toMatchObject({
      ownerId: "owner:test",
      ownerGeneration: "generation:test",
      billing: {
        kind: "parallel_search_fast",
        chargeMicroCents: 100_000,
      },
    });
    expect(mutations[1]).toMatchObject({
      ownerId: "owner:test",
      ownerGeneration: "generation:test",
      attemptId: mutations[0]?.attemptId,
      leaseId: mutations[0]?.leaseId,
      billing: mutations[0]?.billing,
    });
    expect(mutations[2]).toMatchObject({
      ownerId: "owner:test",
      ownerGeneration: "generation:test",
      attemptId: mutations[0]?.attemptId,
      leaseId: mutations[0]?.leaseId,
      outcome: "succeeded",
    });
  });

  test("reports the Parallel environment variable when unconfigured", async () => {
    delete process.env.PARALLEL_API_KEY;

    expect(
      await executeWebSearch({} as never, "query", {
        ownerId: "owner:test",
        ownerGeneration: "generation:test",
        signal: new AbortController().signal,
      }),
    ).toEqual({
      text: "WebSearch is not configured (missing PARALLEL_API_KEY).",
      results: [],
    });
  });

  test("does not expose paid search without an exact owner scope", () => {
    const tools = createBackendTools({} as never, {
      agentType: "general",
      maxAgentDepth: 2,
    });
    expect(tools.WebSearch).toBeUndefined();
  });

  test("rejects an empty runtime owner scope before provider I/O", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("Parallel must not be called");
    }) as typeof fetch;

    await expect(
      executeWebSearch({} as never, "current agents", {
        ownerId: "   ",
        ownerGeneration: "generation:test",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exact owner generation");
    expect(fetchCalled).toBe(false);
  });

  test("aborts a hanging Parallel body and durably settles the attempt", async () => {
    const controller = new AbortController();
    const abortError = new Error("nested search canceled");
    abortError.name = "AbortError";
    const mutations: Array<Record<string, unknown>> = [];
    const ctx = {
      runMutation: async (
        _reference: unknown,
        args: Record<string, unknown>,
      ) => {
        mutations.push(args);
        if ("outcome" in args) return true;
        if (mutations.length > 1) return true;
        const now = Number(args.now);
        return {
          providerDeadlineAt: now + 90_000,
          leaseExpiresAt: now + 120_000,
          quiescentAfterAt: now + 135_000,
        };
      },
    };
    let canceled = false;
    let bodyStartedResolve!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).not.toBe(controller.signal);
      expect(init?.signal?.aborted).toBe(false);
      let pullCount = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(streamController) {
            pullCount += 1;
            if (pullCount === 1) {
              streamController.enqueue(new TextEncoder().encode("partial"));
            } else {
              bodyStartedResolve();
            }
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    let returned = false;
    const running = executeWebSearch(ctx as never, "hanging search", {
      ownerId: "owner:hanging-search",
      ownerGeneration: "generation:hanging-search",
      signal: controller.signal,
    }).then((result) => {
      returned = true;
      return result;
    });
    await bodyStarted;
    controller.abort(abortError);

    await expect(running).rejects.toThrow("nested search canceled");
    expect(canceled).toBe(true);
    expect(returned).toBe(false);
    expect(mutations).toHaveLength(3);
    expect(mutations[2]).toMatchObject({
      ownerId: "owner:hanging-search",
      ownerGeneration: "generation:hanging-search",
      attemptId: mutations[0]?.attemptId,
      leaseId: mutations[0]?.leaseId,
      outcome: "aborted",
    });
  });
});
