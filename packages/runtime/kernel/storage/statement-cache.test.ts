import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cachedStatements, type SqliteDatabase } from "./shared.js";

// bun:sqlite's close() does not finalize outstanding statements (the
// connection stays open until they are collected), so the cache must
// finalize its statements when the connection closes.
describe("cachedStatements on bun:sqlite", () => {
  test("reuses one statement per SQL text and rebinds every argument", () => {
    const db = new Database(":memory:");
    const cache = cachedStatements(db as unknown as SqliteDatabase);
    const echo = cache.prepare("SELECT ? AS a, ? AS b");
    expect(cache.prepare("SELECT ? AS a, ? AS b")).toBe(echo);
    expect(echo.get(1, 2)).toEqual({ a: 1, b: 2 });
    expect(echo.get(3, null)).toEqual({ a: 3, b: null });
    // The one reuse hazard: a no-argument call keeps the previous bindings
    // (see `CachedStatements`), so parameterized SQL is always called with
    // its arguments.
    expect(echo.get()).toEqual({ a: 3, b: null });
    // A short argument list is rejected, never mixed with stale bindings.
    expect(() => echo.get(4)).toThrow();
    db.close();
  });

  test("finalizes cached statements when the connection closes", () => {
    const db = new Database(":memory:");
    const sqlite = db as unknown as SqliteDatabase;
    const cache = cachedStatements(sqlite);
    const statement = cache.prepare("SELECT 1 AS one");
    expect(statement.get()).toEqual({ one: 1 });
    db.close();
    expect(() => statement.get()).toThrow();
    // A later cache for the same object starts empty rather than handing
    // back finalized statements.
    expect(cachedStatements(sqlite)).not.toBe(cache);
  });
});
