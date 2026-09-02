import { describe, expect, test } from "bun:test";
import {
  ThreadTranscriptError,
  appendThreadMessages,
  nextTurnEventSeq,
  purgeThreadTranscript,
  readThreadHistory,
  reserveTurnEventSeq,
} from "../src/thread-transcript.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

/**
 * The thread transcript is the BuildSession's own SQLite state: the rows a
 * continuation reads back, and the two ordinals Convex used to assign. Every
 * property here is one a projection or a continuation depends on.
 */

const payload = (text: string): string =>
  JSON.stringify({ role: "assistant", content: [{ type: "text", text }] });

describe("thread transcript rows", () => {
  test("reads back oldest-first with a monotonic seq across turns", () => {
    const { sql, close } = openSqlStorageFake();
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [
        { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
        { ordinal: 1, role: "assistant", payloadJson: payload("one") },
      ],
      now: 10,
    });
    appendThreadMessages(sql, {
      turnId: "turn-2",
      attemptGeneration: 2,
      messages: [{ ordinal: 0, role: "assistant", payloadJson: payload("two") }],
      now: 20,
    });

    const rows = readThreadHistory(sql, {});
    expect(rows.map((row) => [row.turnId, row.role])).toEqual([
      ["turn-1", "user"],
      ["turn-1", "assistant"],
      ["turn-2", "assistant"],
    ]);
    expect(rows.map((row) => row.seq)).toEqual([...rows]
      .map((row) => row.seq)
      .sort((left, right) => left - right));
    expect(new Set(rows.map((row) => row.seq)).size).toBe(3);
    close();
  });

  test("a continuation excludes only its own turn", () => {
    const { sql, close } = openSqlStorageFake();
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [{ ordinal: 0, role: "assistant", payloadJson: payload("a") }],
      now: 10,
    });
    appendThreadMessages(sql, {
      turnId: "turn-2",
      attemptGeneration: 2,
      messages: [{ ordinal: 0, role: "user", payloadJson: '{"role":"user"}' }],
      now: 20,
    });

    expect(
      readThreadHistory(sql, { excludeTurnId: "turn-2" }).map(
        (row) => row.turnId,
      ),
    ).toEqual(["turn-1"]);
    close();
  });

  test("re-appending the same ordinals commits and projects nothing twice", () => {
    const { sql, close } = openSqlStorageFake();
    const messages = [
      { ordinal: 0, role: "assistant", payloadJson: payload("once") },
    ];
    const first = appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages,
      now: 10,
    });
    const replay = appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages,
      now: 11,
    });

    expect(first.messages).toHaveLength(1);
    expect(first.batchOrdinal).toBe(1);
    // A replay is a no-op, so it must not burn a batch ordinal either.
    expect(replay.messages).toHaveLength(0);
    expect(replay.batchOrdinal).toBe(0);
    expect(readThreadHistory(sql, {})).toHaveLength(1);
    close();
  });

  test("a partially replayed batch commits and projects only the new rows", () => {
    const { sql, close } = openSqlStorageFake();
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [{ ordinal: 0, role: "user", payloadJson: '{"role":"user"}' }],
      now: 10,
    });
    const second = appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [
        { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
        { ordinal: 1, role: "assistant", payloadJson: payload("new") },
      ],
      now: 11,
    });

    expect(second.messages.map((row) => row.ordinal)).toEqual([1]);
    expect(second.batchOrdinal).toBe(2);
    expect(readThreadHistory(sql, {})).toHaveLength(2);
    close();
  });

  test("the same ordinal under a different attempt is a different row", () => {
    const { sql, close } = openSqlStorageFake();
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [{ ordinal: 0, role: "assistant", payloadJson: payload("a") }],
      now: 10,
    });
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 2,
      messages: [{ ordinal: 0, role: "assistant", payloadJson: payload("b") }],
      now: 20,
    });

    expect(readThreadHistory(sql, {}).map((row) => row.payloadJson)).toEqual([
      payload("a"),
      payload("b"),
    ]);
    close();
  });

  test("refuses rows that are not transcript rows", () => {
    const { sql, close } = openSqlStorageFake();
    const bad = (messages: unknown[]) => () =>
      appendThreadMessages(sql, {
        turnId: "turn-1",
        attemptGeneration: 1,
        messages: messages as never,
        now: 10,
      });

    expect(bad([{ ordinal: 0, role: "system", payloadJson: "{}" }])).toThrow(
      ThreadTranscriptError,
    );
    expect(bad([{ ordinal: -1, role: "user", payloadJson: "{}" }])).toThrow(
      ThreadTranscriptError,
    );
    expect(bad([{ ordinal: 0, role: "user", payloadJson: "" }])).toThrow(
      ThreadTranscriptError,
    );
    expect(
      bad([
        { ordinal: 0, role: "user", payloadJson: "{}" },
        { ordinal: 0, role: "assistant", payloadJson: "{}" },
      ]),
    ).toThrow(ThreadTranscriptError);
    expect(readThreadHistory(sql, {})).toEqual([]);
    close();
  });

  test("refuses an append that cannot name its attempt", () => {
    const { sql, close } = openSqlStorageFake();
    expect(() =>
      appendThreadMessages(sql, {
        turnId: "  ",
        attemptGeneration: 1,
        messages: [],
        now: 10,
      }),
    ).toThrow(ThreadTranscriptError);
    expect(() =>
      appendThreadMessages(sql, {
        turnId: "turn-1",
        attemptGeneration: 0,
        messages: [],
        now: 10,
      }),
    ).toThrow(ThreadTranscriptError);
    close();
  });
});

describe("per-attempt ordinals", () => {
  test("event sequences are monotonic per attempt and independent across them", () => {
    const { sql, close } = openSqlStorageFake();
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(1);
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(2);
    expect(nextTurnEventSeq(sql, "turn-1", 2)).toBe(1);
    expect(nextTurnEventSeq(sql, "turn-2", 1)).toBe(1);
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(3);
    close();
  });

  test("a restarted isolate continues the sequence rather than repeating it", () => {
    const { sql, close } = openSqlStorageFake();
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(1);
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(2);

    // The counter lives in the object's storage, not the isolate: a fresh
    // isolate over the same SQLite reads it back instead of restarting at 1
    // and colliding with events Convex has already projected.
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(3);
    close();
  });

  test("owner purge drops the thread's rows and its ordinals", () => {
    const { sql, close } = openSqlStorageFake();
    appendThreadMessages(sql, {
      turnId: "turn-1",
      attemptGeneration: 1,
      messages: [{ ordinal: 0, role: "assistant", payloadJson: payload("a") }],
      now: 10,
    });
    nextTurnEventSeq(sql, "turn-1", 1);

    purgeThreadTranscript(sql);

    expect(readThreadHistory(sql, {})).toEqual([]);
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(1);
    close();
  });
});

describe("caller-chosen ordinals", () => {
  test("a reserved ordinal is never handed out again", () => {
    const { sql, close } = openSqlStorageFake();
    reserveTurnEventSeq(sql, "turn-1", 1, 4);

    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(5);
    // A lower reservation (an idempotent replay of an earlier event) must not
    // rewind the sequence.
    reserveTurnEventSeq(sql, "turn-1", 1, 2);
    expect(nextTurnEventSeq(sql, "turn-1", 1)).toBe(6);
    close();
  });

  test("reservations are scoped to one attempt", () => {
    const { sql, close } = openSqlStorageFake();
    reserveTurnEventSeq(sql, "turn-1", 1, 9);

    expect(nextTurnEventSeq(sql, "turn-1", 2)).toBe(1);
    close();
  });
});
