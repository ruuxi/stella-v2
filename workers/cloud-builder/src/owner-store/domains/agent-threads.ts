/**
 * The owner's agent threads: cloud agents (each a `BuildSession`) and
 * desktop agents ("computer" placement), for Activity, the running pill,
 * reports and the originating desktop's delivery.
 *
 * Cloud threads are written from two directions. A desktop's spawn, continue
 * and cancel calls land here first and record the attempt before dispatching
 * it; the BuildSession's owner events (`turn.started`, `turn.event`,
 * `thread.spawned`, `thread.completed`) then confirm it. Every write is fenced
 * on the thread's `attempt_generation`, so a late event from an older attempt
 * never rewrites a newer one.
 *
 * A thread with an `executor_device_id` runs on one of the owner's paired
 * devices for someone else: a desktop, the cloud orchestrator or a cloud
 * agent. Its attempts go to that device through the gate's dispatch offer
 * instead of a BuildSession, and the gate reports each terminal dispatch
 * back here. A desktop requester receives the result through its own
 * `forDevice` delivery; a cloud requester is woken (see `settleDeviceAttempt`).
 */

import type {
  AgentThreadCalls,
  AgentThreadControl,
  AgentThreadLookup,
  AgentThreadSummary,
  ComputerThreadRecord,
  DeviceAgentThread,
} from "@stella/contracts/backend/agent-threads";
import {
  AGENT_MESSAGE_MAX_CHARS,
  STELLA_MESSAGE_TARGET,
  formatAgentMessage,
  normalizeAgentDirectoryStatus,
  type AgentDirectoryAgentRow,
  type AgentDirectorySessionRow,
} from "@stella/contracts/agent-directory";
import { SELECTED_DEVICE_NEEDS_CONSENT } from "@stella/contracts/turn-plane/placement";
import {
  AGENT_PROMPT_MAX_CHARS,
  AGENT_THREAD_PAGE_MAX,
  RUNNING_AGENT_THREADS_LIMIT,
  CONVERSATION_AGENT_THREADS_MAX,
} from "@stella/contracts/backend/agent-threads";
import { CONVERSATION_TITLE_MAX } from "@stella/contracts/backend/conversations";
import { OWNER_GENERATION_STALE } from "@stella/contracts/backend/protocol";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { CloudBrowserResumeReceipt } from "@stella/contracts/cloud-browser";
import type {
  ThreadCompletedEvent,
  ThreadSpawnedEvent,
  TurnEventEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/owner-events";
import { TURN_ATTACHMENTS_MAX } from "@stella/contracts/turn-plane/turn-start";
import { parseCloudExecutionSelection } from "../../turn-start-request.js";
import { normalizeDrivePath } from "./drive.js";
import { array, literal, number, object, optional, string, type Parser } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import {
  DispatchError,
  type OwnerContext,
  type OwnerDb,
  type OwnerDbReader,
  type OwnerDomain,
} from "../registry.js";

type ThreadRow = {
  thread_id: string;
  conversation_id: string;
  owner_generation: string | null;
  parent_turn_id: string | null;
  parent_thread_id: string | null;
  executor_device_id: string | null;
  requested_model: string | null;
  origin_device_id: string | null;
  origin_conversation_id: string | null;
  origin_delivery_ack_at: number | null;
  description: string;
  placement: string;
  agent_type: string;
  execution_json: string | null;
  attempt_generation: number;
  status: string;
  result_json: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

type TurnRow = {
  turn_id: string;
  thread_id: string | null;
  conversation_id: string | null;
  owner_generation: string | null;
  attempt_generation: number | null;
  status: string;
  client_msg_id: string | null;
  spawn_fingerprint: string | null;
  dispatch_id: string | null;
  created_at: number;
  updated_at: number;
};

export const AGENT_THREADS_MIGRATION = {
  id: "agent-threads.1-init",
  statements: [
    `CREATE TABLE agent_threads (
       thread_id TEXT PRIMARY KEY,
       conversation_id TEXT NOT NULL,
       owner_generation TEXT,
       parent_turn_id TEXT,
       parent_thread_id TEXT,
       workspace_fork_id TEXT,
       origin_device_id TEXT,
       origin_conversation_id TEXT,
       origin_delivery_ack_at INTEGER,
       description TEXT NOT NULL,
       placement TEXT NOT NULL,
       agent_type TEXT NOT NULL,
       execution_json TEXT,
       attempt_generation INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL,
       result_json TEXT,
       error_message TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    "CREATE INDEX agent_threads_conversation ON agent_threads (conversation_id, updated_at DESC)",
    "CREATE INDEX agent_threads_updated ON agent_threads (updated_at DESC)",
    `CREATE INDEX agent_threads_device ON agent_threads (origin_device_id, owner_generation, updated_at DESC)
       WHERE origin_delivery_ack_at IS NULL`,
    // Agent attempts only: the spawn replay key, the running turn a cancel
    // targets, and the files a completed thread produced.
    `CREATE TABLE agent_turns (
       turn_id TEXT PRIMARY KEY,
       thread_id TEXT,
       conversation_id TEXT,
       owner_generation TEXT,
       attempt_generation INTEGER,
       status TEXT NOT NULL,
       client_msg_id TEXT,
       spawn_fingerprint TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    "CREATE UNIQUE INDEX agent_turns_client_msg ON agent_turns (client_msg_id) WHERE client_msg_id IS NOT NULL",
    "CREATE INDEX agent_turns_thread ON agent_turns (thread_id, created_at DESC)",
    `CREATE TABLE agent_turn_files (
       turn_id TEXT NOT NULL,
       path TEXT NOT NULL,
       entry_json TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (turn_id, path)
     )`,
    `CREATE TABLE agent_cancel_receipts (
       cancel_request_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL,
       result_json TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ],
};

const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
const CONTROL_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const OUTPUT_FILE_CARD_MAX = 20;
const DISPATCH_MAX_ATTEMPTS = 3;
const DISPATCH_RETRY_MS = 15_000;
const DEVICE_AVAILABILITY_RETRY_MS = 10_000;
const DEVICE_AVAILABILITY_WAIT_MS = 60 * 60_000;
/**
 * Blocked dispatches worth retrying rather than failing: the device may be
 * about to come back, finish starting up, or — for consent — have someone tap
 * allow on its screen. Waiting is what lets a spawn aimed at a computer that
 * has not agreed yet simply start once it does, instead of making the
 * requester notice the refusal and ask again.
 */
const DEVICE_AVAILABILITY_CODES = new Set<string>([
  "SELECTED_DEVICE_OFFLINE",
  "SELECTED_DEVICE_UNAVAILABLE",
  SELECTED_DEVICE_NEEDS_CONSENT,
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const ACTIVE_STATUSES = new Set(["running", "resuming"]);

/** Threads that run on one of the owner's devices for someone else. */
export const AGENT_THREADS_DEVICE_EXECUTOR_MIGRATION = {
  id: "agent-threads.4-device-executor",
  statements: [
    "ALTER TABLE agent_threads ADD COLUMN executor_device_id TEXT",
    "ALTER TABLE agent_turns ADD COLUMN dispatch_id TEXT",
    "CREATE INDEX agent_turns_dispatch ON agent_turns (dispatch_id) WHERE dispatch_id IS NOT NULL",
  ],
};

/** The model a device thread's requester asked for; the device runs it or fails. */
export const AGENT_THREADS_REQUESTED_MODEL_MIGRATION = {
  id: "agent-threads.5-requested-model",
  statements: ["ALTER TABLE agent_threads ADD COLUMN requested_model TEXT"],
};

/** Agents no longer get isolated world forks. */
export const AGENT_THREADS_DROP_WORKSPACE_FORK_MIGRATION = {
  id: "agent-threads.3-drop-workspace-fork",
  statements: ["ALTER TABLE agent_threads DROP COLUMN workspace_fork_id"],
};

// ── Projections ───────────────────────────────────────────────────────────

const summary = (row: ThreadRow, ownerId: string): AgentThreadSummary => ({
  ownerId,
  threadId: row.thread_id,
  conversationId: row.conversation_id,
  ...(row.parent_turn_id !== null ? { parentTurnId: row.parent_turn_id } : {}),
  ...(row.parent_thread_id !== null ? { parentThreadId: row.parent_thread_id } : {}),
  ...(row.executor_device_id !== null ? { executorDeviceId: row.executor_device_id } : {}),
  description: row.description,
  placement: row.placement === "computer" ? "computer" : "cloud",
  agentType: row.agent_type,
  status: row.status,
  attemptGeneration: row.attempt_generation,
  ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
  ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const control = (row: ThreadRow): AgentThreadControl => ({
  threadId: row.thread_id,
  conversationId: row.conversation_id,
  attemptGeneration: row.attempt_generation,
  threadUpdatedAt: row.updated_at,
  status: row.status,
});

const readThread = (db: OwnerDbReader, threadId: string): ThreadRow | null =>
  db.one<ThreadRow>("SELECT * FROM agent_threads WHERE thread_id = ?", threadId);

const readTurn = (db: OwnerDbReader, turnId: string): TurnRow | null =>
  db.one<TurnRow>("SELECT * FROM agent_turns WHERE turn_id = ?", turnId);

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

// ── Fences ────────────────────────────────────────────────────────────────

const assertGeneration = async (ctx: OwnerContext, ownerGeneration: string): Promise<void> => {
  const snapshot = await ctx.host.snapshot();
  if (snapshot.ownerGeneration !== ownerGeneration) {
    throw new RpcError("CONFLICT", "This request started before the account data was reset.", {
      reason: OWNER_GENERATION_STALE,
    });
  }
  if (!snapshot.writable) {
    throw new RpcError("CONFLICT", "Account data is currently being reset or deleted.");
  }
};

const threadChanged = (threadId: string): RpcError =>
  new RpcError(
    "CONFLICT",
    `That cloud thread changed while this request was in flight. Refresh ${threadId} and try again.`,
    { reason: "thread_changed" },
  );

// ── Cloud dispatch from a desktop ─────────────────────────────────────────

type DispatchJob = {
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  attempt: number;
  /** The hosted-browser answer this attempt resumes with. */
  browserResume?: CloudBrowserResumeReceipt;
  availabilityRetries?: number;
};

const failAttempt = (db: OwnerDb, job: DispatchJob, message: string, now: number): void => {
  db.run(
    "UPDATE agent_turns SET status = 'failed', updated_at = ? WHERE turn_id = ? AND status IN ('running', 'resuming')",
    now,
    job.turnId,
  );
  db.run(
    `UPDATE agent_threads SET status = 'failed', error_message = ?, updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status = 'running'`,
    clip(message, 2_000),
    now,
    job.threadId,
    job.attemptGeneration,
  );
};

const runDispatch = async (ctx: OwnerContext, job: DispatchJob): Promise<void> => {
  const thread = readThread(ctx.db, job.threadId);
  const turn = readTurn(ctx.db, job.turnId);
  if (
    !thread ||
    !turn ||
    thread.attempt_generation !== job.attemptGeneration ||
    thread.status !== "running" ||
    turn.status !== "running"
  ) {
    return;
  }
  const dispatchRow = ctx.db.one<{ prompt: string; attachments: string | null }>(
    "SELECT prompt, attachments FROM agent_dispatch_prompts WHERE turn_id = ?",
    turn.turn_id,
  );
  const prompt = dispatchRow?.prompt ?? thread.description;
  if (thread.executor_device_id) {
    await runDeviceDispatch(
      ctx,
      job,
      thread,
      turn,
      prompt,
      dispatchAttachments(dispatchRow?.attachments),
    );
    return;
  }
  const execution = thread.execution_json
    ? (JSON.parse(thread.execution_json) as CloudExecutionSelection)
    : (await ctx.host.snapshot()).execution;
  try {
    await ctx.host.dispatchAgentTurn({
      ownerGeneration: thread.owner_generation ?? "",
      conversationId: thread.conversation_id,
      threadId: thread.thread_id,
      turnId: turn.turn_id,
      attemptGeneration: thread.attempt_generation,
      clientMsgId: turn.client_msg_id ?? turn.turn_id,
      description: thread.description,
      prompt,
      execution,
      ...(thread.origin_device_id ? { originDeviceId: thread.origin_device_id } : {}),
      ...(thread.origin_conversation_id
        ? { originConversationId: thread.origin_conversation_id }
        : {}),
      ...(thread.parent_thread_id ? { parentThreadId: thread.parent_thread_id } : {}),
      ...(job.browserResume ? { browserResume: job.browserResume } : {}),
    });
    ctx.db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turn.turn_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof DispatchError) || error.retryable;
    if (retryable && job.attempt < DISPATCH_MAX_ATTEMPTS) {
      ctx.jobs.schedule(
        "agentThreads.dispatch",
        ctx.now + DISPATCH_RETRY_MS,
        { ...job, attempt: job.attempt + 1 },
        { id: `dispatch:${job.turnId}` },
      );
      return;
    }
    failAttempt(ctx.db, job, message, ctx.now);
    ctx.db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turn.turn_id);
  }
};

// ── Device threads ────────────────────────────────────────────────────────

/**
 * Hand new input to the device attempt a thread is running, as a cloud
 * agent is steered: the running agent takes it before its next model call.
 */
const steerDeviceThread = async (
  ctx: OwnerContext,
  thread: ThreadRow,
  messageId: string,
  text: string,
): Promise<AgentThreadControl> => {
  const turn = ctx.db.one<TurnRow>(
    `SELECT * FROM agent_turns WHERE thread_id = ? AND attempt_generation = ?
       AND status IN ('running', 'resuming') ORDER BY created_at DESC LIMIT 1`,
    thread.thread_id,
    thread.attempt_generation,
  );
  const steered = turn?.dispatch_id
    ? await ctx.host.steerDeviceAgentTurn({ dispatchId: turn.dispatch_id, messageId, text })
    : { delivered: false as const, reason: "not_running" as const };
  if (steered.delivered) return control(thread);
  if (steered.reason === "unreachable") {
    throw new RpcError(
      "UNAVAILABLE",
      `The device running ${thread.thread_id} can't be reached right now. Send the message again shortly.`,
      { retryable: true, reason: "device_unreachable" },
    );
  }
  throw new RpcError(
    "CONFLICT",
    `${thread.thread_id} is between runs on its device (starting up or just finishing). Check agent_status, then send_message again.`,
    { reason: "thread_changed" },
  );
};

/**
 * The device a spawn names, checked while the caller is still waiting so a
 * wrong id or an offline device comes back as the tool's error instead of a
 * failed report later. The gate checks again when it offers the attempt.
 */
const assertDeviceDestination = async (
  ctx: OwnerContext,
  targetDeviceId: string,
  requestingDeviceId?: string,
): Promise<{ waiting: boolean }> => {
  if (requestingDeviceId && targetDeviceId === requestingDeviceId) {
    throw new RpcError(
      "BAD_REQUEST",
      "That is the device this agent is already running on. Leave destination empty to run the work here.",
      { reason: "device_is_requester" },
    );
  }
  const device = (await ctx.host.deviceDestinations()).find(
    (candidate) => candidate.deviceId === targetDeviceId,
  );
  if (!device) {
    throw new RpcError(
      "NOT_FOUND",
      `No connected device has the id ${targetDeviceId}. Use "cloud" or a device_id from the connected devices list.`,
      { reason: "device_not_found" },
    );
  }
  const name = device.label || device.deviceId;
  // A device that has turned remote work down is a definite no, and failing
  // the spawn now says so while the caller is still there to hear it. One that
  // simply has not been asked is not a no: the gate raises the prompt on its
  // screen when the attempt goes out, so this waits for the tap instead.
  if (device.remoteExecution === "declined") {
    throw new RpcError("CONFLICT", `${name} is set not to accept work from other devices.`, {
      reason: "device_remote_execution_declined",
    });
  }
  return {
    waiting:
      !device.remoteExecutionEnabled ||
      !device.online ||
      Boolean(device.availability && !device.availability.ready),
  };
};

const waitForAvailableDevice = (
  ctx: OwnerContext,
  turn: TurnRow,
  availabilityRetries: number,
): boolean => {
  if (!turn.thread_id || turn.attempt_generation === null) return false;
  if (ctx.now - turn.created_at >= DEVICE_AVAILABILITY_WAIT_MS) return false;
  ctx.jobs.schedule(
    "agentThreads.dispatch",
    ctx.now + DEVICE_AVAILABILITY_RETRY_MS,
    {
      threadId: turn.thread_id,
      turnId: turn.turn_id,
      attemptGeneration: turn.attempt_generation,
      attempt: 1,
      availabilityRetries: availabilityRetries + 1,
    } satisfies DispatchJob,
    { id: `dispatch:${turn.turn_id}` },
  );
  return true;
};

const deviceWaitExpiredMessage = (message: string): string =>
  `${message} It did not become available within ${Math.round(DEVICE_AVAILABILITY_WAIT_MS / 60_000)} minutes, so this agent never started.`;

/** Offer one recorded attempt to the thread's device. */
/**
 * The stored attachment list, or none. A row written before this column
 * existed, or a value that no longer parses, degrades to an agent without
 * attachments rather than failing a dispatch that is otherwise fine.
 */
const dispatchAttachments = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
};

const runDeviceDispatch = async (
  ctx: OwnerContext,
  job: DispatchJob,
  thread: ThreadRow,
  turn: TurnRow,
  prompt: string,
  attachments: readonly string[],
): Promise<void> => {
  try {
    const { dispatchId } = await ctx.host.dispatchDeviceAgentTurn({
      ownerGeneration: thread.owner_generation ?? "",
      conversationId: thread.conversation_id,
      threadId: thread.thread_id,
      turnId: turn.turn_id,
      description: thread.description,
      prompt,
      targetDeviceId: thread.executor_device_id!,
      ...(thread.origin_device_id ? { requestingDeviceId: thread.origin_device_id } : {}),
      ...(thread.requested_model ? { model: thread.requested_model } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(job.availabilityRetries ? { requeue: job.availabilityRetries } : {}),
    });
    ctx.db.run("UPDATE agent_turns SET dispatch_id = ? WHERE turn_id = ?", dispatchId, turn.turn_id);
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (error instanceof DispatchError && DEVICE_AVAILABILITY_CODES.has(error.code ?? "")) {
      if (waitForAvailableDevice(ctx, turn, job.availabilityRetries ?? 0)) return;
      message = deviceWaitExpiredMessage(message);
    }
    const retryable = !(error instanceof DispatchError) || error.retryable;
    if (retryable && job.attempt < DISPATCH_MAX_ATTEMPTS) {
      ctx.jobs.schedule(
        "agentThreads.dispatch",
        ctx.now + DISPATCH_RETRY_MS,
        { ...job, attempt: job.attempt + 1 },
        { id: `dispatch:${job.turnId}` },
      );
      return;
    }
    ctx.db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turn.turn_id);
    await settleDeviceAttempt(ctx, turn.turn_id, "failed", { errorMessage: message });
  }
};

/**
 * Record the terminal outcome of one device attempt and, for a cloud
 * requester, deliver it. Only the attempt the thread is on moves the
 * thread; a late outcome for an older attempt updates just its turn row.
 */
const settleDeviceAttempt = async (
  ctx: OwnerContext,
  turnId: string,
  status: "completed" | "failed" | "canceled",
  outcome: { resultJson?: string; errorMessage?: string },
): Promise<void> => {
  const turn = readTurn(ctx.db, turnId);
  if (!turn?.thread_id || TERMINAL_STATUSES.has(turn.status)) return;
  ctx.db.run(
    "UPDATE agent_turns SET status = ?, updated_at = ? WHERE turn_id = ?",
    status,
    ctx.now,
    turnId,
  );
  ctx.db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turnId);
  const thread = readThread(ctx.db, turn.thread_id);
  if (
    !thread ||
    !thread.executor_device_id ||
    thread.attempt_generation !== turn.attempt_generation ||
    !ACTIVE_STATUSES.has(thread.status)
  ) {
    return;
  }
  const errorMessage =
    status === "completed" ? null : clip(outcome.errorMessage?.trim() || `The agent ${status === "canceled" ? "was stopped" : "failed"}.`, 2_000);
  ctx.db.run(
    `UPDATE agent_threads SET status = ?, result_json = ?, error_message = ?,
       origin_delivery_ack_at = NULL, updated_at = ?
     WHERE thread_id = ?`,
    status,
    outcome.resultJson ?? null,
    errorMessage,
    ctx.now,
    thread.thread_id,
  );
  if (thread.origin_device_id) return;
  try {
    await ctx.host.deliverAgentCompletion({
      ownerGeneration: thread.owner_generation ?? "",
      conversationId: thread.conversation_id,
      threadId: thread.thread_id,
      ...(thread.parent_thread_id ? { parentThreadId: thread.parent_thread_id } : {}),
      attemptGeneration: thread.attempt_generation,
      description: thread.description,
      status,
      ...(outcome.resultJson ? { resultJson: outcome.resultJson } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      threadUpdatedAt: ctx.now,
    });
  } catch (error) {
    // The result is durable on the thread row; the requester still reads it
    // with agent_status even when the wake is lost.
    console.error(
      JSON.stringify({
        event: "device_agent_delivery_failed",
        threadId: thread.thread_id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};

/** The gate reports every terminal dispatch it ran for a device thread. */
const deviceSettled = async (ctx: OwnerContext, raw: unknown): Promise<{ settled: boolean }> => {
  const args = object({
    turnId: id(),
    requeue: optional(number({ int: true, min: 0, max: 100_000 })),
    state: literal("completed", "failed", "canceled", "blocked"),
    resultJson: optional(string({ max: 1_000_000 })),
    errorCode: optional(string({ max: 128 })),
    errorMessage: optional(string({ max: 4_000 })),
  })(raw);
  const turn = readTurn(ctx.db, args.turnId);
  if (!turn || TERMINAL_STATUSES.has(turn.status)) return { settled: false };
  const unavailable = args.state === "blocked" && DEVICE_AVAILABILITY_CODES.has(args.errorCode ?? "");
  if (unavailable && waitForAvailableDevice(ctx, turn, args.requeue ?? 0)) return { settled: false };
  await settleDeviceAttempt(ctx, args.turnId, args.state === "blocked" ? "failed" : args.state, {
    ...(args.resultJson ? { resultJson: args.resultJson } : {}),
    ...(args.errorMessage
      ? { errorMessage: unavailable ? deviceWaitExpiredMessage(args.errorMessage) : args.errorMessage }
      : args.state === "blocked"
        ? { errorMessage: "The selected computer did not accept the request." }
        : {}),
  });
  return { settled: true };
};

/** A cloud requester's own device thread, or not found. */
const readCloudDeviceThread = (
  ctx: OwnerContext,
  args: { threadId: string; conversationId: string; ownerGeneration: string },
): ThreadRow => {
  const thread = readThread(ctx.db, args.threadId);
  if (
    !thread ||
    !thread.executor_device_id ||
    thread.origin_device_id !== null ||
    thread.conversation_id !== args.conversationId ||
    thread.owner_generation !== args.ownerGeneration
  ) {
    throw new RpcError("NOT_FOUND", "That device agent no longer exists.");
  }
  return thread;
};

/**
 * Spawn an agent on one of the owner's devices for the cloud orchestrator
 * or a cloud agent. `clientMsgId` is the caller's tool-scoped id, so a
 * retried tool call returns the thread it already started.
 */
const spawnOnDeviceForCloud = async (ctx: OwnerContext, raw: unknown): Promise<AgentThreadControl> => {
  const args = object({
    ownerGeneration: generation,
    conversationId: id(),
    parentTurnId: id(),
    parentThreadId: optional(id()),
    clientMsgId: id(),
    targetDeviceId: id(256),
    description: string({ max: 2_000 }),
    prompt: string({ max: AGENT_PROMPT_MAX_CHARS }),
    model: optional(string({ max: 256 })),
    attachments: optional(
      array(string({ min: 1, max: 1_024 }), { max: TURN_ATTACHMENTS_MAX }),
    ),
  })(raw);
  assertPrompt(args.prompt, args.description);
  // Validated here, where the owner is known, so a path that is not a drive
  // path never reaches a device as something to resolve.
  const attachments = (args.attachments ?? []).map((path) =>
    normalizeDrivePath(path),
  );
  const fingerprint = await sha256Hex(
    JSON.stringify([
      "device-agent-intent/v1",
      args.model ?? null,
      args.conversationId,
      args.parentTurnId,
      args.parentThreadId ?? null,
      args.targetDeviceId,
      args.description,
      args.prompt,
      // In the fingerprint so a retry that would hand over a different set is
      // a different intent rather than a replay of the first one.
      attachments,
    ]),
  );
  const replay = replayAttempt(ctx.db, args.clientMsgId, fingerprint, args.ownerGeneration);
  if (replay) return replay;
  await assertGeneration(ctx, args.ownerGeneration);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "agentThreads.spawn",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many agents started at once. Wait a moment and try again.",
  );
  const destination = await assertDeviceDestination(ctx, args.targetDeviceId);
  const raced = replayAttempt(ctx.db, args.clientMsgId, fingerprint, args.ownerGeneration);
  if (raced) return raced;
  const threadId = `thr-${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
  ctx.db.run(
    `INSERT INTO agent_threads
       (thread_id, conversation_id, owner_generation, parent_turn_id, parent_thread_id,
        executor_device_id, requested_model, description, placement, agent_type,
        attempt_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'computer', 'general', 1, 'running', ?, ?)`,
    threadId,
    args.conversationId,
    args.ownerGeneration,
    args.parentTurnId,
    args.parentThreadId ?? null,
    args.targetDeviceId,
    args.model?.trim() || null,
    clip(args.description.trim(), 1_000),
    ctx.now,
    ctx.now,
  );
  const thread = readThread(ctx.db, threadId)!;
  startAttempt(ctx, {
    thread,
    turnId: crypto.randomUUID(),
    clientMsgId: args.clientMsgId,
    fingerprint,
    prompt: args.prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  return { ...control(thread), ...(destination.waiting ? { waitingForDevice: true } : {}) };
};

/** A cloud requester's view of its device thread. */
const deviceThreadForCloud = (ctx: OwnerContext, raw: unknown): AgentThreadSummary => {
  const args = object({ ownerGeneration: generation, conversationId: id(), threadId: id() })(raw);
  return summary(readCloudDeviceThread(ctx, args), ctx.ownerId);
};

/** The owner's device names by id; empty when the gate can't list them. */
const deviceLabels = async (ctx: OwnerContext): Promise<Map<string, string>> => {
  const labels = new Map<string, string>();
  try {
    for (const device of await ctx.host.deviceDestinations()) {
      if (device.label) labels.set(device.deviceId, device.label);
    }
  } catch {
    labels.clear();
  }
  return labels;
};

const lookupConversationThread = async (
  ctx: OwnerContext,
  args: { conversationId: string; threadId: string; ownerGeneration?: string },
): Promise<AgentThreadLookup | null> => {
  const thread = readThread(ctx.db, args.threadId);
  if (
    !thread ||
    (thread.conversation_id !== args.conversationId &&
      thread.origin_conversation_id !== args.conversationId) ||
    (args.ownerGeneration !== undefined &&
      thread.owner_generation !== null &&
      thread.owner_generation !== args.ownerGeneration)
  ) {
    return null;
  }
  const labels =
    thread.executor_device_id || thread.origin_device_id
      ? await deviceLabels(ctx)
      : new Map<string, string>();
  const executorLabel = thread.executor_device_id ? labels.get(thread.executor_device_id) : undefined;
  const originLabel = thread.origin_device_id ? labels.get(thread.origin_device_id) : undefined;
  return {
    ...summary(thread, ctx.ownerId),
    ...(thread.origin_device_id ? { originDeviceId: thread.origin_device_id } : {}),
    ...(originLabel ? { originDeviceLabel: originLabel } : {}),
    ...(executorLabel ? { executorDeviceLabel: executorLabel } : {}),
  };
};

const conversationThreadForCloud = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<AgentThreadLookup | null> => {
  const args = object({ ownerGeneration: generation, conversationId: id(), threadId: id() })(raw);
  return await lookupConversationThread(ctx, args);
};

/** A follow-up to a finished device thread from its cloud requester. */
const continueDeviceForCloud = async (ctx: OwnerContext, raw: unknown): Promise<AgentThreadControl> => {
  const args = object({
    ownerGeneration: generation,
    conversationId: id(),
    threadId: id(),
    controlRequestId: id(),
    description: string({ max: 2_000 }),
    prompt: string({ max: AGENT_PROMPT_MAX_CHARS }),
  })(raw);
  assertPrompt(args.prompt, args.description);
  const fingerprint = await sha256Hex(
    JSON.stringify(["device-continue-intent/v1", args.threadId, args.description, args.prompt]),
  );
  const replay = replayAttempt(ctx.db, args.controlRequestId, fingerprint, args.ownerGeneration);
  if (replay) return replay;
  await assertGeneration(ctx, args.ownerGeneration);
  const thread = readCloudDeviceThread(ctx, args);
  if (ACTIVE_STATUSES.has(thread.status)) {
    return await steerDeviceThread(ctx, thread, args.controlRequestId, args.prompt);
  }
  const destination = await assertDeviceDestination(ctx, thread.executor_device_id!);
  ctx.db.run(
    `UPDATE agent_threads SET
       status = 'running', attempt_generation = ?, description = ?,
       result_json = NULL, error_message = NULL, updated_at = ?
     WHERE thread_id = ?`,
    thread.attempt_generation + 1,
    clip(args.description.trim(), 1_000),
    ctx.now,
    thread.thread_id,
  );
  const continued = readThread(ctx.db, thread.thread_id)!;
  startAttempt(ctx, {
    thread: continued,
    turnId: crypto.randomUUID(),
    clientMsgId: args.controlRequestId,
    fingerprint,
    prompt: args.prompt,
  });
  return { ...control(continued), ...(destination.waiting ? { waitingForDevice: true } : {}) };
};

/** Stop a cloud requester's running device thread. */
const cancelDeviceForCloud = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<{ canceled: boolean; control: AgentThreadControl }> => {
  const args = object({
    ownerGeneration: generation,
    conversationId: id(),
    threadId: id(),
    controlRequestId: id(),
  })(raw);
  await assertGeneration(ctx, args.ownerGeneration);
  const thread = readCloudDeviceThread(ctx, args);
  await stopDeviceAttempt(ctx, thread, args.controlRequestId);
  return { canceled: true, control: control(readThread(ctx.db, thread.thread_id)!) };
};

/**
 * Stop the device attempt a thread is on: withdraw its dispatch (or the
 * queued job that would send it) and mark it canceled now. The gate's own
 * terminal report then finds the turn already settled.
 */
const stopDeviceAttempt = async (
  ctx: OwnerContext,
  thread: ThreadRow,
  cancelRequestId: string,
): Promise<void> => {
  if (!ACTIVE_STATUSES.has(thread.status)) return;
  const turn = ctx.db.one<TurnRow>(
    `SELECT * FROM agent_turns WHERE thread_id = ? AND attempt_generation = ?
       AND status IN ('running', 'resuming') ORDER BY created_at DESC LIMIT 1`,
    thread.thread_id,
    thread.attempt_generation,
  );
  if (!turn) return;
  // Settle first: the gate reports the withdrawn dispatch as canceled, and
  // that report must find this attempt already closed rather than deliver a
  // second "[Agent canceled]" for a pause the requester asked for.
  ctx.jobs.cancel(`dispatch:${turn.turn_id}`);
  ctx.db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turn.turn_id);
  ctx.db.run(
    "UPDATE agent_turns SET status = 'canceled', updated_at = ? WHERE turn_id = ?",
    ctx.now,
    turn.turn_id,
  );
  ctx.db.run(
    `UPDATE agent_threads SET status = 'canceled', error_message = 'Paused by orchestrator.', updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status IN ('running', 'resuming')`,
    ctx.now,
    thread.thread_id,
    thread.attempt_generation,
  );
  if (turn.dispatch_id) {
    await ctx.host.cancelDeviceAgentTurn({
      dispatchId: turn.dispatch_id,
      cancelRequestId,
      reason: "Paused by orchestrator.",
    });
  }
};

/** Record one attempt and queue its dispatch. */
const startAttempt = (
  ctx: OwnerContext,
  input: {
    thread: ThreadRow;
    turnId: string;
    clientMsgId: string;
    fingerprint: string;
    prompt: string;
    attachments?: readonly string[];
    browserResume?: CloudBrowserResumeReceipt;
  },
): void => {
  ctx.db.run(
    `INSERT INTO agent_turns
       (turn_id, thread_id, conversation_id, owner_generation, attempt_generation,
        status, client_msg_id, spawn_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    input.turnId,
    input.thread.thread_id,
    input.thread.conversation_id,
    input.thread.owner_generation,
    input.thread.attempt_generation,
    input.clientMsgId,
    input.fingerprint,
    ctx.now,
    ctx.now,
  );
  ctx.db.run(
    "INSERT INTO agent_dispatch_prompts (turn_id, prompt, attachments) VALUES (?, ?, ?)",
    input.turnId,
    input.prompt,
    input.attachments?.length ? JSON.stringify([...input.attachments]) : null,
  );
  ctx.jobs.schedule(
    "agentThreads.dispatch",
    ctx.now,
    {
      threadId: input.thread.thread_id,
      turnId: input.turnId,
      attemptGeneration: input.thread.attempt_generation,
      attempt: 1,
      ...(input.browserResume ? { browserResume: input.browserResume } : {}),
    } satisfies DispatchJob,
    { id: `dispatch:${input.turnId}` },
  );
};

/** A retried request with the same id: return the attempt it already started. */
const replayAttempt = (
  db: OwnerDbReader,
  clientMsgId: string,
  fingerprint: string,
  ownerGeneration: string,
): AgentThreadControl | null => {
  const turn = db.one<TurnRow>("SELECT * FROM agent_turns WHERE client_msg_id = ?", clientMsgId);
  if (!turn) return null;
  if (
    turn.spawn_fingerprint !== fingerprint ||
    turn.owner_generation !== ownerGeneration ||
    !turn.thread_id
  ) {
    throw new RpcError("CONFLICT", "That request id was already used for a different agent request.");
  }
  const thread = readThread(db, turn.thread_id);
  if (!thread || thread.owner_generation !== ownerGeneration) {
    throw new RpcError("CONFLICT", "That request id was already used for a different agent request.");
  }
  return {
    threadId: thread.thread_id,
    conversationId: thread.conversation_id,
    attemptGeneration: turn.attempt_generation ?? thread.attempt_generation,
    threadUpdatedAt: turn.created_at,
    status: "running",
  };
};

const executionParser: Parser<CloudExecutionSelection> = (value, path = "") => {
  const parsed = parseCloudExecutionSelection(value);
  if (!parsed) throw new RpcError("BAD_REQUEST", `${path || "execution"} is invalid.`);
  return parsed;
};

const assertExecutionAvailable = async (
  ctx: OwnerContext,
  execution: CloudExecutionSelection,
): Promise<void> => {
  if (execution.engine === "stella") return;
  const snapshot = await ctx.host.snapshot();
  if (!(snapshot.connectedEngines ?? []).includes(execution.engine)) {
    throw new RpcError(
      "CONFLICT",
      execution.engine === "anthropic"
        ? "Connect Claude before using that cloud execution route."
        : "Connect ChatGPT before using that cloud execution route.",
    );
  }
};

const assertPrompt = (prompt: string, description: string): void => {
  if (!prompt.trim() || prompt.length > AGENT_PROMPT_MAX_CHARS) {
    throw new RpcError("BAD_REQUEST", `The agent prompt must be 1 to ${AGENT_PROMPT_MAX_CHARS} characters.`);
  }
  if (!description.trim()) throw new RpcError("BAD_REQUEST", "The agent needs a description.");
};

type SpawnArgs = AgentThreadCalls["agentThreads.spawnFromDesktop"]["args"];

const spawnFromDesktop = async (ctx: OwnerContext, args: SpawnArgs): Promise<AgentThreadControl> => {
  if (!CLIENT_MSG_ID_PATTERN.test(args.clientMsgId)) {
    throw new RpcError("BAD_REQUEST", "That agent request could not be sent. Try again.");
  }
  assertPrompt(args.prompt, args.description);
  const fingerprint = await sha256Hex(
    JSON.stringify([
      "spawn-agent-intent/v3",
      args.conversationId ?? null,
      args.description,
      args.prompt,
      args.execution ?? null,
      args.originDeviceId,
      args.originConversationId,
      args.targetDeviceId ?? null,
      args.model ?? null,
    ]),
  );
  const replay = replayAttempt(ctx.db, args.clientMsgId, fingerprint, args.ownerGeneration);
  if (replay) return replay;
  await assertGeneration(ctx, args.ownerGeneration);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "agentThreads.spawn",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many cloud agents started at once. Wait a moment and try again.",
  );
  const targetDeviceId = args.targetDeviceId?.trim() || null;
  const destination = targetDeviceId
    ? await assertDeviceDestination(ctx, targetDeviceId, args.originDeviceId)
    : { waiting: false };
  const conversation = args.conversationId
    ? ctx.db.one<{ conversation_id: string; execution_json: string | null }>(
        "SELECT conversation_id, execution_json FROM conversations WHERE conversation_id = ? AND deleted_at IS NULL",
        args.conversationId,
      )
    : ctx.db.one<{ conversation_id: string; execution_json: string | null }>(
        `SELECT conversation_id, execution_json FROM conversations WHERE deleted_at IS NULL
          ORDER BY updated_at DESC, conversation_id DESC LIMIT 1`,
      );
  if (args.conversationId && !conversation) {
    throw new RpcError("NOT_FOUND", "Conversation not found.", { reason: "conversation_not_found" });
  }
  const snapshot = await ctx.host.snapshot();
  const execution =
    args.execution ??
    (conversation?.execution_json
      ? (JSON.parse(conversation.execution_json) as CloudExecutionSelection)
      : snapshot.execution);
  // A device runs the agent on its own models.
  if (!targetDeviceId) await assertExecutionAvailable(ctx, execution);
  // A replay may have landed during the awaits above.
  const raced = replayAttempt(ctx.db, args.clientMsgId, fingerprint, args.ownerGeneration);
  if (raced) return raced;

  let conversationId = conversation?.conversation_id;
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    ctx.db.run(
      `INSERT INTO conversations (conversation_id, title, created_at, updated_at, execution_json)
       VALUES (?, ?, ?, ?, ?)`,
      conversationId,
      clip(args.description.trim(), CONVERSATION_TITLE_MAX),
      ctx.now,
      ctx.now,
      JSON.stringify(execution),
    );
  } else {
    ctx.db.run(
      "UPDATE conversations SET updated_at = MAX(updated_at, ?), allow_empty = 0 WHERE conversation_id = ?",
      ctx.now,
      conversationId,
    );
  }
  const threadId = `thr-${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
  ctx.db.run(
    `INSERT INTO agent_threads
       (thread_id, conversation_id, owner_generation, origin_device_id, origin_conversation_id,
        executor_device_id, requested_model, description, placement, agent_type, execution_json,
        attempt_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'general', ?, 1, 'running', ?, ?)`,
    threadId,
    conversationId,
    args.ownerGeneration,
    args.originDeviceId,
    args.originConversationId,
    targetDeviceId,
    targetDeviceId ? (args.model?.trim() || null) : null,
    clip(args.description.trim(), 1_000),
    targetDeviceId ? "computer" : "cloud",
    JSON.stringify(execution),
    ctx.now,
    ctx.now,
  );
  const thread = readThread(ctx.db, threadId)!;
  startAttempt(ctx, {
    thread,
    turnId: crypto.randomUUID(),
    clientMsgId: args.clientMsgId,
    fingerprint,
    prompt: args.prompt,
  });
  return { ...control(thread), ...(destination.waiting ? { waitingForDevice: true } : {}) };
};

type ContinueArgs = AgentThreadCalls["agentThreads.continueFromDesktop"]["args"];

const continueFromDesktop = async (
  ctx: OwnerContext,
  args: ContinueArgs,
): Promise<AgentThreadControl> => {
  if (!CONTROL_REQUEST_ID_PATTERN.test(args.controlRequestId)) {
    throw new RpcError("BAD_REQUEST", "That follow-up could not be sent. Try again.");
  }
  assertPrompt(args.prompt, args.description);
  const fingerprint = await sha256Hex(
    JSON.stringify([
      "continue-agent-intent/v1",
      args.threadId,
      args.expectedAttemptGeneration,
      args.expectedTerminalUpdatedAt,
      args.description,
      args.prompt,
      args.originDeviceId,
      args.originConversationId,
    ]),
  );
  const replay = replayAttempt(ctx.db, args.controlRequestId, fingerprint, args.ownerGeneration);
  if (replay) return replay;
  await assertGeneration(ctx, args.ownerGeneration);
  const thread = readThread(ctx.db, args.threadId);
  if (
    !thread ||
    thread.owner_generation !== args.ownerGeneration ||
    thread.origin_device_id !== args.originDeviceId ||
    thread.origin_conversation_id !== args.originConversationId
  ) {
    throw new RpcError("NOT_FOUND", "That cloud thread no longer exists.");
  }
  // A running thread is steered: the attempt that is running takes the
  // message before its next model call, wherever it runs.
  if (ACTIVE_STATUSES.has(thread.status)) {
    if (thread.attempt_generation !== args.expectedAttemptGeneration) {
      throw threadChanged(thread.thread_id);
    }
    if (thread.executor_device_id) {
      return await steerDeviceThread(ctx, thread, args.controlRequestId, args.prompt);
    }
    const steered = await ctx.host.steerAgentTurn({
      threadId: thread.thread_id,
      messageId: args.controlRequestId,
      text: args.prompt,
    });
    if (!steered) throw threadChanged(thread.thread_id);
    return control(thread);
  }
  if (
    thread.attempt_generation !== args.expectedAttemptGeneration ||
    thread.updated_at !== args.expectedTerminalUpdatedAt
  ) {
    throw threadChanged(thread.thread_id);
  }
  const attemptGeneration = thread.attempt_generation + 1;
  ctx.db.run(
    `UPDATE agent_threads SET
       status = 'running', attempt_generation = ?, description = ?,
       origin_delivery_ack_at = NULL, result_json = NULL, error_message = NULL, updated_at = ?
     WHERE thread_id = ?`,
    attemptGeneration,
    clip(args.description.trim(), 1_000),
    ctx.now,
    thread.thread_id,
  );
  const continued = readThread(ctx.db, thread.thread_id)!;
  startAttempt(ctx, {
    thread: continued,
    turnId: crypto.randomUUID(),
    clientMsgId: args.controlRequestId,
    fingerprint,
    prompt: args.prompt,
  });
  return control(continued);
};

// ── Agent directory and messages ──────────────────────────────────────────

const DIRECTORY_AGENTS_RECENT = 50;
const DIRECTORY_SESSIONS_RECENT = 20;
const LIVE_STATUSES_SQL = "('running', 'resuming', 'waiting_for_user')";
const AGENT_MESSAGE_RECEIPT_TTL_MS = 24 * 60 * 60_000;

/** The device a thread runs on: its executor, or the desktop a local thread lives on. */
const threadDeviceId = (row: ThreadRow): string | null =>
  row.executor_device_id ?? (row.placement === "computer" ? row.origin_device_id : null);

type DirectoryResult = AgentThreadCalls["agentThreads.directory"]["result"];

/**
 * One conversation's agents from every placement, matched by the cloud
 * conversation or the desktop conversation that started them, and the
 * owner's other cloud conversations. Every live agent is kept; the rest are
 * the newest few.
 */
const agentDirectory = async (
  ctx: OwnerContext,
  args: { conversationId: string },
): Promise<DirectoryResult> => {
  const rows = new Map<string, ThreadRow>();
  for (const column of ["conversation_id", "origin_conversation_id"] as const) {
    for (const row of [
      ...ctx.db.all<ThreadRow>(
        `SELECT * FROM agent_threads WHERE ${column} = ? AND status IN ${LIVE_STATUSES_SQL}`,
        args.conversationId,
      ),
      ...ctx.db.all<ThreadRow>(
        `SELECT * FROM agent_threads WHERE ${column} = ?
          ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
        args.conversationId,
        DIRECTORY_AGENTS_RECENT,
      ),
    ]) {
      rows.set(row.thread_id, row);
    }
  }
  const labels = [...rows.values()].some((row) => threadDeviceId(row) !== null)
    ? await deviceLabels(ctx)
    : new Map<string, string>();
  const agents = [...rows.values()].map((row): AgentDirectoryAgentRow => {
    const deviceId = threadDeviceId(row);
    return {
      threadId: row.thread_id,
      conversationId: args.conversationId,
      ...(row.parent_thread_id !== null ? { parentThreadId: row.parent_thread_id } : {}),
      description: row.description,
      status: normalizeAgentDirectoryStatus(row.status),
      where: deviceId ? (labels.get(deviceId) ?? "another computer") : "cloud",
      updatedAt: row.updated_at,
    };
  });
  const sessions = ctx.db
    .all<{ conversation_id: string; title: string; updated_at: number; activity: string | null }>(
      `SELECT conversation_id, title, updated_at, activity FROM conversations
        WHERE deleted_at IS NULL ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
      DIRECTORY_SESSIONS_RECENT + 1,
    )
    .filter((row) => row.conversation_id !== args.conversationId)
    .slice(0, DIRECTORY_SESSIONS_RECENT)
    .map(
      (row): AgentDirectorySessionRow => ({
        conversationId: row.conversation_id,
        title: row.title,
        active: row.activity === "running",
        where: "cloud",
        updatedAt: row.updated_at,
      }),
    );
  return { agents, sessions };
};

type MessageArgs = AgentThreadCalls["agentThreads.message"]["args"];
type MessageDelivery = AgentThreadCalls["agentThreads.message"]["result"];

/**
 * `send_message` to a thread the caller does not own. A cloud conversation
 * id queues a hidden wake turn on that conversation's Stella; a running agent
 * reads the message before its next model call; an idle one resumes with it
 * as its next attempt, under the same parent, so its report still goes where
 * it always did. Idempotent per `messageId`.
 */
const messageAgent = async (ctx: OwnerContext, args: MessageArgs): Promise<MessageDelivery> => {
  if (!CONTROL_REQUEST_ID_PATTERN.test(args.messageId)) {
    throw new RpcError("BAD_REQUEST", "That message could not be sent. Try again.");
  }
  const to = args.to.trim();
  const text = args.text.trim();
  if (!text || text.length > AGENT_MESSAGE_MAX_CHARS) {
    throw new RpcError("BAD_REQUEST", `A message must be 1 to ${AGENT_MESSAGE_MAX_CHARS} characters.`);
  }
  if (to === STELLA_MESSAGE_TARGET) {
    throw new RpcError(
      "BAD_REQUEST",
      `"${STELLA_MESSAGE_TARGET}" names the sender's own Stella; send its conversation id instead.`,
    );
  }
  if (to === args.from.threadId) {
    throw new RpcError("BAD_REQUEST", "That thread_id is the sender's own.");
  }
  const fingerprint = await sha256Hex(
    JSON.stringify(["agent-message/v1", to, text, args.from.threadId, args.from.label]),
  );
  const receipt = ctx.db.one<{ fingerprint: string; result_json: string }>(
    "SELECT fingerprint, result_json FROM agent_message_receipts WHERE message_id = ?",
    args.messageId,
  );
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) {
      throw new RpcError("CONFLICT", "That message id was already used for a different message.");
    }
    return JSON.parse(receipt.result_json) as MessageDelivery;
  }
  await assertGeneration(ctx, args.ownerGeneration);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "agentThreads.message",
    { count: 120, windowMs: 10 * 60_000 },
    "Too many agent messages at once. Wait a moment and try again.",
  );
  const delivery = await deliverAgentMessage(ctx, {
    ownerGeneration: args.ownerGeneration,
    messageId: args.messageId,
    to,
    framed: formatAgentMessage(args.from, text),
  });
  ctx.db.run(
    "DELETE FROM agent_message_receipts WHERE created_at < ?",
    ctx.now - AGENT_MESSAGE_RECEIPT_TTL_MS,
  );
  ctx.db.run(
    `INSERT INTO agent_message_receipts (message_id, fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`,
    args.messageId,
    fingerprint,
    JSON.stringify(delivery),
    ctx.now,
  );
  return delivery;
};

const deliverAgentMessage = async (
  ctx: OwnerContext,
  args: { ownerGeneration: string; messageId: string; to: string; framed: string },
): Promise<MessageDelivery> => {
  const { to } = args;
  const conversation = ctx.db.one<{ conversation_id: string }>(
    "SELECT conversation_id FROM conversations WHERE conversation_id = ? AND deleted_at IS NULL",
    to,
  );
  if (conversation) {
    await ctx.host.startAgentMessageTurn({
      ownerGeneration: args.ownerGeneration,
      conversationId: to,
      clientMsgId: `msg:${(await sha256Hex(args.messageId)).slice(0, 48)}`,
      prompt: args.framed,
    });
    return { delivered: "queued", threadId: to };
  }
  const thread = readThread(ctx.db, to);
  if (
    !thread ||
    (thread.owner_generation !== null && thread.owner_generation !== args.ownerGeneration)
  ) {
    throw new RpcError(
      "NOT_FOUND",
      `No agent or Stella session has the thread_id ${to}. agent_status without a thread_id lists who you can reach.`,
      { reason: "message_target_not_found" },
    );
  }
  if (!thread.executor_device_id && thread.placement === "computer") {
    const deviceId = thread.origin_device_id ?? "";
    const name = (await deviceLabels(ctx)).get(deviceId) || deviceId || "another computer";
    throw new RpcError(
      "CONFLICT",
      `${to} runs locally on ${name}, so it can only be messaged from that computer.`,
      { reason: "thread_local_to_device" },
    );
  }
  if (ACTIVE_STATUSES.has(thread.status)) {
    if (thread.executor_device_id) {
      await steerDeviceThread(ctx, thread, args.messageId, args.framed);
      return { delivered: "steered", threadId: to };
    }
    const steered = await ctx.host.steerAgentTurn({
      threadId: to,
      messageId: args.messageId,
      text: args.framed,
      kind: "message",
    });
    if (steered) return { delivered: "steered", threadId: to };
    // Not running yet is not finished: superseding a queued first attempt
    // would drop its prompt.
    const queued = ctx.db.one<{ turn_id: string }>(
      `SELECT t.turn_id FROM agent_turns t JOIN agent_dispatch_prompts p ON p.turn_id = t.turn_id
        WHERE t.thread_id = ? AND t.attempt_generation = ? LIMIT 1`,
      to,
      thread.attempt_generation,
    );
    if (queued) {
      throw new RpcError("CONFLICT", `${to} is starting up. Send the message again in a moment.`, {
        retryable: true,
        reason: "thread_starting",
      });
    }
  } else if (thread.executor_device_id) {
    await assertDeviceDestination(ctx, thread.executor_device_id);
  }
  const current = readThread(ctx.db, to);
  if (!current || current.attempt_generation !== thread.attempt_generation) {
    throw threadChanged(to);
  }
  ctx.db.run(
    `UPDATE agent_threads SET
       status = 'running', attempt_generation = ?, origin_delivery_ack_at = NULL,
       result_json = NULL, error_message = NULL, updated_at = ?
     WHERE thread_id = ?`,
    current.attempt_generation + 1,
    ctx.now,
    to,
  );
  startAttempt(ctx, {
    thread: readThread(ctx.db, to)!,
    turnId: crypto.randomUUID(),
    clientMsgId: args.messageId,
    fingerprint: "agent-message",
    prompt: args.framed,
  });
  return { delivered: "resumed", threadId: to };
};

/**
 * Resume a thread parked on a hosted-browser wait as its next attempt, with
 * the browser's answer. False when that exact wait is no longer current.
 */
export const resumeWaitingAgentThread = (
  ctx: OwnerContext,
  input: {
    threadId: string;
    attemptGeneration: number;
    ownerGeneration: string;
    clientMsgId: string;
    browserResume: CloudBrowserResumeReceipt;
  },
): boolean => {
  const thread = readThread(ctx.db, input.threadId);
  if (
    !thread ||
    thread.status !== "waiting_for_user" ||
    thread.attempt_generation !== input.attemptGeneration ||
    thread.owner_generation !== input.ownerGeneration
  ) {
    return false;
  }
  ctx.db.run(
    `UPDATE agent_turns SET status = 'completed', updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status = 'waiting_for_user'`,
    ctx.now,
    thread.thread_id,
    thread.attempt_generation,
  );
  ctx.db.run(
    `UPDATE agent_threads SET status = 'running', attempt_generation = ?,
       result_json = NULL, error_message = NULL, updated_at = ?
     WHERE thread_id = ?`,
    thread.attempt_generation + 1,
    ctx.now,
    thread.thread_id,
  );
  const resumed = readThread(ctx.db, thread.thread_id)!;
  startAttempt(ctx, {
    thread: resumed,
    turnId: crypto.randomUUID(),
    clientMsgId: input.clientMsgId,
    fingerprint: "browser-resume",
    prompt: `[Browser ${input.browserResume.result}] ${input.browserResume.safeMessage}`,
    browserResume: input.browserResume,
  });
  return true;
};

/** Cancel a thread parked on a hosted-browser wait (the browser profile was reset). */
export const cancelWaitingAgentThread = (
  ctx: OwnerContext,
  input: { threadId: string; attemptGeneration: number; message: string },
): void => {
  ctx.db.run(
    `UPDATE agent_turns SET status = 'canceled', updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status = 'waiting_for_user'`,
    ctx.now,
    input.threadId,
    input.attemptGeneration,
  );
  ctx.db.run(
    `UPDATE agent_threads SET status = 'canceled', error_message = ?, updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status = 'waiting_for_user'`,
    clip(input.message, 2_000),
    ctx.now,
    input.threadId,
    input.attemptGeneration,
  );
};

type CancelArgs = AgentThreadCalls["agentThreads.cancel"]["args"];
type CancelResult = AgentThreadCalls["agentThreads.cancel"]["result"];

const cancelThread = async (ctx: OwnerContext, args: CancelArgs): Promise<CancelResult> => {
  if (!CONTROL_REQUEST_ID_PATTERN.test(args.controlRequestId)) {
    throw new RpcError("BAD_REQUEST", "That stop request could not be sent. Try again.");
  }
  const receipt = ctx.db.one<{ thread_id: string; result_json: string }>(
    "SELECT thread_id, result_json FROM agent_cancel_receipts WHERE cancel_request_id = ?",
    args.controlRequestId,
  );
  if (receipt) {
    if (receipt.thread_id !== args.threadId) {
      throw new RpcError("CONFLICT", "That request id was already used for a different thread.");
    }
    return JSON.parse(receipt.result_json) as CancelResult;
  }
  await assertGeneration(ctx, args.ownerGeneration);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "agentThreads.cancel",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many stop requests. Wait a moment and try again.",
  );
  const thread = readThread(ctx.db, args.threadId);
  if (
    !thread ||
    thread.owner_generation !== args.ownerGeneration ||
    thread.origin_device_id !== args.originDeviceId ||
    thread.origin_conversation_id !== args.originConversationId
  ) {
    throw new RpcError("NOT_FOUND", "That cloud thread no longer exists.");
  }
  if (!ACTIVE_STATUSES.has(thread.status)) {
    return { canceled: true, control: control(thread) };
  }
  if (
    thread.attempt_generation !== args.expectedAttemptGeneration ||
    thread.updated_at !== args.expectedThreadUpdatedAt
  ) {
    throw threadChanged(thread.thread_id);
  }
  const turn = ctx.db.one<TurnRow>(
    `SELECT * FROM agent_turns WHERE thread_id = ? AND attempt_generation = ?
       AND status IN ('running', 'resuming') ORDER BY created_at DESC LIMIT 1`,
    thread.thread_id,
    thread.attempt_generation,
  );
  if (!turn) throw threadChanged(thread.thread_id);
  if (thread.executor_device_id) {
    await stopDeviceAttempt(ctx, thread, args.controlRequestId);
    const stopped: CancelResult = { canceled: true, control: control(readThread(ctx.db, thread.thread_id)!) };
    ctx.db.run(
      "INSERT INTO agent_cancel_receipts (cancel_request_id, thread_id, result_json, created_at) VALUES (?, ?, ?, ?)",
      args.controlRequestId,
      thread.thread_id,
      JSON.stringify(stopped),
      ctx.now,
    );
    return stopped;
  }
  const outcome = await ctx.host.cancelAgentTurn({
    threadId: thread.thread_id,
    turnId: turn.turn_id,
    attemptGeneration: thread.attempt_generation,
    ownerGeneration: args.ownerGeneration,
    cancelRequestId: args.controlRequestId,
  });
  if (outcome === "changed") throw threadChanged(thread.thread_id);
  const now = Date.now();
  ctx.db.run(
    "UPDATE agent_turns SET status = 'canceled', updated_at = ? WHERE turn_id = ?",
    now,
    turn.turn_id,
  );
  ctx.db.run(
    `UPDATE agent_threads SET status = 'canceled', error_message = 'Paused by orchestrator.', updated_at = ?
      WHERE thread_id = ? AND attempt_generation = ? AND status IN ('running', 'resuming')`,
    now,
    thread.thread_id,
    thread.attempt_generation,
  );
  ctx.jobs.cancel(`dispatch:${turn.turn_id}`);
  const result: CancelResult = { canceled: true, control: control(readThread(ctx.db, thread.thread_id)!) };
  ctx.db.run(
    "INSERT INTO agent_cancel_receipts (cancel_request_id, thread_id, result_json, created_at) VALUES (?, ?, ?, ?)",
    args.controlRequestId,
    thread.thread_id,
    JSON.stringify(result),
    now,
  );
  return result;
};

const acknowledgeDelivery = (
  ctx: OwnerContext,
  args: AgentThreadCalls["agentThreads.acknowledgeDelivery"]["args"],
): AgentThreadCalls["agentThreads.acknowledgeDelivery"]["result"] => {
  const thread = readThread(ctx.db, args.threadId);
  if (
    !thread ||
    thread.origin_device_id !== args.originDeviceId ||
    thread.owner_generation !== args.ownerGeneration
  ) {
    throw new RpcError("NOT_FOUND", "That thread is not waiting for this device.");
  }
  if (
    thread.attempt_generation !== args.attemptGeneration ||
    thread.updated_at !== args.terminalUpdatedAt
  ) {
    return { acknowledged: false, superseded: true };
  }
  if (!TERMINAL_STATUSES.has(thread.status) && thread.status !== "waiting_for_user") {
    throw new RpcError("CONFLICT", "That thread is still running.");
  }
  if (thread.origin_delivery_ack_at !== null) return { acknowledged: false, superseded: false };
  ctx.db.run(
    "UPDATE agent_threads SET origin_delivery_ack_at = ? WHERE thread_id = ?",
    ctx.now,
    thread.thread_id,
  );
  return { acknowledged: true, superseded: false };
};

// ── Desktop ("computer") threads ──────────────────────────────────────────

const rejectStart = (reason: string, message: string): RpcError =>
  new RpcError("CONFLICT", message, { reason });

const startComputerThread = async (
  ctx: OwnerContext,
  args: AgentThreadCalls["computerThreads.start"]["args"],
): Promise<{ threadId: string }> => {
  await assertGeneration(ctx, args.ownerGeneration);
  const conversation = ctx.db.one<{ conversation_id: string }>(
    "SELECT conversation_id FROM conversations WHERE conversation_id = ? AND deleted_at IS NULL",
    args.conversationId,
  );
  if (!conversation) throw rejectStart("conversation_not_found", "That conversation no longer exists.");
  const existing = readThread(ctx.db, args.threadId);
  if (existing) {
    if (
      existing.placement !== "computer" ||
      existing.conversation_id !== args.conversationId ||
      existing.origin_device_id !== args.originDeviceId ||
      existing.owner_generation !== args.ownerGeneration
    ) {
      throw rejectStart("thread_identity_conflict", "That agent id belongs to a different agent.");
    }
    if (args.attemptGeneration === existing.attempt_generation) {
      if (existing.description !== args.description || existing.agent_type !== args.agentType) {
        throw rejectStart("attempt_replay_conflict", "That agent attempt was already started differently.");
      }
      return { threadId: existing.thread_id };
    }
    // Fencing is monotonic, not dense: the desktop advances its generation
    // both when it invalidates an unwinding attempt and when the next one
    // starts, so a follow-up can skip numbers.
    if (args.attemptGeneration < existing.attempt_generation) {
      throw rejectStart("attempt_stale", "A newer attempt of this agent already started.");
    }
    ctx.db.run(
      `UPDATE agent_threads SET status = 'running', attempt_generation = ?, description = ?, agent_type = ?,
         origin_delivery_ack_at = NULL, result_json = NULL, error_message = NULL, updated_at = ?
       WHERE thread_id = ?`,
      args.attemptGeneration,
      args.description,
      args.agentType,
      ctx.now,
      existing.thread_id,
    );
    return { threadId: existing.thread_id };
  }
  if (args.attemptGeneration !== 1) {
    throw rejectStart("initial_attempt_invalid", "A new agent starts at attempt 1.");
  }
  ctx.db.run(
    `INSERT INTO agent_threads
       (thread_id, conversation_id, owner_generation, origin_device_id, origin_conversation_id,
        description, placement, agent_type, attempt_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'computer', ?, 1, 'running', ?, ?)`,
    args.threadId,
    args.conversationId,
    args.ownerGeneration,
    args.originDeviceId,
    args.conversationId,
    args.description,
    args.agentType,
    ctx.now,
    ctx.now,
  );
  return { threadId: args.threadId };
};

const readComputerThread = (
  db: OwnerDbReader,
  args: { threadId: string; originDeviceId: string; ownerGeneration: string },
): ThreadRow | null => {
  const row = readThread(db, args.threadId);
  return row &&
    row.placement === "computer" &&
    row.origin_device_id === args.originDeviceId &&
    row.owner_generation === args.ownerGeneration
    ? row
    : null;
};

const completeComputerThread = async (
  ctx: OwnerContext,
  args: AgentThreadCalls["computerThreads.complete"]["args"],
): Promise<AgentThreadCalls["computerThreads.complete"]["result"]> => {
  await assertGeneration(ctx, args.ownerGeneration);
  const row = readComputerThread(ctx.db, args);
  if (!row) throw new RpcError("NOT_FOUND", "That agent no longer exists.");
  if (row.attempt_generation !== args.attemptGeneration || row.status !== "running") {
    return { updated: false, status: row.status };
  }
  ctx.db.run(
    `UPDATE agent_threads SET status = ?, result_json = ?, error_message = ?, updated_at = ?
      WHERE thread_id = ?`,
    args.status,
    args.result !== undefined ? JSON.stringify({ finalText: args.result }) : null,
    args.error ?? null,
    ctx.now,
    row.thread_id,
  );
  return { updated: true, status: args.status };
};

const cancelComputerThread = async (
  ctx: OwnerContext,
  args: AgentThreadCalls["computerThreads.cancel"]["args"],
): Promise<AgentThreadCalls["computerThreads.cancel"]["result"]> => {
  await assertGeneration(ctx, args.ownerGeneration);
  const row = readComputerThread(ctx.db, args);
  if (!row) throw new RpcError("NOT_FOUND", "That agent no longer exists.");
  if (row.attempt_generation !== args.attemptGeneration) return { canceled: false, status: row.status };
  if (row.status !== "running") return { canceled: true, status: row.status };
  ctx.db.run(
    "UPDATE agent_threads SET status = 'canceled', error_message = ?, updated_at = ? WHERE thread_id = ?",
    args.reason?.trim() || "Canceled on this computer.",
    ctx.now,
    row.thread_id,
  );
  return { canceled: true, status: "canceled" };
};

const computerRecord = (row: ThreadRow): ComputerThreadRecord => {
  let result: string | null = null;
  if (row.result_json) {
    try {
      const parsed = JSON.parse(row.result_json) as { finalText?: unknown };
      result = typeof parsed.finalText === "string" ? parsed.finalText : null;
    } catch {
      result = null;
    }
  }
  return {
    threadId: row.thread_id,
    status:
      row.status === "failed"
        ? "error"
        : row.status === "completed" || row.status === "canceled"
          ? row.status
          : "running",
    description: row.description,
    attemptGeneration: row.attempt_generation,
    startedAt: row.created_at,
    completedAt: row.status === "running" ? null : row.updated_at,
    result,
    error: row.error_message,
  };
};

// ── Owner events from BuildSessions and the orchestrator ──────────────────

export type AgentThreadEvent =
  | TurnStartedEvent
  | TurnEventEvent
  | ThreadSpawnedEvent
  | ThreadCompletedEvent;

export type AgentThreadEffects = {
  /** Cards to post once the events are applied. */
  cards: Array<{ conversationId: string; ownerGeneration: string; sourceTurnId: string; card: unknown }>;
};

/** The newest entry per path across the thread's last three attempts. */
const threadOutputFiles = (db: OwnerDbReader, threadId: string): unknown[] => {
  const turns = db.all<{ turn_id: string }>(
    "SELECT turn_id FROM agent_turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 3",
    threadId,
  );
  const byPath = new Map<string, unknown>();
  for (const { turn_id } of turns.reverse()) {
    for (const file of db.all<{ path: string; entry_json: string }>(
      "SELECT path, entry_json FROM agent_turn_files WHERE turn_id = ? ORDER BY updated_at",
      turn_id,
    )) {
      byPath.set(file.path, JSON.parse(file.entry_json));
    }
  }
  return [...byPath.values()].slice(0, OUTPUT_FILE_CARD_MAX);
};

/** Apply one event. Safe to replay; late events from older attempts are dropped. */
export const applyAgentThreadEvent = (
  db: OwnerDb,
  event: AgentThreadEvent,
  effects: AgentThreadEffects,
): void => {
  switch (event.kind) {
    case "turn.started": {
      if (event.turnKind !== "agent" || readTurn(db, event.turnId)) return;
      db.run(
        `INSERT INTO agent_turns
           (turn_id, thread_id, conversation_id, owner_generation, attempt_generation,
            status, client_msg_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        event.turnId,
        event.threadId ?? null,
        event.conversationId,
        event.ownerGeneration,
        event.attemptGeneration ?? null,
        event.clientMsgId ?? null,
        event.createdAt,
        event.createdAt,
      );
      return;
    }
    case "turn.event": {
      const turn = readTurn(db, event.turnId);
      if (!turn || !turn.thread_id) return;
      if (
        event.attemptGeneration !== undefined &&
        turn.attempt_generation !== null &&
        event.attemptGeneration !== turn.attempt_generation
      ) {
        return;
      }
      if (event.eventKind === "output_files") {
        const files = (event.payload as { files?: unknown } | null)?.files;
        if (!Array.isArray(files)) return;
        for (const entry of files) {
          const path = (entry as { path?: unknown } | null)?.path;
          if (typeof path !== "string" || !path) continue;
          db.run(
            `INSERT INTO agent_turn_files (turn_id, path, entry_json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (turn_id, path) DO UPDATE SET entry_json = excluded.entry_json, updated_at = excluded.updated_at`,
            turn.turn_id,
            path,
            JSON.stringify(entry),
            event.createdAt,
          );
        }
        return;
      }
      if (!event.terminal && event.eventKind === "waiting_for_user") {
        db.run(
          "UPDATE agent_turns SET status = 'waiting_for_user', updated_at = ? WHERE turn_id = ? AND status IN ('running', 'resuming')",
          event.createdAt,
          turn.turn_id,
        );
        db.run(
          `UPDATE agent_threads SET status = 'waiting_for_user', updated_at = MAX(updated_at, ?)
            WHERE thread_id = ? AND attempt_generation = ? AND status IN ('running', 'resuming')`,
          event.createdAt,
          turn.thread_id,
          turn.attempt_generation,
        );
        return;
      }
      if (event.terminal) {
        db.run(
          "UPDATE agent_turns SET status = ?, updated_at = ? WHERE turn_id = ? AND status IN ('running', 'resuming', 'waiting_for_user')",
          event.terminalStatus ?? "failed",
          event.createdAt,
          turn.turn_id,
        );
      }
      return;
    }
    case "thread.spawned": {
      const thread = readThread(db, event.threadId);
      if (!thread) {
        db.run(
          `INSERT INTO agent_threads
             (thread_id, conversation_id, owner_generation, parent_turn_id, parent_thread_id,
              origin_device_id, origin_conversation_id, description, placement,
              agent_type, execution_json, attempt_generation, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cloud', 'general', ?, ?, 'running', ?, ?)`,
          event.threadId,
          event.conversationId,
          event.ownerGeneration,
          event.parentTurnId,
          event.parentThreadId ?? null,
          event.originDeviceId ?? null,
          event.originConversationId ?? null,
          clip(event.description, 1_000),
          JSON.stringify(event.execution),
          event.attemptGeneration,
          event.createdAt,
          event.createdAt,
        );
        return;
      }
      // An attempt this object already recorded (a desktop spawn) or an
      // older one arriving late.
      if (event.attemptGeneration <= thread.attempt_generation) {
        if (event.attemptGeneration === thread.attempt_generation && thread.parent_turn_id === null) {
          db.run(
            "UPDATE agent_threads SET parent_turn_id = ? WHERE thread_id = ?",
            event.parentTurnId,
            thread.thread_id,
          );
        }
        return;
      }
      db.run(
        `UPDATE agent_threads SET
           status = 'running', attempt_generation = ?, description = ?, execution_json = ?,
           origin_delivery_ack_at = NULL, result_json = NULL, error_message = NULL,
           updated_at = MAX(updated_at, ?)
         WHERE thread_id = ?`,
        event.attemptGeneration,
        clip(event.description, 1_000),
        JSON.stringify(event.execution),
        event.createdAt,
        thread.thread_id,
      );
      return;
    }
    case "thread.completed": {
      const thread = readThread(db, event.threadId);
      if (!thread) return;
      if (thread.owner_generation !== null && thread.owner_generation !== event.ownerGeneration) return;
      if (event.attemptGeneration < thread.attempt_generation) return;
      if (
        event.attemptGeneration === thread.attempt_generation &&
        !ACTIVE_STATUSES.has(thread.status) &&
        thread.status !== "waiting_for_user"
      ) {
        return;
      }
      db.run(
        `UPDATE agent_threads SET status = ?, attempt_generation = ?, result_json = ?, error_message = ?,
           updated_at = MAX(updated_at + 1, ?)
         WHERE thread_id = ?`,
        event.status,
        event.attemptGeneration,
        event.resultJson ?? null,
        event.errorMessage ?? null,
        event.completedAt,
        thread.thread_id,
      );
      // A desktop-dispatched thread delivers through that desktop; any
      // other completed thread files its outputs under the turn that
      // started it, where both clients attribute them.
      if (event.status === "completed" && thread.origin_device_id === null) {
        const files = threadOutputFiles(db, thread.thread_id);
        if (files.length > 0) {
          effects.cards.push({
            conversationId: thread.conversation_id,
            ownerGeneration: event.ownerGeneration,
            sourceTurnId: thread.parent_turn_id ?? event.turnId,
            card: { type: "files", files },
          });
        }
      }
      return;
    }
  }
};

// ── Views ─────────────────────────────────────────────────────────────────

const recentThreads = (db: OwnerDbReader, ownerId: string, limit: number): AgentThreadSummary[] =>
  db
    .all<ThreadRow>("SELECT * FROM agent_threads ORDER BY updated_at DESC, thread_id DESC LIMIT ?", limit)
    .map((row) => summary(row, ownerId));

const runningThreads = (db: OwnerDbReader, ownerId: string, conversationId: string): AgentThreadSummary[] =>
  db
    .all<ThreadRow>(
      `SELECT * FROM agent_threads WHERE conversation_id = ? AND status IN ('running', 'resuming')
        ORDER BY updated_at DESC LIMIT ?`,
      conversationId,
      RUNNING_AGENT_THREADS_LIMIT,
    )
    .map((row) => summary(row, ownerId));

const deviceThreads = (
  db: OwnerDbReader,
  ownerId: string,
  args: { originDeviceId: string; ownerGeneration: string; limit?: number },
): DeviceAgentThread[] =>
  db
    .all<ThreadRow>(
      `SELECT * FROM agent_threads
        WHERE origin_device_id = ? AND owner_generation = ? AND origin_delivery_ack_at IS NULL
        ORDER BY updated_at DESC LIMIT ?`,
      args.originDeviceId,
      args.ownerGeneration,
      Math.min(Math.max(args.limit ?? 100, 1), 100),
    )
    .map((row) => ({
      ...summary(row, ownerId),
      originDeviceId: row.origin_device_id!,
      originConversationId: row.origin_conversation_id ?? row.conversation_id,
      ownerGeneration: row.owner_generation!,
    }));

const threadPage = (
  db: OwnerDbReader,
  ownerId: string,
  args: AgentThreadCalls["agentThreads.page"]["args"],
): AgentThreadCalls["agentThreads.page"]["result"] => {
  const limit = Math.min(Math.max(args.limit ?? 30, 1), AGENT_THREAD_PAGE_MAX);
  const rows = args.before
    ? db.all<ThreadRow>(
        `SELECT * FROM agent_threads WHERE conversation_id = ?
           AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
         ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
        args.conversationId,
        args.before.updatedAt,
        args.before.updatedAt,
        args.before.threadId,
        limit + 1,
      )
    : db.all<ThreadRow>(
        `SELECT * FROM agent_threads WHERE conversation_id = ?
         ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
        args.conversationId,
        limit + 1,
      );
  return { threads: rows.slice(0, limit).map((row) => summary(row, ownerId)), hasMore: rows.length > limit };
};

// ── Registration ──────────────────────────────────────────────────────────

const id = (max = 128) => string({ min: 1, max });
const generation = id(512);
const origin = { originDeviceId: id(256), originConversationId: id(256) };
const messageParser = object({
  ownerGeneration: generation,
  messageId: id(),
  to: id(256),
  text: string({ max: AGENT_MESSAGE_MAX_CHARS * 2 }),
  from: object({ threadId: id(256), label: string({ max: 2_000 }) }),
});

export const agentThreadsDomain = {
  name: "agent-threads",
  migrations: [
    AGENT_THREADS_MIGRATION,
    {
      id: "agent-threads.2-dispatch-prompts",
      statements: [
        "CREATE TABLE agent_dispatch_prompts (turn_id TEXT PRIMARY KEY, prompt TEXT NOT NULL)",
      ],
    },
    AGENT_THREADS_DROP_WORKSPACE_FORK_MIGRATION,
    AGENT_THREADS_DEVICE_EXECUTOR_MIGRATION,
    AGENT_THREADS_REQUESTED_MODEL_MIGRATION,
    {
      // Alongside the prompt, with the same lifecycle: both are what the
      // dispatch job still needs after the spawn call returned, and both are
      // dropped once the attempt is dispatched or settled.
      id: "agent-threads.3-dispatch-attachments",
      statements: [
        "ALTER TABLE agent_dispatch_prompts ADD COLUMN attachments TEXT",
      ],
    },
    {
      id: "agent-threads.6-agent-messages",
      statements: [
        `CREATE INDEX agent_threads_origin_conversation
           ON agent_threads (origin_conversation_id, updated_at DESC)
           WHERE origin_conversation_id IS NOT NULL`,
        `CREATE TABLE agent_message_receipts (
           message_id TEXT PRIMARY KEY,
           fingerprint TEXT NOT NULL,
           result_json TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`,
        "CREATE INDEX agent_message_receipts_created ON agent_message_receipts (created_at)",
      ],
    },
  ],
  calls: {
    "agentThreads.page": {
      scope: "owner",
      parse: object({
        conversationId: id(),
        before: optional(object({ updatedAt: number({ int: true, min: 0 }), threadId: id() })),
        limit: optional(number({ int: true, min: 1, max: AGENT_THREAD_PAGE_MAX })),
      }),
      handler: (ctx, args) => threadPage(ctx.db, ctx.ownerId, args),
    },
    "agentThreads.lookup": {
      scope: "owner",
      parse: object({ conversationId: id(256), threadId: id(256) }),
      handler: (ctx, args) => lookupConversationThread(ctx, args),
    },
    "agentThreads.directory": {
      scope: "owner",
      parse: object({ conversationId: id(256) }),
      handler: agentDirectory,
    },
    "agentThreads.message": {
      scope: "owner",
      requireAccount: true,
      parse: messageParser,
      handler: messageAgent,
    },
    "agentThreads.spawnFromDesktop": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        ...origin,
        ownerGeneration: generation,
        clientMsgId: id(64),
        description: string({ max: 2_000 }),
        prompt: string({ max: AGENT_PROMPT_MAX_CHARS }),
        conversationId: optional(id()),
        execution: optional(executionParser),
        targetDeviceId: optional(id(256)),
        model: optional(string({ max: 256 })),
      }),
      handler: spawnFromDesktop,
    },
    "agentThreads.continueFromDesktop": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        ...origin,
        ownerGeneration: generation,
        threadId: id(),
        expectedAttemptGeneration: number({ int: true, min: 1 }),
        expectedTerminalUpdatedAt: number({ int: true, min: 0 }),
        description: string({ max: 2_000 }),
        prompt: string({ max: AGENT_PROMPT_MAX_CHARS }),
        controlRequestId: id(),
      }),
      handler: continueFromDesktop,
    },
    "agentThreads.cancel": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        ...origin,
        ownerGeneration: generation,
        threadId: id(),
        expectedAttemptGeneration: number({ int: true, min: 1 }),
        expectedThreadUpdatedAt: number({ int: true, min: 0 }),
        controlRequestId: id(),
      }),
      handler: cancelThread,
    },
    "agentThreads.acknowledgeDelivery": {
      scope: "owner",
      parse: object({
        threadId: id(),
        originDeviceId: id(256),
        ownerGeneration: generation,
        attemptGeneration: number({ int: true, min: 1 }),
        terminalUpdatedAt: number({ int: true, min: 0 }),
      }),
      handler: acknowledgeDelivery,
    },
    "computerThreads.start": {
      scope: "owner",
      parse: object({
        threadId: id(),
        ownerGeneration: generation,
        conversationId: id(),
        originDeviceId: id(256),
        description: string({ max: 1_000 }),
        agentType: string({ min: 1, max: 100 }),
        attemptGeneration: number({ int: true, min: 1 }),
      }),
      handler: startComputerThread,
    },
    "computerThreads.complete": {
      scope: "owner",
      parse: object({
        threadId: id(),
        ownerGeneration: generation,
        originDeviceId: id(256),
        attemptGeneration: number({ int: true, min: 1 }),
        status: literal("completed", "failed", "canceled"),
        result: optional(string({ max: 30_000 })),
        error: optional(string({ max: 10_000 })),
      }),
      handler: completeComputerThread,
    },
    "computerThreads.cancel": {
      scope: "owner",
      parse: object({
        threadId: id(),
        ownerGeneration: generation,
        originDeviceId: id(256),
        attemptGeneration: number({ int: true, min: 1 }),
        reason: optional(string({ max: 2_000 })),
      }),
      handler: cancelComputerThread,
    },
    "computerThreads.get": {
      scope: "owner",
      parse: object({ threadId: id(), originDeviceId: id(256), ownerGeneration: generation }),
      handler: async (ctx, args) => {
        await assertGeneration(ctx, args.ownerGeneration);
        const row = readComputerThread(ctx.db, args);
        return row ? computerRecord(row) : null;
      },
    },
  },
  views: {
    "agentThreads.recent": {
      parse: object({ limit: optional(number({ int: true, min: 1, max: 100 })) }),
      read: (ctx, args) => recentThreads(ctx.db, ctx.ownerId, args.limit ?? 30),
    },
    "agentThreads.running": {
      parse: object({ conversationId: id() }),
      read: (ctx, args) => runningThreads(ctx.db, ctx.ownerId, args.conversationId),
    },
    "agentThreads.forConversation": {
      parse: object({
        conversationId: id(),
        limit: optional(number({ int: true, min: 1, max: CONVERSATION_AGENT_THREADS_MAX })),
      }),
      read: (ctx, args) => {
        const limit = args.limit ?? 30;
        const rows = ctx.db.all<ThreadRow>(
          `SELECT * FROM agent_threads WHERE conversation_id = ?
           ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
          args.conversationId,
          limit + 1,
        );
        return {
          threads: rows.slice(0, limit).map((row) => summary(row, ctx.ownerId)),
          hasMore: rows.length > limit,
        };
      },
    },
    "agentThreads.get": {
      parse: object({ conversationId: id(), threadId: id() }),
      read: (ctx, args) => {
        const row = readThread(ctx.db, args.threadId);
        return row && row.conversation_id === args.conversationId ? summary(row, ctx.ownerId) : null;
      },
    },
    "agentThreads.forDevice": {
      parse: object({
        originDeviceId: id(256),
        ownerGeneration: generation,
        limit: optional(number({ int: true, min: 1, max: 100 })),
      }),
      read: (ctx, args) => deviceThreads(ctx.db, ctx.ownerId, args),
    },
  },
  internal: {
    "agentThreads.spawnOnDevice": spawnOnDeviceForCloud,
    "agentThreads.deviceThread": deviceThreadForCloud,
    "agentThreads.conversationThread": conversationThreadForCloud,
    "agentThreads.continueOnDevice": continueDeviceForCloud,
    "agentThreads.cancelOnDevice": cancelDeviceForCloud,
    "agentThreads.deviceSettled": deviceSettled,
    "agentThreads.directory": async (ctx, raw) =>
      await agentDirectory(ctx, object({ ownerGeneration: generation, conversationId: id(256) })(raw)),
    "agentThreads.message": async (ctx, raw) => await messageAgent(ctx, messageParser(raw)),
  },
  jobs: {
    "agentThreads.dispatch": {
      // Retries are scheduled by the job itself so the last failure can mark
      // the attempt failed; the store-level backoff is only for crashes.
      maxAttempts: 3,
      run: async (ctx, payload) => await runDispatch(ctx, payload as DispatchJob),
    },
  },
} satisfies OwnerDomain;
