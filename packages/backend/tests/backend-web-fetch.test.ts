import { afterEach, describe, expect, test } from "bun:test";

import { createBackendTools } from "../convex/tools/backend";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const webFetch = () =>
  createBackendTools({} as never, {
    agentType: "general",
    maxAgentDepth: 2,
  }).WebFetch;

const executeWebFetch = (
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
) => webFetch().execute(args, { signal });

describe("backend WebFetch parity", () => {
  test("returns semantic markdown and keeps prompt optional", async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><body><h1>Release notes</h1><p>Read <a href="https://example.test/docs">docs</a>.</p><script>hidden()</script></body></html>',
        { headers: { "content-type": "text/html" } },
      )) as typeof fetch;

    const output = await executeWebFetch({
      url: "https://example.test",
      format: "markdown",
    });
    expect(output).toContain("# Release notes");
    expect(output).toContain("[docs](https://example.test/docs)");
    expect(output).not.toContain("hidden()");
    expect(output).not.toContain("Prompt:");
  });

  test("rejects binary responses", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { "content-type": "application/octet-stream" },
      })) as typeof fetch;
    expect(
      await executeWebFetch({ url: "https://example.test/file" }),
    ).toContain("Unsupported or binary Content-Type");
  });

  test("enforces the streaming 5 MiB limit with a lying Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 6; index += 1)
              controller.enqueue(chunk);
            controller.close();
          },
        }),
        {
          headers: {
            "content-type": "text/plain",
            "content-length": "12",
          },
        },
      )) as typeof fetch;
    expect(
      await executeWebFetch({ url: "https://example.test/large" }),
    ).toContain("exceeds the 5242880 byte limit");
  });

  test("revalidates redirects and blocks a private redirect target", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    }) as typeof fetch;
    const output = await executeWebFetch({ url: "https://example.test" });
    expect(output).toContain("Private and local network targets are blocked");
    expect(calls).toBe(1);
  });

  test("aborts a hanging response body without returning a late tool result", async () => {
    const controller = new AbortController();
    const abortError = new Error("nested tool canceled");
    abortError.name = "AbortError";
    let canceled = false;
    let bodyStartedResolve!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
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
        { headers: { "content-type": "text/plain" } },
      );
    }) as typeof fetch;

    let returned = false;
    const running = executeWebFetch(
      { url: "https://example.test/hanging" },
      controller.signal,
    ).then((result) => {
      returned = true;
      return result;
    });
    await bodyStarted;
    controller.abort(abortError);

    await expect(running).rejects.toThrow("nested tool canceled");
    expect(canceled).toBe(true);
    expect(returned).toBe(false);
  });
});
