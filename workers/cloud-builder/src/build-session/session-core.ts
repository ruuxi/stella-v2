/**
 * `BuildSession`'s core: the turn registry, the identity assertions every
 * other cluster calls before it writes, event/outbox emission, transient-write
 * settlement, and the owner-plane RPC (gate, fence, turn state, Convex).
 *
 * Extracted verbatim from `src/index.ts`; every method takes the host surface
 * instead of `this` and is delegated to from the class. See
 * `src/build-session/host.ts` for why the host is a structural type.
 */
import { createAgentControlPlane } from "../agent-control-plane.js";
import { retireTransientAppBuild } from "../app-build-artifacts.js";
import { mintTurnCapability } from "../capability-signer.js";
import { EXACT_TURN_CANCELLATIONS_KEY } from "../execution-placement-turn-cancellation.js";
import {
  nativeStateCheckpointPrefix,
  parseNativeStateCheckpointRecord,
} from "../native-state-checkpoint.js";
import { enqueueOutbox } from "../outbox.js";
import { HEADER_OWNER_FENCE_ID } from "../owner-fence-do.js";
import { isSandboxDestroyDebtKey } from "../sandbox-lifecycle.js";
import {
  appendThreadMessages,
  nextTurnEventSeq,
  readThreadHistory,
  reserveTurnEventSeq,
  type ThreadMessageInput,
} from "../thread-transcript.js";
import { checkpointKey } from "../workspace.js";
import type { BuildSessionInternals } from "./host.js";
import type { Env } from "./shared/env.js";
import {
  BACKUP_ID_PATTERN,
  OUTBOX_DEBT_KEY,
  OUTBOX_DEBT_MAX,
  OUTBOX_DEBT_RETRY_MS,
  R2_SWEEP_MAX_PAGES,
  TERMINAL_EVENT_STATUS,
  agentExecutionMarkerKey,
  buildOwnerFenceLeaseReceiptKey,
  builderFallbackTranscriptKey,
  errorMessage,
  exactTurnIdentityMatches,
  isBuildOwnerFenceDurabilityKey,
  log,
  nativeBackupDebtKey,
  nativeTransientBackupKey,
  sweepR2Prefix,
} from "./shared/keys.js";
import {
  AgentTurnAuthorityLostError,
  AppTurnAuthorityLostError,
  OwnerPurgeFenceError,
  TurnStateOwnerCallError,
} from "./shared/errors.js";
import type {
  AgentExecutionMarker,
  BuildOwnerFenceLeaseReceipt,
  BuilderFallbackTranscript,
  NativeTransientBackup,
  PendingTerminal,
  TurnRequest,
  WorkspaceBackupDebt,
} from "./shared/types.js";
import type { CloudAgentDispatchDependencies } from "../cloud-agent-dispatch.js";
import type { TurnExecutionContext } from "../turn-cancellation.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { CONTROL_PLANE_CAPABILITY_AUDIENCE } from "@stella/contracts/gateway/capability";
import {
  OUTBOX_EVENT_VERSION,
  type OutboxEvent,
  type TurnEventEvent,
} from "@stella/contracts/turn-plane/outbox";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";

export type SessionCoreHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "runningTurns"
  | "controlPlaneCapabilities"
  | "armOwnerFenceLeaseReconciliationAlarm"
  | "assertAgentTurnIdentity"
  | "assertTurnWritable"
  | "appendThreadTranscript"
  | "callOwnerFence"
  | "cleanupTransientWrites"
  | "controlPlaneCapability"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverTerminal"
  | "emitTurnEvent"
  | "enqueueOutboxDurable"
  | "fetchCanonicalAgentHistory"
  | "hasOwnerFenceLeaseRetirementDebt"
  | "mutateExactTurn"
  | "outboxBase"
  | "ownerFenceLeaseSlotKey"
  | "ownerFenceReceiptMatches"
  | "ownerGateFor"
  | "ownsExactTurn"
  | "registerBuildOwnerFenceLease"
  | "registerTurn"
  | "retireBuildOwnerFenceLease"
  | "scheduleDurabilityAlarm"
  | "scheduleSandboxDestroyDebtAlarm"
  | "settleAgentTransientBackup"
  | "settleTerminalTransientWrites"
  | "unregisterTurn"
  | "unregisterTurnLease"
>;

/**
 * The app-build lane has no model call and therefore no execution selection
 * — but a turn capability's binding is not optional. This placeholder is what
 * the lane's control-plane capability carries. It is never minted for the
 * model-gateway audience, so it can never pin a model call.
 */
const APP_BUILD_CONTROL_PLANE_EXECUTION = {
  engine: "stella",
  provider: "stella",
  model: "app-build",
  reasoningEffort: "default",
} as CloudExecutionSelection;

/** @see src/build-session/shared/keys.ts */
export { mintAgentTurnModelGateway } from "./shared/keys.js";

/**
 * Normal turn cleanup must retain exact cancellation receipts. The key list
 * is captured while input is gated and the deletion is one transaction, so
 * a crash or concurrent Stop cannot open a tombstone-loss window. Sandbox
 * destroy debt is retained too: terminal delivery is never authority to
 * forget a container whose teardown has not been confirmed.
 */
export const deleteTurnStoragePreservingExactCancellations = async (
  host: SessionCoreHost,
  expectedTurn?: TurnRequest,
  deleteAlarm = false,
): Promise<boolean> => {
  const deleted = await host.ctx.blockConcurrencyWhile(async () => {
    if (
      expectedTurn &&
      !exactTurnIdentityMatches(
        await host.ctx.storage.get<TurnRequest>("turn"),
        expectedTurn,
      )
    ) {
      return false;
    }
    const listed = [...(await host.ctx.storage.list<unknown>()).keys()];
    const hasDestroyDebt = listed.some(isSandboxDestroyDebtKey);
    const hasOwnerFenceDebt = listed.some(isBuildOwnerFenceDurabilityKey);
    // Projections a queue outage deferred outlive the turn that produced
    // them: Convex has no other way to learn a terminal state, and the
    // alarm that retries them must survive with the debt.
    const hasOutboxDebt = listed.includes(OUTBOX_DEBT_KEY);
    const keys = listed.filter(
      (key) =>
        key !== EXACT_TURN_CANCELLATIONS_KEY &&
        key !== OUTBOX_DEBT_KEY &&
        !isSandboxDestroyDebtKey(key) &&
        !isBuildOwnerFenceDurabilityKey(key),
    );
    let deleted = false;
    await host.ctx.storage.transaction(async (txn) => {
      if (
        expectedTurn &&
        !exactTurnIdentityMatches(
          await txn.get<TurnRequest>("turn"),
          expectedTurn,
        )
      ) {
        return;
      }
      if (keys.length > 0) await txn.delete(keys);
      if (
        deleteAlarm &&
        !hasDestroyDebt &&
        !hasOwnerFenceDebt &&
        !hasOutboxDebt
      ) {
        await txn.deleteAlarm();
      }
      deleted = true;
    });
    return deleted;
  });
  if (deleted) await host.scheduleDurabilityAlarm();
  return deleted;
};

export const ownerGateFor = (host: SessionCoreHost, ownerId: string) => {
  return host.env.OWNER_GATES.getByName(ownerId);
};

/** Shared dispatch dependencies used when this agent spawns a child. */
export const childAgentDispatchDependencies = (
  host: SessionCoreHost,
): CloudAgentDispatchDependencies => {
  return {
    env: host.env,
    ownerGateAdmit: async (input) =>
      await host.ownerGateFor(input.ownerId).admit({
        lane: "agent",
        turnId: input.turnId,
        conversationId: input.conversationId,
        expectedGeneration: input.expectedGeneration,
      }),
    releaseOwnerGate: async (input) => {
      await host.ownerGateFor(input.ownerId).release({
        turnId: input.turnId,
      });
    },
    enqueueOutbox: async (events) =>
      await host.enqueueOutboxDurable([...events]),
  };
};

/**
 * Give this turn's slot back to the owner gate. Idempotent by construction
 * (the gate deletes a row it may not have), and never fatal: a release that
 * cannot be delivered is bounded by the gate's own running-row expiry, so
 * failing the turn over it would trade a recoverable lag for a lost result.
 */
export const releaseOwnerGate = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  if (turn.kind !== "agent" || !turn.ownerId) return;
  try {
    await host.ownerGateFor(turn.ownerId).release({ turnId: turn.turnId });
  } catch (error) {
    log("error", "owner_gate_release_failed", {
      turnId: turn.turnId,
      message: errorMessage(error),
    });
  }
};

/**
 * The control-plane capability for this exact attempt.
 *
 * Minted here rather than stored: a bearer token that outlives the isolate
 * would have to be written to durable storage and rotated there, and the
 * signature costs less than the storage round trip would. Cached per
 * isolate until a minute before expiry so a long turn re-signs at most a
 * handful of times.
 *
 * It is the model-gateway capability's twin — same owner, generation, turn
 * binding, audience and budget — and differs only in `aud`, which is why it
 * must never leave this Durable Object.
 */
export const controlPlaneCapability = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<string> => {
  const attemptGeneration = turn.attemptGeneration ?? 1;
  const key = `${turn.turnId}:${attemptGeneration}`;
  const now = Date.now();
  const cached = host.controlPlaneCapabilities.get(key);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const conversationId = turn.conversationId?.trim() ?? "";
  if (!conversationId) {
    throw turn.kind === "agent"
      ? new AgentTurnAuthorityLostError()
      : new AppTurnAuthorityLostError();
  }
  const minted = await mintTurnCapability(host.env, {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    conversationId,
    execution:
      turn.execution ??
      (turn.kind === "agent" ? undefined : APP_BUILD_CONTROL_PLANE_EXECUTION)!,
    audience: turn.audience,
    budgetMicroCents: turn.budgetMicroCents,
    agentTypes: ["general"],
    aud: CONTROL_PLANE_CAPABILITY_AUDIENCE,
  });
  host.controlPlaneCapabilities.set(key, {
    token: minted.token,
    expiresAt: minted.expiresAt,
  });
  return minted.token;
};

/**
 * The remaining synchronous Convex reads a turn still needs — the ones that
 * answer a question only the control plane can answer (web search, drive,
 * the app-build art director). Authority is this turn's control-plane
 * capability; the worker's shared secret is no longer sent from a turn path,
 * so a compromised turn cannot act as the worker.
 */
export const convexCall = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  path: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> => {
  const base = (host.env.STELLA_CONVEX_SITE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) throw new Error("Convex site URL is not configured.");
  const capability = await host.controlPlaneCapability(turn);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  return await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capability}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  });
};

/**
 * The resident loop's control plane, wired to this object's own transcript
 * table and outbox. The capability is resolved lazily so a long turn does
 * not hold an expiring token captured at construction.
 */
export const agentControlPlane = (
  host: SessionCoreHost,
  turn: TurnRequest,
  attemptGeneration: number,
  sessionId: string,
): ReturnType<typeof createAgentControlPlane> => {
  return createAgentControlPlane({
    convexSiteUrl: host.env.STELLA_CONVEX_SITE_URL,
    capability: () => host.controlPlaneCapability(turn),
    identity: {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      threadId: turn.threadId!,
      turnId: turn.turnId,
      attemptGeneration,
      sessionId,
    },
    storage: host.ctx.storage,
    transport: {
      readHistory: (options) =>
        host.fetchCanonicalAgentHistory(turn, {
          excludeCurrentTurn: options.excludeCurrentTurn,
        }),
      appendMessages: (messages) => host.appendThreadTranscript(turn, messages),
      emitEvent: async (args) => {
        await host.emitTurnEvent(turn, args.kind, args.payload, {
          terminal: args.terminal,
          ...(args.seq === "auto" ? {} : { eventSeq: args.seq }),
          ...(args.signal ? { signal: args.signal } : {}),
        });
      },
    },
  });
};

export const outboxBase = (
  host: SessionCoreHost,
  turn: TurnRequest,
  key: string,
) => {
  return {
    v: OUTBOX_EVENT_VERSION,
    key,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    emittedAt: Date.now(),
  } as const;
};

/**
 * Append to the outbox, or remember the debt and let the alarm retry it.
 * A queue outage must not lose a projection Convex has no other way to
 * learn: the UI's thread rows, the turn's terminal state, a recorded build.
 */
export const enqueueOutboxDurable = async (
  host: SessionCoreHost,
  events: OutboxEvent[],
): Promise<void> => {
  if (events.length === 0) return;
  try {
    await enqueueOutbox(host.env, events);
    return;
  } catch (error) {
    log("error", "outbox_enqueue_deferred", {
      events: events.map((event) => `${event.kind}:${event.key}`),
      message: errorMessage(error),
    });
  }
  await host.ctx.blockConcurrencyWhile(async () => {
    const debt =
      (await host.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY)) ?? [];
    await host.ctx.storage.put(
      OUTBOX_DEBT_KEY,
      [...debt, ...events].slice(-OUTBOX_DEBT_MAX),
    );
    const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
    const current = await host.ctx.storage.getAlarm();
    if (current === null || current > retryAt) {
      await host.ctx.storage.setAlarm(retryAt);
    }
  });
};

export const retryOutboxDebt = async (host: SessionCoreHost): Promise<void> => {
  const debt = await host.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY);
  if (!debt || debt.length === 0) return;
  try {
    await enqueueOutbox(host.env, debt);
    await host.ctx.storage.delete(OUTBOX_DEBT_KEY);
  } catch (error) {
    log("error", "outbox_debt_retry_failed", {
      events: debt.length,
      message: errorMessage(error),
    });
    const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
    const current = await host.ctx.storage.getAlarm();
    if (current === null || current > retryAt) {
      await host.ctx.storage.setAlarm(retryAt);
    }
  }
};

/**
 * One `turn.event`. The ordinal is assigned here — Convex used to do it —
 * and persisted in this object's SQLite, so a restarted isolate continues
 * the sequence instead of colliding with events already projected. Callers
 * that own an idempotent retry pass their own `eventSeq` back in.
 */
export const emitTurnEvent = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  eventKind: string,
  payload: unknown,
  options: {
    terminal?: boolean;
    eventSeq?: number;
    errorMessage?: string;
    resultJson?: string;
    signal?: AbortSignal;
  } = {},
): Promise<number> => {
  options.signal?.throwIfAborted();
  await host.assertTurnWritable(turn);
  options.signal?.throwIfAborted();
  const attemptGeneration = turn.attemptGeneration ?? 1;
  let eventSeq: number;
  if (options.eventSeq === undefined) {
    eventSeq = nextTurnEventSeq(
      host.ctx.storage.sql,
      turn.turnId,
      attemptGeneration,
    );
  } else {
    eventSeq = options.eventSeq;
    reserveTurnEventSeq(
      host.ctx.storage.sql,
      turn.turnId,
      attemptGeneration,
      eventSeq,
    );
  }
  const terminal = options.terminal === true;
  const event: TurnEventEvent = {
    ...host.outboxBase(turn, `${turn.turnId}:${attemptGeneration}:${eventSeq}`),
    kind: "turn.event",
    turnId: turn.turnId,
    ...(turn.kind === "agent" ? { attemptGeneration } : {}),
    sessionId: turn.threadId ?? turn.sessionId ?? host.ctx.id.toString(),
    eventSeq,
    eventKind,
    payload,
    terminal,
    ...(terminal
      ? { terminalStatus: TERMINAL_EVENT_STATUS[eventKind] ?? "failed" }
      : {}),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    ...(options.resultJson ? { resultJson: options.resultJson } : {}),
    createdAt: Date.now(),
  };
  await host.enqueueOutboxDurable([event]);
  return eventSeq;
};

/**
 * Commit transcript rows to this thread's own table. A continuation reads
 * them back from SQLite, and re-appending the same ordinals is a no-op.
 */
export const appendThreadTranscript = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  messages: readonly ThreadMessageInput[],
): Promise<void> => {
  if (turn.kind !== "agent" || !turn.threadId) {
    throw new AgentTurnAuthorityLostError();
  }
  const attemptGeneration = turn.attemptGeneration ?? 1;
  appendThreadMessages(host.ctx.storage.sql, {
    turnId: turn.turnId,
    attemptGeneration,
    messages,
    now: Date.now(),
  });
};

export const trackTurn = <T>(
  host: SessionCoreHost,
  turnId: string,
  work: Promise<T>,
): Promise<T> => {
  const active = host.runningTurns.get(turnId) ?? new Set<Promise<unknown>>();
  const tracked = work.finally(() => {
    active.delete(tracked);
    if (active.size === 0) {
      host.runningTurns.delete(turnId);
    }
  });
  active.add(tracked);
  host.runningTurns.set(turnId, active);
  return tracked;
};

const ownerFence = (host: SessionCoreHost, ownerId: string) => {
  return host.env.OWNER_GATES.getByName(ownerId);
};

export const callOwnerFence = async (
  host: SessionCoreHost,
  ownerId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  return ownerFence(host, ownerId).fetch(
    `https://owner-gate/owner-fence/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER_FENCE_ID]: ownerId,
      },
      body: JSON.stringify({ ...body, ownerId }),
    },
  );
};

const ownerTurnStateEnvelope = (
  host: SessionCoreHost,
  turn: TurnRequest,
): {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  generation: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
} => {
  if (
    !turn.ownerPurgeGeneration ||
    !turn.ownerPurgeLeaseId ||
    !turn.ownerGeneration
  ) {
    throw new OwnerPurgeFenceError();
  }
  return {
    schemaVersion: 1,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    generation: turn.ownerPurgeGeneration,
    leaseId: turn.ownerPurgeLeaseId,
    sessionId: host.ctx.id.toString(),
    turnId: turn.turnId,
  };
};

export const callOwnerTurnState = async <T>(
  host: SessionCoreHost,
  turn: TurnRequest,
  path:
    | "prepare"
    | "mark-uploaded"
    | "commit"
    | "publish-workspace"
    | "abort-unpublished"
    | "resolve"
    | "confirm-restore"
    | "drain",
  body: Record<string, unknown>,
): Promise<T> => {
  const response = await host.callOwnerFence(
    turn.ownerId,
    `turn-state/${path}`,
    { ...body, ...ownerTurnStateEnvelope(host, turn) },
  );
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) {
    throw new Error("Turn state owner response exceeded its bound.");
  }
  if (!response.ok) throw new TurnStateOwnerCallError(response.status);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error("Turn state owner response was invalid.", {
      cause: error,
    });
  }
};

export const registerTurn = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  freshLease = false,
): Promise<string> => {
  const kind = freshLease ? "aux" : "run";
  const slotKey = await host.ownerFenceLeaseSlotKey(turn, kind);
  const grant = await host.registerBuildOwnerFenceLease({
    turn,
    kind,
    slotKey,
    role: kind,
    mutateTurn: true,
  });
  return grant.generation;
};

export const unregisterTurn = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  if (!turn.ownerPurgeLeaseId) return;
  const hasTransientWrites =
    Boolean(
      await host.ctx.storage.get<string>(`transientBuild:${turn.turnId}`),
    ) ||
    Boolean(
      await host.ctx.storage.get<NativeTransientBackup>(
        nativeTransientBackupKey(turn.turnId),
      ),
    ) ||
    (turn.kind === "agent" &&
      (Boolean(
        await host.ctx.storage.get<AgentExecutionMarker>(
          agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
        ),
      ) ||
        Boolean(
          await host.ctx.storage.get<BuilderFallbackTranscript>(
            builderFallbackTranscriptKey(turn.turnId, turn.attemptGeneration!),
          ),
        )));
  if (hasTransientWrites) {
    try {
      // A callback whose response was lost may already have committed the
      // row that names a build. Preserve it during ordinary operation. Once
      // purge changes the generation, the turn's lease stays active until
      // these otherwise-unnameable bytes are verifiably gone.
      await host.assertTurnWritable(turn);
      return;
    } catch (error) {
      if (!(error instanceof OwnerPurgeFenceError)) return;
      try {
        await host.cleanupTransientWrites(turn);
      } catch (cleanupError) {
        log("error", "owner_purge_transient_cleanup_failed", {
          turnId: turn.turnId,
          message: errorMessage(cleanupError),
        });
        return;
      }
    }
  }
  await host.unregisterTurnLease(
    turn,
    turn.ownerPurgeLeaseId,
    turn.ownerPurgeGeneration,
  );
};

export const unregisterTurnLease = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  leaseId: string,
  generation?: string,
): Promise<boolean> => {
  const key = buildOwnerFenceLeaseReceiptKey(leaseId);
  let receipt = await host.ctx.storage.get<BuildOwnerFenceLeaseReceipt>(key);
  if (receipt && !host.ownerFenceReceiptMatches(receipt, turn, leaseId)) {
    throw new OwnerPurgeFenceError();
  }
  if (!receipt) {
    const now = Date.now();
    receipt = {
      schemaVersion: 1,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      leaseId,
      kind: "run",
      phase: "unregister_pending",
      ...(generation ? { registrationGeneration: generation } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await host.ctx.storage.put(key, receipt);
  }
  return await host.retireBuildOwnerFenceLease(receipt, generation);
};

const appendNativeBackupDebt = async (
  host: SessionCoreHost,
  workspaceKey: string,
  backupId: string,
): Promise<void> => {
  if (!BACKUP_ID_PATTERN.test(backupId)) {
    throw new Error("Invalid transient native backup id.");
  }
  const debtKey = nativeBackupDebtKey(workspaceKey);
  const existing = (await host.env.APP_ROUTES.get<WorkspaceBackupDebt>(
    debtKey,
    "json",
  )) ?? { backupIds: [] };
  const backupIds = [...new Set([...existing.backupIds, backupId])];
  if (backupIds.length > 100) {
    throw new Error("Native backup cleanup debt is too large.");
  }
  await host.env.APP_ROUTES.put(
    debtKey,
    JSON.stringify({ backupIds } satisfies WorkspaceBackupDebt),
  );
};

export const sweepNativeBackupDebt = async (
  host: SessionCoreHost,
  workspaceKey: string,
): Promise<void> => {
  const debtKey = nativeBackupDebtKey(workspaceKey);
  const debt = await host.env.APP_ROUTES.get<WorkspaceBackupDebt>(
    debtKey,
    "json",
  );
  if (!debt?.backupIds.length) return;
  const referenced = new Set<string>();
  let cursor: string | undefined;
  let listingComplete = false;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await host.env.APP_ROUTES.list({
      prefix: nativeStateCheckpointPrefix(workspaceKey),
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listing.keys) {
      const raw = await host.env.APP_ROUTES.get<unknown>(entry.name, "json");
      const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
      if (!record) continue;
      for (const version of [
        ...(record.committed ? [record.committed] : []),
        ...record.candidates,
      ]) {
        referenced.add(version.descriptor.id);
      }
    }
    if (listing.list_complete) {
      listingComplete = true;
      break;
    }
    cursor = listing.cursor;
    if (!cursor) break;
  }
  if (!listingComplete) {
    throw new Error("Native checkpoint reference listing was truncated.");
  }

  const remaining: string[] = [];
  for (const backupId of debt.backupIds) {
    if (!BACKUP_ID_PATTERN.test(backupId) || referenced.has(backupId)) {
      remaining.push(backupId);
      continue;
    }
    try {
      const swept = await sweepR2Prefix(
        host.env.BACKUP_BUCKET,
        `backups/${backupId}/`,
      );
      if (!swept.done) remaining.push(backupId);
    } catch {
      remaining.push(backupId);
    }
  }
  if (remaining.length > 0) {
    await host.env.APP_ROUTES.put(
      debtKey,
      JSON.stringify({ backupIds: remaining } satisfies WorkspaceBackupDebt),
    );
  } else {
    await host.env.APP_ROUTES.delete(debtKey);
  }
};

const settleNativeTransientBackup = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<boolean> => {
  const markerKey = nativeTransientBackupKey(turn.turnId);
  const marker = await host.ctx.storage.get<NativeTransientBackup>(markerKey);
  if (!marker) return true;
  if (
    !BACKUP_ID_PATTERN.test(marker.backupId) ||
    !marker.checkpointKey.startsWith(
      nativeStateCheckpointPrefix(marker.workspaceKey),
    )
  ) {
    log("error", "native_transient_backup_marker_invalid", {
      turnId: turn.turnId,
    });
    return false;
  }
  const raw = await host.env.APP_ROUTES.get<unknown>(
    marker.checkpointKey,
    "json",
  );
  const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
  const referenced = record
    ? [
        ...(record.committed ? [record.committed] : []),
        ...record.candidates,
      ].some((version) => version.descriptor.id === marker.backupId)
    : false;
  try {
    if (!referenced) {
      await appendNativeBackupDebt(host, marker.workspaceKey, marker.backupId);
    }
    await host.ctx.storage.delete(markerKey);
    return true;
  } catch (error) {
    log("error", "native_transient_backup_settlement_failed", {
      turnId: turn.turnId,
      message: errorMessage(error),
    });
    return false;
  }
};

export const settleAgentTransientBackup = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<boolean> => {
  return await settleNativeTransientBackup(host, turn);
};

export const cleanupTransientWrites = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  const buildKey = `transientBuild:${turn.turnId}`;
  const nativeMarker = await host.ctx.storage.get<NativeTransientBackup>(
    nativeTransientBackupKey(turn.turnId),
  );
  const buildPrefix = await host.ctx.storage.get<string>(buildKey);
  if (nativeMarker) {
    if (!BACKUP_ID_PATTERN.test(nativeMarker.backupId)) {
      throw new Error("Transient native backup descriptor is invalid.");
    }
    const swept = await sweepR2Prefix(
      host.env.BACKUP_BUCKET,
      `backups/${nativeMarker.backupId}/`,
    );
    if (!swept.done) {
      throw new Error("Transient native backup cleanup was truncated.");
    }
    await host.ctx.storage.delete(nativeTransientBackupKey(turn.turnId));
  }
  if (buildPrefix) {
    const retired = await retireTransientAppBuild({
      sweep: async () =>
        await sweepR2Prefix(host.env.APP_BUILDS, `${buildPrefix}/`),
      clearRecovery: async () => {
        await host.ctx.storage.delete(buildKey);
      },
    });
    if (!retired) throw new Error("Transient build cleanup was truncated.");
  }
};

/** Shared by alarm and live-unwind owner-fence loss paths. */
export const cleanupOwnerPurgedTurnStorage = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<boolean> => {
  await host.cleanupTransientWrites(turn);
  if (!(await host.ownsExactTurn(turn))) return false;
  return await host.deleteTurnStoragePreservingExactCancellations(turn, true);
};

export const settleTerminalTransientWrites = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<boolean> => {
  if (turn.kind === "agent") {
    return await host.settleAgentTransientBackup(turn);
  }
  try {
    await host.cleanupTransientWrites(turn);
    return true;
  } catch (error) {
    log("error", "terminal_transient_cleanup_failed", {
      turnId: turn.turnId,
      message: errorMessage(error),
    });
    return false;
  }
};

/**
 * Durable app-turn state is the only name for transient backup/build bytes.
 * Never erase it until every named prefix is empty; an alarm retains the
 * owner lease and retries cleanup after a partial R2 failure.
 */
export const retireTerminalAppTurnStorage = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  if (!(await host.ownsExactTurn(turn))) return;
  if (await host.settleTerminalTransientWrites(turn)) {
    await host.deleteTurnStoragePreservingExactCancellations(turn, true);
    return;
  }
  if (await host.ownsExactTurn(turn)) {
    await host.ctx.storage.setAlarm(Date.now() + 30_000);
  }
};

export const redeliverOrphan = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  pending: PendingTerminal,
): Promise<void> => {
  try {
    turn.ownerPurgeGeneration = await host.registerTurn(turn, true);
    await host.assertTurnWritable(turn);
    await host.deliverTerminal(turn, pending);
  } catch (error) {
    if (!(error instanceof OwnerPurgeFenceError)) throw error;
  } finally {
    await host.unregisterTurn(turn);
  }
};

export const assertTurnWritable = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  if (
    !turn.ownerGeneration ||
    !turn.ownerPurgeGeneration ||
    !turn.ownerPurgeLeaseId
  ) {
    throw new OwnerPurgeFenceError();
  }
  const response = await host.callOwnerFence(turn.ownerId, "assert", {
    ownerGeneration: turn.ownerGeneration,
    generation: turn.ownerPurgeGeneration,
    leaseId: turn.ownerPurgeLeaseId,
  });
  if (!response.ok) throw new OwnerPurgeFenceError();
};

const assertAgentTurnActive = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  await host.assertTurnWritable(turn);
  if (
    !(await host.ownsExactTurn(turn)) ||
    (await host.ctx.storage.get<boolean>("terminal"))
  ) {
    throw new Error("The agent turn is no longer active.");
  }
};

/**
 * The turn's own identity, which is now the only authority there is.
 *
 * Convex used to be asked, on every side effect, whether this attempt was
 * still the live one (`/api/cloud/agent-turn-authority`, resolved against a
 * reusable turn token). That question is answered locally now: the owner
 * gate admitted the attempt, this object holds the attempt, and its
 * capability is signed and bound to it. What remains is the structural
 * check — a record that cannot name a thread and an attempt is not a turn.
 */
export const assertAgentTurnIdentity = (
  host: SessionCoreHost,
  turn: TurnRequest,
): void => {
  if (
    turn.kind !== "agent" ||
    !turn.threadId ||
    !turn.conversationId ||
    !Number.isSafeInteger(turn.attemptGeneration) ||
    turn.attemptGeneration! < 1
  ) {
    throw new AgentTurnAuthorityLostError();
  }
};

/** The app-build lane's equivalent of `assertAgentTurnIdentity`. */
export const assertAppTurnIdentity = (
  host: SessionCoreHost,
  turn: TurnRequest,
): void => {
  if (
    turn.kind === "agent" ||
    !turn.appId ||
    !turn.conversationId ||
    !turn.sessionId
  ) {
    throw new AppTurnAuthorityLostError();
  }
};

/**
 * This thread's transcript, from this object's own SQLite.
 *
 * It used to be a `GET /api/cloud/context` on the continuation's critical
 * path, which made Convex the authority for rows only this object ever
 * writes and put a control-plane round trip in front of every send_input.
 */
export const fetchCanonicalAgentHistory = (
  host: SessionCoreHost,
  turn: TurnRequest,
  options: { excludeCurrentTurn: boolean; signal?: AbortSignal },
): AgentHistoryRow[] => {
  options.signal?.throwIfAborted();
  if (!turn.threadId) return [];
  return readThreadHistory(host.ctx.storage.sql, {
    ...(options.excludeCurrentTurn ? { excludeTurnId: turn.turnId } : {}),
  });
};

export const assertAgentExecutionActive = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  execution: TurnExecutionContext,
): Promise<void> => {
  execution.assertActive();
  await assertAgentTurnActive(host, turn);
  host.assertAgentTurnIdentity(turn);
  // Stop can land while the durable owner/turn checks await remote storage.
  // Repeat the local fiber latch immediately before the caller's side effect.
  execution.assertActive();
};

const assertAppTurnActive = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<void> => {
  await host.assertTurnWritable(turn);
  if (
    !(await host.ownsExactTurn(turn)) ||
    (await host.ctx.storage.get<boolean>("terminal"))
  ) {
    throw new Error("The app-build turn is no longer active.");
  }
};

export const assertAppExecutionActive = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  execution: TurnExecutionContext,
): Promise<void> => {
  execution.assertActive();
  await assertAppTurnActive(host, turn);
  // Owner purge can land while the durable fence read is in flight.
  execution.assertActive();
};

/** Keep the one DO alarm at the earliest lease, teardown, or receipt debt. */
export const scheduleDurabilityAlarm = async (
  host: SessionCoreHost,
): Promise<void> => {
  await host.scheduleSandboxDestroyDebtAlarm();
  if (await host.hasOwnerFenceLeaseRetirementDebt()) {
    await host.armOwnerFenceLeaseReconciliationAlarm();
  }
  // Deferred projections are durability debt like any other: without a wake
  // a queue outage would strand a terminal state Convex never hears about.
  const outboxDebt = await host.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY);
  if (outboxDebt && outboxDebt.length > 0) {
    const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
    const current = await host.ctx.storage.getAlarm();
    if (current === null || current > retryAt) {
      await host.ctx.storage.setAlarm(retryAt);
    }
  }
};

// The detached agent-turn promise and the alarm share this DO's storage;
// a stale turn (superseded by a send_input continuation on the same
// thread) must never mutate the successor's state or complete its thread.
export const ownsExactTurn = async (
  host: SessionCoreHost,
  turn: TurnRequest,
): Promise<boolean> => {
  return exactTurnIdentityMatches(
    await host.ctx.storage.get<TurnRequest>("turn"),
    turn,
  );
};

export const mutateExactTurn = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  operation: (txn: DurableObjectTransaction) => Promise<void>,
): Promise<boolean> => {
  return await host.ctx.storage.transaction(async (txn) => {
    if (!exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)) {
      return false;
    }
    await operation(txn);
    return true;
  });
};

export const setExactTurnAlarm = async (
  host: SessionCoreHost,
  turn: TurnRequest,
  scheduledTime: number,
): Promise<boolean> => {
  return await host.mutateExactTurn(turn, async (txn) => {
    await txn.setAlarm(scheduledTime);
  });
};

/**
 * The positional shape every call site in this file already uses. `"auto"`
 * takes the next DO-assigned ordinal; an explicit number is an idempotent
 * retry of an ordinal this turn already reserved.
 */
export const event = (
  host: SessionCoreHost,
  turn: TurnRequest,
  seq: number | "auto",
  kind: string,
  payload: unknown,
  terminal = false,
  executionSignal?: AbortSignal,
): Promise<number> => {
  return host.emitTurnEvent(turn, kind, payload, {
    terminal,
    ...(seq === "auto" ? {} : { eventSeq: seq }),
    ...(executionSignal ? { signal: executionSignal } : {}),
  });
};
