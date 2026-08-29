import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "../runtime_ai/types";
import { createAssistantTextFramer } from "./assistant_text_frames";

const partial = {} as AssistantMessage;

const delta = (contentIndex: number, text: string): AssistantMessageEvent => ({
  type: "text_delta",
  contentIndex,
  delta: text,
  partial,
});

const end = (contentIndex: number, content: string): AssistantMessageEvent => ({
  type: "text_end",
  contentIndex,
  content,
  partial,
});

const done: AssistantMessageEvent = {
  type: "done",
  reason: "stop",
  message: partial,
};

const drive = (events: AssistantMessageEvent[]): string[] => {
  const framer = createAssistantTextFramer();
  return events.flatMap((event) => framer.accept(event));
};

describe("assistant SSE text framing", () => {
  test("holds every delta and flushes one whole frame when the block closes", () => {
    assert.deepEqual(
      drive([
        delta(0, "Hel"),
        delta(0, "lo, "),
        delta(0, "world"),
        end(0, "Hello, world"),
        done,
      ]),
      ["Hello, world"],
    );
  });

  test("prefers the canonical block text over re-emitted deltas", () => {
    // OpenAI's Responses protocol replays the finished text as a fresh delta,
    // so trusting the accumulator would double the reply.
    assert.deepEqual(
      drive([delta(0, "Hi"), delta(0, "Hi there"), end(0, "Hi there")]),
      ["Hi there"],
    );
  });

  test("emits one frame per text block so tool-interleaved segments stay separate", () => {
    assert.deepEqual(
      drive([
        delta(0, "Looking that up"),
        end(0, "Looking that up"),
        delta(2, "It is 24C"),
        end(2, "It is 24C"),
      ]),
      ["Looking that up", "It is 24C"],
    );
  });

  test("flushes a block the provider never closed when the stream is done", () => {
    assert.deepEqual(drive([delta(0, "orphan"), done]), ["orphan"]);
  });

  test("releases blocks in content order on an explicit flush", () => {
    const framer = createAssistantTextFramer();
    framer.accept(delta(1, "second"));
    framer.accept(delta(0, "first"));
    assert.deepEqual(framer.flush(), ["first", "second"]);
    assert.deepEqual(framer.flush(), []);
  });

  test("drops a half-written block when the stream errors", () => {
    assert.deepEqual(
      drive([
        delta(0, "half a re"),
        { type: "error", reason: "error", error: partial },
      ]),
      [],
    );
  });

  test("never frames an empty segment", () => {
    assert.deepEqual(drive([delta(0, ""), end(0, ""), done]), []);
  });
});
