import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureChatUiVisibilityIndex } from "./chat-ui-visibility.js";
import type { SqliteDatabase } from "./shared.js";

const openDatabase = (): Database => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ordering_sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      data_json TEXT
    );
  `);
  return database;
};

describe("chat UI visibility completion marker", () => {
  test("backfills once and keeps future chat rows materialized", () => {
    const database = openDatabase();
    database
      .prepare(
        "INSERT INTO message (id, session_id, type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("m1", "s1", "user_message", 1);
    const db = database as unknown as SqliteDatabase;

    ensureChatUiVisibilityIndex(db);
    expect(
      database.prepare("SELECT ui_visible FROM message WHERE id = 'm1'").get(),
    ).toEqual({ ui_visible: 1 });
    expect(
      database
        .prepare(
          "SELECT value FROM settings WHERE key = 'chat_ui_visibility_backfilled_v1'",
        )
        .get(),
    ).toEqual({ value: "1" });

    database
      .prepare(
        "INSERT INTO message (id, session_id, type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("m2", "s1", "assistant_message", 2);
    expect(
      database.prepare("SELECT ui_visible FROM message WHERE id = 'm2'").get(),
    ).toEqual({ ui_visible: 1 });
    database.close();
  });

  test("adopts the previous post-backfill partial index proof", () => {
    const database = openDatabase();
    const db = database as unknown as SqliteDatabase;
    ensureChatUiVisibilityIndex(db);
    database
      .prepare(
        "DELETE FROM settings WHERE key = 'chat_ui_visibility_backfilled_v1'",
      )
      .run();

    ensureChatUiVisibilityIndex(db);
    expect(
      database
        .prepare(
          "SELECT value FROM settings WHERE key = 'chat_ui_visibility_backfilled_v1'",
        )
        .get(),
    ).toEqual({ value: "1" });
    database.close();
  });
});
