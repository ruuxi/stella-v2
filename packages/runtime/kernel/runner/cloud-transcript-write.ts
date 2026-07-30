import type {
  CloudTranscriptOutboxRecord,
  RuntimeStore,
} from "../storage/runtime-store.js";

export type CloudTranscriptBeginRequest = {
  conversationId: string;
  /** Stable per local turn. Replaying this id must return the same lease. */
  localTurnId: string;
  /** Stable id of the user message admitted by this turn. */
  clientMsgId: string;
  /** Serialized user `AgentMessage`. */
  userMessageJson: string;
  /** Local-only data used to reconstruct persisted output after a crash. */
  recovery?: {
    threadKey: string;
    afterInsertionSequence: number;
  };
  /** Abort the provider if a renewal proves this process lost the cloud lease. */
  onLeaseLost?: (reason: string) => void;
  /** Local cancellation stops waiting but keeps the durable begin for cleanup. */
  signal?: AbortSignal;
};

export type CloudTranscriptBeginAck = {
  turnId: string;
  leaseToken: string;
  /** Canonical pre-prompt serialized `AgentMessage`s. */
  history: string[];
};

export type CloudTranscriptFinishRecord = {
  ordinal: number;
  role: "assistant" | "toolResult";
  /** Serialized `AgentMessage`, exactly as persisted by the local runtime. */
  payloadJson: string;
};

export type CloudTranscriptFinishRequest = {
  conversationId: string;
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

export type CloudTranscriptWriterOptions = {
  deviceId: string;
  store: RuntimeStore;
  /** The runtime's Convex JWT, or null while signed out. */
  getAuthToken: () => string | null;
  /** Builder origin from Convex, or null when realtime is not configured. */
  getBaseUrl: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Test override; production renews well inside the 30-minute DO lease. */
  heartbeatIntervalMs?: number;
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
  /**
   * Persists the admission request, then waits for the Durable Object to grant
   * the single-writer lease. A local provider must not start before this
   * resolves.
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

type BeginPayload = {
  deviceId: string;
  localTurnId: string;
  clientMsgId: string;
  userMessageJson: string;
};

type RenewPayload = {
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
  renewOnly: true;
};

type FinishPayload = {
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
  records: CloudTranscriptFinishRecord[];
  phase: CloudTranscriptFinishRequest["phase"];
  notice?: string;
};

type AttemptResult =
  | { kind: "ack"; begin?: CloudTranscriptBeginAck }
  | { kind: "dead_letter"; reason: string; userMessage?: string }
  | {
      kind: "terminal";
      reason:
        | "conversation_deleted"
        | "lease_mismatch"
        | "turn_expired"
        | "turn_finished"
        | "turn_canceled";
    }
  | { kind: "retry"; delayMs: number; reason: string };

type BeginWaiter = {
  resolve: (ack: CloudTranscriptBeginAck) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  onLeaseLost?: (reason: string) => void;
};

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

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

const parseBeginAck = (value: unknown): CloudTranscriptBeginAck | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.turnId !== "string" ||
    !candidate.turnId ||
    typeof candidate.leaseToken !== "string" ||
    !candidate.leaseToken ||
    !Array.isArray(candidate.history) ||
    !candidate.history.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return {
    turnId: candidate.turnId,
    leaseToken: candidate.leaseToken,
    history: candidate.history,
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
    }
  >();
  const heartbeatIntervalMs = Math.max(
    10,
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeating = false;
  let draining = false;
  let stopped = false;

  const attempt = async (
    entry: CloudTranscriptOutboxRecord,
    attemptOptions: { renewLeaseToken?: string } = {},
  ): Promise<AttemptResult> => {
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
    try {
      const body =
        entry.kind === "begin" && attemptOptions.renewLeaseToken
          ? JSON.stringify({
              deviceId: entry.deviceId,
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
      if (ack) return { kind: "ack", begin: ack };
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
        body?.code === "turn_canceled"
      ) {
        return { kind: "terminal", reason: body.code };
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

  const reconstructInterruptedRecords = (
    entry: CloudTranscriptOutboxRecord,
  ): CloudTranscriptFinishRecord[] => {
    if (!entry.recoveryJson) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.recoveryJson);
    } catch {
      parsed = null;
    }
    const candidate = parsed as {
      threadKey?: unknown;
      afterInsertionSequence?: unknown;
    } | null;
    if (
      typeof candidate?.threadKey !== "string" ||
      typeof candidate.afterInsertionSequence !== "number" ||
      !Number.isFinite(candidate.afterInsertionSequence) ||
      candidate.afterInsertionSequence < 0
    ) {
      log("error", "cloud_transcript_recovery_metadata_invalid", {
        conversationId: entry.conversationId,
        localTurnId: entry.localTurnId,
      });
      return [];
    }
    return options.store
      .loadRawThreadMessagesAfterInsertionSequence(
        candidate.threadKey,
        candidate.afterInsertionSequence,
      )
      .filter(
        (message) =>
          message.payload !== undefined &&
          (message.payload.role === "assistant" ||
            message.payload.role === "toolResult"),
      )
      .map((message, ordinal) => ({
        ordinal,
        role: message.payload!.role as "assistant" | "toolResult",
        payloadJson: JSON.stringify(message.payload),
      }));
  };

  const persistInterruptedRecovery = (
    entry: CloudTranscriptOutboxRecord,
    ack: CloudTranscriptBeginAck,
  ): void => {
    const payload: FinishPayload = {
      deviceId: entry.deviceId,
      localTurnId: entry.localTurnId,
      leaseToken: ack.leaseToken,
      records: reconstructInterruptedRecords(entry),
      phase: "canceled",
      notice: "The local turn was interrupted before it could finish.",
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
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        void drain();
      },
      Math.max(0, delayMs),
    );
  };

  const scheduleHeartbeat = (delayMs = heartbeatIntervalMs): void => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stopped || activeBegins.size === 0) return;
    heartbeatTimer = setTimeout(
      () => {
        heartbeatTimer = null;
        void heartbeat();
      },
      Math.max(10, delayMs),
    );
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
            activeBegins.set(id, { ...active, ack: result.begin });
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
        try {
          active.onLeaseLost?.(result.reason);
        } catch {
          log("error", "cloud_transcript_lease_lost_callback_failed", {
            conversationId: active.entry.conversationId,
            localTurnId: active.entry.localTurnId,
            reason: result.reason,
          });
        }
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
          finishFailureCallbacks.delete(entry.id);
          options.store.deleteCloudTranscriptOutbox(entry.id);
          activeBegins.delete(entry.id);
          const waiters = beginWaiters.get(entry.id);
          if (waiters?.length) {
            const error = new Error(
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
          activeBegins.set(entry.id, {
            ack,
            entry,
            ...(onLeaseLost ? { onLeaseLost } : {}),
          });
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

  const resume = (): void => {
    if (stopped) return;
    scheduleDrain(0);
    scheduleHeartbeat(0);
  };

  // Startup recovery includes both pending finishes and begins left behind by
  // a crash. An orphaned begin is converted to a durable canceled finish once
  // its lease is reacquired.
  resume();

  return {
    begin: (request) => {
      if (stopped) {
        return Promise.reject(new Error("Cloud transcript writer is stopped."));
      }
      const payload: BeginPayload = {
        deviceId: options.deviceId,
        localTurnId: request.localTurnId,
        clientMsgId: request.clientMsgId,
        userMessageJson: request.userMessageJson,
      };
      const id = outboxId(
        "begin",
        options.deviceId,
        request.conversationId,
        request.localTurnId,
      );
      const active = activeBegins.get(id);
      if (active) {
        if (request.onLeaseLost) {
          activeBegins.set(id, {
            ...active,
            onLeaseLost: request.onLeaseLost,
          });
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
        localTurnId: request.localTurnId,
        payloadJson: JSON.stringify(payload),
        recoveryJson: request.recovery
          ? JSON.stringify(request.recovery)
          : null,
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
        localTurnId: request.localTurnId,
        payloadJson: JSON.stringify(payload),
        recoveryJson: request.failureNotificationUserMessageId
          ? JSON.stringify({
              failureNotificationUserMessageId:
                request.failureNotificationUserMessageId,
            })
          : null,
      });
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
    pending: () => options.store.countCloudTranscriptOutbox(),
    resume,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      const error = new Error("Cloud transcript writer stopped.");
      for (const waiters of beginWaiters.values()) {
        for (const waiter of waiters) {
          waiter.cleanup();
          waiter.reject(error);
        }
      }
      beginWaiters.clear();
      activeBegins.clear();
      finishFailureCallbacks.clear();
    },
  };
};
