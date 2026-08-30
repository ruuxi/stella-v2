import { describe, expect, test } from "bun:test";
import { BoundedBodyError } from "../src/bounded-body.js";
import {
  CLOUD_BUILDER_BODY_LIMITS,
  boundedBodyStatus,
  bufferBoundedJsonRequest,
  publicJsonBodyLimit,
  serviceJsonBodyLimit,
} from "../src/request-ingress.js";

const chunkedJsonRequest = (chunks: string[]): Request => {
  const encoder = new TextEncoder();
  return new Request("https://builder.example/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  });
};

describe("Cloud Builder request ingress", () => {
  test("assigns product-shaped limits and leaves unknown routes unconsumed", () => {
    expect(
      publicJsonBodyLimit(
        "POST",
        "/conversations/conversation-1/local-turns/begin",
      ),
    ).toBe(CLOUD_BUILDER_BODY_LIMITS.localTurnBegin);
    expect(
      publicJsonBodyLimit("POST", "/conversations/conversation-1/journal"),
    ).toBe(CLOUD_BUILDER_BODY_LIMITS.conversationAppend);
    expect(serviceJsonBodyLimit("POST", "/sessions/thread-1/turns")).toBe(
      CLOUD_BUILDER_BODY_LIMITS.turn,
    );
    expect(serviceJsonBodyLimit("POST", "/owners/purge")).toBe(
      CLOUD_BUILDER_BODY_LIMITS.conversationAppend,
    );
    expect(serviceJsonBodyLimit("POST", "/not-a-route")).toBeNull();
    expect(serviceJsonBodyLimit("POST", "/m0/echo")).toBeNull();
    expect(CLOUD_BUILDER_BODY_LIMITS.localTurnBegin).toBe(8 * 1024 * 1024);
  });

  test("accepts valid chunked JSON and preserves its exact text", async () => {
    const bounded = await bufferBoundedJsonRequest(
      chunkedJsonRequest(['{"hello":', '"world"}']),
      64,
    );
    expect(await bounded.text()).toBe('{"hello":"world"}');
    expect(bounded.headers.has("content-length")).toBe(false);
  });

  test("rejects an oversized chunked request while it streams", async () => {
    const failure = await bufferBoundedJsonRequest(
      chunkedJsonRequest(['{"value":"', "x".repeat(64), '"}']),
      32,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoundedBodyError);
    expect((failure as BoundedBodyError).reason).toBe("too_large");
    expect(boundedBodyStatus(failure)).toBe(413);
  });

  test("rejects malformed JSON and invalid declared lengths deterministically", async () => {
    const malformed = await bufferBoundedJsonRequest(
      chunkedJsonRequest(["{"]),
      64,
    ).catch((error: unknown) => error);
    expect((malformed as BoundedBodyError).reason).toBe("invalid_json");
    expect(boundedBodyStatus(malformed)).toBe(400);

    const declared = new Request("https://builder.example/control", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "{}",
    });
    const invalidLength = await bufferBoundedJsonRequest(declared, 64).catch(
      (error: unknown) => error,
    );
    expect((invalidLength as BoundedBodyError).reason).toBe(
      "invalid_content_length",
    );
    expect(boundedBodyStatus(invalidLength)).toBe(400);
  });
});
