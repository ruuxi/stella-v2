import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { anyApi } from "convex/server";
import WebSocket from "ws";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import {
  forkDelayed,
  forkInterval,
  type HostTimerHandle,
} from "./effect-runtime.js";

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 25_000;
const PRESENCE_SOCKET_RECONNECT_MAX_MS = 30_000;
const EXECUTION_LEASE_RENEWAL_FAILSAFE_MS = 2 * 60_000;
const CLAIM_ACK_RETRY_BASE_MS = 1_000;
const CLAIM_ACK_RETRY_MAX_MS = 15_000;
const TERMINAL_RESULT_LIMIT = 110_000;

type PlacementKind = "chat" | "agent";
type PlacementCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";
type PlacementOutcome = "completed" | "failed" | "canceled";
type PlacementSubject = "portable" | "computer" | "cloud";
type LocalInboxState =
  | "claimed"
  | "accepted"
  | "running"
  | "terminal_pending"
  | "terminal"
  | "orphaned";

type DispatchSummary = {
  dispatchId: string;
  kind: PlacementKind;
  conversationId: string;
  state: string;
  placement?: "computer" | "cloud";
  cancelRequestId?: string;
  errorCode?: string;
};

export type ExecutionPlacementDesktopSubmit = {
  idempotencyKey: string;
  payloadJson: string;
  payloadHash: string;
  kind: PlacementKind;
  subject: PlacementSubject;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  requestedTargetMode: "cloud" | "device";
  requestedExecutorDeviceId?: string;
  requiredCapabilities: PlacementCapability[];
};

type ClaimedExecution = {
  dispatch: DispatchSummary;
  payloadJson: string;
  payloadHash: string;
  claimExpiresAt: number;
};

export type ExecutionPlacementAvailability = {
  ready: boolean;
  chatSlots: number;
  agentSlots: number;
  capabilities: PlacementCapability[];
};

export type ExecutionPlacementRunResult = {
  status: "ok" | "error" | "canceled";
  finalText?: string;
  error?: string;
};

export type ExecutionPlacementClient = {
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  onUpdate(
    reference: unknown,
    args: Record<string, unknown>,
    onValue: (value: unknown) => void,
    onError?: (error: Error) => void,
  ): { unsubscribe(): void };
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

type PlacementBridgeOptions = {
  client: ExecutionPlacementClient;
  database: SqliteDatabase;
  deviceIdentity: DeviceIdentity;
  appVersion: string;
  deviceName?: string;
  platform?: string;
  getAuthToken?: () => string | null;
  getAvailability: () =>
    ExecutionPlacementAvailability | Promise<ExecutionPlacementAvailability>;
  runExecution: (args: {
    dispatch: DispatchSummary;
    payload: Record<string, unknown>;
    ownerGeneration: string;
  }) => Promise<ExecutionPlacementRunResult>;
  cancelExecution: (args: {
    dispatchId: string;
    kind: PlacementKind;
    conversationId: string;
  }) => Promise<void>;
  log?: (level: "warn" | "error", message: string, error?: unknown) => void;
  now?: () => number;
  /** Test seam; production uses the accepted execution lease duration. */
  leaseRenewalGraceMs?: number;
  /** Test seam for deterministic claim-ACK retry/backoff coverage. */
  claimAckRetryBaseMs?: number;
};

type SessionRow = {
  owner_id: string;
  owner_generation: string;
  presence_session_id: string;
  proof_seq: number;
};

export type ExecutionPlacementInboxRow = {
  dispatchId: string;
  ownerId: string;
  ownerGeneration: string;
  presenceSessionId: string;
  kind: PlacementKind;
  conversationId: string;
  claimToken: string;
  payloadHash: string;
  payloadJson: string;
  dispatchJson: string;
  state: LocalInboxState;
  terminalOutcome?: PlacementOutcome;
  resultJson?: string;
  errorCode?: string;
  errorMessage?: string;
  cancelRpcPending: boolean;
  cancelOrphanOnAck: boolean;
  persistedAt: number;
  startedAt?: number;
  updatedAt: number;
};

type InboxDbRow = {
  dispatch_id: string;
  owner_id: string;
  owner_generation: string;
  presence_session_id: string;
  kind: PlacementKind;
  conversation_id: string;
  claim_token: string;
  payload_hash: string;
  payload_json: string;
  dispatch_json: string;
  state: LocalInboxState;
  terminal_outcome: PlacementOutcome | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  cancel_rpc_pending: number;
  cancel_orphan_on_ack: number;
  persisted_at: number;
  started_at: number | null;
  updated_at: number;
};

const fromInboxRow = (row: InboxDbRow): ExecutionPlacementInboxRow => ({
  dispatchId: row.dispatch_id,
  ownerId: row.owner_id,
  ownerGeneration: row.owner_generation,
  presenceSessionId: row.presence_session_id,
  kind: row.kind,
  conversationId: row.conversation_id,
  claimToken: row.claim_token,
  payloadHash: row.payload_hash,
  payloadJson: row.payload_json,
  dispatchJson: row.dispatch_json,
  state: row.state,
  ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
  ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
  ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
  ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  cancelRpcPending: row.cancel_rpc_pending === 1,
  cancelOrphanOnAck: row.cancel_orphan_on_ack === 1,
  persistedAt: row.persisted_at,
  ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
  updatedAt: row.updated_at,
});

/**
 * Durable ownership boundary. A server claim is acknowledged only after the
 * exact payload and claim token are committed here in one SQLite transaction.
 */
export class ExecutionPlacementInbox {
  constructor(private readonly database: SqliteDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_placement_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        presence_session_id TEXT NOT NULL,
        proof_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_placement_inbox (
        dispatch_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        presence_session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'agent')),
        conversation_id TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dispatch_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'claimed', 'accepted', 'running', 'terminal_pending',
            'terminal', 'orphaned'
          )
        ),
        terminal_outcome TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        cancel_rpc_pending INTEGER NOT NULL DEFAULT 0,
        cancel_orphan_on_ack INTEGER NOT NULL DEFAULT 0,
        persisted_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    const inboxColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(execution_placement_inbox)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!inboxColumns.has("cancel_rpc_pending")) {
      this.database.exec(
        "ALTER TABLE execution_placement_inbox ADD COLUMN cancel_rpc_pending INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!inboxColumns.has("cancel_orphan_on_ack")) {
      this.database.exec(
        "ALTER TABLE execution_placement_inbox ADD COLUMN cancel_orphan_on_ack INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_execution_placement_inbox_recovery
      ON execution_placement_inbox(
        owner_id, owner_generation, presence_session_id, state, updated_at
      );
    `);
  }

  openSession(args: {
    ownerId: string;
    ownerGeneration: string;
    now: number;
  }): { presenceSessionId: string; proofSeq: number; reused: boolean } {
    const current = this.database
      .prepare(
        `SELECT owner_id, owner_generation, presence_session_id, proof_seq
         FROM execution_placement_runtime_state WHERE id = 1`,
      )
      .get() as SessionRow | undefined;
    if (
      current?.owner_id === args.ownerId &&
      current.owner_generation === args.ownerGeneration
    ) {
      return {
        presenceSessionId: current.presence_session_id,
        proofSeq: current.proof_seq,
        reused: true,
      };
    }
    const presenceSessionId = `presence:${randomUUID()}`;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      // A generation/session rotation can strand a worker effect that was
      // started by the previous process. Persist the exact local cancellation
      // obligation before changing ownership. openSession deliberately keeps
      // these rows non-terminal until the cancellation RPC is acknowledged.
      this.database
        .prepare(
          `UPDATE execution_placement_inbox
           SET cancel_rpc_pending = 1, cancel_orphan_on_ack = 1,
               terminal_outcome = 'canceled', result_json = NULL,
               error_code = 'LOCAL_EXECUTION_OWNER_CHANGED',
               error_message =
                 'The local execution owner changed before completion.',
               updated_at = ?
           WHERE state IN ('claimed', 'accepted', 'running')`,
        )
        .run(args.now);
      this.database
        .prepare(
          `UPDATE execution_placement_inbox
           SET state = 'orphaned', updated_at = ?
           WHERE state NOT IN ('terminal', 'orphaned')
             AND cancel_rpc_pending = 0`,
        )
        .run(args.now);
      this.database
        .prepare(
          `INSERT INTO execution_placement_runtime_state (
             id, owner_id, owner_generation, presence_session_id,
             proof_seq, updated_at
           ) VALUES (1, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_id = excluded.owner_id,
             owner_generation = excluded.owner_generation,
             presence_session_id = excluded.presence_session_id,
             proof_seq = 0,
             updated_at = excluded.updated_at`,
        )
        .run(args.ownerId, args.ownerGeneration, presenceSessionId, args.now);
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // BEGIN itself failed.
      }
      throw error;
    }
    return { presenceSessionId, proofSeq: 0, reused: false };
  }

  nextProofSequence(now: number): number {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          "SELECT proof_seq FROM execution_placement_runtime_state WHERE id = 1",
        )
        .get() as { proof_seq?: number } | undefined;
      if (!Number.isSafeInteger(row?.proof_seq)) {
        throw new Error("Execution placement session is not initialized.");
      }
      const next = (row!.proof_seq as number) + 1;
      this.database
        .prepare(
          `UPDATE execution_placement_runtime_state
           SET proof_seq = ?, updated_at = ? WHERE id = 1`,
        )
        .run(next, now);
      this.database.exec("COMMIT;");
      return next;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // BEGIN itself failed.
      }
      throw error;
    }
  }

  persistClaim(args: {
    ownerId: string;
    ownerGeneration: string;
    presenceSessionId: string;
    claimToken: string;
    claimed: ClaimedExecution;
    now: number;
  }): { replayed: boolean } {
    const existing = this.get(args.claimed.dispatch.dispatchId);
    if (existing) {
      const same =
        existing.ownerId === args.ownerId &&
        existing.ownerGeneration === args.ownerGeneration &&
        existing.presenceSessionId === args.presenceSessionId &&
        existing.claimToken === args.claimToken &&
        existing.payloadHash === args.claimed.payloadHash &&
        existing.payloadJson === args.claimed.payloadJson;
      if (!same) {
        throw new Error(
          "A local execution dispatch was replayed with different claim bytes.",
        );
      }
      return { replayed: true };
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO execution_placement_inbox (
             dispatch_id, owner_id, owner_generation, presence_session_id,
             kind, conversation_id, claim_token, payload_hash, payload_json,
             dispatch_json, state, persisted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(
          args.claimed.dispatch.dispatchId,
          args.ownerId,
          args.ownerGeneration,
          args.presenceSessionId,
          args.claimed.dispatch.kind,
          args.claimed.dispatch.conversationId,
          args.claimToken,
          args.claimed.payloadHash,
          args.claimed.payloadJson,
          JSON.stringify(args.claimed.dispatch),
          args.now,
          args.now,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // BEGIN itself failed.
      }
      throw error;
    }
    return { replayed: false };
  }

  get(dispatchId: string): ExecutionPlacementInboxRow | null {
    const row = this.database
      .prepare(`SELECT * FROM execution_placement_inbox WHERE dispatch_id = ?`)
      .get(dispatchId) as InboxDbRow | undefined;
    return row ? fromInboxRow(row) : null;
  }

  listUnfinished(args: {
    ownerId: string;
    ownerGeneration: string;
    presenceSessionId: string;
  }): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE owner_id = ? AND owner_generation = ?
             AND presence_session_id = ?
             AND state IN (
               'claimed', 'accepted', 'running', 'terminal_pending'
             )
           ORDER BY persisted_at ASC`,
        )
        .all(
          args.ownerId,
          args.ownerGeneration,
          args.presenceSessionId,
        ) as InboxDbRow[]
    ).map(fromInboxRow);
  }

  listAllUnfinished(): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE state IN (
             'claimed', 'accepted', 'running', 'terminal_pending'
           )
           ORDER BY persisted_at ASC`,
        )
        .all() as InboxDbRow[]
    ).map(fromInboxRow);
  }

  listCancellationPending(): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE cancel_rpc_pending = 1
           ORDER BY persisted_at ASC`,
        )
        .all() as InboxDbRow[]
    ).map(fromInboxRow);
  }

  stageCancellation(
    dispatchId: string,
    args: {
      outcome: PlacementOutcome;
      errorCode?: string;
      errorMessage?: string;
      orphanOnAck?: boolean;
      now: number;
    },
  ) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET cancel_rpc_pending = 1,
             cancel_orphan_on_ack = CASE
               WHEN cancel_orphan_on_ack = 1 OR ? = 1 THEN 1
               ELSE 0
             END,
             terminal_outcome = ?, result_json = NULL,
             error_code = ?, error_message = ?, updated_at = ?
         WHERE dispatch_id = ?
           AND state IN (
             'claimed', 'accepted', 'running', 'terminal_pending'
           )`,
      )
      .run(
        args.orphanOnAck ? 1 : 0,
        args.outcome,
        args.errorCode ?? null,
        args.errorMessage ?? null,
        args.now,
        dispatchId,
      );
  }

  acknowledgeCancellation(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = CASE
               WHEN cancel_orphan_on_ack = 1 THEN 'orphaned'
               ELSE 'terminal_pending'
             END,
             cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0,
             updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 1`,
      )
      .run(now, dispatchId);
  }

  acknowledgeClaimRelease(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'orphaned', cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND state = 'claimed'`,
      )
      .run(now, dispatchId);
  }

  markAccepted(dispatchId: string, dispatch: DispatchSummary, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'accepted', dispatch_json = ?, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0
           AND state IN ('claimed', 'accepted')`,
      )
      .run(JSON.stringify(dispatch), now, dispatchId);
  }

  markRunning(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'running', started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0
           AND state IN ('accepted', 'running')`,
      )
      .run(now, now, dispatchId);
  }

  markTerminalPending(
    dispatchId: string,
    args: {
      outcome: PlacementOutcome;
      resultJson?: string;
      errorCode?: string;
      errorMessage?: string;
      now: number;
    },
  ) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'terminal_pending', terminal_outcome = ?,
             result_json = ?, error_code = ?, error_message = ?,
             cancel_rpc_pending = 0, cancel_orphan_on_ack = 0,
             updated_at = ?
         WHERE dispatch_id = ?
           AND cancel_rpc_pending = 0
           AND state IN ('claimed', 'accepted', 'running', 'terminal_pending')`,
      )
      .run(
        args.outcome,
        args.resultJson ?? null,
        args.errorCode ?? null,
        args.errorMessage ?? null,
        args.now,
        dispatchId,
      );
  }

  markTerminal(dispatchId: string, dispatch: DispatchSummary, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'terminal', dispatch_json = ?, cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0`,
      )
      .run(JSON.stringify(dispatch), now, dispatchId);
  }

  markOrphaned(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'orphaned', cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0`,
      )
      .run(now, dispatchId);
  }

  pruneTerminal(before: number) {
    this.database
      .prepare(
        `DELETE FROM execution_placement_inbox
         WHERE state IN ('terminal', 'orphaned') AND updated_at < ?`,
      )
      .run(before);
  }
}

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Stable, dispatch-scoped ID for the exact blocking local-agent run. */
export const placementLocalAgentThreadId = (dispatchId: string) =>
  `placement-agent:${sha256(dispatchId).slice(0, 32)}`;

/** Stable, dispatch-scoped ID for the exact local automation/chat run. */
export const placementLocalChatRunId = (dispatchId: string) =>
  `placement-chat:${sha256(dispatchId).slice(0, 32)}`;

const parseRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Execution placement returned an invalid object.");
  }
  return value as Record<string, unknown>;
};

const parseDispatch = (value: unknown): DispatchSummary => {
  const row = parseRecord(value);
  if (
    typeof row.dispatchId !== "string" ||
    (row.kind !== "chat" && row.kind !== "agent") ||
    typeof row.conversationId !== "string" ||
    typeof row.state !== "string"
  ) {
    throw new Error("Execution placement returned an invalid dispatch.");
  }
  return row as DispatchSummary;
};

const boundedResult = (value: string | undefined) => {
  if (!value) return undefined;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= TERMINAL_RESULT_LIMIT) return value;
  return bytes.subarray(0, TERMINAL_RESULT_LIMIT).toString("utf8");
};

const isOwnerLifecycleFenceError = (error: unknown) => {
  const record =
    error && typeof error === "object"
      ? (error as { data?: { code?: unknown }; message?: unknown })
      : undefined;
  const code = record?.data?.code;
  const message =
    typeof record?.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    code === "OWNER_DATA_PURGE_ACTIVE" ||
    code === "OWNER_DATA_GENERATION_STALE" ||
    message.includes("OWNER_DATA_PURGE_ACTIVE") ||
    message.includes("OWNER_DATA_GENERATION_STALE")
  );
};

/**
 * Signed presence + durable claim/ack runtime. All signed mutations share one
 * promise queue so proof sequence N can never arrive after N+1.
 */
export class ExecutionPlacementBridge {
  readonly client: ExecutionPlacementClient;
  private readonly inbox: ExecutionPlacementInbox;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly subscriptions = new Set<{ unsubscribe(): void }>();
  private heartbeatTimer: HostTimerHandle | null = null;
  private ownerId: string | null = null;
  private ownerGeneration: string | null = null;
  private presenceSessionId: string | null = null;
  private sessionReady = false;
  private started = false;
  private stopped = false;
  private lifecycleEpoch = 0;
  private heartbeatTask: Promise<void> | null = null;
  private presenceSocket: WebSocket | null = null;
  private presenceSocketBaseUrl: string | null = null;
  private presenceSocketReconnectTimer: HostTimerHandle | null = null;
  private presenceSocketPingTimer: HostTimerHandle | null = null;
  private presenceSocketReconnectAttempt = 0;
  private advertisedAvailability = "";
  private stopTask: Promise<void> | null = null;
  private readonly renewalFailureSince = new Map<string, number>();
  private readonly claimAckRetry = new Map<
    string,
    { attempts: number; nextAt: number }
  >();
  private signedQueue: Promise<unknown> = Promise.resolve();
  private offerQueue: Promise<void> = Promise.resolve();
  private readonly executing = new Set<string>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly cancellationInFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: PlacementBridgeOptions) {
    this.client = options.client;
    this.inbox = new ExecutionPlacementInbox(options.database);
    this.privateKey = createPrivateKey({
      key: Buffer.from(options.deviceIdentity.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  }

  get isRunning() {
    return this.started && !this.stopped;
  }

  async submitDesktopExecution(
    args: ExecutionPlacementDesktopSubmit,
  ): Promise<DispatchSummary> {
    if (!this.isRunning || !this.sessionReady) {
      throw new Error("Execution placement is not ready on this computer.");
    }
    const session = this.requireSession();
    const idempotencyKey = args.idempotencyKey.trim();
    const payloadHash = args.payloadHash.trim().toLowerCase();
    const conversationId = args.conversationId.trim();
    const parentTurnId = args.parentTurnId?.trim() || undefined;
    const threadId = args.threadId?.trim() || undefined;
    const requestedExecutorDeviceId =
      args.requestedExecutorDeviceId?.trim() || undefined;
    const requiredCapabilities = [
      ...new Set<PlacementCapability>([
        args.kind,
        ...args.requiredCapabilities,
      ]),
    ].sort();
    const mutationArgs = {
      idempotencyKey,
      expectedOwnerGeneration: session.ownerGeneration,
      requestedTargetMode: args.requestedTargetMode,
      ...(requestedExecutorDeviceId ? { requestedExecutorDeviceId } : {}),
      payloadJson: args.payloadJson,
      payloadHash,
      kind: args.kind,
      subject: args.subject,
      conversationId,
      ...(parentTurnId ? { parentTurnId } : {}),
      ...(threadId ? { threadId } : {}),
      requiredCapabilities,
    };
    const proofParts = [
      idempotencyKey,
      payloadHash,
      args.kind,
      args.subject,
      conversationId,
      parentTurnId ?? null,
      threadId ?? null,
      args.requestedTargetMode,
      requestedExecutorDeviceId ?? null,
      requiredCapabilities,
    ];
    return parseDispatch(
      await this.enqueueSigned(
        "execution-submit",
        proofParts,
        anyApi.execution_placement.submitMyDesktopExecution,
        mutationArgs,
      ),
    );
  }

  private log(level: "warn" | "error", message: string, error?: unknown) {
    this.options.log?.(level, message, error);
  }

  private requireSession() {
    if (!this.ownerId || !this.ownerGeneration || !this.presenceSessionId) {
      throw new Error("Execution placement session is not initialized.");
    }
    return {
      ownerId: this.ownerId,
      ownerGeneration: this.ownerGeneration,
      presenceSessionId: this.presenceSessionId,
    };
  }

  private enqueueSigned<T>(
    operation: string,
    bodyParts: readonly unknown[],
    reference: unknown,
    args: Record<string, unknown>,
    control: { allowStopped?: boolean } = {},
  ): Promise<T> {
    // Capture immutable proof authority when the operation is queued. Reading
    // mutable bridge fields inside the serialized task could otherwise sign an
    // old operation under a replacement owner generation/session.
    const session = this.requireSession();
    const epoch = this.lifecycleEpoch;
    const task = async () => {
      if (
        epoch !== this.lifecycleEpoch ||
        (this.stopped && !control.allowStopped)
      ) {
        throw new Error(
          "Execution placement proof session changed before signing.",
        );
      }
      const bodyHash = sha256(JSON.stringify(bodyParts));
      const sequence = this.inbox.nextProofSequence(
        (this.options.now ?? Date.now)(),
      );
      const message = JSON.stringify([
        "stella-execution-placement",
        PROTOCOL_VERSION,
        operation,
        session.ownerGeneration,
        this.options.deviceIdentity.deviceId,
        session.presenceSessionId,
        sequence,
        bodyHash,
      ]);
      const signature = sign(
        null,
        Buffer.from(message, "utf8"),
        this.privateKey,
      ).toString("base64url");
      return (await this.client.mutation(reference, {
        ownerGeneration: session.ownerGeneration,
        deviceId: this.options.deviceIdentity.deviceId,
        presenceSessionId: session.presenceSessionId,
        sequence,
        bodyHash,
        signature,
        ...args,
      })) as T;
    };
    const result = this.signedQueue.then(task, task);
    this.signedQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isLiveEpoch(epoch: number) {
    return this.started && !this.stopped && epoch === this.lifecycleEpoch;
  }

  private noteClaimAckFailure(dispatchId: string) {
    const previous = this.claimAckRetry.get(dispatchId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const baseMs = Math.max(
      1,
      this.options.claimAckRetryBaseMs ?? CLAIM_ACK_RETRY_BASE_MS,
    );
    const delayMs = Math.min(
      CLAIM_ACK_RETRY_MAX_MS,
      baseMs * 2 ** Math.min(attempts - 1, 8),
    );
    this.claimAckRetry.set(dispatchId, {
      attempts,
      nextAt: (this.options.now ?? Date.now)() + delayMs,
    });
  }

  private claimAckRetryIsDue(dispatchId: string) {
    const retry = this.claimAckRetry.get(dispatchId);
    return !retry || (this.options.now ?? Date.now)() >= retry.nextAt;
  }

  private async registerPresence() {
    const availability = await this.options.getAvailability();
    const active = this.inbox.listUnfinished(this.requireSession());
    const ready =
      availability.ready &&
      active.length === 0 &&
      this.inbox.listCancellationPending().length === 0;
    const capabilities = [...new Set(availability.capabilities)].sort();
    const status = ready ? "ready" : "draining";
    const chatCapacity = Math.max(0, Math.min(16, availability.chatSlots));
    const agentCapacity = Math.max(0, Math.min(16, availability.agentSlots));
    const availableChatSlots = ready ? chatCapacity : 0;
    const availableAgentSlots = ready ? agentCapacity : 0;
    const bodyParts = [
      this.options.deviceIdentity.publicKey,
      PROTOCOL_VERSION,
      this.options.appVersion,
      capabilities,
      status,
      chatCapacity,
      agentCapacity,
      availableChatSlots,
      availableAgentSlots,
      ...(this.presenceSocketBaseUrl ? ["socket"] : []),
      ...(this.options.deviceName || this.options.platform
        ? [this.options.deviceName ?? null, this.options.platform ?? null]
        : []),
    ];
    await this.enqueueSigned(
      "presence-register",
      bodyParts,
      anyApi.execution_placement.registerMyExecutionPresence,
      {
        devicePublicKey: this.options.deviceIdentity.publicKey,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: this.options.appVersion,
        ...(this.options.deviceName
          ? { deviceName: this.options.deviceName }
          : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        ...(this.presenceSocketBaseUrl ? { presenceTransport: "socket" } : {}),
        capabilities,
        status,
        chatSlotCapacity: chatCapacity,
        agentSlotCapacity: agentCapacity,
        availableChatSlots,
        availableAgentSlots,
      },
    );
    this.advertisedAvailability = JSON.stringify([
      status,
      chatCapacity,
      agentCapacity,
      availableChatSlots,
      availableAgentSlots,
    ]);
  }

  private applyPresenceSocketBaseUrl(identity: Record<string, unknown>) {
    this.presenceSocketBaseUrl =
      typeof identity.presenceSocketBaseUrl === "string" &&
      identity.presenceSocketBaseUrl.startsWith("wss://")
        ? identity.presenceSocketBaseUrl.replace(/\/+$/u, "")
        : null;
  }

  private closePresenceSocket() {
    this.presenceSocketReconnectTimer?.cancel();
    this.presenceSocketReconnectTimer = null;
    this.presenceSocketPingTimer?.cancel();
    this.presenceSocketPingTimer = null;
    const socket = this.presenceSocket;
    this.presenceSocket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "desktop_stopped");
    }
  }

  private schedulePresenceSocketReconnect() {
    if (
      this.stopped ||
      !this.started ||
      !this.sessionReady ||
      !this.presenceSocketBaseUrl ||
      this.presenceSocketReconnectTimer
    ) {
      return;
    }
    const attempt = this.presenceSocketReconnectAttempt++;
    const delay = Math.min(
      PRESENCE_SOCKET_RECONNECT_MAX_MS,
      500 * 2 ** Math.min(attempt, 6),
    );
    this.presenceSocketReconnectTimer = forkDelayed(delay, () => {
      this.presenceSocketReconnectTimer = null;
      this.openPresenceSocket();
    });
  }

  private openPresenceSocket() {
    if (
      this.stopped ||
      !this.started ||
      !this.sessionReady ||
      !this.presenceSocketBaseUrl ||
      this.presenceSocket
    ) {
      return;
    }
    const token = this.options.getAuthToken?.()?.trim();
    if (!token) {
      this.schedulePresenceSocketReconnect();
      return;
    }
    const session = this.requireSession();
    const url = `${this.presenceSocketBaseUrl}/${encodeURIComponent(this.options.deviceIdentity.deviceId)}/presence`;
    const socket = new WebSocket(url, ["stella.v1", `stella.token.${token}`]);
    this.presenceSocket = socket;
    let connectionId = "";
    let nonce = "";

    socket.on("message", (data) => {
      void (async () => {
        let frame: Record<string, unknown>;
        try {
          const value = JSON.parse(data.toString());
          if (!value || typeof value !== "object" || Array.isArray(value))
            return;
          frame = value as Record<string, unknown>;
        } catch {
          socket.close(4000, "bad_response");
          return;
        }
        if (frame.type === "challenge") {
          connectionId =
            typeof frame.connectionId === "string" ? frame.connectionId : "";
          nonce = typeof frame.nonce === "string" ? frame.nonce : "";
          if (!connectionId || !nonce) {
            socket.close(4000, "bad_response");
            return;
          }
          socket.send(
            JSON.stringify({
              type: "begin",
              presenceSessionId: session.presenceSessionId,
            }),
          );
          return;
        }
        if (frame.type === "prove") {
          if (frame.connectionId !== connectionId || !nonce) {
            socket.close(4000, "bad_response");
            return;
          }
          await this.enqueueSigned(
            "presence-socket-connect",
            [connectionId, nonce],
            anyApi.execution_placement.connectMyExecutionPresenceSocket,
            { connectionId, nonce },
          );
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ready" }));
          }
          return;
        }
        if (frame.type === "connected") {
          this.presenceSocketReconnectAttempt = 0;
          this.presenceSocketPingTimer?.cancel();
          this.presenceSocketPingTimer = forkInterval(10_000, () => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "ping" }));
            }
          });
        }
      })().catch((error) => {
        this.log("warn", "Execution placement presence socket failed.", error);
        socket.close(4500, "presence_failed");
      });
    });
    socket.on("close", () => {
      if (this.presenceSocket !== socket) return;
      this.presenceSocket = null;
      this.presenceSocketPingTimer?.cancel();
      this.presenceSocketPingTimer = null;
      this.schedulePresenceSocketReconnect();
    });
    socket.on("error", (error) => {
      this.log(
        "warn",
        "Execution placement presence socket disconnected.",
        error,
      );
    });
  }

  /**
   * A new bridge instance has no in-memory Promise that can still own a
   * pre-crash execution. Persist that ambiguity before the first new presence
   * proof is signed, then let the exact-run cancellation outbox join it. A
   * server-side Stop that already won keeps the truthful canceled outcome.
   */
  private async stageRestartCancellations() {
    const now = (this.options.now ?? Date.now)();
    for (const row of this.inbox.listAllUnfinished()) {
      if (
        row.cancelRpcPending ||
        !["claimed", "accepted", "running"].includes(row.state)
      ) {
        continue;
      }
      let remoteCanceled = false;
      try {
        const value = await this.client.query(
          anyApi.execution_placement.getMyExecutionDispatchStatus,
          { dispatchId: row.dispatchId },
        );
        const remote = value ? parseDispatch(value) : null;
        remoteCanceled =
          remote?.state === "cancel_pending" || remote?.state === "canceled";
      } catch (error) {
        // The local execution is still ambiguous even if the status read is
        // unavailable. Fail closed and reconcile its terminal meaning later.
        this.log(
          "warn",
          "Execution placement restart status reconciliation was deferred.",
          error,
        );
      }
      this.inbox.stageCancellation(row.dispatchId, {
        outcome: remoteCanceled ? "canceled" : "failed",
        ...(remoteCanceled
          ? { errorMessage: "Canceled by the user." }
          : {
              errorCode: "LOCAL_EXECUTION_INTERRUPTED",
              errorMessage:
                "The desktop restarted after local execution ownership was recorded.",
            }),
        now,
      });
    }
  }

  private heartbeat(): Promise<void> {
    if (this.heartbeatTask) return this.heartbeatTask;
    if (!this.started || this.stopped) return Promise.resolve();
    const task = this.runHeartbeat();
    this.heartbeatTask = task;
    const clear = () => {
      if (this.heartbeatTask === task) this.heartbeatTask = null;
    };
    void task.then(clear, clear);
    return task;
  }

  private async runHeartbeat() {
    let identityRefreshNeeded = false;
    try {
      await this.retryPendingCancellations();
      if (!this.sessionReady) {
        await this.refreshIdentityAfterFence();
        return;
      }
      const active = this.inbox.listUnfinished(this.requireSession());
      try {
        const availability = await this.options.getAvailability();
        const ready =
          availability.ready &&
          active.length === 0 &&
          this.inbox.listCancellationPending().length === 0;
        const chatCapacity = Math.max(0, Math.min(16, availability.chatSlots));
        const agentCapacity = Math.max(
          0,
          Math.min(16, availability.agentSlots),
        );
        const status = ready ? "ready" : "draining";
        const availableChatSlots = ready ? chatCapacity : 0;
        const availableAgentSlots = ready ? agentCapacity : 0;
        const advertisedAvailability = JSON.stringify([
          status,
          chatCapacity,
          agentCapacity,
          availableChatSlots,
          availableAgentSlots,
        ]);
        if (
          !this.presenceSocketBaseUrl ||
          advertisedAvailability !== this.advertisedAvailability
        ) {
          await this.enqueueSigned(
            "presence-heartbeat",
            [
              status,
              chatCapacity,
              agentCapacity,
              availableChatSlots,
              availableAgentSlots,
            ],
            anyApi.execution_placement.heartbeatMyExecutionPresence,
            {
              status,
              chatSlotCapacity: chatCapacity,
              agentSlotCapacity: agentCapacity,
              availableChatSlots,
              availableAgentSlots,
            },
          );
          this.advertisedAvailability = advertisedAvailability;
        }
      } catch (error) {
        identityRefreshNeeded = true;
        this.log("warn", "Execution placement heartbeat failed.", error);
      }
      const now = (this.options.now ?? Date.now)();
      for (const row of active) {
        if (this.stopped) break;
        if (row.cancelRpcPending) {
          try {
            await this.renew(row);
            this.renewalFailureSince.delete(row.dispatchId);
          } catch (error) {
            identityRefreshNeeded = true;
            this.log(
              "warn",
              "Execution placement cancellation lease renewal failed.",
              error,
            );
          }
          continue;
        }
        if (row.state === "claimed") {
          this.renewalFailureSince.delete(row.dispatchId);
          if (this.claimAckRetryIsDue(row.dispatchId)) {
            let remote: DispatchSummary | null = null;
            try {
              const value = await this.client.query(
                anyApi.execution_placement.getMyExecutionDispatchStatus,
                { dispatchId: row.dispatchId },
              );
              remote = value ? parseDispatch(value) : null;
            } catch (error) {
              this.noteClaimAckFailure(row.dispatchId);
              this.log(
                "warn",
                "Execution placement claim-ACK status retry was deferred.",
                error,
              );
              continue;
            }
            if (
              !remote ||
              remote.placement === "cloud" ||
              ["completed", "failed", "canceled"].includes(remote.state)
            ) {
              this.claimAckRetry.delete(row.dispatchId);
              this.inbox.markOrphaned(row.dispatchId, now);
            } else {
              this.launchLocal(row, remote);
            }
          }
          continue;
        }
        if (row.state === "terminal_pending") {
          this.renewalFailureSince.delete(row.dispatchId);
          await this.flushTerminal(row).catch((error) =>
            this.log(
              "warn",
              "Execution placement terminal receipt retry was deferred.",
              error,
            ),
          );
          continue;
        }
        try {
          await this.renew(row);
          this.renewalFailureSince.delete(row.dispatchId);
        } catch (error) {
          identityRefreshNeeded = true;
          const failedSince =
            this.renewalFailureSince.get(row.dispatchId) ?? now;
          this.renewalFailureSince.set(row.dispatchId, failedSince);
          this.log("warn", "Execution placement lease renewal failed.", error);
          if (
            isOwnerLifecycleFenceError(error) ||
            now - failedSince >=
              (this.options.leaseRenewalGraceMs ??
                EXECUTION_LEASE_RENEWAL_FAILSAFE_MS)
          ) {
            await this.cancelForLostLease(row);
          }
        }
      }
      this.inbox.pruneTerminal(now - 7 * 86_400_000);
      if (identityRefreshNeeded) {
        await this.refreshIdentityAfterFence().catch((error) =>
          this.log(
            "warn",
            "Execution placement identity refresh was deferred.",
            error,
          ),
        );
      }
    } finally {
      // `heartbeatTask` is cleared by the wrapper after this body settles.
    }
  }

  private async cancelForLostLease(row: ExecutionPlacementInboxRow) {
    this.renewalFailureSince.delete(row.dispatchId);
    this.inbox.stageCancellation(row.dispatchId, {
      outcome: "canceled",
      errorCode: "LOCAL_EXECUTION_LEASE_EXPIRED",
      errorMessage:
        "The desktop stopped executing because its server lease could not be renewed.",
      now: (this.options.now ?? Date.now)(),
    });
    await this.retryCancellation(row.dispatchId);
  }

  private async retryPendingCancellations(
    control: { allowStopped?: boolean } = {},
  ) {
    let acknowledged = true;
    for (const row of this.inbox.listCancellationPending()) {
      if (!(await this.retryCancellation(row.dispatchId, control))) {
        acknowledged = false;
      }
    }
    return acknowledged;
  }

  private retryCancellation(
    dispatchId: string,
    control: { allowStopped?: boolean } = {},
  ): Promise<boolean> {
    const existing = this.cancellationInFlight.get(dispatchId);
    if (existing) return existing;
    const pending = (async () => {
      const row = this.inbox.get(dispatchId);
      if (!row?.cancelRpcPending) return true;
      try {
        await this.options.cancelExecution({
          dispatchId: row.dispatchId,
          kind: row.kind,
          conversationId: row.conversationId,
        });
      } catch (error) {
        this.log(
          "warn",
          "Execution placement local cancellation RPC was deferred.",
          error,
        );
        return false;
      }
      const afterLocalCancel = this.inbox.get(row.dispatchId);
      if (!afterLocalCancel?.cancelRpcPending) return true;
      const currentSession = this.requireSession();
      if (
        afterLocalCancel.ownerId !== currentSession.ownerId ||
        afterLocalCancel.ownerGeneration !== currentSession.ownerGeneration ||
        afterLocalCancel.presenceSessionId !== currentSession.presenceSessionId
      ) {
        // Owner rotation already made the old proof authority unusable. The
        // durable local cancel has joined/reconciled the effect, so orphan the
        // old receipt without attempting to sign under the replacement key.
        this.inbox.acknowledgeCancellation(
          afterLocalCancel.dispatchId,
          (this.options.now ?? Date.now)(),
        );
        return true;
      }
      if (afterLocalCancel.state === "claimed") {
        const tokenHash = sha256(afterLocalCancel.claimToken);
        try {
          await this.enqueueSigned(
            "claim-release",
            [
              afterLocalCancel.dispatchId,
              tokenHash,
              "local execution canceled before claim acceptance",
            ],
            anyApi.execution_placement.releaseMyExecutionClaim,
            {
              dispatchId: afterLocalCancel.dispatchId,
              claimToken: afterLocalCancel.claimToken,
              reason: "local execution canceled before claim acceptance",
            },
            control,
          );
          this.inbox.acknowledgeClaimRelease(
            afterLocalCancel.dispatchId,
            (this.options.now ?? Date.now)(),
          );
          this.claimAckRetry.delete(afterLocalCancel.dispatchId);
          return true;
        } catch (releaseError) {
          // The ACK response can be lost after the server accepts it but before
          // SQLite advances from `claimed`. Reconcile that exact dispatch; only
          // an accepted/cancel-pending remote owner may continue to completion.
          try {
            const value = await this.client.query(
              anyApi.execution_placement.getMyExecutionDispatchStatus,
              { dispatchId: afterLocalCancel.dispatchId },
            );
            const remote = value ? parseDispatch(value) : null;
            if (
              remote &&
              remote.placement === "computer" &&
              [
                "computer_accepted",
                "computer_running",
                "cancel_pending",
                "reconciliation_required",
              ].includes(remote.state)
            ) {
              this.inbox.markAccepted(
                afterLocalCancel.dispatchId,
                remote,
                (this.options.now ?? Date.now)(),
              );
            } else if (
              !remote ||
              remote.placement === "cloud" ||
              ["completed", "failed", "canceled"].includes(remote?.state ?? "")
            ) {
              this.inbox.acknowledgeClaimRelease(
                afterLocalCancel.dispatchId,
                (this.options.now ?? Date.now)(),
              );
              return true;
            } else {
              this.log(
                "warn",
                "Execution placement pre-acceptance claim release was deferred.",
                releaseError,
              );
              return false;
            }
          } catch (statusError) {
            this.log(
              "warn",
              "Execution placement pre-acceptance claim reconciliation was deferred.",
              statusError,
            );
            return false;
          }
        }
      }
      this.inbox.acknowledgeCancellation(
        afterLocalCancel.dispatchId,
        (this.options.now ?? Date.now)(),
      );
      const acknowledged = this.inbox.get(afterLocalCancel.dispatchId);
      if (acknowledged?.state === "terminal_pending") {
        await this.flushTerminal(acknowledged).catch((error) =>
          this.log(
            "warn",
            "Execution placement cancellation receipt was deferred.",
            error,
          ),
        );
      }
      return true;
    })();
    this.cancellationInFlight.set(dispatchId, pending);
    const clear = () => {
      if (this.cancellationInFlight.get(dispatchId) === pending) {
        this.cancellationInFlight.delete(dispatchId);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private clearSubscriptions() {
    for (const subscription of this.subscriptions) {
      try {
        subscription.unsubscribe();
      } catch {
        // Best-effort reactive teardown.
      }
    }
    this.subscriptions.clear();
  }

  private async refreshIdentityAfterFence() {
    if (this.stopped || !this.started) return;
    const identity = parseRecord(
      await this.client.query(
        anyApi.execution_placement.getMyExecutionPlacementIdentity,
        {},
      ),
    );
    if (
      typeof identity.ownerId !== "string" ||
      typeof identity.ownerGeneration !== "string" ||
      identity.protocolVersion !== PROTOCOL_VERSION
    ) {
      throw new Error("Execution placement identity is incompatible.");
    }
    if (
      identity.ownerId === this.ownerId &&
      identity.ownerGeneration === this.ownerGeneration
    ) {
      if (!this.sessionReady) {
        const cancellationsAcknowledged =
          await this.retryPendingCancellations();
        if (!cancellationsAcknowledged) {
          throw new Error(
            "Execution placement session recovery is waiting for local cancellation acknowledgement.",
          );
        }
        await Promise.allSettled([...this.executionTasks.values()]);
        await this.registerPresence();
        this.sessionReady = true;
        this.openPresenceSocket();
        this.subscribe();
        await this.reconcileInbox();
      }
      return;
    }

    this.clearSubscriptions();
    this.closePresenceSocket();
    this.renewalFailureSince.clear();
    this.claimAckRetry.clear();
    this.sessionReady = false;
    this.lifecycleEpoch += 1;
    await this.offerQueue.catch(() => undefined);
    await this.signedQueue;
    this.ownerId = identity.ownerId;
    this.ownerGeneration = identity.ownerGeneration;
    this.applyPresenceSocketBaseUrl(identity);
    const nextSession = this.inbox.openSession({
      ownerId: identity.ownerId,
      ownerGeneration: identity.ownerGeneration,
      now: (this.options.now ?? Date.now)(),
    });
    this.presenceSessionId = nextSession.presenceSessionId;
    const cancellationsAcknowledged = await this.retryPendingCancellations();
    if (!cancellationsAcknowledged) {
      throw new Error(
        "Execution placement owner rotation is waiting for local cancellation acknowledgement.",
      );
    }
    await Promise.allSettled([...this.executionTasks.values()]);
    await this.registerPresence();
    this.sessionReady = true;
    this.openPresenceSocket();
    this.subscribe();
    await this.reconcileInbox();
  }

  private subscribe() {
    const session = this.requireSession();
    const offers = this.client.onUpdate(
      anyApi.execution_placement.listMyExecutionOffers,
      {
        deviceId: this.options.deviceIdentity.deviceId,
        presenceSessionId: session.presenceSessionId,
        limit: 16,
      },
      (value) => {
        const rows = Array.isArray(value) ? value : [];
        this.offerQueue = this.offerQueue
          .then(async () => {
            for (const raw of rows) await this.handleOffer(raw);
          })
          .catch((error) =>
            this.log(
              "error",
              "Execution placement offer handling failed.",
              error,
            ),
          );
      },
      (error) =>
        this.log("warn", "Execution placement offer stream failed.", error),
    );
    this.subscriptions.add(offers);
    const accepted = this.client.onUpdate(
      anyApi.execution_placement.listMyAcceptedExecutionDispatches,
      {
        deviceId: this.options.deviceIdentity.deviceId,
        presenceSessionId: session.presenceSessionId,
        limit: 64,
      },
      (value) => {
        if (!Array.isArray(value)) return;
        for (const raw of value) {
          let dispatch: DispatchSummary;
          try {
            dispatch = parseDispatch(raw);
          } catch (error) {
            this.log("warn", "Ignored malformed accepted execution.", error);
            continue;
          }
          const local = this.inbox.get(dispatch.dispatchId);
          if (!local) continue;
          if (dispatch.state === "cancel_pending") {
            void this.cancelAccepted(local).catch((error) =>
              this.log(
                "warn",
                "Execution placement cancellation retry was deferred.",
                error,
              ),
            );
          } else if (!this.executing.has(dispatch.dispatchId)) {
            this.launchLocal(local, dispatch);
          }
        }
      },
      (error) =>
        this.log("warn", "Execution placement accepted stream failed.", error),
    );
    this.subscriptions.add(accepted);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopTask) {
      throw new Error("A stopped execution placement bridge cannot restart.");
    }
    this.stopped = false;
    const epoch = ++this.lifecycleEpoch;
    const identity = parseRecord(
      await this.client.query(
        anyApi.execution_placement.getMyExecutionPlacementIdentity,
        {},
      ),
    );
    if (
      typeof identity.ownerId !== "string" ||
      typeof identity.ownerGeneration !== "string" ||
      identity.protocolVersion !== PROTOCOL_VERSION
    ) {
      throw new Error("Execution placement identity is incompatible.");
    }
    if (this.stopped || epoch !== this.lifecycleEpoch) {
      throw new Error("Execution placement stopped while starting.");
    }
    this.ownerId = identity.ownerId;
    this.ownerGeneration = identity.ownerGeneration;
    this.applyPresenceSocketBaseUrl(identity);
    const session = this.inbox.openSession({
      ownerId: identity.ownerId,
      ownerGeneration: identity.ownerGeneration,
      now: (this.options.now ?? Date.now)(),
    });
    this.presenceSessionId = session.presenceSessionId;
    await this.stageRestartCancellations();
    this.started = true;
    const cancellationsAcknowledged = await this.retryPendingCancellations();
    if (!cancellationsAcknowledged) {
      // Stay alive only as a cancellation reconciler. No presence or offer
      // subscription exists until a later heartbeat joins every exact run.
      this.heartbeatTimer = forkInterval(HEARTBEAT_INTERVAL_MS, () => {
        void this.heartbeat();
      });
      return;
    }
    await this.registerPresence();
    if (this.stopped || epoch !== this.lifecycleEpoch) {
      throw new Error("Execution placement stopped while registering.");
    }
    this.sessionReady = true;
    this.openPresenceSocket();
    this.subscribe();
    await this.reconcileInbox();
    this.heartbeatTimer = forkInterval(HEARTBEAT_INTERVAL_MS, () => {
      void this.heartbeat();
    });
  }

  async stop(): Promise<void> {
    if (this.stopTask) return await this.stopTask;
    const task = this.stopAndQuiesce();
    this.stopTask = task;
    try {
      await task;
    } catch (error) {
      // The durable cancellation outbox remains pending. Let the host retry
      // this same stopped bridge; it must not create a replacement first.
      if (this.stopTask === task) this.stopTask = null;
      throw error;
    }
  }

  private async stopAndQuiesce(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.sessionReady = false;
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = null;
    this.closePresenceSocket();
    this.clearSubscriptions();
    this.renewalFailureSince.clear();
    this.claimAckRetry.clear();

    // No replacement bridge may establish a new proof sequence until every
    // continuation already admitted by this instance has crossed its stop
    // fence. `stopped` makes queued non-cleanup signatures reject, while an
    // already-issued mutation is joined through these queues.
    await this.heartbeatTask?.catch(() => undefined);
    await this.offerQueue.catch(() => undefined);
    await this.signedQueue;

    const now = (this.options.now ?? Date.now)();
    for (const row of this.inbox.listAllUnfinished()) {
      if (["claimed", "accepted", "running"].includes(row.state)) {
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "canceled",
          errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
          errorMessage:
            "The desktop execution bridge stopped before the local run settled.",
          orphanOnAck:
            row.ownerGeneration !== this.ownerGeneration ||
            row.presenceSessionId !== this.presenceSessionId,
          now,
        });
      }
    }

    const cancellationResults = await Promise.all(
      this.inbox
        .listCancellationPending()
        .map((row) =>
          this.retryCancellation(row.dispatchId, { allowStopped: true }),
        ),
    );
    const cancellationsAcknowledged = cancellationResults.every(Boolean);
    if (cancellationsAcknowledged) {
      await Promise.allSettled([...this.executionTasks.values()]);
    }
    await Promise.allSettled([...this.cancellationInFlight.values()]);
    await this.signedQueue;

    for (const row of this.inbox.listAllUnfinished()) {
      if (row.state === "terminal_pending" && !row.cancelRpcPending) {
        await this.flushTerminal(row, { allowStopped: true }).catch((error) =>
          this.log(
            "warn",
            "Execution placement terminal receipt during stop was deferred.",
            error,
          ),
        );
      }
    }
    await this.signedQueue;
    let drainError: unknown;
    if (this.ownerGeneration && this.presenceSessionId) {
      try {
        await this.enqueueSigned(
          "presence-drain",
          ["draining"],
          anyApi.execution_placement.drainMyExecutionPresence,
          {},
          { allowStopped: true },
        );
      } catch (error) {
        drainError = error;
        this.log("warn", "Execution placement drain failed.", error);
      }
    }
    await this.signedQueue;
    this.lifecycleEpoch += 1;
    if (!cancellationsAcknowledged) {
      throw new Error(
        "Execution placement stopped with an unacknowledged local cancellation.",
      );
    }
    if (drainError) {
      const error = new Error(
        "Execution placement stopped without a durable presence-drain acknowledgement.",
      );
      (error as Error & { cause?: unknown }).cause = drainError;
      throw error;
    }
  }

  private async handleOffer(raw: unknown) {
    if (!this.started || this.stopped) return;
    const epoch = this.lifecycleEpoch;
    const envelope = parseRecord(raw);
    const dispatch = parseDispatch(envelope.dispatch);
    if (
      this.executing.has(dispatch.dispatchId) ||
      this.inbox.get(dispatch.dispatchId)
    ) {
      return;
    }
    if (
      this.inbox.listUnfinished(this.requireSession()).length > 0 ||
      this.inbox.listCancellationPending().length > 0
    ) {
      return;
    }
    const availability = await this.options.getAvailability();
    if (!this.isLiveEpoch(epoch)) return;
    const slots =
      dispatch.kind === "chat"
        ? availability.chatSlots
        : availability.agentSlots;
    if (!availability.ready || slots <= 0) return;
    const claimToken = randomBytes(48).toString("base64url");
    const claimRequestId = `claim:${this.presenceSessionId}:${dispatch.dispatchId}`;
    const tokenHash = sha256(claimToken);
    let claimed: ClaimedExecution;
    try {
      claimed = (await this.enqueueSigned(
        "claim",
        [dispatch.dispatchId, claimRequestId, tokenHash],
        anyApi.execution_placement.claimMyExecutionOffer,
        {
          dispatchId: dispatch.dispatchId,
          claimRequestId,
          claimToken,
        },
      )) as ClaimedExecution;
    } catch (error) {
      this.log("warn", "Execution placement claim lost its race.", error);
      return;
    }
    const session = this.requireSession();
    try {
      this.inbox.persistClaim({
        ...session,
        claimToken,
        claimed,
        now: (this.options.now ?? Date.now)(),
      });
    } catch (error) {
      const reason = "local inbox transaction failed";
      await this.enqueueSigned(
        "claim-release",
        [dispatch.dispatchId, tokenHash, reason],
        anyApi.execution_placement.releaseMyExecutionClaim,
        { dispatchId: dispatch.dispatchId, claimToken, reason },
        { allowStopped: this.stopped },
      ).catch(() => undefined);
      throw error;
    }
    const local = this.inbox.get(dispatch.dispatchId)!;
    if (!this.isLiveEpoch(epoch)) {
      this.inbox.stageCancellation(dispatch.dispatchId, {
        outcome: "canceled",
        errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
        errorMessage:
          "The desktop execution bridge stopped before claim acceptance.",
        now: (this.options.now ?? Date.now)(),
      });
      await this.retryCancellation(dispatch.dispatchId, {
        allowStopped: true,
      });
      return;
    }
    this.launchLocal(local, claimed.dispatch);
  }

  private async reconcileInbox() {
    const session = this.requireSession();
    for (const row of this.inbox.listUnfinished(session)) {
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        continue;
      }
      let remote: DispatchSummary | null = null;
      try {
        const value = await this.client.query(
          anyApi.execution_placement.getMyExecutionDispatchStatus,
          { dispatchId: row.dispatchId },
        );
        remote = value ? parseDispatch(value) : null;
      } catch (error) {
        this.log("warn", "Execution inbox reconciliation was deferred.", error);
        continue;
      }
      if (!remote || remote.placement === "cloud") {
        if (["claimed", "accepted", "running"].includes(row.state)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_NO_LONGER_OWNED",
            errorMessage:
              "The server no longer assigned this execution to the desktop.",
            orphanOnAck: true,
            now: (this.options.now ?? Date.now)(),
          });
          await this.retryCancellation(row.dispatchId);
        } else {
          this.inbox.markOrphaned(
            row.dispatchId,
            (this.options.now ?? Date.now)(),
          );
        }
        continue;
      }
      if (["completed", "failed", "canceled"].includes(remote.state)) {
        if (["claimed", "accepted", "running"].includes(row.state)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_REMOTE_TERMINAL",
            errorMessage:
              "The server reached a terminal state before local reconciliation.",
            orphanOnAck: true,
            now: (this.options.now ?? Date.now)(),
          });
          await this.retryCancellation(row.dispatchId);
        } else {
          this.inbox.markTerminal(
            row.dispatchId,
            remote,
            (this.options.now ?? Date.now)(),
          );
        }
        continue;
      }
      if (remote.state === "cancel_pending") {
        // A cancellation can arrive while the desktop is down. Recover it
        // before classifying an in-flight local row as an interrupted failure,
        // and let it override a not-yet-accepted terminal receipt.
        await this.launchLocal(row, remote);
      } else if (row.state === "terminal_pending") {
        void this.flushTerminal(row);
      } else if (row.state === "running") {
        // The process boundary erased the Promise that owned this run. Never
        // replay it: cancel any surviving worker run and report the ambiguity.
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_EXECUTION_INTERRUPTED",
          errorMessage:
            "The desktop restarted after local execution began; Stella did not replay it because effects may already have occurred.",
          now: (this.options.now ?? Date.now)(),
        });
        await this.retryCancellation(row.dispatchId);
      } else {
        this.launchLocal(row, remote);
      }
    }
  }

  private launchLocal(
    row: ExecutionPlacementInboxRow,
    remote: DispatchSummary,
  ): Promise<void> | undefined {
    if (this.executing.has(row.dispatchId) || this.stopped) return;
    this.executing.add(row.dispatchId);
    const epoch = this.lifecycleEpoch;
    const task = this.resumeLocal(row, remote, epoch);
    this.executionTasks.set(row.dispatchId, task);
    const clear = () => {
      if (this.executionTasks.get(row.dispatchId) === task) {
        this.executionTasks.delete(row.dispatchId);
        this.executing.delete(row.dispatchId);
      }
      void this.heartbeat();
    };
    void task.then(clear, clear);
    return task;
  }

  private async resumeLocal(
    row: ExecutionPlacementInboxRow,
    remote: DispatchSummary,
    epoch: number,
  ) {
    try {
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        return;
      }
      if (remote.state === "cancel_pending") {
        await this.cancelAccepted(row);
        return;
      }
      if (row.state === "claimed") {
        const tokenHash = sha256(row.claimToken);
        remote = parseDispatch(
          await this.enqueueSigned(
            "claim-ack",
            [row.dispatchId, tokenHash, row.payloadHash],
            anyApi.execution_placement.ackMyExecutionClaim,
            {
              dispatchId: row.dispatchId,
              claimToken: row.claimToken,
              payloadHash: row.payloadHash,
            },
          ),
        );
        this.inbox.markAccepted(
          row.dispatchId,
          remote,
          (this.options.now ?? Date.now)(),
        );
        this.claimAckRetry.delete(row.dispatchId);
        row = this.inbox.get(row.dispatchId)!;
        if (!this.isLiveEpoch(epoch)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
            errorMessage:
              "The desktop execution bridge stopped after claim acceptance.",
            now: (this.options.now ?? Date.now)(),
          });
          await this.retryCancellation(row.dispatchId, {
            allowStopped: true,
          });
          return;
        }
        if (row.cancelRpcPending) {
          await this.retryCancellation(row.dispatchId);
          return;
        }
      }
      if (row.state === "terminal_pending") {
        await this.flushTerminal(row);
        return;
      }
      this.inbox.markRunning(row.dispatchId, (this.options.now ?? Date.now)());
      await this.markRunning(row);
      row = this.inbox.get(row.dispatchId)!;
      if (!this.isLiveEpoch(epoch)) {
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "canceled",
          errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
          errorMessage:
            "The desktop execution bridge stopped before local launch.",
          now: (this.options.now ?? Date.now)(),
        });
        await this.retryCancellation(row.dispatchId, { allowStopped: true });
        return;
      }
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = parseRecord(JSON.parse(row.payloadJson));
      } catch {
        this.inbox.markTerminalPending(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_PAYLOAD_INVALID",
          errorMessage: "The durably accepted local payload was invalid.",
          now: (this.options.now ?? Date.now)(),
        });
        await this.flushTerminal(this.inbox.get(row.dispatchId)!);
        return;
      }
      const result = await this.options.runExecution({
        dispatch: remote,
        payload,
        ownerGeneration: row.ownerGeneration,
      });
      const cancellation = this.inbox.get(row.dispatchId);
      if (
        cancellation?.cancelRpcPending ||
        cancellation?.state === "terminal" ||
        (cancellation?.state === "terminal_pending" &&
          cancellation.terminalOutcome === "canceled")
      ) {
        if (cancellation.state === "terminal_pending") {
          await this.flushTerminal(cancellation).catch(() => undefined);
        }
        return;
      }
      const canceled = result.status === "canceled";
      const failed = result.status === "error";
      const resultJson =
        result.status === "ok"
          ? boundedResult(
              JSON.stringify({
                finalText: boundedResult(result.finalText),
              }),
            )
          : undefined;
      this.inbox.markTerminalPending(row.dispatchId, {
        outcome: canceled ? "canceled" : failed ? "failed" : "completed",
        ...(resultJson ? { resultJson } : {}),
        ...(failed ? { errorCode: "LOCAL_EXECUTION_FAILED" } : {}),
        ...((failed || canceled) && (result.error || result.finalText)
          ? { errorMessage: boundedResult(result.error || result.finalText) }
          : {}),
        now: (this.options.now ?? Date.now)(),
      });
      await this.flushTerminal(this.inbox.get(row.dispatchId)!);
    } catch (error) {
      const current = this.inbox.get(row.dispatchId);
      if (
        current?.state === "claimed" &&
        !current.cancelRpcPending &&
        this.isLiveEpoch(epoch)
      ) {
        this.noteClaimAckFailure(row.dispatchId);
        this.log(
          "warn",
          "Execution placement claim acknowledgement was deferred.",
          error,
        );
        return;
      }
      this.log("error", "Accepted local execution failed.", error);
      if (
        current &&
        !current.cancelRpcPending &&
        current.state !== "terminal_pending" &&
        current.state !== "terminal"
      ) {
        // A thrown execution call may be an ambiguous worker-transport result:
        // the effect can still exist even though the caller lost its response.
        // Cancel/reconcile that exact owner before signing a failed receipt.
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_EXECUTION_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Local execution failed.",
          now: (this.options.now ?? Date.now)(),
        });
        await this.retryCancellation(row.dispatchId);
      }
    }
  }

  private async markRunning(row: ExecutionPlacementInboxRow) {
    const tokenHash = sha256(row.claimToken);
    await this.enqueueSigned(
      "running",
      [row.dispatchId, tokenHash],
      anyApi.execution_placement.markMyExecutionRunning,
      { dispatchId: row.dispatchId, claimToken: row.claimToken },
    );
  }

  private async renew(row: ExecutionPlacementInboxRow) {
    const tokenHash = sha256(row.claimToken);
    await this.enqueueSigned(
      "renew",
      [row.dispatchId, tokenHash],
      anyApi.execution_placement.renewMyExecutionClaim,
      { dispatchId: row.dispatchId, claimToken: row.claimToken },
    );
  }

  private async cancelAccepted(row: ExecutionPlacementInboxRow) {
    if (row.state === "terminal" || row.state === "orphaned") return;
    this.inbox.stageCancellation(row.dispatchId, {
      outcome: "canceled",
      errorMessage: "Canceled by the user.",
      now: (this.options.now ?? Date.now)(),
    });
    await this.retryCancellation(row.dispatchId);
  }

  private async flushTerminal(
    row: ExecutionPlacementInboxRow,
    control: { allowStopped?: boolean } = {},
  ) {
    const current = this.inbox.get(row.dispatchId);
    if (
      !current ||
      current.cancelRpcPending ||
      current.state !== "terminal_pending" ||
      !current.terminalOutcome
    ) {
      return;
    }
    row = current;
    const tokenHash = sha256(row.claimToken);
    const resultHash = row.resultJson ? sha256(row.resultJson) : "";
    const dispatch = parseDispatch(
      await this.enqueueSigned(
        "complete",
        [
          row.dispatchId,
          tokenHash,
          row.terminalOutcome,
          resultHash,
          row.errorCode ?? "",
          row.errorMessage ?? "",
        ],
        anyApi.execution_placement.completeMyExecutionDispatch,
        {
          dispatchId: row.dispatchId,
          claimToken: row.claimToken,
          outcome: row.terminalOutcome,
          ...(row.resultJson ? { resultJson: row.resultJson } : {}),
          ...(row.errorCode ? { errorCode: row.errorCode } : {}),
          ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
        },
        control,
      ),
    );
    this.inbox.markTerminal(
      row.dispatchId,
      dispatch,
      (this.options.now ?? Date.now)(),
    );
  }
}

export const createExecutionPlacementBridge = (
  options: PlacementBridgeOptions,
) => new ExecutionPlacementBridge(options);
