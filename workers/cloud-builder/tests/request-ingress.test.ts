import { describe, expect, test } from "bun:test";
import { BoundedBodyError } from "../src/bounded-body.js";
import {
  boundedBodyStatus,
  bufferBoundedJsonRequest,
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
