/**
 * Durable runs and tool intents (`run_task`, `tool_intent`, schema v5).
 *
 * The agent loop that ran Stella's own turns in this runtime kept one
 * `run_task` row per orchestrator chat run or local agent run, and one
 * `tool_intent` row per tool call, so a run could resume after its worker
 * died. Nothing writes them anymore: Stella's chat runs on pi-durable, which
 * keeps its own. What older builds left behind is settled once, at the next
 * worker's boot, and terminal rows are pruned by idle maintenance.
 *
 * All statements are synchronous on the worker's database thread.
 */

import type { SqliteDatabase } from "./shared.js";

/** Terminal rows (and their intents) older than this are deleted. */
const RUN_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A run an older build left running, as its terminal event needs it. */
export type InterruptedRunTask = {
  runId: string;
  conversationId: string;
  agentType: string;
  abortRequested: boolean;
};

const changesOf = (result: unknown): number => {
  const changes = (result as { changes?: unknown } | undefined)?.changes;
  return typeof changes === "number" ? changes : 0;
};

/**
 * Mark every run (and tool intent) still `running` as `interrupted`: no
 * process will continue it. Returns the runs it settled.
 */
export const settleInterruptedRunTasks = (
  db: SqliteDatabase,
  now = Date.now(),
): InterruptedRunTask[] => {
  const rows = (
    db
      .prepare(
        `SELECT run_id AS runId, conversation_id AS conversationId,
           agent_type AS agentType, abort_requested AS abortRequested
         FROM run_task WHERE status = 'running' ORDER BY created_at`,
      )
      .all() as Array<Omit<InterruptedRunTask, "abortRequested"> & {
      abortRequested: number;
    }>
  ).map((row) => ({ ...row, abortRequested: row.abortRequested === 1 }));
  db.prepare(
    `UPDATE run_task SET status = 'interrupted', updated_at = ?
     WHERE status = 'running'`,
  ).run(now);
  db.prepare(
    `UPDATE tool_intent SET status = 'interrupted', result_json = NULL,
       updated_at = ?
     WHERE status = 'running'`,
  ).run(now);
  return rows;
};

/**
 * Retention: delete terminal runs last updated before `now - retentionMs`,
 * and intents of the same age that no running run owns. Returns rows deleted.
 */
export const pruneRunTasks = (
  db: SqliteDatabase,
  options: { now?: number; retentionMs?: number } = {},
): number => {
  const cutoff =
    (options.now ?? Date.now()) -
    (options.retentionMs ?? RUN_TASK_RETENTION_MS);
  const runs = changesOf(
    db
      .prepare(
        `DELETE FROM run_task WHERE status != 'running' AND updated_at < ?`,
      )
      .run(cutoff),
  );
  const intents = changesOf(
    db
      .prepare(
        `DELETE FROM tool_intent
         WHERE updated_at < ?
           AND run_id NOT IN (
             SELECT run_id FROM run_task WHERE status = 'running'
           )`,
      )
      .run(cutoff),
  );
  return runs + intents;
};
