import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD,
  Journal,
  JournalContextIntegrityError,
} from "../src/journal.js";

const databases: Database[] = [];

const openHarness = async () => {
  const database = new Database(":memory:");
  databases.push(database);
  const kv = new Map<string, unknown>();
  const sql = {
    get databaseSize() {
      return 0;
    },
    exec<T>(statement: string, ...bindings: unknown[]) {
      const query = statement.trim();
      const rows = /^(SELECT|PRAGMA|WITH)\b/i.test(query)
        ? (database.query(query).all(...bindings) as T[])
        : (database.run(query, bindings), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected one row, received ${rows.length}.`);
          }
          return rows[0]!;
        },
      };
    },
  };
  const storage = {
    sql,
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") kv.set(key, value);
      else {
        for (const [entryKey, entryValue] of Object.entries(key)) {
          kv.set(entryKey, entryValue);
        }
      }
    },
    transactionSync: <T>(operation: () => T): T =>
      database.transaction(operation)(),
  };
  const state = { storage } as unknown as DurableObjectState;
  const journal = new Journal(state, () => undefined);
  await journal.bootstrap();
  return { database, state, journal };
};

const appendContextWithCorruption = (journal: Journal): number => {
  journal.appendMessage({
    turnId: "turn-before",
    writer: "orchestrator",
    writerKey: "turn:turn-before:prompt",
    role: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "remember this" }],
      timestamp: 1,
    },
  });
  return journal.appendMessage({
    turnId: "turn-before",
    writer: "orchestrator",
    writerKey: "turn:turn-before:reply:0",
    role: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "stored reply" }],
      timestamp: 2,
    },
    payloadJson: '{"role":"assistant","content":[',
  }).seq;
};

const captureIntegrityError = (operation: () => unknown) => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected canonical history selection to fail.");
};

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("canonical journal context integrity", () => {
  test("fails closed on malformed payload_json and retains the exact row", async () => {
    const { database, journal } = await openHarness();
    const corruptSeq = appendContextWithCorruption(journal);

    const error = captureIntegrityError(() =>
      journal.selectWindow("turn-current", 100_000),
    );

    expect(error).toBeInstanceOf(JournalContextIntegrityError);
    expect(error).toMatchObject({
      code: "CLOUD_CONTEXT_UNAVAILABLE",
      component: "canonical_history",
      seq: corruptSeq,
      message: "Canonical conversation history is unreadable.",
    });
    expect(
      database
        .query(
          `SELECT seq, payload_json, model_skip FROM journal WHERE seq = ?`,
        )
        .get(corruptSeq),
    ).toEqual({
      seq: corruptSeq,
      payload_json: '{"role":"assistant","content":[',
      model_skip: 0,
    });
  });

  test("a restart and reconnect observe the same blocking corruption", async () => {
    const { database, state, journal } = await openHarness();
    const corruptSeq = appendContextWithCorruption(journal);

    const beforeRestart = captureIntegrityError(() =>
      journal.selectWindow("turn-current", 100_000),
    );
    const restarted = new Journal(state, () => undefined);
    await restarted.bootstrap();
    const afterRestart = captureIntegrityError(() =>
      restarted.selectWindow("turn-current", 100_000),
    );
    const reconnectSnapshot = restarted.newest();
    const afterReconnect = captureIntegrityError(() =>
      restarted.selectWindow("turn-current", 100_000),
    );

    for (const error of [beforeRestart, afterRestart, afterReconnect]) {
      expect(error).toBeInstanceOf(JournalContextIntegrityError);
      expect(error).toMatchObject({ seq: corruptSeq });
    }
    expect(
      reconnectSnapshot.find((record) => record.seq === corruptSeq),
    ).toMatchObject({
      seq: corruptSeq,
      kind: "message",
      payload: null,
    });
    expect(
      database.query(`SELECT COUNT(*) AS count FROM journal`).get(),
    ).toEqual({ count: 2 });
    expect(
      database
        .query(`SELECT payload_json FROM journal WHERE seq = ?`)
        .get(corruptSeq),
    ).toEqual({ payload_json: '{"role":"assistant","content":[' });
  });

  test("does not inspect malformed rows excluded from active model context", async () => {
    const { journal } = await openHarness();
    journal.appendMessage({
      turnId: "turn-hidden",
      writer: "orchestrator",
      writerKey: "turn:turn-hidden:hidden",
      role: "user",
      modelSkip: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "not model context" }],
        timestamp: 1,
      },
      payloadJson: "{",
    });
    journal.appendMessage({
      turnId: "turn-before",
      writer: "orchestrator",
      writerKey: "turn:turn-before:prompt",
      role: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "valid model context" }],
        timestamp: 2,
      },
    });

    expect(journal.selectWindow("turn-current", 100_000).messages).toHaveLength(
      1,
    );
  });

  test("bounded acceptance corruption survives restart and auto-repairs after two blocked turns", async () => {
    const { database, state, journal } = await openHarness();
    const original = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "durable acceptance marker" }],
      timestamp: 1,
    });
    const seq = journal.appendMessage({
      turnId: "turn-before",
      writer: "orchestrator",
      writerKey: "turn:turn-before:prompt",
      role: "user",
      message: JSON.parse(original),
      payloadJson: original,
    }).seq;
    const candidate = journal.acceptanceContextFaultCandidate();
    expect(candidate).toEqual({ seq, payloadJson: original });
    expect(
      journal.armAcceptanceContextFault({
        runIdSha256: "a".repeat(64),
        seq: candidate!.seq,
        expectedPayloadJson: candidate!.payloadJson,
        originalPayloadSha256: "b".repeat(64),
        corruptPayloadSha256: "c".repeat(64),
        createdAt: 10,
      }),
    ).toMatchObject({
      seq,
      observed_failures: 0,
      repair_after_failures: 2,
    });
    expect(
      database.query(`SELECT payload_json FROM journal WHERE seq = ?`).get(seq),
    ).toEqual({ payload_json: ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD });
    expect(() => journal.selectWindow("turn-current", 100_000)).toThrow(
      JournalContextIntegrityError,
    );
    expect(
      journal.observeAcceptanceContextFault("a".repeat(64)),
    ).toMatchObject({ observedFailures: 1, repaired: false, seq });

    const restarted = new Journal(state, () => undefined);
    await restarted.bootstrap();
    expect(restarted.acceptanceContextFaultStatus()).toMatchObject({
      seq,
      observed_failures: 1,
      repair_after_failures: 2,
    });
    expect(() => restarted.selectWindow("turn-after-restart", 100_000)).toThrow(
      JournalContextIntegrityError,
    );
    expect(
      restarted.observeAcceptanceContextFault("a".repeat(64)),
    ).toEqual({
      observedFailures: 2,
      repaired: true,
      seq,
      originalPayloadSha256: "b".repeat(64),
      corruptPayloadSha256: "c".repeat(64),
    });
    expect(restarted.acceptanceContextFaultStatus()).toBeNull();
    expect(
      database.query(`SELECT payload_json FROM journal WHERE seq = ?`).get(seq),
    ).toEqual({ payload_json: original });
    expect(
      restarted.selectWindow("turn-after-repair", 100_000).messages,
    ).toHaveLength(1);
  });
});

test("lifecycle cards survive journal reconstruction and duplicate delivery without entering model context", async () => {
  const { state, journal } = await openHarness();
  const { cloudAgentActivationCard, cloudAgentTerminalCard } =
    await import("../src/cloud-agent-lifecycle.js");
  const control = {
    threadId: "thread",
    attemptGeneration: 1,
    threadUpdatedAt: 30,
    status: "running",
    description: "Task",
  } as const;
  const cards = [
    cloudAgentActivationCard({
      outcome: { kind: "spawn_agent", fingerprint: "f", control },
      parentTurnId: "root",
      toolCallId: "call",
    }),
    cloudAgentTerminalCard({
      ...control,
      status: "completed",
      lifecycleReport: "Report",
    }),
  ];
  for (const card of cards) {
    if (!card) throw new Error("Missing lifecycle card");
    const input = {
      turnId: "root",
      writer: "orchestrator",
      writerKey: card.eventId,
      createdAt: 30,
      card,
    };
    expect(journal.appendCard(input).inserted).toBe(true);
    expect(journal.appendCard(input).inserted).toBe(false);
  }
  const restored = new Journal(state, () => undefined);
  await restored.bootstrap();
  expect(
    restored
      .newest(100)
      .map((record) => (record.kind === "card" ? record.card : null)),
  ).toEqual(cards);
  expect(restored.selectWindow("next", 100_000).messages).toEqual([]);
});
