import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import {
  chatOrderingSequenceIsComplete,
  installChatOrderingSequence,
  uninstallChatOrderingSequence,
  verifyChatOrderingSequenceOrder,
} from "../kernel/storage/chat-ordering-sequence.js";

const args = process.argv.slice(2);
const dbPath = args.find((arg) => !arg.startsWith("--"));
const apply = args.includes("--apply");
const unset = args.includes("--unset");

if (!dbPath) {
  console.error(
    "usage: bun packages/runtime/scripts/chat-ordering-backfill.ts <db-path> [--apply] [--unset]",
  );
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(2);
}

const openDb = (file: string): SqliteDatabase =>
  new Database(file) as unknown as SqliteDatabase;

const countRows = (db: SqliteDatabase): number => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM message").get() as {
    n?: number;
  };
  return typeof row?.n === "number" ? row.n : 0;
};

let target = dbPath;
if (!apply) {
  const copy = path.join(
    tmpdir(),
    `chat-ordering-rehearsal-${Date.now()}.sqlite`,
  );
  copyFileSync(dbPath, copy);
  target = copy;
  console.log(`[dry-run] operating on a COPY: ${copy}`);
  console.log(`[dry-run] the real database (${dbPath}) is untouched.`);
} else {
  console.log(`[apply] operating IN PLACE on: ${dbPath}`);
}

const db = openDb(target);
try {
  const total = countRows(db);
  if (unset) {
    uninstallChatOrderingSequence(db);
    console.log(`[unset] reversed migration over ${total} message rows.`);
    console.log(
      `[unset] complete=${chatOrderingSequenceIsComplete(db)} (expected false)`,
    );
  } else {
    installChatOrderingSequence(db);
    const divergences = verifyChatOrderingSequenceOrder(db);
    const complete = chatOrderingSequenceIsComplete(db);
    console.log(`rows:                 ${total}`);
    console.log(`sequences complete:   ${complete}`);
    console.log(`order divergences:    ${divergences.length}`);
    if (divergences.length > 0) {
      console.error(
        "ORDER NOT PRESERVED — the sequence order differs from (created_at,id) for:",
      );
      for (const d of divergences.slice(0, 20)) {
        console.error(
          `  session=${d.sessionId} pos=${d.position} bySeq=${d.bySequenceId} byTs=${d.byTimestampId}`,
        );
      }
      process.exitCode = 1;
    } else {
      console.log(
        "OK — sequence order == (created_at,id) order for every session (order-preserving).",
      );
    }
  }
} finally {
  db.close();
}
