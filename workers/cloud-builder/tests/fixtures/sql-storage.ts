/**
 * A `SqlStorage` backed by in-memory SQLite, for tests that exercise Durable
 * Object SQL outside workerd.
 *
 * `exec` in workerd returns a cursor whose rows are already materialized for
 * the statement it ran; `bun:sqlite` splits that into `all` for reads and `run`
 * for writes, so the shim dispatches on the leading keyword.
 */

import { Database } from "bun:sqlite";

export type SqlStorageFake = Readonly<{
  sql: SqlStorage;
  close(): void;
}>;

export const openSqlStorageFake = (): SqlStorageFake => {
  const database = new Database(":memory:");
  const sql = {
    get databaseSize() {
      return 0;
    },
    exec<T>(statement: string, ...bindings: unknown[]) {
      const query = statement.trim();
      const rows = /^(SELECT|PRAGMA|WITH)\b/iu.test(query) || /\bRETURNING\b/iu.test(query)
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
  } as unknown as SqlStorage;
  return { sql, close: () => database.close() };
};
