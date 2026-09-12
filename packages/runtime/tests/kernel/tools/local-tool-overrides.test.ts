import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractRelevantWebText,
  htmlToMarkdown,
  htmlToText,
  localWebFetch,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_BODY_CHARS,
  MAX_PROMPT_FETCH_BODY_CHARS,
} from "@stella/runtime/kernel/tools/local-tool-overrides";

vi.mock("@stella/runtime/kernel/tools/network-guards", () => ({
  normalizeSafeExternalUrl: vi.fn(async (url: string) => url),
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("local web fetch model-facing bounds", () => {
  it("keeps prompt-relevant excerpts from deep in a long page", () => {
    const page = [
      "Navigation and unrelated introduction",
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `Unrelated changelog entry ${index} with filler ${"x".repeat(80)}`,
      ),
      "Express 5.1.0",
      "This release requires Node.js 18 or higher.",
      "The stable release includes the new path syntax.",
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `Older unrelated entry ${index} with filler ${"y".repeat(80)}`,
      ),
    ].join("\n");

    const extracted = extractRelevantWebText(
      page,
      "Express 5.1.0 stable release and Node.js requirement",
    );

    expect(extracted.length).toBeLessThanOrEqual(MAX_PROMPT_FETCH_BODY_CHARS);
    expect(extracted).toContain("Express 5.1.0");
    expect(extracted).toContain("Node.js 18 or higher");
    expect(extracted).not.toContain("Unrelated changelog entry 100");
  });

  it("bounds unprompted pages while retaining both ends", () => {
    const page = `PAGE-START\n${"z".repeat(MAX_FETCH_BODY_CHARS * 2)}\nPAGE-END`;
    const extracted = extractRelevantWebText(page);

    expect(extracted.length).toBeLessThanOrEqual(MAX_FETCH_BODY_CHARS);
    expect(extracted).toMatch(/^PAGE-START/);
    expect(extracted).toMatch(/PAGE-END$/);
    expect(extracted).toContain("[Content truncated]");
  });
});

describe("local web fetch formats and transport bounds", () => {
  const html = `<!doctype html><html><head><title>Ignored title</title><style>.x{}</style></head><body><main><h1>Release &amp; notes</h1><p>Read <a href="https://example.com/docs">the docs</a>.</p><ul><li>First</li><li>Second</li></ul><script>secret()</script></main></body></html>`;

  it("uses parsed HTML for text and semantic HTML-to-Markdown conversion", () => {
    expect(htmlToText(html)).toContain("Release & notes");
    expect(htmlToText(html)).not.toContain("secret()");
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain("# Release & notes");
    expect(markdown).toContain("[the docs](https://example.com/docs)");
    expect(markdown).toMatch(/-\s+First/);
    expect(markdown).not.toContain("secret()");
  });

  it.each([
    ["text", "Release & notes"],
    ["markdown", "# Release & notes"],
    ["html", "<!doctype html>"],
  ] as const)("returns requested %s format", async (format, expected) => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as typeof fetch;
    await expect(
      localWebFetch({ url: "https://example.com", format }),
    ).resolves.toContain(expected);
  });

  it.each(["application/octet-stream", ""])(
    "rejects unsupported or missing MIME type: %s",
    async (contentType) => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(new Uint8Array([0, 1, 2]), {
            headers: contentType ? { "content-type": contentType } : {},
          }),
      ) as typeof fetch;
      await expect(
        localWebFetch({ url: "https://example.com/file" }),
      ).resolves.toContain("Unsupported or binary Content-Type");
    },
  );

  it("enforces 5 MiB from Content-Length", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("small", {
          headers: {
            "content-type": "text/plain",
            "content-length": String(MAX_FETCH_BODY_BYTES + 1),
          },
        }),
    ) as typeof fetch;
    await expect(
      localWebFetch({ url: "https://example.com/large" }),
    ).resolves.toContain("exceeds the 5242880 byte limit");
  });

  it.each([false, true])(
    "enforces 5 MiB while streaming with lying length: %s",
    async (lyingLength) => {
      const chunk = new Uint8Array(1024 * 1024).fill(97);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 6; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
      globalThis.fetch = vi.fn(
        async () =>
          new Response(body, {
            headers: {
              "content-type": "text/plain",
              ...(lyingLength ? { "content-length": "12" } : {}),
            },
          }),
      ) as typeof fetch;
      await expect(
        localWebFetch({ url: "https://example.com/stream" }),
      ).resolves.toContain("exceeds the 5242880 byte limit");
    },
  );

  it("revalidates every redirect target", async () => {
    const { normalizeSafeExternalUrl } = await import(
      "@stella/runtime/kernel/tools/network-guards"
    );
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://redirected.example/page" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", { headers: { "content-type": "text/plain" } }),
      ) as typeof fetch;
    await expect(localWebFetch({ url: "https://example.com" })).resolves.toBe(
      "ok",
    );
    expect(normalizeSafeExternalUrl).toHaveBeenCalledWith(
      "https://example.com",
    );
    expect(normalizeSafeExternalUrl).toHaveBeenCalledWith(
      "https://redirected.example/page",
    );
  });
});
