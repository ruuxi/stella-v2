import { describe, expect, it } from "bun:test";

import { publishStellaPromptsRequest } from "../scripts/lib/publish-stella-prompts-request";

describe("prompt publisher request", () => {
  it("keeps the timeout active while consuming the response body", async () => {
    const fetchImpl = (async (
      _input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    await expect(
      publishStellaPromptsRequest({
        endpoint: new URL("https://example.test/api/admin/stella/prompts"),
        token: "secret",
        revision: "0".repeat(64),
        prompts: [{ id: "prompts/test.md", content: "test" }],
        timeoutMs: 20,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
