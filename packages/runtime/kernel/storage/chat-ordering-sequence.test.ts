import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chatOrderingSequenceIsComplete,
  installChatOrderingSequence,
  uninstallChatOrderingSequence,
} from "./chat-ordering-sequence.js";
import type { SqliteDatabase } from "./shared.js";

const openDatabase = (): Database => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return database;
};

describe("chat ordering sequence completion marker", () => {
  test("persists the completion proof and keeps new inserts sequenced", () => {
    const database = openDatabase();
    database
      .prepare(
        "INSERT INTO message (id, session_id, created_at) VALUES (?, ?, ?)",
      )
      .run("m1", "s1", 1);
    const db = database as unknown as SqliteDatabase;

    installChatOrderingSequence(db);
    expect(chatOrderingSequenceIsComplete(db)).toBe(true);
    expect(
      database
        .prepare(
          "SELECT completed FROM message_ordering_migration_state WHERE id = 0",
        )
        .get(),
    ).toEqual({ completed: 1 });
    database
      .prepare(
        "INSERT INTO message (id, session_id, created_at) VALUES (?, ?, ?)",
      )
      .run("m2", "s1", 2);
    expect(
      database
        .prepare("SELECT ordering_sequence FROM message WHERE id = 'm2'")
        .get(),
    ).toEqual({ ordering_sequence: 2 });

    installChatOrderingSequence(db);
    expect(chatOrderingSequenceIsComplete(db)).toBe(true);
    database.close();
  });

  test("adopts the prior atomic trigger and counter proof without a data rewrite", () => {
    const database = openDatabase();
    const db = database as unknown as SqliteDatabase;
    installChatOrderingSequence(db);
    database.exec("DROP TABLE message_ordering_migration_state;");
    expect(chatOrderingSequenceIsComplete(db)).toBe(false);

    installChatOrderingSequence(db);
    expect(chatOrderingSequenceIsComplete(db)).toBe(true);
    expect(
      database
        .prepare(
          "SELECT completed FROM message_ordering_migration_state WHERE id = 0",
        )
        .get(),
    ).toEqual({ completed: 1 });

    uninstallChatOrderingSequence(db);
    expect(chatOrderingSequenceIsComplete(db)).toBe(false);
    database.close();
  });
});
