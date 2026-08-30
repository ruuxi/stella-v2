import { describe, expect, test } from "bun:test";
import {
  BoundedBodyError,
  readBoundedRequestBytes,
  readBoundedRequestJson,
  readBoundedRequestText,
  readBoundedResponseBytes,
} from "../src/bounded-body.js";

const chunkedRequest = (chunks: Uint8Array[]): Request =>
  new Request("https://builder.example/internal", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

describe("bounded Worker request bodies", () => {
  test("accepts a chunked body exactly at the route bound", async () => {
    const bytes = await readBoundedRequestBytes(
      chunkedRequest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4,
    );
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  test("stops a chunked body as soon as it crosses the route bound", async () => {
    await expect(
      readBoundedRequestBytes(
        chunkedRequest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
        3,
      ),
    ).rejects.toMatchObject<Partial<BoundedBodyError>>({
      reason: "too_large",
    });
  });

  test("rejects malformed or oversized Content-Length before reading", async () => {
    for (const value of ["four", "-1", "5"]) {
      const request = new Request("https://builder.example/internal", {
        method: "POST",
        headers: { "content-length": value },
        body: "{}",
      });
      await expect(readBoundedRequestBytes(request, 4)).rejects.toBeInstanceOf(
        BoundedBodyError,
      );
    }
  });

  test("uses fatal UTF-8 decoding and rejects invalid JSON", async () => {
    await expect(
      readBoundedRequestText(chunkedRequest([new Uint8Array([0xff])]), 4),
    ).rejects.toMatchObject<Partial<BoundedBodyError>>({
      reason: "invalid_utf8",
    });
    await expect(
      readBoundedRequestJson(
        new Request("https://builder.example/internal", {
          method: "POST",
          body: "{",
        }),
        4,
      ),
    ).rejects.toMatchObject<Partial<BoundedBodyError>>({
      reason: "invalid_json",
    });
  });

  test("requires a body for JSON but permits an empty byte body", async () => {
    const request = new Request("https://builder.example/internal", {
      method: "POST",
    });
    expect(await readBoundedRequestBytes(request, 4)).toHaveLength(0);
    await expect(readBoundedRequestJson(request, 4)).rejects.toMatchObject<
      Partial<BoundedBodyError>
    >({ reason: "missing_body" });
  });

  test("bounds an upstream response before buffering it", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );
    await expect(readBoundedResponseBytes(response, 3)).rejects.toMatchObject<
      Partial<BoundedBodyError>
    >({ reason: "too_large" });
  });
});
