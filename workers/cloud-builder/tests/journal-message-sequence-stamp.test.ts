/**
 * Canonical history stamps every visible user message with its journal
 * sequence (`reply-refs`) so the model can cite earlier messages by number;
 * hidden lifecycle prompts and assistant rows are left untouched and the
 * stored payloads stay raw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Journal, stampUserMessageSequences } from "../src/journal.js";

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
  return { database, journal };
};

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

const text = (message: { content: unknown }): string =>
  (message.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

describe("journal user message sequence stamping", () => {
  test("stamps visible user rows, skips hidden and assistant rows, keeps payloads raw", async () => {
    const { database, journal } = await openHarness();
    const asked = journal.appendMessage({
      turnId: "turn-1",
      writer: "desktop:d1",
      writerKey: "turn:turn-1:prompt",
      role: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Compare vendor pricing" }],
        timestamp: 1,
      },
    });
    journal.appendMessage({
      turnId: "turn-1",
      writer: "orchestrator",
      writerKey: "turn:turn-1:reply:0",
      role: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "On it." }],
        timestamp: 2,
      },
    });
    journal.appendMessage({
      turnId: "turn-2",
      writer: "desktop:d1",
      writerKey: "turn:turn-2:prompt",
      role: "user",
      hidden: true,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Agent completed]\nthread_id: pricing-research",
          },
        ],
        timestamp: 3,
      },
    });

    const selection = journal.selectWindow("turn-current", 100_000);
    expect(selection.rows.map((row) => [row.role, row.hidden])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", true],
    ]);
    const stamped = stampUserMessageSequences(
      selection.messages,
      selection.rows,
    );
    expect(text(stamped[0]!)).toBe(
      `Compare vendor pricing\n\n<system-reminder>message #${asked.seq}</system-reminder>`,
    );
    expect(text(stamped[1]!)).toBe("On it.");
    expect(text(stamped[2]!)).toBe(
      "[Agent completed]\nthread_id: pricing-research",
    );
    // The window's own messages and the stored rows stay untouched.
    expect(text(selection.messages[0]!)).toBe("Compare vendor pricing");
    const stored = database
      .query("SELECT payload_json FROM journal WHERE seq = ?")
      .get(asked.seq) as { payload_json: string };
    expect(stored.payload_json).not.toContain("system-reminder");
  });
});
