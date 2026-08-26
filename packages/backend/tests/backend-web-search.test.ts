import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { executeWebSearch } from "../convex/tools/backend";

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

    const result = await executeWebSearch({} as never, "current search APIs", {
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
  });

  test("reports the Parallel environment variable when unconfigured", async () => {
    delete process.env.PARALLEL_API_KEY;

    expect(await executeWebSearch({} as never, "query")).toEqual({
      text: "WebSearch is not configured (missing PARALLEL_API_KEY).",
      results: [],
    });
  });
});
