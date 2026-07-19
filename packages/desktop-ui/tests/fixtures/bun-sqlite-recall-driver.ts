import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../runtime/kernel/storage/database-init.ts";
import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "../../../runtime/kernel/storage/recall-read-queries.ts";
import {
  FtsSearchUnavailableError,
  SessionStore,
} from "../../../runtime/kernel/storage/session-store.ts";
import type { SqliteDatabase } from "../../../runtime/kernel/storage/shared.ts";

const isolatedDataDir = path.resolve(process.argv[2] ?? "");
const liveDataDir = path.join(os.homedir(), ".stella");
if (
  !process.argv[2] ||
  process.env.STELLA_V2_DEV_DATA_DIR !== isolatedDataDir ||
  isolatedDataDir === liveDataDir ||
  isolatedDataDir.startsWith(`${liveDataDir}${path.sep}`)
) {
  throw new Error("bun:sqlite Recall test requires an isolated v2 data dir");
}

const db = new Database(
  getDesktopDatabasePath(isolatedDataDir),
) as unknown as SqliteDatabase;

try {
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  for (const [eventId, timestamp, text] of [
    ["evt-before", 100, "before zanzibar"],
    ["evt-hit", 200, "the secret is zanzibar"],
    ["evt-after", 300, "after zanzibar"],
  ] as const) {
    store.appendEvent({
      conversationId: "conv-bun",
      eventId,
      type: "user_message",
      timestamp,
      payload: { text },
    });
  }

  const health = readRecallFtsHealth(db);
  const neighbors = listTranscriptNeighborsBatch(
    db,
    [{ conversationId: "conv-bun", atMs: 200 }],
    { before: 1, after: 1 },
  );

  db.exec("DROP TRIGGER trg_message_text_fts_part_insert;");
  db.exec("DROP TRIGGER trg_message_text_fts_part_update;");
  db.exec("DROP TRIGGER trg_message_text_fts_part_delete;");
  db.exec("DROP TABLE message_text_fts;");
  const missingIndexStore = new SessionStore(db);
  let missingIndexTypedError = false;
  try {
    missingIndexStore.searchTranscripts({ query: "zanzibar" });
  } catch (error) {
    missingIndexTypedError =
      error instanceof FtsSearchUnavailableError &&
      error.index === "transcripts";
  }

  db.exec("CREATE TABLE message_text_fts (text TEXT);");
  const brokenMatchHealth = readRecallFtsHealth(db);
  const brokenMatchStore = new SessionStore(db);
  let brokenMatchTypedError = false;
  try {
    brokenMatchStore.searchTranscripts({ query: "zanzibar" });
  } catch (error) {
    brokenMatchTypedError =
      error instanceof FtsSearchUnavailableError &&
      error.index === "transcripts" &&
      error.message.includes("MATCH query failed");
  }
  const likeHits = brokenMatchStore
    .searchTranscripts({ query: "zanzibar", degradedMode: "like" })
    .map((hit) => hit.text);

  process.stdout.write(
    JSON.stringify({
      health,
      neighbors: neighbors.map((group) => group.map((row) => row.text)),
      missingIndexTypedError,
      brokenMatchHealth,
      brokenMatchTypedError,
      likeHits,
    }),
  );
} finally {
  db.close();
}
