import type {
  CloudJournalOutboxRecord,
  CloudTranscriptOutboxRecord,
  RuntimeStore,
} from "../storage/runtime-store.js";
import { forkDelayedCall } from "./cloud-effect-runtime.js";

export type CloudTranscriptBeginRequest = {
  conversationId: string;
  /** Immutable owner-data epoch captured before this local turn was prepared. */
  ownerGeneration: string;
  /** Stable per local turn. Replaying this id must return the same lease. */
  localTurnId: string;
  /** Stable id of the user message admitted by this turn. */
  clientMsgId: string;
  /** Serialized user `AgentMessage`. */
  userMessageJson: string;
  /** Local-only data used to reconstruct persisted output after a crash. */
  recovery?: {
    /**
     * A historical import has no provider process to reconstruct. Persist
     * its exact terminal records with the begin so crash recovery can
     * finish the admitted turn without inventing a canceled response.
     */
    kind: "precomputed-finish";
    records: CloudTranscriptFinishRecord[];
    phase: CloudTranscriptFinishRequest["phase"];
    notice?: string;
  };
  /** Abort the provider if a renewal proves this process lost the cloud lease. */
  onLeaseLost?: (reason: string) => void;
  /** Local cancellation stops waiting but keeps the durable begin for cleanup. */
  signal?: AbortSignal;
};

export type CloudTranscriptBeginAck = {
  turnId: string;
  leaseToken: string;
  /** Authoritative server deadline for this exact single-writer lease. */
  expiresAt: number;
  /** Canonical pre-prompt serialized `AgentMessage`s. */
  history: string[];
  contextStartSeq: number;
  contextEndSeq: number;
};

export type CloudTranscriptHistory = {
  history: string[];
  contextStartSeq: number;
  contextEndSeq: number;
};

/**
 * The same stable client message was already admitted by the cloud journal.
 * Callers must stop the replacement local run quietly: the canonical turn is
 * already running or terminal and will reconcile through the cloud feed.
 */
export class CloudTranscriptAlreadyAdmittedError extends Error {
  constructor() {
    super("The cloud conversation already admitted this message.");
    this.name = "CloudTranscriptAlreadyAdmittedError";
  }
}

export type CloudTranscriptFinishRecord = {
  ordinal: number;
  role: "assistant" | "toolResult";
  /** Serialized `AgentMessage`, exactly as persisted by the local runtime. */
  payloadJson: string;
};

export type CloudTranscriptFinishRequest = {
  conversationId: string;
  /** Must match the generation durably admitted by `begin`. */
  ownerGeneration: string;
  localTurnId: string;
  leaseToken: string;
  records: CloudTranscriptFinishRecord[];
  phase: "completed" | "failed" | "canceled" | "timeout";
  /** User-facing text only. Raw provider/runtime errors must never be sent. */
  notice?: string;
  /** Stable local prompt owner for a restart-safe sync-failure notice. */
  failureNotificationUserMessageId?: string;
  /**
   * The durable write is delivered after `finish` returns. Surface a
   * deterministic server rejection (for example, a full conversation) even
   * though the local provider has already completed.
   */
  onDeliveryFailure?: (message: string) => void;
};

export type CloudTranscriptFinishStatus =
  | { queued: true }
  | {
      queued: false;
      reason: "finish_record_limit_exceeded" | "finish_byte_limit_exceeded";
    };

export type CloudJournalAppendRecord = {
  kind: "message";
  role: "user" | "assistant" | "toolResult";
  payloadJson: string;
  hidden?: boolean;
};

export type CloudJournalAppendRequest = {
  conversationId: string;
  /** Optional only for callers that ask the writer to capture it at admission. */
  ownerGeneration?: string;
  /** Stable id for the complete atomic append batch. */
  appendId: string;
  records: CloudJournalAppendRecord[];
};

export type CloudTranscriptWriterOptions = {
  deviceId: string;
  store: RuntimeStore;
  /** The runtime's Convex JWT, or null while signed out. */
  getAuthToken: () => string | null;
  /** Builder origin from Convex, or null when realtime is not configured. */
  getBaseUrl: () => Promise<string | null>;
  /** Captures the current immutable owner epoch before a journal append is queued. */
  getOwnerGeneration?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Test override; production renews well inside the 30-minute DO lease. */
  heartbeatIntervalMs?: number;
  /** Test override for the maximum time the provider may run without an ACK. */
  authoritySilenceMs?: number;
  /** Test override for the stop-before-server-expiry safety margin. */
  authorityExpiryMarginMs?: number;
  /**
   * Persists a device-specific notice when a recovered finish is rejected
   * after the original run callback no longer exists.
   */
  onDurableDeliveryFailure?: (failure: {
    conversationId: string;
    localTurnId: string;
    userMessageId: string;
    message: string;
  }) => void;
  onLog?: (
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
};

export type CloudTranscriptWriter = {
  /** Reads the canonical bounded DO history without acquiring a turn lease. */
  history: (conversationId: string) => Promise<CloudTranscriptHistory>;
  /** Returns the last successfully refreshed canonical history window. */
  peekHistory: (conversationId: string) => CloudTranscriptHistory | null;
  /** Refreshes the cached canonical window without surfacing network errors. */
  refreshHistory: (conversationId: string) => Promise<void>;
  /**
   * Persists the admission request, then waits for the Durable Object to grant
   * the single-writer lease. A caller with a cached canonical window may start
   * speculatively, but must validate the ACK's `contextEndSeq` before keeping
   * the result.
   */
  begin: (
    request: CloudTranscriptBeginRequest,
  ) => Promise<CloudTranscriptBeginAck>;
  /**
   * Commits the terminal payload to SQLite before resolving. Delivery is
   * retried in the background, including after worker restart.
   */
  finish: (
    request: CloudTranscriptFinishRequest,
  ) => Promise<CloudTranscriptFinishStatus>;
  /**
   * Durably queues an ordered, idempotent append that does not own the text
   * turn lease. Delivery remains FIFO per conversation and retries while a
   * text turn or owner transfer holds the Durable Object.
   */
  append: (
    request: CloudJournalAppendRequest,
  ) => Promise<{ queued: true; replayed: boolean }>;
  pending: () => number;
  /** Retry immediately after startup, connectivity recovery, or auth refresh. */
  resume: () => void;
  /** Stops network attempts without deleting durable rows. */
  stop: () => void;
};

const FINISH_MAX_ROWS = 1024;
const FINISH_MAX_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 60_000;
const TURN_BUSY_RETRY_MS = 3_000;
const NO_AUTH_RETRY_MS = 4_000;
/** Remote cancel keeps its lease for a 45s desktop-ack grace window. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * Owner purge may start immediately after an ACK and retire this lease 45s
 * later. Stop locally after at most 30s of ACK silence, leaving a bounded
 * provider/tool unwind window before a replacement generation can run.
 */
const DEFAULT_AUTHORITY_SILENCE_MS = 30_000;
/** Stop comfortably before the ordinary server lease expiry as well. */
const DEFAULT_AUTHORITY_EXPIRY_MARGIN_MS = 10_000;

type BeginPayload = {
  deviceId: string;
  expectedOwnerGeneration: string;
  localTurnId: string;
  clientMsgId: string;
  userMessageJson: string;
};

type RenewPayload = {
  deviceId: string;
  expectedOwnerGeneration: string;
  localTurnId: string;
  leaseToken: string;
  renewOnly: true;
};

type FinishPayload = {
  deviceId: string;
  expectedOwnerGeneration: string;
  localTurnId: string;
  leaseToken: string;
  records: CloudTranscriptFinishRecord[];
  phase: CloudTranscriptFinishRequest["phase"];
  notice?: string;
};

type JournalAppendPayload = {
  deviceId: string;
  expectedOwnerGeneration: string;
  localTurnId: string;
  source: "voice";
  records: CloudJournalAppendRecord[];
};

type AttemptResult =
  | {
      kind: "ack";
      begin?: CloudTranscriptBeginAck;
      /** Conservative origin for authority granted by a begin/renew request. */
      authorityRequestStartedAt?: number;
    }
  | { kind: "dead_letter"; reason: string; userMessage?: string }
  | {
      kind: "terminal";
      reason:
        | "conversation_deleted"
        | "lease_mismatch"
        | "turn_expired"
        | "turn_finished"
        | "turn_canceled"
        | "owner_generation_stale"
        | "idempotency_conflict";
    }
  | { kind: "retry"; delayMs: number; reason: string };

type JournalAttemptResult =
  | { kind: "ack" }
  | { kind: "dead_letter"; reason: string }
  | { kind: "retry"; delayMs: number; reason: string };

type BeginWaiter = {
  resolve: (ack: CloudTranscriptBeginAck) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  onLeaseLost?: (reason: string) => void;
};

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const normalizeOwnerGeneration = (value: string): string => {
  const generation = value.trim();
  if (!generation || generation.length > 512 || /\s/.test(generation)) {
    throw new Error("Cloud transcript owner generation is invalid.");
  }
  return generation;
};

const outboxId = (
  kind: "begin" | "finish",
  deviceId: string,
  conversationId: string,
  localTurnId: string,
): string =>
  `cloud-transcript:${JSON.stringify([
    kind,
    deviceId,
    conversationId,
    localTurnId,
  ])}`;

const journalOutboxId = (
  deviceId: string,
  conversationId: string,
  appendId: string,
): string =>
  `cloud-journal:${JSON.stringify([deviceId, conversationId, appendId])}`;

const parseBeginAck = (value: unknown): CloudTranscriptBeginAck | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.turnId !== "string" ||
    !candidate.turnId ||
    typeof candidate.leaseToken !== "string" ||
    !candidate.leaseToken ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= Date.now() ||
    !Array.isArray(candidate.history) ||
    !candidate.history.every((entry) => typeof entry === "string") ||
    typeof candidate.contextStartSeq !== "number" ||
    !Number.isInteger(candidate.contextStartSeq) ||
    typeof candidate.contextEndSeq !== "number" ||
    !Number.isInteger(candidate.contextEndSeq)
  ) {
    return null;
  }
  return {
    turnId: candidate.turnId,
    leaseToken: candidate.leaseToken,
    expiresAt: candidate.expiresAt,
    history: candidate.history,
    contextStartSeq: candidate.contextStartSeq,
    contextEndSeq: candidate.contextEndSeq,
  };
};

const retryDelay = (attempts: number): number =>
  Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts, 7));

const failureNotificationUserMessageId = (
  entry: CloudTranscriptOutboxRecord,
): string | null => {
  if (!entry.recoveryJson) return null;
  try {
    const parsed = JSON.parse(entry.recoveryJson) as {
      failureNotificationUserMessageId?: unknown;
    };
    return typeof parsed.failureNotificationUserMessageId === "string" &&
      parsed.failureNotificationUserMessageId.trim()
      ? parsed.failureNotificationUserMessageId.trim()
      : null;
  } catch {
    return null;
  }
};

const parseDeadLetterResponse = async (
  response: Response,
): Promise<{ reason: string; userMessage?: string }> => {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
  } | null;
  const code =
    typeof body?.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.code)
      ? body.code
      : `http_${response.status}`;
  const message =
    typeof body?.message === "string" && body.message.trim()
      ? body.message.trim().slice(0, 500)
      : undefined;
  return {
    reason: code,
    ...(message ? { userMessage: message } : {}),
  };
};

export const createCloudTranscriptWriter = (
  options: CloudTranscriptWriterOptions,
): CloudTranscriptWriter => {
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.onLog ?? (() => {});
  const beginWaiters = new Map<string, BeginWaiter[]>();
  const finishFailureCallbacks = new Map<string, (message: string) => void>();
  const historyWindows = new Map<string, CloudTranscriptHistory>();
  const historyRefreshes = new Map<string, Promise<void>>();
  const historyCacheVersions = new Map<string, number>();
  /**
   * Acknowledged begins stay in SQLite until finish replaces them. Membership
   * here means this process still owns the provider run, so the background
   * drain must not mistake the durable marker for a restart orphan.
   */
  const activeBegins = new Map<
    string,
    {
      ack: CloudTranscriptBeginAck;
      entry: CloudTranscriptOutboxRecord;
      onLeaseLost?: (reason: string) => void;
      cancelAuthorityDeadline: () => void;
    }
  >();
  const heartbeatIntervalMs = Math.max(
    10,
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const authoritySilenceMs = Math.max(
    10,
    options.authoritySilenceMs ?? DEFAULT_AUTHORITY_SILENCE_MS,
  );
  const authorityExpiryMarginMs = Math.max(
    0,
    options.authorityExpiryMarginMs ?? DEFAULT_AUTHORITY_EXPIRY_MARGIN_MS,
  );
  /** Cancel thunks for the pending delay fibers (the old `clearTimeout`s). */
  let cancelRetryDelay: (() => void) | null = null;
  let cancelJournalRetryDelay: (() => void) | null = null;
  let cancelHeartbeatDelay: (() => void) | null = null;
  let heartbeating = false;
  let draining = false;
  let journalDraining = false;
  let stopped = false;

  const loadHistory = async (
    conversationId: string,
  ): Promise<CloudTranscriptHistory> => {
    if (stopped) {
      throw new Error("Cloud transcript writer is stopped.");
    }
    const token = options.getAuthToken();
    if (!token) throw new Error("Sign in to load cloud conversation history.");
    const baseUrl = await options.getBaseUrl();
    if (!baseUrl) {
      throw new Error("Cloud conversation history is unavailable.");
    }
    const response = await doFetch(
      `${baseUrl.replace(
        /\/+$/,
        "",
      )}/conversations/${encodeURIComponent(conversationId)}/history`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "Cloud conversation was not found."
          : "Cloud conversation history could not be loaded.",
      );
    }
    const body = (await response.json()) as Partial<CloudTranscriptHistory>;
    if (
      !Array.isArray(body.history) ||
      !body.history.every((entry) => typeof entry === "string") ||
      typeof body.contextStartSeq !== "number" ||
      !Number.isInteger(body.contextStartSeq) ||
      typeof body.contextEndSeq !== "number" ||
      !Number.isInteger(body.contextEndSeq)
    ) {
      throw new Error("Cloud conversation history response is malformed.");
    }
    return {
      history: body.history,
      contextStartSeq: body.contextStartSeq,
      contextEndSeq: body.contextEndSeq,
    };
  };

  const clearHistory = (conversationId: string): void => {
    historyWindows.delete(conversationId);
    historyCacheVersions.set(
      conversationId,
      (historyCacheVersions.get(conversationId) ?? 0) + 1,
    );
  };

  const refreshHistory = (conversationId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const existing = historyRefreshes.get(conversationId);
    if (existing) return existing;
    const cacheVersion = historyCacheVersions.get(conversationId) ?? 0;
    const refresh = loadHistory(conversationId)
      .then((window) => {
        if (
          !stopped &&
          (historyCacheVersions.get(conversationId) ?? 0) === cacheVersion
        ) {
          historyWindows.set(conversationId, window);
        }
      })
      .catch((error: unknown) => {
        log("error", "cloud_transcript_history_refresh_failed", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (historyRefreshes.get(conversationId) === refresh) {
          historyRefreshes.delete(conversationId);
        }
      });
    historyRefreshes.set(conversationId, refresh);
    return refresh;
  };

  const refreshHistoryAfterFinishAck = (conversationId: string): void => {
    const existing = historyRefreshes.get(conversationId);
    if (existing) {
      void existing.then(() => refreshHistory(conversationId));
      return;
    }
    void refreshHistory(conversationId);
  };

  type ActiveBegin = NonNullable<ReturnType<typeof activeBegins.get>>;

  const notifyLeaseLost = (
    id: string,
    active: ActiveBegin,
    reason: string,
  ): void => {
    if (activeBegins.get(id) !== active) return;
    activeBegins.delete(id);
    active.cancelAuthorityDeadline();
    try {
      active.onLeaseLost?.(reason);
    } catch {
      log("error", "cloud_transcript_lease_lost_callback_failed", {
        conversationId: active.entry.conversationId,
        localTurnId: active.entry.localTurnId,
        reason,
      });
    }
    // Keep the durable begin untouched. `finish` may still replace it with an
    // exact canceled result during the server's grace; after restart/resume it
    // remains the interrupted-turn recovery owner.
    scheduleHeartbeat();
    log("error", "cloud_transcript_authority_deadline", {
      conversationId: active.entry.conversationId,
      localTurnId: active.entry.localTurnId,
      reason,
    });
  };

  const activateBegin = (
    id: string,
    args: Omit<ActiveBegin, "cancelAuthorityDeadline">,
    authorityRequestStartedAt = Date.now(),
  ): ActiveBegin => {
    activeBegins.get(id)?.cancelAuthorityDeadline();
    const now = Date.now();
    const authorityDeadline = Math.min(
      args.ack.expiresAt - authorityExpiryMarginMs,
      authorityRequestStartedAt + authoritySilenceMs,
    );
    let active!: ActiveBegin;
    active = {
      ...args,
      cancelAuthorityDeadline: forkDelayedCall(
        Math.max(0, authorityDeadline - now),
        () => notifyLeaseLost(id, active, "lease_renewal_silence"),
      ),
    };
    activeBegins.set(id, active);
    return active;
  };

  const attempt = async (
    entry: CloudTranscriptOutboxRecord,
    attemptOptions: { renewLeaseToken?: string } = {},
  ): Promise<AttemptResult> => {
    if (!entry.ownerGeneration) {
      return {
        kind: "dead_letter",
        reason: "owner_generation_missing",
      };
    }
    const token = options.getAuthToken();
    if (!token) {
      return {
        kind: "retry",
        delayMs: NO_AUTH_RETRY_MS,
        reason: "signed_out",
      };
    }
    const baseUrl = await options.getBaseUrl();
    if (!baseUrl) {
      return {
        kind: "retry",
        delayMs: NO_AUTH_RETRY_MS,
        reason: "realtime_unconfigured",
      };
    }

    const endpoint = entry.kind === "begin" ? "begin" : "finish";
    const url = `${baseUrl.replace(
      /\/+$/,
      "",
    )}/conversations/${encodeURIComponent(
      entry.conversationId,
    )}/local-turns/${endpoint}`;
    let response: Response;
    const authorityRequestStartedAt =
      entry.kind === "begin" ? Date.now() : undefined;
    try {
      const body =
        entry.kind === "begin" && attemptOptions.renewLeaseToken
          ? JSON.stringify({
              deviceId: entry.deviceId,
              expectedOwnerGeneration: entry.ownerGeneration,
              localTurnId: entry.localTurnId,
              leaseToken: attemptOptions.renewLeaseToken,
              renewOnly: true,
            } satisfies RenewPayload)
          : entry.payloadJson;
      response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return {
        kind: "retry",
        delayMs: retryDelay(entry.attempts),
        reason: "network",
      };
    }

    if (response.ok) {
      if (entry.kind === "finish") return { kind: "ack" };
      const ack = parseBeginAck(await response.json().catch(() => null));
      if (ack) {
        return {
          kind: "ack",
          begin: ack,
          authorityRequestStartedAt,
        };
      }
      return {
        kind: "retry",
        delayMs: retryDelay(entry.attempts),
        reason: "invalid_begin_ack",
      };
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      if (
        body?.code === "lease_mismatch" ||
        body?.code === "turn_expired" ||
        body?.code === "turn_finished" ||
        body?.code === "turn_canceled" ||
        body?.code === "idempotency_conflict"
      ) {
        return { kind: "terminal", reason: body.code };
      }
      if (body?.code === "OWNER_DATA_GENERATION_STALE") {
        return { kind: "terminal", reason: "owner_generation_stale" };
      }
      return {
        kind: "retry",
        delayMs: TURN_BUSY_RETRY_MS,
        reason: "turn_busy",
      };
    }
    if (response.status === 410) {
      return { kind: "terminal", reason: "conversation_deleted" };
    }
    if (response.status === 413) {
      return {
        kind: "dead_letter",
        ...(await parseDeadLetterResponse(response)),
      };
    }
    if (entry.kind === "begin" && response.status === 400) {
      return {
        kind: "dead_letter",
        ...(await parseDeadLetterResponse(response)),
      };
    }
    return {
      kind: "retry",
      delayMs:
        response.status === 429 || response.status >= 500
          ? retryDelay(entry.attempts)
          : MAX_RETRY_MS,
      reason: `http_${response.status}`,
    };
  };

  const attemptJournal = async (
    entry: CloudJournalOutboxRecord,
  ): Promise<JournalAttemptResult> => {
    if (!entry.ownerGeneration) {
      return { kind: "dead_letter", reason: "owner_generation_missing" };
    }
    const token = options.getAuthToken();
    if (!token) {
      return {
        kind: "retry",
        delayMs: NO_AUTH_RETRY_MS,
        reason: "signed_out",
      };
    }
    const baseUrl = await options.getBaseUrl();
    if (!baseUrl) {
      return {
        kind: "retry",
        delayMs: NO_AUTH_RETRY_MS,
        reason: "realtime_unconfigured",
      };
    }
    let response: Response;
    try {
      response = await doFetch(
        `${baseUrl.replace(
          /\/+$/,
          "",
        )}/conversations/${encodeURIComponent(entry.conversationId)}/journal`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: entry.payloadJson,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      return {
        kind: "retry",
        delayMs: retryDelay(entry.attempts),
        reason: "network",
      };
    }
    if (response.ok) return { kind: "ack" };
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      if (body?.code === "idempotency_conflict") {
        return { kind: "dead_letter", reason: "idempotency_conflict" };
      }
      if (
        body?.code === "owner_generation_stale" ||
        body?.code === "OWNER_DATA_GENERATION_STALE"
      ) {
        return { kind: "dead_letter", reason: "owner_generation_stale" };
      }
      return {
        kind: "retry",
        delayMs: TURN_BUSY_RETRY_MS,
        reason:
          typeof body?.code === "string" ? body.code : "conversation_busy",
      };
    }
    if (response.status === 400 || response.status === 413) {
      const parsed = await parseDeadLetterResponse(response);
      return { kind: "dead_letter", reason: parsed.reason };
    }
    if (response.status === 410) {
      return { kind: "dead_letter", reason: "conversation_deleted" };
    }
    return {
      kind: "retry",
      delayMs:
        response.status === 429 || response.status >= 500
          ? retryDelay(entry.attempts)
          : MAX_RETRY_MS,
      reason: `http_${response.status}`,
    };
  };

  const reconstructInterruptedFinish = (
    entry: CloudTranscriptOutboxRecord,
  ): Pick<FinishPayload, "records" | "phase" | "notice"> => {
    const canceled = {
      records: [] as CloudTranscriptFinishRecord[],
      phase: "canceled" as const,
      notice: "The local turn was interrupted before it could finish.",
    };
    if (!entry.recoveryJson) return canceled;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.recoveryJson);
    } catch {
      parsed = null;
    }
    const precomputed = parsed as {
      kind?: unknown;
      records?: unknown;
      phase?: unknown;
      notice?: unknown;
    } | null;
    if (precomputed?.kind === "precomputed-finish") {
      const records = Array.isArray(precomputed.records)
        ? (precomputed.records as CloudTranscriptFinishRecord[])
        : [];
      const phase =
        precomputed.phase === "completed" ||
        precomputed.phase === "failed" ||
        precomputed.phase === "canceled" ||
        precomputed.phase === "timeout"
          ? precomputed.phase
          : null;
      const structurallyValid =
        phase !== null &&
        records.length <= FINISH_MAX_ROWS &&
        records.every(
          (record, ordinal) =>
            record?.ordinal === ordinal &&
            (record.role === "assistant" || record.role === "toolResult") &&
            typeof record.payloadJson === "string",
        );
      if (
        structurallyValid &&
        jsonBytes({
          deviceId: entry.deviceId,
          expectedOwnerGeneration: entry.ownerGeneration,
          localTurnId: entry.localTurnId,
          leaseToken: "",
          records,
          phase,
          ...(typeof precomputed.notice === "string" &&
          precomputed.notice.trim()
            ? { notice: precomputed.notice.trim() }
            : {}),
        }) <= FINISH_MAX_BYTES
      ) {
        return {
          records,
          phase,
          ...(typeof precomputed.notice === "string" &&
          precomputed.notice.trim()
            ? { notice: precomputed.notice.trim() }
            : {}),
        };
      }
      log("error", "cloud_transcript_precomputed_recovery_invalid", {
        conversationId: entry.conversationId,
        localTurnId: entry.localTurnId,
      });
      return canceled;
    }
    log("error", "cloud_transcript_recovery_metadata_invalid", {
      conversationId: entry.conversationId,
      localTurnId: entry.localTurnId,
    });
    return canceled;
  };

  const persistInterruptedRecovery = (
    entry: CloudTranscriptOutboxRecord,
    ack: CloudTranscriptBeginAck,
  ): void => {
    const ownerGeneration = entry.ownerGeneration;
    if (!ownerGeneration) {
      throw new Error(
        "Cloud transcript recovery is missing its owner generation.",
      );
    }
    const recovered = reconstructInterruptedFinish(entry);
    const payload: FinishPayload = {
      deviceId: entry.deviceId,
      expectedOwnerGeneration: ownerGeneration,
      localTurnId: entry.localTurnId,
      leaseToken: ack.leaseToken,
      ...recovered,
    };
    options.store.replaceCloudTranscriptOutbox(entry.id, {
      id: outboxId(
        "finish",
        entry.deviceId,
        entry.conversationId,
        entry.localTurnId,
      ),
      kind: "finish",
      conversationId: entry.conversationId,
      deviceId: entry.deviceId,
      ownerGeneration,
      localTurnId: entry.localTurnId,
      payloadJson: JSON.stringify(payload),
      recoveryJson: null,
    });
    log("info", "cloud_transcript_begin_recovered", {
      conversationId: entry.conversationId,
      localTurnId: entry.localTurnId,
    });
  };

  const scheduleDrain = (delayMs = 0): void => {
    if (stopped) return;
    if (cancelRetryDelay) cancelRetryDelay();
    cancelRetryDelay = forkDelayedCall(Math.max(0, delayMs), () => {
      cancelRetryDelay = null;
      void drain();
    });
  };

  const scheduleJournalDrain = (delayMs = 0): void => {
    if (stopped) return;
    if (cancelJournalRetryDelay) cancelJournalRetryDelay();
    cancelJournalRetryDelay = forkDelayedCall(Math.max(0, delayMs), () => {
      cancelJournalRetryDelay = null;
      void drainJournal();
    });
  };

  const scheduleHeartbeat = (delayMs = heartbeatIntervalMs): void => {
    if (cancelHeartbeatDelay) {
      cancelHeartbeatDelay();
      cancelHeartbeatDelay = null;
    }
    if (stopped || activeBegins.size === 0) return;
    cancelHeartbeatDelay = forkDelayedCall(Math.max(10, delayMs), () => {
      cancelHeartbeatDelay = null;
      void heartbeat();
    });
  };

  const heartbeat = async (): Promise<void> => {
    if (heartbeating || stopped || activeBegins.size === 0) return;
    heartbeating = true;
    let nextHeartbeatMs = heartbeatIntervalMs;
    try {
      for (const [id, active] of [...activeBegins.entries()]) {
        if (stopped) break;
        const result = await attempt(active.entry, {
          renewLeaseToken: active.ack.leaseToken,
        });
        // Finish may have replaced this marker while the renewal was in
        // flight. Never resurrect or delete the replacement finish.
        if (activeBegins.get(id) !== active) continue;
        if (result.kind === "ack") {
          if (result.begin) {
            activateBegin(
              id,
              { ...active, ack: result.begin },
              result.authorityRequestStartedAt,
            );
          } else {
            nextHeartbeatMs = Math.min(nextHeartbeatMs, BASE_RETRY_MS);
          }
          continue;
        }
        if (result.kind === "retry") {
          nextHeartbeatMs = Math.min(nextHeartbeatMs, result.delayMs);
          log("info", "cloud_transcript_heartbeat_retry", {
            conversationId: active.entry.conversationId,
            localTurnId: active.entry.localTurnId,
            reason: result.reason,
          });
          continue;
        }
        activeBegins.delete(id);
        active.cancelAuthorityDeadline();
        try {
          active.onLeaseLost?.(result.reason);
        } catch {
          log("error", "cloud_transcript_lease_lost_callback_failed", {
            conversationId: active.entry.conversationId,
            localTurnId: active.entry.localTurnId,
            reason: result.reason,
          });
        }
        clearHistory(active.entry.conversationId);
        if (result.kind === "dead_letter") {
          options.store.deadLetterCloudTranscriptOutbox(id, result.reason);
        } else {
          options.store.deleteCloudTranscriptOutbox(id);
        }
        log("error", "cloud_transcript_heartbeat_terminal", {
          conversationId: active.entry.conversationId,
          localTurnId: active.entry.localTurnId,
          reason: result.reason,
        });
      }
    } finally {
      heartbeating = false;
    }
    scheduleHeartbeat(nextHeartbeatMs);
  };

  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    // Cloud outbox drain only applies to stores that support it; a local-only
    // store (cloud disabled) has no outbox tables, so there is nothing to push.
    if (typeof options.store.listCloudTranscriptOutbox !== "function") return;
    draining = true;
    let nextRetryMs: number | null = null;
    try {
      const entries = options.store
        .listCloudTranscriptOutbox()
        .filter((entry) => !activeBegins.has(entry.id))
        .sort(
          (left, right) =>
            Number(beginWaiters.has(right.id)) -
            Number(beginWaiters.has(left.id)),
        );
      for (const entry of entries) {
        if (stopped) break;
        options.store.markCloudTranscriptOutboxAttempt(entry.id);
        const result = await attempt({
          ...entry,
          attempts: entry.attempts + 1,
        });
        if (result.kind === "dead_letter") {
          if (entry.kind === "begin") {
            clearHistory(entry.conversationId);
          }
          const durableFailureUserMessageId =
            entry.kind === "finish"
              ? failureNotificationUserMessageId(entry)
              : null;
          const onDeliveryFailure = finishFailureCallbacks.get(entry.id);
          finishFailureCallbacks.delete(entry.id);
          const failureMessage =
            result.userMessage ??
            "This response could not be synced to your cloud conversation.";
          if (durableFailureUserMessageId) {
            options.store.deadLetterCloudTranscriptOutboxWithFailureNotice({
              id: entry.id,
              reason: result.reason,
              conversationId: entry.conversationId,
              deviceId: entry.deviceId,
              localTurnId: entry.localTurnId,
              userMessageId: durableFailureUserMessageId,
              message: failureMessage,
            });
          } else {
            options.store.deadLetterCloudTranscriptOutbox(
              entry.id,
              result.reason,
            );
          }
          if (durableFailureUserMessageId && options.onDurableDeliveryFailure) {
            try {
              options.onDurableDeliveryFailure({
                conversationId: entry.conversationId,
                localTurnId: entry.localTurnId,
                userMessageId: durableFailureUserMessageId,
                message: failureMessage,
              });
            } catch {
              log("error", "cloud_transcript_durable_failure_notice_failed", {
                conversationId: entry.conversationId,
                localTurnId: entry.localTurnId,
                reason: result.reason,
              });
            }
          } else if (onDeliveryFailure) {
            try {
              onDeliveryFailure(failureMessage);
            } catch {
              log(
                "error",
                "cloud_transcript_delivery_failure_callback_failed",
                {
                  conversationId: entry.conversationId,
                  localTurnId: entry.localTurnId,
                  reason: result.reason,
                },
              );
            }
          }
          const waiters = beginWaiters.get(entry.id);
          if (waiters?.length) {
            const error = new Error(
              result.reason === "http_413"
                ? "The cloud transcript request exceeds the supported protocol limits."
                : "The cloud transcript request was rejected as malformed.",
            );
            for (const waiter of waiters) {
              waiter.cleanup();
              waiter.reject(error);
            }
            beginWaiters.delete(entry.id);
          }
          log("error", "cloud_transcript_delivery_dead_lettered", {
            conversationId: entry.conversationId,
            localTurnId: entry.localTurnId,
            kind: entry.kind,
            reason: result.reason,
          });
          continue;
        }
        if (result.kind === "terminal") {
          if (entry.kind === "begin") {
            clearHistory(entry.conversationId);
          }
          finishFailureCallbacks.delete(entry.id);
          options.store.deleteCloudTranscriptOutbox(entry.id);
          activeBegins.delete(entry.id);
          const waiters = beginWaiters.get(entry.id);
          if (waiters?.length) {
            const error =
              result.reason === "turn_finished"
                ? new CloudTranscriptAlreadyAdmittedError()
                : new Error(
                    result.reason === "conversation_deleted"
                      ? "The cloud conversation was deleted before the local turn could start."
                      : "The cloud local turn no longer owns the conversation.",
                  );
            for (const waiter of waiters) {
              waiter.cleanup();
              waiter.reject(error);
            }
            beginWaiters.delete(entry.id);
          }
          log("error", "cloud_transcript_delivery_terminal", {
            conversationId: entry.conversationId,
            localTurnId: entry.localTurnId,
            kind: entry.kind,
            reason: result.reason,
          });
          continue;
        }
        if (result.kind === "retry") {
          nextRetryMs =
            nextRetryMs === null
              ? result.delayMs
              : Math.min(nextRetryMs, result.delayMs);
          log(
            result.reason.startsWith("http_") ? "error" : "info",
            "cloud_transcript_delivery_retry",
            {
              conversationId: entry.conversationId,
              localTurnId: entry.localTurnId,
              kind: entry.kind,
              reason: result.reason,
            },
          );
          continue;
        }

        if (entry.kind === "finish") {
          finishFailureCallbacks.delete(entry.id);
          options.store.deleteCloudTranscriptOutbox(entry.id);
          refreshHistoryAfterFinishAck(entry.conversationId);
          continue;
        }
        const ack = result.begin;
        if (!ack) {
          nextRetryMs =
            nextRetryMs === null
              ? MAX_RETRY_MS
              : Math.min(nextRetryMs, MAX_RETRY_MS);
          continue;
        }
        const waiters = beginWaiters.get(entry.id);
        if (waiters?.length) {
          // Keep the begin row as the write-ahead in-flight marker. A clean
          // finish atomically replaces it; a process restart has no matching
          // activeBegins entry and therefore recovers it as an orphan.
          const onLeaseLost = waiters.find(
            (waiter) => waiter.onLeaseLost,
          )?.onLeaseLost;
          activateBegin(
            entry.id,
            {
              ack,
              entry,
              ...(onLeaseLost ? { onLeaseLost } : {}),
            },
            result.authorityRequestStartedAt,
          );
          scheduleHeartbeat();
          beginWaiters.delete(entry.id);
          for (const waiter of waiters) {
            waiter.cleanup();
            waiter.resolve(ack);
          }
        } else {
          // This begin survived a worker crash. Reacquire its idempotent lease
          // and terminalize it instead of leaving the cloud writer blocked.
          persistInterruptedRecovery(entry, ack);
        }
      }
    } finally {
      draining = false;
    }
    if (stopped) return;
    const hasDeliverableRows = options.store
      .listCloudTranscriptOutbox()
      .some((entry) => !activeBegins.has(entry.id));
    if (hasDeliverableRows) {
      scheduleDrain(nextRetryMs ?? 0);
    }
  };

  const drainJournal = async (): Promise<void> => {
    if (journalDraining || stopped) return;
    // See `drain`: skip entirely when the store has no cloud journal outbox.
    if (typeof options.store.listCloudJournalOutbox !== "function") return;
    journalDraining = true;
    let nextRetryMs: number | null = null;
    const blockedConversations = new Set<string>();
    try {
      for (const entry of options.store.listCloudJournalOutbox()) {
        if (stopped) break;
        if (blockedConversations.has(entry.conversationId)) continue;
        options.store.markCloudJournalOutboxAttempt(entry.id);
        const result = await attemptJournal({
          ...entry,
          attempts: entry.attempts + 1,
        });
        if (result.kind === "ack") {
          options.store.deleteCloudJournalOutbox(entry.id);
          continue;
        }
        if (result.kind === "dead_letter") {
          options.store.deadLetterCloudJournalOutbox(entry.id, result.reason);
          log("error", "cloud_journal_delivery_dead_lettered", {
            conversationId: entry.conversationId,
            appendId: entry.appendId,
            reason: result.reason,
          });
          continue;
        }
        // Never let a later append in the same conversation overtake this
        // one. Other conversations remain independent and may still drain.
        blockedConversations.add(entry.conversationId);
        nextRetryMs =
          nextRetryMs === null
            ? result.delayMs
            : Math.min(nextRetryMs, result.delayMs);
        log(
          result.reason.startsWith("http_") ? "error" : "info",
          "cloud_journal_delivery_retry",
          {
            conversationId: entry.conversationId,
            appendId: entry.appendId,
            reason: result.reason,
          },
        );
      }
    } finally {
      journalDraining = false;
    }
    if (stopped) return;
    if (options.store.countCloudJournalOutbox() > 0) {
      scheduleJournalDrain(nextRetryMs ?? 0);
    }
  };

  const resume = (): void => {
    if (stopped) return;
    scheduleDrain(0);
    scheduleJournalDrain(0);
    scheduleHeartbeat(0);
  };

  // Startup recovery includes both pending finishes and begins left behind by
  // a crash. An orphaned begin is converted to a durable canceled finish once
  // its lease is reacquired.
  resume();

  return {
    history: loadHistory,
    peekHistory: (conversationId) => historyWindows.get(conversationId) ?? null,
    refreshHistory,
    begin: (request) => {
      if (stopped) {
        return Promise.reject(new Error("Cloud transcript writer is stopped."));
      }
      let ownerGeneration: string;
      try {
        ownerGeneration = normalizeOwnerGeneration(request.ownerGeneration);
      } catch (error) {
        return Promise.reject(error);
      }
      const payload: BeginPayload = {
        deviceId: options.deviceId,
        expectedOwnerGeneration: ownerGeneration,
        localTurnId: request.localTurnId,
        clientMsgId: request.clientMsgId,
        userMessageJson: request.userMessageJson,
      };
      const payloadJson = JSON.stringify(payload);
      const recoveryJson = request.recovery
        ? JSON.stringify(request.recovery)
        : null;
      const id = outboxId(
        "begin",
        options.deviceId,
        request.conversationId,
        request.localTurnId,
      );
      const active = activeBegins.get(id);
      if (active) {
        if (
          active.entry.kind !== "begin" ||
          active.entry.conversationId !== request.conversationId ||
          active.entry.deviceId !== options.deviceId ||
          active.entry.ownerGeneration !== ownerGeneration ||
          active.entry.localTurnId !== request.localTurnId ||
          active.entry.payloadJson !== payloadJson ||
          active.entry.recoveryJson !== recoveryJson
        ) {
          return Promise.reject(
            new Error(
              "Cloud transcript turn id was reused with different authority or payload.",
            ),
          );
        }
        if (request.onLeaseLost) {
          active.onLeaseLost = request.onLeaseLost;
        }
        return request.signal?.aborted
          ? Promise.reject(new Error("Run canceled."))
          : Promise.resolve(active.ack);
      }
      options.store.putCloudTranscriptOutbox({
        id,
        kind: "begin",
        conversationId: request.conversationId,
        deviceId: options.deviceId,
        ownerGeneration,
        localTurnId: request.localTurnId,
        payloadJson,
        recoveryJson,
      });
      return new Promise<CloudTranscriptBeginAck>((resolve, reject) => {
        const waiters = beginWaiters.get(id) ?? [];
        const onAbort = () => {
          const current = beginWaiters.get(id) ?? [];
          const remaining = current.filter((waiter) => waiter !== entry);
          if (remaining.length) beginWaiters.set(id, remaining);
          else beginWaiters.delete(id);
          entry.cleanup();
          reject(new Error("Run canceled."));
        };
        const entry: BeginWaiter = {
          resolve,
          reject,
          cleanup: () => request.signal?.removeEventListener("abort", onAbort),
          ...(request.onLeaseLost ? { onLeaseLost: request.onLeaseLost } : {}),
        };
        if (request.signal?.aborted) {
          reject(new Error("Run canceled."));
          resume();
          return;
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(entry);
        beginWaiters.set(id, waiters);
        resume();
      });
    },
    finish: async (request) => {
      const ownerGeneration = normalizeOwnerGeneration(request.ownerGeneration);
      const tooManyRecords = request.records.length > FINISH_MAX_ROWS;
      if (tooManyRecords) {
        log("error", "cloud_transcript_finish_oversized", {
          conversationId: request.conversationId,
          localTurnId: request.localTurnId,
          records: request.records.length,
          limit: FINISH_MAX_ROWS,
        });
      }
      const payload: FinishPayload = {
        deviceId: options.deviceId,
        expectedOwnerGeneration: ownerGeneration,
        localTurnId: request.localTurnId,
        leaseToken: request.leaseToken,
        records: request.records,
        phase: request.phase,
        ...(request.notice ? { notice: request.notice } : {}),
      };
      const payloadBytes = jsonBytes(payload);
      const tooManyBytes = payloadBytes > FINISH_MAX_BYTES;
      if (tooManyBytes) {
        log("error", "cloud_transcript_finish_oversized", {
          conversationId: request.conversationId,
          localTurnId: request.localTurnId,
          bytes: payloadBytes,
          limit: FINISH_MAX_BYTES,
        });
      }
      const beginId = outboxId(
        "begin",
        options.deviceId,
        request.conversationId,
        request.localTurnId,
      );
      const finishId = outboxId(
        "finish",
        options.deviceId,
        request.conversationId,
        request.localTurnId,
      );
      options.store.replaceCloudTranscriptOutbox(beginId, {
        id: finishId,
        kind: "finish",
        conversationId: request.conversationId,
        deviceId: options.deviceId,
        ownerGeneration,
        localTurnId: request.localTurnId,
        payloadJson: JSON.stringify(payload),
        recoveryJson: request.failureNotificationUserMessageId
          ? JSON.stringify({
              failureNotificationUserMessageId:
                request.failureNotificationUserMessageId,
            })
          : null,
      });
      activeBegins.get(beginId)?.cancelAuthorityDeadline();
      activeBegins.delete(beginId);
      scheduleHeartbeat();
      if (tooManyRecords || tooManyBytes) {
        const reason = tooManyRecords
          ? "finish_record_limit_exceeded"
          : "finish_byte_limit_exceeded";
        options.store.deadLetterCloudTranscriptOutbox(finishId, reason);
        return { queued: false, reason };
      }
      if (request.onDeliveryFailure) {
        finishFailureCallbacks.set(finishId, request.onDeliveryFailure);
      }
      resume();
      return { queued: true };
    },
    append: async (request) => {
      if (stopped) {
        throw new Error("Cloud transcript writer is stopped.");
      }
      const appendId = request.appendId.trim();
      if (!appendId || request.records.length === 0) {
        throw new Error("Cloud journal append requires an id and records.");
      }
      const ownerGeneration = normalizeOwnerGeneration(
        request.ownerGeneration ?? (await options.getOwnerGeneration?.()) ?? "",
      );
      const payload: JournalAppendPayload = {
        deviceId: options.deviceId,
        expectedOwnerGeneration: ownerGeneration,
        localTurnId: appendId,
        source: "voice",
        records: request.records,
      };
      const { replayed } = options.store.putCloudJournalOutbox({
        id: journalOutboxId(options.deviceId, request.conversationId, appendId),
        conversationId: request.conversationId,
        deviceId: options.deviceId,
        ownerGeneration,
        appendId,
        payloadJson: JSON.stringify(payload),
      });
      scheduleJournalDrain(0);
      return { queued: true, replayed };
    },
    pending: () =>
      options.store.countCloudTranscriptOutbox() +
      options.store.countCloudJournalOutbox(),
    resume,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (cancelRetryDelay) {
        cancelRetryDelay();
        cancelRetryDelay = null;
      }
      if (cancelJournalRetryDelay) {
        cancelJournalRetryDelay();
        cancelJournalRetryDelay = null;
      }
      if (cancelHeartbeatDelay) {
        cancelHeartbeatDelay();
        cancelHeartbeatDelay = null;
      }
      const error = new Error("Cloud transcript writer stopped.");
      for (const waiters of beginWaiters.values()) {
        for (const waiter of waiters) {
          waiter.cleanup();
          waiter.reject(error);
        }
      }
      beginWaiters.clear();
      for (const active of activeBegins.values()) {
        active.cancelAuthorityDeadline();
      }
      activeBegins.clear();
      finishFailureCallbacks.clear();
      historyWindows.clear();
      historyRefreshes.clear();
      historyCacheVersions.clear();
    },
  };
};
