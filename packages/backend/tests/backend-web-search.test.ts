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

});
