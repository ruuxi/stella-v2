/**
 * Durable runs and tool intents (`run_task`, `tool_intent`, schema v5).
 *
 * After pi-durable's task checkpoints and tool intents. A native orchestrator
 * chat run or a local agent run writes one `run_task` row when its turn
 * starts (launch metadata in `checkpoint_json.launch`), keeps the in-flight
 * state the thread does not hold yet in the same checkpoint, and settles the
 * row when the run ends. Every tool call writes a `tool_intent` row
 * synchronously before the tool starts and settles it when the tool returns,
 * in the same seam (`tool-lifecycle.ts`).
 *
 * When the worker process dies (crash, SIGKILL, or a graceful stop that
 * suspended the run) the row is still `running`. The next worker's
 * {@link RunTaskStore.recoveryPlan} classifies those rows exactly once:
 * resumable when no cancel was requested, fewer than
 * {@link RUN_TASK_RESUME_LIMIT} resumes happened, and the row was updated in
 * the last {@link RUN_TASK_RESUME_WINDOW_MS}; everything else is marked
 * `interrupted` and goes down today's failure path.
 *
 * Abort marks: a cancel commits `abort_requested` before it signals the run
 * (`requestAbort`), so a cancel that loses the race with a crash still keeps
 * the run from being resumed.
 *
 * Suspension: a graceful worker stop marks this process's live runs
 * suspended before it aborts them. Every terminal write, settle, and
 * persistence seam checks {@link RunTaskStore.isSuspended} and skips, so the
 * stop leaves exactly the durable state a crash would — and the next worker
 * resumes it.
 *
 * All statements are synchronous on the worker's database thread.
 */

import type { ToolReplayPolicy } from "../tools/defs/replay-policy.js";
import {
  cachedStatements,
  type CachedStatements,
  type SqliteDatabase,
} from "./shared.js";

export type RunTaskStatus =
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "interrupted";

export type ToolIntentStatus = "running" | "done" | "interrupted";

/** One in-run transcript message a cloud turn holds only in memory. */
export type RunTaskCapturedMessage = {
  timestamp: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: unknown;
};

export type RunTaskCheckpoint = {
  /** Caller-owned metadata needed to relaunch the run (`RunTaskLaunch`). */
  launch?: Record<string, unknown>;
  /**
   * The assistant message whose tool calls are executing. The orchestrator
   * persists an assistant/tool group only at the turn boundary, so until then
   * this checkpoint is the only durable copy of the calls being answered.
   */
  pending?: { message: unknown; at: number };
  /**
   * Cloud-owned turns keep their transcript in process memory until finish;
   * this mirrors it (prompt + completed groups) so a resume can rebuild it.
   */
  captured?: RunTaskCapturedMessage[];
  /** The captured transcript outgrew the checkpoint bound; no cloud resume. */
  capturedOmitted?: boolean;
};

export type RunTaskRecord = {
  runId: string;
  conversationId: string;
  threadKey: string;
  agentType: string;
  ownerRunId: string | null;
  background: boolean;
  status: RunTaskStatus;
  abortRequested: boolean;
  resumeCount: number;
  checkpoint: RunTaskCheckpoint;
  createdAt: number;
  updatedAt: number;
};

export type ToolIntentRecord = {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  replay: ToolReplayPolicy;
  status: ToolIntentStatus;
  /** Stored tool result, or null once the thread holds it (or it was too big). */
  result: unknown;
  attempts: number;
  startedAt: number;
  updatedAt: number;
};

export type RunRecoveryPlan = {
  /** Running rows of a previous process that may resume this boot. */
  resumable: RunTaskRecord[];
  /** Running rows of a previous process now marked `interrupted`. */
  abandoned: RunTaskRecord[];
};

/** A run resumes at most this many times (user decision). */
export const RUN_TASK_RESUME_LIMIT = 2;
/** Only runs whose row was updated this recently resume (user decision). */
export const RUN_TASK_RESUME_WINDOW_MS = 15 * 60 * 1000;
/** Terminal rows (and their intents) older than this are deleted. */
export const RUN_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A resumed run's event recorder starts at `resume_count * offset` so its
 * events sort after (and never collide with) the dead process's events in the
 * worker's `(run_id, seq)` run-event log. Below the host's synthetic floor.
 */
export const RUN_TASK_RESUME_SEQ_OFFSET = 1_000_000_000;

/** A cloud turn whose captured transcript exceeds this cannot resume. */
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
/** Larger stored results are dropped; recovery reruns or reports them lost. */
const MAX_INTENT_RESULT_BYTES = 256 * 1024;
/** Arguments are kept only for replay-safe tools, and only when small. */
const MAX_INTENT_ARGS_BYTES = 64 * 1024;

type RunTaskRow = {
  runId: string;
  conversationId: string;
  threadKey: string;
  agentType: string;
  ownerRunId: string | null;
  background: number;
  status: RunTaskStatus;
  abortRequested: number;
  resumeCount: number;
  checkpointJson: string | null;
  createdAt: number;
  updatedAt: number;
};

type ToolIntentRow = {
  runId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string | null;
  replay: ToolReplayPolicy;
  status: ToolIntentStatus;
  resultJson: string | null;
  attempts: number;
  startedAt: number;
  updatedAt: number;
};

const RUN_TASK_COLUMNS = `run_id AS runId, conversation_id AS conversationId,
  thread_key AS threadKey, agent_type AS agentType, owner_run_id AS ownerRunId,
  background, status, abort_requested AS abortRequested,
  resume_count AS resumeCount, checkpoint_json AS checkpointJson,
  created_at AS createdAt, updated_at AS updatedAt`;

const TOOL_INTENT_COLUMNS = `run_id AS runId, tool_call_id AS toolCallId,
  tool_name AS toolName, args_json AS argsJson, replay, status,
  result_json AS resultJson, attempts, started_at AS startedAt,
  updated_at AS updatedAt`;

const changesOf = (result: unknown): number => {
  const changes = (result as { changes?: unknown } | undefined)?.changes;
  return typeof changes === "number" ? changes : 0;
};

const parseJson = (value: string | null): unknown => {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const boundedJson = (value: unknown, maxBytes: number): string | null => {
  if (value === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;
  return Buffer.byteLength(json, "utf8") <= maxBytes ? json : null;
};

const toCheckpoint = (json: string | null): RunTaskCheckpoint => {
  const parsed = parseJson(json);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as RunTaskCheckpoint)
    : {};
};

const toRecord = (row: RunTaskRow): RunTaskRecord => ({
  runId: row.runId,
  conversationId: row.conversationId,
  threadKey: row.threadKey,
  agentType: row.agentType,
  ownerRunId: row.ownerRunId,
  background: row.background === 1,
  status: row.status,
  abortRequested: row.abortRequested === 1,
  resumeCount: row.resumeCount,
  checkpoint: toCheckpoint(row.checkpointJson),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toIntent = (row: ToolIntentRow): ToolIntentRecord => ({
  runId: row.runId,
  toolCallId: row.toolCallId,
  toolName: row.toolName,
  args: parseJson(row.argsJson),
  replay: row.replay,
  status: row.status,
  result: parseJson(row.resultJson),
  attempts: row.attempts,
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
});

const intentKey = (runId: string, toolCallId: string): string =>
  `${runId}\u0000${toolCallId}`;

export class RunTaskStore {
  private readonly cached: CachedStatements;
  private readonly transaction: <T>(work: () => T) => T;
  /** Rows this process began; the recovery plan never classifies them. */
  private readonly begunHere = new Set<string>();
  /** Live runs a graceful stop suspended; their terminal writes are fenced. */
  private readonly suspended = new Set<string>();
  /** Tool executions in flight in this process, by run + call id. */
  private readonly liveIntents = new Map<string, ToolReplayPolicy>();
  /** Checkpoint mirror for live runs, so a checkpoint write never re-reads. */
  private readonly checkpoints = new Map<string, RunTaskCheckpoint>();
  private plan: RunRecoveryPlan | null = null;
  /** Resumable rows a resume of this process took over. */
  private readonly resumedHere = new Set<string>();
  /** Resumable rows this process gave up on. */
  private readonly abandonedHere = new Set<string>();

  constructor(
    db: SqliteDatabase,
    options: { transaction?: <T>(work: () => T) => T } = {},
  ) {
    this.cached = cachedStatements(db);
    this.transaction = options.transaction ?? ((work) => work());
  }

  /* ---------------------------------------------------------------- */
  /* Runs                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Record a run as started (or, for a resumed run, re-attach to its row).
   * A resumed run keeps its checkpoint and resume count.
   */
  begin(args: {
    runId: string;
    conversationId: string;
    threadKey: string;
    agentType: string;
    ownerRunId?: string;
    background?: boolean;
    launch?: Record<string, unknown>;
    now?: number;
  }): void {
    const now = args.now ?? Date.now();
    const checkpoint: RunTaskCheckpoint = args.launch
      ? { launch: args.launch }
      : {};
    this.cached
      .prepare(
        `INSERT INTO run_task (
           run_id, conversation_id, thread_key, agent_type, owner_run_id,
           background, status, abort_requested, resume_count, checkpoint_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        args.runId,
        args.conversationId,
        args.threadKey,
        args.agentType,
        args.ownerRunId ?? null,
        args.background ? 1 : 0,
        JSON.stringify(checkpoint),
        now,
        now,
      );
    this.begunHere.add(args.runId);
    const stored = this.get(args.runId);
    this.checkpoints.set(args.runId, stored?.checkpoint ?? checkpoint);
  }

  get(runId: string): RunTaskRecord | null {
    const row = this.cached
      .prepare(`SELECT ${RUN_TASK_COLUMNS} FROM run_task WHERE run_id = ?`)
      .get(runId) as RunTaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** The newest row for a thread (agent threads key on their thread id). */
  latestForThread(threadKey: string): RunTaskRecord | null {
    const row = this.cached
      .prepare(
        `SELECT ${RUN_TASK_COLUMNS} FROM run_task
         WHERE thread_key = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(threadKey) as RunTaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Count one resume and refresh the row. Returns the new resume count. */
  markResumed(runId: string, now = Date.now()): number {
    this.cached
      .prepare(
        `UPDATE run_task SET resume_count = resume_count + 1,
           status = 'running', updated_at = ?
         WHERE run_id = ?`,
      )
      .run(now, runId);
    this.resumedHere.add(runId);
    return this.get(runId)?.resumeCount ?? 0;
  }

  touch(runId: string, now = Date.now()): void {
    if (this.suspended.has(runId)) return;
    this.cached
      .prepare(
        `UPDATE run_task SET updated_at = ?
         WHERE run_id = ? AND status = 'running'`,
      )
      .run(now, runId);
  }

  private writeCheckpoint(
    runId: string,
    update: (current: RunTaskCheckpoint) => RunTaskCheckpoint,
    now = Date.now(),
  ): boolean {
    if (this.suspended.has(runId)) return false;
    const current = this.checkpoints.get(runId);
    if (!current) return false;
    let next = update(current);
    let json = JSON.stringify(next);
    if (json.length > MAX_CHECKPOINT_BYTES && next.captured) {
      // Bounded: drop the transcript mirror (the run then fails instead of
      // resuming) rather than rewrite many MiB per turn.
      const { captured: _captured, ...rest } = next;
      next = { ...rest, capturedOmitted: true };
      json = JSON.stringify(next);
    }
    const changed = changesOf(
      this.cached
        .prepare(
          `UPDATE run_task SET checkpoint_json = ?, updated_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(json, now, runId),
    );
    if (changed > 0) this.checkpoints.set(runId, next);
    return changed > 0;
  }

  /** The assistant message whose tool calls are about to execute. */
  checkpointPending(runId: string, message: unknown, now = Date.now()): void {
    this.writeCheckpoint(
      runId,
      (current) => ({ ...current, pending: { message, at: now } }),
      now,
    );
  }

  /** Mirror a cloud turn's in-memory transcript (prompt + completed groups). */
  checkpointCaptured(runId: string, captured: RunTaskCapturedMessage[]): void {
    this.writeCheckpoint(runId, (current) => ({ ...current, captured }));
  }

  /**
   * The turn's assistant/tool group is durable in the thread: drop the
   * pending message and the stored tool results it made redundant. Run inside
   * the same transaction as the group write (`SessionStore.commitRun`).
   */
  commitTurn(
    runId: string,
    args: { captured?: RunTaskCapturedMessage[] } = {},
  ): void {
    if (this.suspended.has(runId)) return;
    this.writeCheckpoint(runId, (current) => {
      const { pending: _pending, ...rest } = current;
      return args.captured ? { ...rest, captured: args.captured } : rest;
    });
    this.cached
      .prepare(
        `UPDATE tool_intent SET result_json = NULL
         WHERE run_id = ? AND result_json IS NOT NULL AND status = 'done'`,
      )
      .run(runId);
  }

  /**
   * Durably request cancellation. Committed before the run is signalled, so a
   * process that dies mid-cancel can never resume the run.
   */
  requestAbort(runId: string, now = Date.now()): boolean {
    return (
      changesOf(
        this.cached
          .prepare(
            `UPDATE run_task SET abort_requested = 1, updated_at = ?
             WHERE run_id = ? AND status = 'running'`,
          )
          .run(now, runId),
      ) > 0
    );
  }

  /** Settle a run. Suspended runs keep their `running` row for the resume. */
  finish(
    runId: string,
    status: Exclude<RunTaskStatus, "running">,
    now = Date.now(),
  ): void {
    if (this.suspended.has(runId)) return;
    this.transaction(() => {
      // The launch record stays for diagnostics; the in-flight state is moot.
      this.cached
        .prepare(
          `UPDATE run_task SET status = ?, updated_at = ?,
             checkpoint_json = json_remove(checkpoint_json, '$.pending', '$.captured')
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(status, now, runId);
      // Nothing left can answer a still-open call, and a terminal run's
      // thread already holds every result it kept.
      this.cached
        .prepare(
          `UPDATE tool_intent SET status = CASE
             WHEN status = 'running' THEN 'interrupted' ELSE status END,
             result_json = NULL, updated_at = ?
           WHERE run_id = ? AND (status = 'running' OR result_json IS NOT NULL)`,
        )
        .run(now, runId);
    });
    this.checkpoints.delete(runId);
    this.begunHere.delete(runId);
  }

  /* ---------------------------------------------------------------- */
  /* Tool intents                                                      */
  /* ---------------------------------------------------------------- */

  /** Written synchronously before the tool body runs. */
  beginIntent(args: {
    runId: string;
    toolCallId: string;
    toolName: string;
    replay: ToolReplayPolicy;
    args?: unknown;
    now?: number;
  }): void {
    const now = args.now ?? Date.now();
    this.liveIntents.set(intentKey(args.runId, args.toolCallId), args.replay);
    const argsJson =
      args.replay === "unsafe"
        ? null
        : boundedJson(args.args, MAX_INTENT_ARGS_BYTES);
    this.cached
      .prepare(
        `INSERT INTO tool_intent (
           run_id, tool_call_id, tool_name, args_json, replay, status,
           result_json, attempts, started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'running', NULL, 1, ?, ?)
         ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
           status = 'running', result_json = NULL,
           attempts = tool_intent.attempts + 1, updated_at = excluded.updated_at`,
      )
      .run(
        args.runId,
        args.toolCallId,
        args.toolName,
        argsJson,
        args.replay,
        now,
        now,
      );
    if (this.begunHere.has(args.runId)) this.touch(args.runId, now);
  }

  /**
   * Settled when the tool body returns (or throws). A suspended run keeps the
   * intent `running`: the stop interrupted the tool, it did not finish it.
   */
  settleIntent(args: {
    runId: string;
    toolCallId: string;
    result: unknown;
    now?: number;
  }): void {
    this.liveIntents.delete(intentKey(args.runId, args.toolCallId));
    if (this.suspended.has(args.runId)) return;
    const now = args.now ?? Date.now();
    this.cached
      .prepare(
        `UPDATE tool_intent SET status = 'done', result_json = ?, updated_at = ?
         WHERE run_id = ? AND tool_call_id = ? AND status = 'running'`,
      )
      .run(
        boundedJson(args.result, MAX_INTENT_RESULT_BYTES),
        now,
        args.runId,
        args.toolCallId,
      );
    if (this.begunHere.has(args.runId)) this.touch(args.runId, now);
  }

  /** A resume answered this cut-off call as interrupted. */
  interruptIntent(runId: string, toolCallId: string, now = Date.now()): void {
    this.cached
      .prepare(
        `UPDATE tool_intent SET status = 'interrupted', result_json = NULL,
           updated_at = ?
         WHERE run_id = ? AND tool_call_id = ? AND status = 'running'`,
      )
      .run(now, runId, toolCallId);
  }

  /** The result is durable in the thread now; stop storing a second copy. */
  dropIntentResult(runId: string, toolCallId: string): void {
    if (this.suspended.has(runId)) return;
    this.cached
      .prepare(
        `UPDATE tool_intent SET result_json = NULL
         WHERE run_id = ? AND tool_call_id = ? AND result_json IS NOT NULL`,
      )
      .run(runId, toolCallId);
  }

  listIntents(runId: string): ToolIntentRecord[] {
    return (
      this.cached
        .prepare(
          `SELECT ${TOOL_INTENT_COLUMNS} FROM tool_intent
           WHERE run_id = ? ORDER BY started_at, tool_call_id`,
        )
        .all(runId) as ToolIntentRow[]
    ).map(toIntent);
  }

  /** Unsafe tool executions in flight in this process (restart blocker). */
  liveUnsafeIntentCount(): number {
    let count = 0;
    for (const replay of this.liveIntents.values()) {
      if (replay === "unsafe") count += 1;
    }
    return count;
  }

  /**
   * Whether a live run of this process would resume if the worker stopped
   * now: its row is running, no cancel was requested, and it has resumes
   * left.
   */
  isLiveRunResumable(runId: string): boolean {
    if (!this.begunHere.has(runId)) return false;
    const row = this.get(runId);
    return (
      row !== null &&
      row.status === "running" &&
      !row.abortRequested &&
      row.resumeCount < RUN_TASK_RESUME_LIMIT
    );
  }

  /* ---------------------------------------------------------------- */
  /* Suspension (graceful stop)                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Freeze every live resumable run of this process before a graceful stop
   * aborts it. Returns the suspended run ids.
   */
  suspendLiveRuns(now = Date.now()): string[] {
    const suspended: string[] = [];
    for (const runId of this.begunHere) {
      if (!this.isLiveRunResumable(runId)) continue;
      this.touch(runId, now);
      this.suspended.add(runId);
      suspended.push(runId);
    }
    return suspended;
  }

  isSuspended(runId: string | undefined): boolean {
    return Boolean(runId) && this.suspended.has(runId!);
  }

  /* ---------------------------------------------------------------- */
  /* Recovery                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Classify the previous process's running rows, once per process. Rows that
   * cannot resume are marked `interrupted` (with their open intents) in the
   * same pass, so later callers only ever see resumable rows as running.
   */
  recoveryPlan(now = Date.now()): RunRecoveryPlan {
    if (this.plan) return this.plan;
    const rows = (
      this.cached
        .prepare(
          `SELECT ${RUN_TASK_COLUMNS} FROM run_task
           WHERE status = 'running' ORDER BY created_at`,
        )
        .all() as RunTaskRow[]
    )
      .map(toRecord)
      .filter((row) => !this.begunHere.has(row.runId));
    const plan: RunRecoveryPlan = { resumable: [], abandoned: [] };
    for (const row of rows) {
      const resumable =
        !row.abortRequested &&
        row.resumeCount < RUN_TASK_RESUME_LIMIT &&
        now - row.updatedAt < RUN_TASK_RESUME_WINDOW_MS;
      (resumable ? plan.resumable : plan.abandoned).push(row);
    }
    const resumableIds = new Set(plan.resumable.map((row) => row.runId));
    const openIntents = this.cached
      .prepare(
        `SELECT run_id AS runId, tool_call_id AS toolCallId
         FROM tool_intent WHERE status = 'running'`,
      )
      .all() as Array<{ runId: string; toolCallId: string }>;
    this.transaction(() => {
      for (const row of plan.abandoned) {
        this.cached
          .prepare(
            `UPDATE run_task SET status = 'interrupted', updated_at = ?
             WHERE run_id = ? AND status = 'running'`,
          )
          .run(now, row.runId);
      }
      // Open intents of runs that will not resume (abandoned runs, and turns
      // that never had a durable row) were cut off with their process.
      for (const intent of openIntents) {
        if (resumableIds.has(intent.runId)) continue;
        if (this.begunHere.has(intent.runId)) continue;
        if (this.liveIntents.has(intentKey(intent.runId, intent.toolCallId))) {
          continue;
        }
        this.cached
          .prepare(
            `UPDATE tool_intent SET status = 'interrupted', result_json = NULL,
               updated_at = ?
             WHERE run_id = ? AND tool_call_id = ? AND status = 'running'`,
          )
          .run(now, intent.runId, intent.toolCallId);
      }
    });
    this.plan = plan;
    return plan;
  }

  private inPlan(runId: string): boolean {
    return this.recoveryPlan().resumable.some((row) => row.runId === runId);
  }

  /** Resumable, and no resume of this process has taken it or given up. */
  isResumable(runId: string): boolean {
    if (this.resumedHere.has(runId) || this.abandonedHere.has(runId)) {
      return false;
    }
    return this.inPlan(runId);
  }

  /**
   * Resumable or being resumed this boot (not given up). The cloud
   * transcript writer leaves such a turn's orphaned begin for the resume.
   */
  isResumeOwned(runId: string): boolean {
    return !this.abandonedHere.has(runId) && this.inPlan(runId);
  }

  /** The resumable agent run of `threadKey`, if the plan kept one. */
  resumableForThread(threadKey: string): RunTaskRecord | null {
    const candidates = this.recoveryPlan().resumable.filter(
      (row) => row.threadKey === threadKey && this.isResumable(row.runId),
    );
    return candidates.at(-1) ?? null;
  }

  /** Give up on a resumable row this boot (no owner, or relaunch failed). */
  abandon(runId: string, now = Date.now()): void {
    this.abandonedHere.add(runId);
    this.transaction(() => {
      this.cached
        .prepare(
          `UPDATE run_task SET status = 'interrupted', updated_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(now, runId);
      this.cached
        .prepare(
          `UPDATE tool_intent SET status = 'interrupted', result_json = NULL,
             updated_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(now, runId);
    });
  }
}

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
