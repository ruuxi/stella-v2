/**
 * Rehearsal / backfill / verify / unset tool for the Phase-0 chat-ordering
 * sequence migration (see the hardened plan v2.1). Run with bun.
 *
 * SAFETY: the default mode is a DRY RUN on a COPY of the database — it never
 * touches the real file. It proves the backfill preserves current display order
 * (`ORDER BY ordering_sequence` == `ORDER BY (created_at, id)` per session)
 * before anyone runs `--apply` against real user data. `--apply` is the only
 * mode that writes to the target, and it is intended to run only with explicit
 * sign-off.
 *
 * Usage:
 *   bun packages/runtime/scripts/chat-ordering-backfill.ts <db-path> [--apply] [--unset]
 *
 *   (no flags)   Copy <db-path> to a temp file, run the migration on the copy,
 *                verify order-preservation, print a report. Real DB untouched.
 *   --apply      Run the migration IN PLACE on <db-path> (writes real data).
 *   --unset      Reverse the migration (drop trigger/counter/indexes, NULL the
 *                column). Combine with --apply to reverse the real DB; otherwise
 *                rehearsed on a copy.
 */

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
