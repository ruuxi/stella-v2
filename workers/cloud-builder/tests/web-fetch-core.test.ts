import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchReadableText,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_BODY_CHARS,
} from "@stella/runtime/kernel/tools/web-fetch-core.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloud web fetch bounds", () => {
  test("never sizes the joined buffer from an oversized single stream chunk", async () => {
    const hugeChunk = new Uint8Array(MAX_FETCH_BODY_BYTES + 1).fill(97);
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(hugeChunk);
            controller.close();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )) as typeof fetch;

    const text = await fetchReadableText(
      { url: "https://example.test/large" },
      { guardUrl: async (url) => url },
    );
    expect(text.length).toBeLessThanOrEqual(
      MAX_FETCH_BODY_CHARS + "\n\n[Content truncated]".length,
    );
    expect(text).toEndWith("[Content truncated]");
  });

  test("rejects an oversized declared body before reading it", async () => {
    globalThis.fetch = (async () =>
      new Response("small", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_FETCH_BODY_BYTES + 1),
        },
      })) as typeof fetch;

    await expect(
      fetchReadableText(
        { url: "https://example.test/declared-large" },
        { guardUrl: async (url) => url },
      ),
    ).resolves.toContain("safe byte limit");
  });
});
