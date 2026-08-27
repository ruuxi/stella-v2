import { Effect, Exit, Scope } from "effect";
import {
  connectorsRuntime,
  forkTimeoutFiber,
} from "./connectors/effect-runtime.js";

const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const BUSY_RETRY_MS = 1_000;
const ERROR_RETRY_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_TERMINAL_RETRY_ATTEMPTS = 3;
const DEFAULT_TERMINAL_RPC_TIMEOUT_MS = 5_000;
const EMPTY_RESPONSE_TEXT = "(Stella had nothing to say.)";

export type RemoteTurnAttemptOutcome = "failed" | "aborted" | "timed_out";

export type RemoteTurnAttemptReceipt = {
  acquired: boolean;
  status: "reserved" | "busy" | "cancelled" | "legacy_unbound";
  attemptId: string;
  leaseExpiresAt: number;
  hardExpiresAt: number;
  quiescentAfterAt: number;
};

export type RemoteTurnAttemptHeartbeat = {
  allowed: boolean;
  cancelRequested: boolean;
  leaseExpiresAt: number | null;
  hardExpiresAt: number | null;
  quiescentAfterAt: number | null;
};

export type RemoteTurnRequestEvent = {
  _id: string;
  timestamp: number;
  type: string;
  requestId?: string;
  ownerGeneration?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: Record<string, unknown>;
};

type RemoteTurnRunResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string }
  | { status: "uncertain"; finalText: ""; error: string };

type PendingRemoteTurn = {
  event: RemoteTurnRequestEvent;
  nextAttemptAt: number;
  /** Stable across an ambiguous claim retry; never reused after terminal ACK. */
  attemptId: string;
};

type RemoteTurnBridgeOptions = {
  startupLookbackMs?: number;
  heartbeatIntervalMs?: number;
  terminalRetryAttempts?: number;
  terminalRetryMs?: number;
  terminalRpcTimeoutMs?: number;
  createAttemptId?: () => string;
};

type RemoteTurnBridgeDeps = {
  deviceId: string;
  isEnabled: () => boolean;
  isRunnerBusy: () => boolean;
  subscribeRemoteTurnRequests: (args: {
    deviceId: string;
    since: number;
    onUpdate: (events: RemoteTurnRequestEvent[]) => void;
    onError?: (error: Error) => void;
  }) => () => void;
  runLocalTurn: (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
    ownerGeneration: string;
    userPrompt: string;
    agentType?: string;
    modelOverride?: string;
    provider?: string;
    externalMessageId?: string;
    attachments?: Array<{
      url: string;
      mimeType?: string;
      kind?: string;
      name?: string;
      size?: number;
      transcript?: string;
      extractedText?: string;
    }>;
    /** Lease loss, cancellation, or deadline aborts the exact local run. */
    signal: AbortSignal;
    /**
     * Must be awaited after local preparation and immediately before the
     * physical worker dispatch. It performs a fresh exact-attempt heartbeat
     * and fails closed if the lifecycle fence is no longer valid.
     */
    confirmDispatchLease: () => Promise<void>;
  }) => Promise<RemoteTurnRunResult>;
  claimRemoteTurn: (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
  }) => Promise<RemoteTurnAttemptReceipt>;
  heartbeatRemoteTurn: (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
  }) => Promise<RemoteTurnAttemptHeartbeat>;
  completeConnectorTurn: (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
    text: string;
  }) => Promise<void>;
  finishRemoteTurnAttempt: (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
    outcome: RemoteTurnAttemptOutcome;
  }) => Promise<void>;
  log?: (level: "warn" | "error", message: string, error?: unknown) => void;
};

type AttemptAbortCode =
  | "remote_turn_lease_denied"
  | "remote_turn_lease_expired"
  | "remote_turn_bridge_stopped";

class RemoteTurnAttemptAbortError extends Error {
  readonly code: AttemptAbortCode;

  constructor(code: AttemptAbortCode, message: string) {
    super(message);
    this.name = "AbortError";
    this.code = code;
  }
}

class RemoteTurnTerminalBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTurnTerminalBoundaryError";
  }
}

const attemptDeadline = (
  value: Pick<RemoteTurnAttemptReceipt, "leaseExpiresAt" | "hardExpiresAt">,
): number => Math.min(value.leaseExpiresAt, value.hardExpiresAt);

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isValidClaimReceipt = (
  receipt: RemoteTurnAttemptReceipt,
  expectedAttemptId: string,
  now: number,
): boolean =>
  receipt.acquired &&
  receipt.status === "reserved" &&
  receipt.attemptId === expectedAttemptId &&
  isFiniteTimestamp(receipt.leaseExpiresAt) &&
  isFiniteTimestamp(receipt.hardExpiresAt) &&
  isFiniteTimestamp(receipt.quiescentAfterAt) &&
  receipt.leaseExpiresAt <= receipt.hardExpiresAt &&
  receipt.quiescentAfterAt >= receipt.leaseExpiresAt &&
  attemptDeadline(receipt) > now;

const terminalOutcomeFor = (
  abortCode: AttemptAbortCode | null,
  signal: AbortSignal,
  result?: RemoteTurnRunResult,
): RemoteTurnAttemptOutcome => {
  if (abortCode === "remote_turn_lease_expired") {
    return "timed_out";
  }
  if (signal.aborted) return "aborted";
  if (result?.status === "busy" || result?.status === "error") return "failed";
  return "failed";
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const getTrimmedString = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

type RuntimeAttachment = {
  url: string;
  mimeType?: string;
  kind?: string;
  name?: string;
  size?: number;
  transcript?: string;
  extractedText?: string;
};

/**
 * Parse a payload's `mediaRefs` (set by the backend after relaying inbound
 * attachments through R2) into the shape the runtime expects. We preserve
 * `kind`/`name`/`size` even though the worker's image materializer only
 * acts on images today — those fields are needed for future non-image
 * support (voice notes, documents) without another round of plumbing.
 */
const getRuntimeAttachments = (value: unknown): RuntimeAttachment[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): RuntimeAttachment | null => {
      const record = asRecord(entry);
      const url = getTrimmedString(record?.url);
      if (!url) return null;
      const mimeType = getTrimmedString(record?.mimeType) || undefined;
      const kind = getTrimmedString(record?.kind) || undefined;
      const name = getTrimmedString(record?.name) || undefined;
      const sizeRaw = record?.size;
      const size =
        typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw >= 0
          ? sizeRaw
          : undefined;
      const transcript = getTrimmedString(record?.transcript) || undefined;
      const extractedText =
        getTrimmedString(record?.extractedText) || undefined;
      return {
        url,
        ...(mimeType ? { mimeType } : {}),
        ...(kind ? { kind } : {}),
        ...(name ? { name } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(transcript ? { transcript } : {}),
        ...(extractedText ? { extractedText } : {}),
      };
    })
    .filter((entry): entry is RuntimeAttachment => Boolean(entry));
};

const isAttachmentOnlyPlaceholder = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "[attachment]" ||
    normalized === "[audio]" ||
    normalized === "[voice message]" ||
    normalized === "the user sent an attachment."
  );
};

const isAudioAttachment = (attachment: RuntimeAttachment): boolean => {
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  const kind = attachment.kind?.toLowerCase() ?? "";
  return (
    mimeType.startsWith("audio/") ||
    kind.includes("audio") ||
    kind.includes("voice")
  );
};

const userPromptWithAttachmentContext = (
  userPrompt: string,
  attachments: RuntimeAttachment[],
): string => {
  const audioAttachments = attachments.filter(isAudioAttachment);
  const textAttachments = attachments.filter((attachment) =>
    Boolean(attachment.extractedText),
  );

  const transcriptBlocks = audioAttachments
    .map((attachment, index) => {
      if (!attachment.transcript) return null;
      const label =
        audioAttachments.length === 1
          ? "Voice message transcript"
          : `Voice message ${index + 1} transcript`;
      return `${label}:\n${attachment.transcript}`;
    })
    .filter((block): block is string => Boolean(block));

  const textBlocks = textAttachments
    .map((attachment, index) => {
      if (!attachment.extractedText) return null;
      const label =
        attachment.name ||
        (textAttachments.length === 1
          ? "Attached file text"
          : `Attached file ${index + 1} text`);
      return `${label}:\n${attachment.extractedText}`;
    })
    .filter((block): block is string => Boolean(block));

  const contextBlocks = [...transcriptBlocks, ...textBlocks];
  if (contextBlocks.length > 0) {
    const contextText = contextBlocks.join("\n\n");
    return isAttachmentOnlyPlaceholder(userPrompt)
      ? contextText
      : `${userPrompt}\n\n${contextText}`;
  }

  if (audioAttachments.length > 0) {
    const fallback =
      "The user sent an audio attachment, but it could not be transcribed.";
    return isAttachmentOnlyPlaceholder(userPrompt)
      ? fallback
      : `${userPrompt}\n\n${fallback}`;
  }

  return userPrompt;
};

const isConnectorRequest = (
  payload: Record<string, unknown> | null,
): boolean => {
  const source = getTrimmedString(payload?.source);
  return source !== "cron";
};

const sortEventsAsc = (
  left: RemoteTurnRequestEvent,
  right: RemoteTurnRequestEvent,
) => {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left._id.localeCompare(right._id);
};

export const createRemoteTurnBridge = (
  deps: RemoteTurnBridgeDeps,
  options: RemoteTurnBridgeOptions = {},
) => {
  const startupLookbackMs = options.startupLookbackMs ?? DEFAULT_LOOKBACK_MS;
  const heartbeatIntervalMs = Math.max(
    10,
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const terminalRetryAttempts = Math.max(
    1,
    Math.min(
      5,
      Math.floor(
        options.terminalRetryAttempts ?? DEFAULT_TERMINAL_RETRY_ATTEMPTS,
      ),
    ),
  );
  const terminalRetryMs = Math.max(
    0,
    options.terminalRetryMs ?? ERROR_RETRY_MS,
  );
  const terminalRpcTimeoutMs = Math.max(
    10,
    options.terminalRpcTimeoutMs ?? DEFAULT_TERMINAL_RPC_TIMEOUT_MS,
  );
  const createAttemptId =
    options.createAttemptId ?? (() => crypto.randomUUID());

  let running = false;
  let processing = false;
  /** Cancel thunk for the pending retry fiber (the old `clearTimeout`). */
  let retryTimer: (() => void) | null = null;
  let unsubscribeRemoteTurns: (() => void) | null = null;
  let abortActiveAttempt: (() => void) | null = null;
  const pending = new Map<string, PendingRemoteTurn>();

  const clearRetryTimer = () => {
    if (retryTimer) {
      retryTimer();
      retryTimer = null;
    }
  };

  const scheduleRetry = (delayMs: number) => {
    if (!running) {
      return;
    }
    clearRetryTimer();
    // Reschedulable retry as a forked fiber (same delays: busy 1s, error
    // 5s); a re-schedule or stop() interrupts the pending fiber.
    retryTimer = forkTimeoutFiber(Math.max(0, delayMs), () => {
      void processPending();
    });
  };

  const raceTerminalBoundary = async <T>(args: {
    operation: () => Promise<T>;
    hardExpiresAt: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<T> => {
    if (args.signal?.aborted) {
      throw new RemoteTurnTerminalBoundaryError(
        "The remote-turn terminal operation was cancelled.",
      );
    }
    const remainingMs = Math.min(
      args.timeoutMs,
      args.hardExpiresAt - Date.now(),
    );
    if (remainingMs <= 0) {
      throw new RemoteTurnTerminalBoundaryError(
        "The remote-turn terminal hard deadline expired.",
      );
    }
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        args.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        settle(() =>
          reject(
            new RemoteTurnTerminalBoundaryError(
              "The remote-turn terminal operation was cancelled.",
            ),
          ),
        );
      const cancelDeadline = forkTimeoutFiber(remainingMs, () =>
        settle(() =>
          reject(
            new RemoteTurnTerminalBoundaryError(
              "The remote-turn terminal operation exceeded its deadline.",
            ),
          ),
        ),
      );
      args.signal?.addEventListener("abort", onAbort, { once: true });
      let operation: Promise<T>;
      try {
        operation = args.operation();
      } catch (error) {
        settle(() => reject(error));
        return;
      }
      operation.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  };

  const waitBeforeTerminalRetry = async (
    hardExpiresAt: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (terminalRetryMs <= 0) return;
    await raceTerminalBoundary({
      operation: () =>
        new Promise<void>((resolve) => {
          forkTimeoutFiber(terminalRetryMs, resolve);
        }),
      hardExpiresAt,
      signal,
      timeoutMs: terminalRetryMs + 1,
    });
  };

  const retryExactTerminalMutation = async (
    label: string,
    hardExpiresAt: number,
    mutation: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= terminalRetryAttempts; attempt += 1) {
      try {
        await raceTerminalBoundary({
          operation: mutation,
          hardExpiresAt,
          signal,
          timeoutMs: terminalRpcTimeoutMs,
        });
        return;
      } catch (error) {
        lastError = error;
        if (
          error instanceof RemoteTurnTerminalBoundaryError ||
          attempt === terminalRetryAttempts ||
          Date.now() + terminalRetryMs >= hardExpiresAt
        ) {
          break;
        }
        await waitBeforeTerminalRetry(hardExpiresAt, signal);
      }
    }
    deps.log?.(
      "error",
      `[remote-turn] ${label} failed for the exact attempt; leaving its durable lease for server reconciliation.`,
      lastError,
    );
    throw lastError;
  };

  const createAttemptMonitor = (args: {
    requestId: string;
    attemptId: string;
    conversationId: string;
    receipt: RemoteTurnAttemptReceipt;
  }) => {
    const abortScope = Scope.makeUnsafe();
    const signal = connectorsRuntime.runSync(
      Effect.provideService(Effect.abortSignal, Scope.Scope, abortScope),
    );
    let currentLease = args.receipt;
    let closed = false;
    let abortCode: AttemptAbortCode | null = null;
    let heartbeatInFlight: Promise<boolean> | null = null;
    let heartbeatTimer: (() => void) | null = null;
    let deadlineTimer: (() => void) | null = null;

    const clearTimers = () => {
      heartbeatTimer?.();
      deadlineTimer?.();
      heartbeatTimer = null;
      deadlineTimer = null;
    };

    const abort = (code: AttemptAbortCode, message: string) => {
      if (!signal.aborted) {
        abortCode = code;
        connectorsRuntime.runSync(
          Scope.close(
            abortScope,
            Exit.fail(new RemoteTurnAttemptAbortError(code, message)),
          ),
        );
      }
      clearTimers();
    };

    const armDeadline = () => {
      deadlineTimer?.();
      deadlineTimer = null;
      if (closed || signal.aborted) return;
      const remainingMs = attemptDeadline(currentLease) - Date.now();
      if (remainingMs <= 0) {
        abort(
          "remote_turn_lease_expired",
          "The remote-turn execution lease expired.",
        );
        return;
      }
      deadlineTimer = forkTimeoutFiber(remainingMs, () => {
        abort(
          "remote_turn_lease_expired",
          "The remote-turn execution lease expired.",
        );
      });
    };

    const scheduleHeartbeat = (preferredDelayMs = heartbeatIntervalMs) => {
      heartbeatTimer?.();
      heartbeatTimer = null;
      if (closed || signal.aborted) return;
      const remainingMs = attemptDeadline(currentLease) - Date.now();
      if (remainingMs <= 0) {
        abort(
          "remote_turn_lease_expired",
          "The remote-turn execution lease expired.",
        );
        return;
      }
      const delayMs = Math.max(
        1,
        Math.min(preferredDelayMs, Math.floor(remainingMs / 2)),
      );
      heartbeatTimer = forkTimeoutFiber(delayMs, () => {
        void heartbeat();
      });
    };

    const runHeartbeat = async (failClosed: boolean): Promise<boolean> => {
      if (closed || signal.aborted) return false;
      try {
        const pulse = await deps.heartbeatRemoteTurn({
          requestId: args.requestId,
          attemptId: args.attemptId,
          conversationId: args.conversationId,
        });
        if (closed || signal.aborted) return false;
        if (!pulse.allowed || pulse.cancelRequested) {
          abort(
            "remote_turn_lease_denied",
            "The remote-turn execution lease was revoked.",
          );
          return false;
        }

        const now = Date.now();
        if (
          !isFiniteTimestamp(pulse.leaseExpiresAt) ||
          !isFiniteTimestamp(pulse.hardExpiresAt) ||
          !isFiniteTimestamp(pulse.quiescentAfterAt) ||
          pulse.quiescentAfterAt < pulse.leaseExpiresAt
        ) {
          abort(
            "remote_turn_lease_denied",
            "The remote-turn heartbeat returned an invalid lease ACK.",
          );
          return false;
        }

        // A heartbeat can shorten the hard deadline, but it can never extend
        // the immutable cap acknowledged by the original claim.
        const hardExpiresAt = Math.min(
          currentLease.hardExpiresAt,
          pulse.hardExpiresAt,
        );
        const leaseExpiresAt = Math.min(pulse.leaseExpiresAt, hardExpiresAt);
        if (Math.min(leaseExpiresAt, hardExpiresAt) <= now) {
          abort(
            "remote_turn_lease_expired",
            "The remote-turn execution lease expired.",
          );
          return false;
        }
        currentLease = {
          ...currentLease,
          leaseExpiresAt,
          hardExpiresAt,
          quiescentAfterAt: pulse.quiescentAfterAt,
        };
        armDeadline();
        scheduleHeartbeat();
        return true;
      } catch (error) {
        if (closed || signal.aborted) return false;
        deps.log?.(
          "warn",
          failClosed
            ? `[remote-turn] Pre-dispatch lease confirmation failed for ${args.requestId}; refusing local execution.`
            : `[remote-turn] Lease heartbeat failed for ${args.requestId}; the local run remains bounded by its last acknowledged deadline.`,
          error,
        );
        if (failClosed) {
          abort(
            "remote_turn_lease_denied",
            "The remote-turn execution lease could not be confirmed before dispatch.",
          );
        } else {
          scheduleHeartbeat(Math.min(ERROR_RETRY_MS, heartbeatIntervalMs));
        }
        return false;
      }
    };

    const heartbeat = (failClosed = false): Promise<boolean> => {
      if (heartbeatInFlight) return heartbeatInFlight;
      const pulse = runHeartbeat(failClosed).finally(() => {
        if (heartbeatInFlight === pulse) {
          heartbeatInFlight = null;
        }
      });
      heartbeatInFlight = pulse;
      return pulse;
    };

    const awaitHeartbeatOrAbort = async (
      pulse: Promise<boolean>,
    ): Promise<boolean> =>
      await new Promise<boolean>((resolve, reject) => {
        const rejectForAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new RemoteTurnAttemptAbortError(
                  abortCode ?? "remote_turn_lease_denied",
                  "The remote-turn execution lease ended during heartbeat.",
                ),
          );
        if (signal.aborted) {
          rejectForAbort();
          return;
        }
        const onAbort = () => rejectForAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        pulse.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });

    const confirmDispatchLease = async (): Promise<void> => {
      heartbeatTimer?.();
      heartbeatTimer = null;
      // If a scheduled pulse raced local preparation, join it and then take
      // one fresh pulse so the ACK is adjacent to the physical dispatch.
      if (heartbeatInFlight) {
        await awaitHeartbeatOrAbort(heartbeatInFlight);
      }
      if (
        closed ||
        signal.aborted ||
        !(await awaitHeartbeatOrAbort(heartbeat(true)))
      ) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new RemoteTurnAttemptAbortError(
              "remote_turn_lease_denied",
              "The remote-turn execution lease was not confirmed before dispatch.",
            );
      }
    };

    armDeadline();
    scheduleHeartbeat();

    return {
      signal,
      confirmDispatchLease,
      getAbortCode: () => abortCode,
      getHardExpiresAt: () => currentLease.hardExpiresAt,
      abortForBridgeStop: () =>
        abort("remote_turn_bridge_stopped", "The remote-turn bridge stopped."),
      close: () => {
        if (closed) return;
        closed = true;
        clearTimers();
        connectorsRuntime.runSync(Scope.close(abortScope, Exit.void));
      },
    };
  };

  const syncPendingWithSubscription = (events: RemoteTurnRequestEvent[]) => {
    const activeRequestIds = new Set<string>();

    for (const event of [...events].sort(sortEventsAsc)) {
      const requestId = getTrimmedString(event.requestId);
      if (!requestId) {
        continue;
      }

      if (!isConnectorRequest(asRecord(event.payload))) {
        continue;
      }

      activeRequestIds.add(requestId);
      if (!pending.has(requestId)) {
        pending.set(requestId, {
          event,
          nextAttemptAt: Date.now(),
          attemptId: createAttemptId(),
        });
      } else {
        const existing = pending.get(requestId)!;
        pending.set(requestId, {
          event,
          nextAttemptAt: existing.nextAttemptAt,
          attemptId: existing.attemptId,
        });
      }
    }

    for (const requestId of [...pending.keys()]) {
      if (!activeRequestIds.has(requestId)) {
        pending.delete(requestId);
      }
    }

    void processPending();
  };

  const processPending = async () => {
    if (processing || !running || !deps.isEnabled()) {
      return;
    }
    if (deps.isRunnerBusy()) {
      scheduleRetry(BUSY_RETRY_MS);
      return;
    }

    processing = true;
    try {
      while (running && deps.isEnabled() && !deps.isRunnerBusy()) {
        const now = Date.now();
        const next = [...pending.values()]
          .filter((entry) => entry.nextAttemptAt <= now)
          .sort((left, right) => sortEventsAsc(left.event, right.event))[0];

        if (!next) {
          const earliestRetryAt = [...pending.values()]
            .map((entry) => entry.nextAttemptAt)
            .sort((left, right) => left - right)[0];
          if (typeof earliestRetryAt === "number") {
            scheduleRetry(Math.max(0, earliestRetryAt - Date.now()));
          }
          return;
        }

        const event = next.event;
        const requestId = getTrimmedString(event.requestId);
        if (!requestId) {
          continue;
        }

        const payload = asRecord(event.payload);
        const ownerGeneration = getTrimmedString(event.ownerGeneration);
        const conversationId = getTrimmedString(payload?.conversationId);
        const userPrompt = getTrimmedString(payload?.text);
        const agentType = getTrimmedString(payload?.agentType) || undefined;
        const provider = getTrimmedString(payload?.provider) || undefined;
        const channelEnvelope = asRecord(event.channelEnvelope);
        const externalMessageId =
          getTrimmedString(channelEnvelope?.externalMessageId) || undefined;
        const deliveryMeta = asRecord(payload?.deliveryMeta);
        const modelOverride =
          getTrimmedString(deliveryMeta?.mobileModel) || undefined;
        const attachments = getRuntimeAttachments(payload?.mediaRefs);
        const effectiveUserPrompt = userPromptWithAttachmentContext(
          userPrompt,
          attachments,
        );

        if (
          !conversationId ||
          !ownerGeneration ||
          (!effectiveUserPrompt && attachments.length === 0)
        ) {
          pending.delete(requestId);
          deps.log?.(
            "warn",
            `[remote-turn] Dropping malformed request ${requestId}.`,
          );
          continue;
        }

        let receipt: RemoteTurnAttemptReceipt;
        try {
          receipt = await deps.claimRemoteTurn({
            requestId,
            attemptId: next.attemptId,
            conversationId,
          });
        } catch (error) {
          // Never run after an ambiguous claim. Retain the same attempt id for
          // an idempotent retry if the request remains visible; if the server
          // reserved it, its subscription row will disappear and expiry
          // reconciliation will safely recover it.
          pending.set(requestId, {
            ...next,
            nextAttemptAt: Date.now() + ERROR_RETRY_MS,
          });
          deps.log?.(
            "warn",
            `[remote-turn] Claim failed for ${requestId}; refusing to start without a positive lease ACK.`,
            error,
          );
          scheduleRetry(ERROR_RETRY_MS);
          return;
        }

        if (!isValidClaimReceipt(receipt, next.attemptId, Date.now())) {
          pending.delete(requestId);
          deps.log?.(
            "warn",
            `[remote-turn] Claim was not acquired for ${requestId} (status=${receipt.status}); local execution was skipped.`,
          );
          continue;
        }

        if (!running || !deps.isEnabled()) {
          pending.delete(requestId);
          try {
            await retryExactTerminalMutation(
              "Post-claim shutdown ACK",
              receipt.hardExpiresAt,
              async () =>
                await deps.finishRemoteTurnAttempt({
                  requestId,
                  attemptId: next.attemptId,
                  conversationId,
                  outcome: "aborted",
                }),
            );
          } catch {
            // The exact lease remains the recovery authority if shutdown
            // prevents its terminal ACK from reaching the server.
          }
          continue;
        }

        const monitor = createAttemptMonitor({
          requestId,
          attemptId: next.attemptId,
          conversationId,
          receipt,
        });
        abortActiveAttempt = monitor.abortForBridgeStop;

        let result: RemoteTurnRunResult | undefined;
        let thrownError: unknown;
        try {
          result = await deps.runLocalTurn({
            requestId,
            attemptId: next.attemptId,
            conversationId,
            ownerGeneration,
            userPrompt: effectiveUserPrompt || "The user sent an attachment.",
            agentType,
            modelOverride,
            provider,
            externalMessageId,
            attachments,
            signal: monitor.signal,
            confirmDispatchLease: monitor.confirmDispatchLease,
          });
        } catch (error) {
          thrownError = error;
        }

        if (result?.status === "uncertain") {
          deps.log?.(
            "error",
            `[remote-turn] Worker transport became ambiguous for ${requestId}; withholding terminal ACK so the durable lease remains authoritative.`,
          );
          monitor.close();
          if (abortActiveAttempt === monitor.abortForBridgeStop) {
            abortActiveAttempt = null;
          }
          pending.delete(requestId);
          continue;
        }

        if (
          monitor.signal.aborted ||
          thrownError !== undefined ||
          !result ||
          result.status !== "ok"
        ) {
          const outcome = terminalOutcomeFor(
            monitor.getAbortCode(),
            monitor.signal,
            result,
          );
          if (result?.status === "error") {
            deps.log?.(
              "warn",
              `[remote-turn] Local run failed for ${requestId}: ${result.error}`,
            );
          } else if (thrownError !== undefined) {
            deps.log?.(
              "warn",
              `[remote-turn] Local run threw for ${requestId}.`,
              thrownError,
            );
          }
          try {
            await retryExactTerminalMutation(
              `Terminal ${outcome} ACK`,
              monitor.getHardExpiresAt(),
              async () =>
                await deps.finishRemoteTurnAttempt({
                  requestId,
                  attemptId: next.attemptId,
                  conversationId,
                  outcome,
                }),
              !monitor.signal.aborted ||
                monitor.getAbortCode() === "remote_turn_bridge_stopped"
                ? monitor.signal
                : undefined,
            );
          } catch {
            // The exact server lease remains the recovery authority.
          } finally {
            monitor.close();
            if (abortActiveAttempt === monitor.abortForBridgeStop) {
              abortActiveAttempt = null;
            }
            pending.delete(requestId);
          }
          continue;
        }

        const finalText = result.finalText.trim() || EMPTY_RESPONSE_TEXT;
        try {
          await retryExactTerminalMutation(
            "Completion ACK",
            monitor.getHardExpiresAt(),
            async () =>
              await deps.completeConnectorTurn({
                requestId,
                attemptId: next.attemptId,
                conversationId,
                text: finalText,
              }),
            monitor.signal,
          );
        } catch {
          // The provider may have completed, so never requeue it as a failed
          // execution. The exact lease and server watchdog reconcile the
          // ambiguous completion without a concurrent local replay.
        } finally {
          monitor.close();
          if (abortActiveAttempt === monitor.abortForBridgeStop) {
            abortActiveAttempt = null;
          }
          pending.delete(requestId);
        }
      }
    } finally {
      processing = false;
    }
  };

  const start = () => {
    if (unsubscribeRemoteTurns) {
      unsubscribeRemoteTurns();
      unsubscribeRemoteTurns = null;
    }
    running = true;
    unsubscribeRemoteTurns = deps.subscribeRemoteTurnRequests({
      deviceId: deps.deviceId,
      since: Date.now() - startupLookbackMs,
      onUpdate: syncPendingWithSubscription,
      onError: (error) => {
        deps.log?.("error", "[remote-turn] Subscription failed.", error);
      },
    });
  };

  const stop = () => {
    running = false;
    abortActiveAttempt?.();
    abortActiveAttempt = null;
    clearRetryTimer();
    unsubscribeRemoteTurns?.();
    unsubscribeRemoteTurns = null;
    pending.clear();
  };

  const kick = () => {
    if (!running) {
      return;
    }
    clearRetryTimer();
    void processPending();
  };

  return {
    start,
    stop,
    kick,
    getPendingRequestIds: () => [...pending.keys()],
  };
};
