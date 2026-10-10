import {
  asRecord,
  entryFromRecord,
  entryFromRow,
  type JournalEntry,
} from "./conversation-files";
import { postJson } from "./http";

/**
 * Reads of one conversation's cloud journal for the Files page, through the
 * same `history/query` route the desktop uses to list a conversation's files.
 * Resident rows are filtered in SQL so only rows that can carry a file cross
 * the network; older, archived rows are read in record batches.
 */

const HOT_PAGE_ROWS = 250;
const COLD_READ_RECORDS = 200;
const ARCHIVE_READS_PER_BATCH = 4;
const REQUEST_TIMEOUT_MS = 20_000;

const historyQuery = async (
  conversationId: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> =>
  postJson(
    `/conversations/${encodeURIComponent(conversationId)}/history/query`,
    body,
    { timeoutMs: REQUEST_TIMEOUT_MS, signal },
  );

const FILE_ROWS_FILTER = `(
  (kind = 'message' AND role = 'assistant' AND payload_json LIKE '%](%')
  OR (kind = 'message' AND role = 'user' AND (
    payload_json LIKE '%"attachments"%'
    OR (payload_json LIKE '%agent-thread%' AND payload_json LIKE '%](%')))
  OR (kind = 'message' AND role = 'toolResult' AND (
    payload_json LIKE '%"toolName":"html"%' OR payload_json LIKE '%"toolName":"image_gen"%'))
  OR (kind = 'card' AND (
    payload_json LIKE '%"type":"files"%' OR payload_json LIKE '%agent-completed%'))
)`;

export type ResidentWindow = { lowestSeq: number; headSeq: number };

/** The seq range the conversation still holds in its fast, queryable store. */
export const readResidentWindow = async (
  conversationId: string,
  signal?: AbortSignal,
): Promise<ResidentWindow | null> => {
  const rows = await historyQuery(
    conversationId,
    { op: "sql", query: "SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM journal" },
    signal,
  );
  const row = Array.isArray(rows) ? asRecord(rows[0]) : null;
  const lo = Number(row?.lo);
  const hi = Number(row?.hi);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return null;
  return { lowestSeq: lo, headSeq: hi };
};

/**
 * Resident journal rows that can carry a file, newest first, strictly between
 * `afterSeq` and `beforeSeq`.
 */
export const readResidentFileEntries = async (
  conversationId: string,
  range: { afterSeq: number; beforeSeq: number },
  signal?: AbortSignal,
): Promise<{ entries: JournalEntry[]; full: boolean }> => {
  const rows = await historyQuery(
    conversationId,
    {
      op: "sql",
      query: `SELECT seq, turn_id, kind, role, created_at, payload_json FROM journal
        WHERE seq > ? AND seq < ? AND ${FILE_ROWS_FILTER}
        ORDER BY seq DESC LIMIT ?`,
      params: [range.afterSeq, range.beforeSeq, HOT_PAGE_ROWS],
    },
    signal,
  );
  const list = Array.isArray(rows) ? rows : [];
  return {
    entries: list.flatMap((row) => {
      const entry = entryFromRow(row);
      return entry ? [entry] : [];
    }),
    full: list.length >= HOT_PAGE_ROWS,
  };
};

/**
 * One archived batch ending just below `beforeSeq`. `nextBeforeSeq` is where
 * the next older batch ends, or null once nothing older can be served.
 */
export const readArchivedEntries = async (
  conversationId: string,
  beforeSeq: number,
  signal?: AbortSignal,
): Promise<{ entries: JournalEntry[]; nextBeforeSeq: number | null }> => {
  const toSeq = beforeSeq - 1;
  if (toSeq < 0) return { entries: [], nextBeforeSeq: null };
  const fromSeq = Math.max(0, toSeq - COLD_READ_RECORDS + 1);
  const entries: JournalEntry[] = [];
  let cursor = fromSeq;
  let lostBelow = false;
  for (let attempt = 0; attempt < ARCHIVE_READS_PER_BATCH && cursor <= toSeq; attempt += 1) {
    const range = asRecord(
      await historyQuery(
        conversationId,
        { op: "read", fromSeq: cursor, toSeq },
        signal,
      ),
    );
    const records = Array.isArray(range?.records) ? range.records : [];
    let highest = cursor - 1;
    for (const record of records) {
      const entry = entryFromRecord(record);
      if (!entry) continue;
      entries.push(entry);
      highest = Math.max(highest, entry.seq);
    }
    if (typeof range?.missingBelowSeq === "number") lostBelow = true;
    if (range?.complete !== false || highest < cursor) break;
    cursor = highest + 1;
  }
  return {
    entries,
    nextBeforeSeq: lostBelow || fromSeq <= 0 ? null : fromSeq,
  };
};
