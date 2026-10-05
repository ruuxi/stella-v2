/**
 * The orchestrator CLI turn's bulky and long-lived state in a `BuildSession`'s
 * own SQLite (see cloud-orchestrator-cli.ts for the turn itself).
 *
 * The spec (the DO's system prompt and tool catalog, up to 512 KiB of
 * characters and 512 KiB of JSON) cannot ride inside the `turn` key-value
 * record: that record is read on almost every lifecycle step, and its
 * serialized size could pass the 2 MB per-value limit (a prompt of
 * multi-byte or escaped characters is several bytes per character). It is
 * stored here once, in chunks well under the 2 MB row limit, and read back
 * only when the executor's turn input is written.
 *
 * The terminal frame each attempt sent its conversation is kept here too,
 * because the key-value turn record is deleted once that frame is acked: a
 * DO that was evicted mid-turn polls by `{turnId, attemptGeneration}` and
 * must still learn how it ended. The last {@link TERMINALS_KEPT} are kept.
 */
import type {
  CloudCliTurnTerminal,
  CloudOrchestratorCliTurnSpec,
} from "@stella/contracts/cloud-orchestrator-cli";
import { parseCloudOrchestratorCliTurnSpec } from "@stella/contracts/cloud-orchestrator-cli";
import { stableValueMarker } from "./hash.js";

/** Bytes per spec row; the platform's row limit is 2 MB. */
const SPEC_CHUNK_BYTES = 512 * 1024;
const TERMINALS_KEPT = 32;

const DDL = [
  `CREATE TABLE IF NOT EXISTS orchestrator_cli_spec_chunks (
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     chunk_index        INTEGER NOT NULL,
     chunk              BLOB    NOT NULL,
     PRIMARY KEY (turn_id, attempt_generation, chunk_index)
   )`,
  `CREATE TABLE IF NOT EXISTS orchestrator_cli_terminals (
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     terminal_json      TEXT    NOT NULL,
     recorded_at        INTEGER NOT NULL,
     PRIMARY KEY (turn_id, attempt_generation)
   )`,
] as const;

const provisioned = new WeakSet<SqlStorage>();

const ensureSchema = (sql: SqlStorage): void => {
  if (provisioned.has(sql)) return;
  for (const statement of DDL) sql.exec(statement);
  provisioned.add(sql);
};

export type OrchestratorCliAttempt = Readonly<{
  turnId: string;
  attemptGeneration: number;
}>;

/**
 * Names the spec inside the stored turn record, so a replayed dispatch is
 * still compared against exactly what was admitted.
 */
export const orchestratorCliSpecDigest = (
  spec: CloudOrchestratorCliTurnSpec,
): Promise<string> => stableValueMarker(spec);

/**
 * Store the admitted attempt's spec. Only one attempt runs on a thread at a
 * time, so any other attempt's spec is dropped with it.
 */
export const storeOrchestratorCliSpec = (
  sql: SqlStorage,
  attempt: OrchestratorCliAttempt,
  spec: CloudOrchestratorCliTurnSpec,
): void => {
  ensureSchema(sql);
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  sql.exec(`DELETE FROM orchestrator_cli_spec_chunks`);
  for (
    let index = 0, offset = 0;
    offset < bytes.byteLength;
    index += 1, offset += SPEC_CHUNK_BYTES
  ) {
    sql.exec(
      `INSERT INTO orchestrator_cli_spec_chunks
         (turn_id, attempt_generation, chunk_index, chunk)
       VALUES (?, ?, ?, ?)`,
      attempt.turnId,
      attempt.attemptGeneration,
      index,
      bytes.slice(offset, offset + SPEC_CHUNK_BYTES).buffer,
    );
  }
};

/** The exact attempt's spec, revalidated, or null when it is gone. */
export const readOrchestratorCliSpec = (
  sql: SqlStorage,
  attempt: OrchestratorCliAttempt,
): CloudOrchestratorCliTurnSpec | null => {
  ensureSchema(sql);
  const rows = sql
    .exec<{ chunk: ArrayBuffer }>(
      `SELECT chunk FROM orchestrator_cli_spec_chunks
        WHERE turn_id = ? AND attempt_generation = ?
        ORDER BY chunk_index`,
      attempt.turnId,
      attempt.attemptGeneration,
    )
    .toArray();
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const row of rows) {
    bytes.set(new Uint8Array(row.chunk), offset);
    offset += row.chunk.byteLength;
  }
  try {
    return parseCloudOrchestratorCliTurnSpec(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
  } catch {
    return null;
  }
};

/**
 * Remember how an attempt ended, before the frame is first sent. The spec is
 * no longer needed once the attempt is decided.
 */
export const recordOrchestratorCliTerminal = (
  sql: SqlStorage,
  terminal: CloudCliTurnTerminal,
  now: number,
): void => {
  ensureSchema(sql);
  sql.exec(
    `DELETE FROM orchestrator_cli_spec_chunks
      WHERE turn_id = ? AND attempt_generation = ?`,
    terminal.turnId,
    terminal.attemptGeneration,
  );
  sql.exec(
    `INSERT INTO orchestrator_cli_terminals
       (turn_id, attempt_generation, terminal_json, recorded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (turn_id, attempt_generation) DO NOTHING`,
    terminal.turnId,
    terminal.attemptGeneration,
    JSON.stringify(terminal),
    now,
  );
  sql.exec(
    `DELETE FROM orchestrator_cli_terminals
      WHERE rowid NOT IN (
        SELECT rowid FROM orchestrator_cli_terminals
         ORDER BY recorded_at DESC, rowid DESC LIMIT ?
      )`,
    TERMINALS_KEPT,
  );
};

export const readOrchestratorCliTerminal = (
  sql: SqlStorage,
  attempt: OrchestratorCliAttempt,
): CloudCliTurnTerminal | null => {
  ensureSchema(sql);
  const row = sql
    .exec<{ terminal_json: string }>(
      `SELECT terminal_json FROM orchestrator_cli_terminals
        WHERE turn_id = ? AND attempt_generation = ?`,
      attempt.turnId,
      attempt.attemptGeneration,
    )
    .toArray()[0];
  if (!row) return null;
  try {
    return JSON.parse(row.terminal_json) as CloudCliTurnTerminal;
  } catch {
    return null;
  }
};

/** Owner purge: the conversation's prompt and outcomes go with the rest. */
export const purgeOrchestratorCliTurnStore = (sql: SqlStorage): void => {
  sql.exec(`DROP TABLE IF EXISTS orchestrator_cli_spec_chunks`);
  sql.exec(`DROP TABLE IF EXISTS orchestrator_cli_terminals`);
  provisioned.delete(sql);
};
