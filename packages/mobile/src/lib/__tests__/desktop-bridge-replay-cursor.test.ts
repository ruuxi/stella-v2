import { describe, expect, test } from "bun:test";
import {
  admitBridgeEvent,
  createBridgeReplayCursor,
} from "../desktop-chat-event-policy";

const event = (
  overrides: Partial<Parameters<typeof admitBridgeEvent>[1]> = {},
) => ({
  runId: "run-1",
  type: "assistant-message",
  seq: 1,
  sourceSeq: 1,
  ...overrides,
});

describe("bridge replay cursor", () => {
  test("admits each event once and drops the resumed duplicate", () => {
    const cursor = createBridgeReplayCursor();
    expect(admitBridgeEvent(cursor, event({ seq: 1, sourceSeq: 7 }))).toBe(
      true,
    );
    // Same recorder row, renumbered by the broadcast buffer on resume.
    expect(admitBridgeEvent(cursor, event({ seq: 2, sourceSeq: 7 }))).toBe(
      false,
    );
  });

  test("a whole reply is not confused with the tool result beside it", () => {
    const cursor = createBridgeReplayCursor();
    expect(
      admitBridgeEvent(
        cursor,
        event({ type: "assistant-message", seq: 1, sourceSeq: 4 }),
      ),
    ).toBe(true);
    expect(
      admitBridgeEvent(
        cursor,
        event({ type: "tool-result", seq: 2, sourceSeq: 4 }),
      ),
    ).toBe(true);
  });

  test("keeps runs independent so a second run replays nothing", () => {
    const cursor = createBridgeReplayCursor();
    expect(
      admitBridgeEvent(cursor, event({ runId: "run-1", seq: 1, sourceSeq: 3 })),
    ).toBe(true);
    expect(
      admitBridgeEvent(cursor, event({ runId: "run-2", seq: 2, sourceSeq: 3 })),
    ).toBe(true);
  });

  test("rejects a rewound wire seq", () => {
    const cursor = createBridgeReplayCursor();
    expect(admitBridgeEvent(cursor, event({ seq: 5, sourceSeq: 5 }))).toBe(
      true,
    );
    expect(admitBridgeEvent(cursor, event({ seq: 4, sourceSeq: 9 }))).toBe(
      false,
    );
    expect(cursor.wireSeq).toBe(5);
  });

  test("resume pages from the recorder's own cursor, not the wire cursor", () => {
    const cursor = createBridgeReplayCursor();
    admitBridgeEvent(cursor, event({ seq: 1, sourceSeq: 41 }));
    admitBridgeEvent(cursor, event({ seq: 2, sourceSeq: 42 }));
    expect(cursor.wireSeq).toBe(2);
    expect(cursor.sourceSeq).toBe(42);
  });

  test("ignores an epoch timestamp stamped in place of a seq", () => {
    const cursor = createBridgeReplayCursor();
    expect(
      admitBridgeEvent(cursor, event({ seq: 1, sourceSeq: 1_764_000_000_000 })),
    ).toBe(true);
    expect(cursor.sourceSeq).toBe(0);
  });

  test("falls back to the wire seq when the host sends no source seq", () => {
    const cursor = createBridgeReplayCursor();
    expect(admitBridgeEvent(cursor, event({ seq: 3, sourceSeq: null }))).toBe(
      true,
    );
    expect(cursor.sourceSeq).toBe(3);
  });

  test("admits an unnumbered event without moving either cursor", () => {
    const cursor = createBridgeReplayCursor();
    expect(admitBridgeEvent(cursor, event({ seq: null, sourceSeq: null }))).toBe(
      true,
    );
    expect(cursor.wireSeq).toBe(0);
    expect(cursor.sourceSeq).toBe(0);
  });
});
