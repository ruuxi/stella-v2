import { describe, expect, test } from "bun:test";
import {
  R2TransferTransformTooLargeError,
  r2TransferBody,
} from "../src/r2-transfer-body.js";

const source = (args: {
  size: number;
  stream: ReadableStream<Uint8Array>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): R2ObjectBody =>
  ({
    key: "source/object.bin",
    version: "fixture",
    size: args.size,
    etag: "fixture-etag",
    httpEtag: '"fixture-etag"',
    uploaded: new Date(0),
    checksums: {},
    body: args.stream,
    bodyUsed: false,
    arrayBuffer:
      args.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
  }) as R2ObjectBody;

describe("R2 owner-transfer bodies", () => {
  test("hands the original ReadableStream to R2 without calling arrayBuffer", async () => {
    let buffered = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const prepared = await r2TransferBody({
      source: source({
        size: 3,
        stream,
        arrayBuffer: () => {
          buffered += 1;
          throw new Error("arrayBuffer must never be called");
        },
      }),
      destinationKey: "destination/object.bin",
    });
    expect(prepared.body).toBe(stream);
    expect(prepared.body).toBeInstanceOf(ReadableStream);
    expect(buffered).toBe(0);
  });

  test("rejects oversized transforms before reading or invoking the transform", async () => {
    let pulled = 0;
    let transformed = 0;
    const failure = await r2TransferBody({
      source: source({
        size: 65,
        stream: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(65));
            controller.close();
          },
        }),
      }),
      destinationKey: "destination/meta.json",
      transformMaxBytes: 64,
      transform: async () => {
        transformed += 1;
        return { body: "{}" };
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(R2TransferTransformTooLargeError);
    expect(pulled).toBe(0);
    expect(transformed).toBe(0);
  });

  test("enforces the transform limit against the stream even if size lies", async () => {
    const failure = await r2TransferBody({
      source: source({
        size: 1,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(33));
            controller.close();
          },
        }),
      }),
      destinationKey: "destination/meta.json",
      transformMaxBytes: 32,
      transform: async (body) => ({ body }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(R2TransferTransformTooLargeError);
  });

  test("preserves transient stream failures so the transfer remains retryable", async () => {
    const transientFailure = new Error("temporary R2 source read failure");
    const failure = await r2TransferBody({
      source: source({
        size: 1,
        stream: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(transientFailure);
          },
        }),
      }),
      destinationKey: "destination/meta.json",
      transformMaxBytes: 32,
      transform: async (body) => ({ body }),
    }).catch((error: unknown) => error);

    expect(failure).toBe(transientFailure);
    expect(failure).not.toBeInstanceOf(R2TransferTransformTooLargeError);
  });
});
