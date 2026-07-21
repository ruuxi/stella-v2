import { describe, expect, it } from "vitest";

import { iterateSseMessages } from "@stella/runtime/ai/providers/anthropic";

/**
 * Transport close-once coverage (Effect phase 4 batch 1): the SSE body
 * reader must cancel the underlying response stream on EVERY exit path —
 * early consumer exit included — so no connection outlives its iterator.
 */

const encoder = new TextEncoder();

const makeBody = () => {
  const state = { cancelled: 0, closed: false };
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      state.cancelled += 1;
    },
  });
  return {
    body,
    state,
    push: (text: string) => controllerRef.enqueue(encoder.encode(text)),
    close: () => {
      state.closed = true;
      controllerRef.close();
    },
  };
};

describe("anthropic SSE transport close", () => {
  it("cancels the body exactly once when the consumer exits early", async () => {
    const { body, state, push } = makeBody();
    push('event: message_start\ndata: {"type":"message_start"}\n\n');
    push('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');

    const events: string[] = [];
    for await (const sse of iterateSseMessages(body)) {
      events.push(sse.event ?? "");
      break; // early exit without abort — the transport must still close
    }
    expect(events).toEqual(["message_start"]);
    expect(state.cancelled).toBe(1);
  });

  it("closes cleanly (no throw, no double cancel) on natural completion", async () => {
    const { body, state, push, close } = makeBody();
    push('event: message_start\ndata: {"type":"message_start"}\n\n');
    push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    close();

    const events: string[] = [];
    for await (const sse of iterateSseMessages(body)) {
      events.push(sse.event ?? "");
    }
    // Byte/order parity: both events observed in sequence.
    expect(events).toEqual(["message_start", "message_stop"]);
    // A fully-drained stream needs no cancel; at most a no-op close call.
    expect(state.cancelled).toBeLessThanOrEqual(1);
  });

  it("closes exactly once when the body stream itself errors mid-read", async () => {
    const state = { cancelled: 0 };
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      cancel() {
        state.cancelled += 1;
      },
    });
    controllerRef.enqueue(
      encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'),
    );

    const failure = new Error("socket reset");
    const events: string[] = [];
    const iterate = async () => {
      for await (const sse of iterateSseMessages(body)) {
        events.push(sse.event ?? "");
        controllerRef.error(failure);
      }
    };
    // The transport error propagates to the consumer (the provider layer
    // maps it to its terminal error event), and cleanup neither throws nor
    // double-closes: cancel on an errored stream is a rejected no-op the
    // finally swallows.
    await expect(iterate()).rejects.toThrow("socket reset");
    expect(events).toEqual(["message_start"]);
    expect(state.cancelled).toBeLessThanOrEqual(1);
  });

  it("propagates an abort as an error and still closes the transport", async () => {
    const { body, state, push } = makeBody();
    push('event: message_start\ndata: {"type":"message_start"}\n\n');
    const abort = new AbortController();

    const iterate = async () => {
      for await (const sse of iterateSseMessages(body, abort.signal)) {
        void sse;
        abort.abort();
      }
    };
    await expect(iterate()).rejects.toThrow("Request was aborted");
    expect(state.cancelled).toBe(1);
  });
});
