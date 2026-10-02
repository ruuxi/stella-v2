/**
 * `history.sql(query, params)` in the orchestrator's code tool: one read-only
 * statement over this conversation's Durable Object SQLite (`journal`,
 * `journal_fts`, `turns`, ...).
 *
 * Two independent guards. The text must be a single SELECT/WITH statement
 * with no write or schema keyword outside literals and comments, and it runs
 * inside a transaction that is rolled back if the cursor reports a written
 * row. Rows stop at the code sandbox's own value cap rather than being
 * materialized and rejected afterwards.
 */

import { CLOUD_CODE_WORKER_VALUE_MAX_BYTES } from "./cloud-code-worker-executor.js";
import { utf8Length } from "./conversation-types.js";

/** Literals, quoted identifiers and comments, which may contain anything. */
const OPAQUE_SQL_RE =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu;

/** `replace(` is the string function; bare REPLACE starts a write. */
const WRITE_KEYWORD_RE =
  /\b(?:insert|update|delete|replace(?!\s*\()|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|returning)\b/iu;

export const readOnlyHistoryQuery = (query: string): string => {
  const statement = query.trim().replace(/;\s*$/u, "");
  const code = statement.replace(OPAQUE_SQL_RE, " ").trim();
  if (code.includes(";")) {
    throw new Error("history.sql runs exactly one statement.");
  }
  if (!/^(?:select|with)\b/iu.test(code) || WRITE_KEYWORD_RE.test(code)) {
    throw new Error("history.sql accepts only a read-only SELECT or WITH query.");
  }
  return statement;
};

export const runHistoryQuery = (
  storage: DurableObjectStorage,
  query: string,
  params: readonly SqlStorageValue[],
  maxBytes = CLOUD_CODE_WORKER_VALUE_MAX_BYTES,
): Record<string, SqlStorageValue>[] => {
  const statement = readOnlyHistoryQuery(query);
  return storage.transactionSync(() => {
    const cursor = storage.sql.exec(statement, ...params);
    const rows: Record<string, SqlStorageValue>[] = [];
    let bytes = 0;
    for (const row of cursor) {
      for (const [column, value] of Object.entries(row)) {
        if (value instanceof ArrayBuffer) {
          row[column] = `[${value.byteLength}-byte blob]`;
        }
      }
      bytes += utf8Length(JSON.stringify(row));
      if (bytes > maxBytes) {
        throw new Error(
          `history.sql result exceeds ${maxBytes} bytes; add a LIMIT or select fewer columns.`,
        );
      }
      rows.push(row);
    }
    // Throwing inside transactionSync rolls the statement back.
    if (cursor.rowsWritten > 0) {
      throw new Error("history.sql is read-only.");
    }
    return rows;
  });
};
