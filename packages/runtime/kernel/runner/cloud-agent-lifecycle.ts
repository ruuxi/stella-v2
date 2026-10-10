import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import { forkDelayedCall } from "./cloud-effect-runtime.js";

type CloudAgentThreadRow = {
  threadId: string;
  cloudConversationId: string;
  originDeviceId: string;
  originConversationId: string;
  description: string;
  agentType: string;
  placement: "cloud" | "computer";
  executorDeviceId: string | null;
  ownerGeneration: string;
  attemptGeneration: number;
  status: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type CloudAgentLifecycleMonitorOptions = {
  deviceId: string;
  /** The verified owner generation; this device's rows are scoped to it. */
  getOwnerGeneration: () => Promise<string>;
  /** The backend's `agentThreads.forDevice` view. */
  watchDeviceThreads: (
    args: { originDeviceId: string; ownerGeneration: string; limit: number },
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => (() => void) | null;
  /** The backend's `agentThreads.acknowledgeDelivery` call. */
  acknowledge: (args: {
    threadId: string;
    originDeviceId: string;
    ownerGeneration: string;
    attemptGeneration: number;
    terminalUpdatedAt: number;
  }) => Promise<unknown>;
  hasDurableLifecycleEvent: (event: AgentLifecycleEvent) => boolean;
  reportsLocally?: (row: CloudAgentThreadRow) => boolean;
  onLifecycleEvent: (event: AgentLifecycleEvent) => void | Promise<void>;
  /** Persist exact control authority before a terminal row can be ACKed. */
  onControlReceipt?: (row: CloudAgentThreadRow) => void | Promise<void>;
  /** Account-only subscriptions must stay dormant for anonymous sessions. */
  canStart?: () => boolean;
  retryDelayMs?: number;
};

const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
};

const readTimestamp = (
  record: Record<string, unknown>,
  key: string,
): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
};

const readAttemptGeneration = (
  record: Record<string, unknown>,
): number | null => {
  const value = record.attemptGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
};

const parseThreadRow = (
  value: unknown,
  deviceId: string,
): CloudAgentThreadRow | null => {
  const record = asRecord(value);
  if (!record) return null;
  const threadId = readString(record, "threadId");
  const cloudConversationId =
    readString(record, "cloudConversationId") ??
    readString(record, "conversationId");
  const originDeviceId = readString(record, "originDeviceId");
  const originConversationId = readString(record, "originConversationId");
  const description = readString(record, "description");
  const agentType = readString(record, "agentType");
  const ownerGeneration = readString(record, "ownerGeneration");
  const attemptGeneration = readAttemptGeneration(record);
  const status = readString(record, "status");
  const createdAt = readTimestamp(record, "createdAt");
  const updatedAt = readTimestamp(record, "updatedAt");
  if (
    !threadId ||
    !cloudConversationId ||
    originDeviceId !== deviceId ||
    !originConversationId ||
    !description ||
    !agentType ||
    !ownerGeneration ||
    attemptGeneration === null ||
    !status ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    threadId,
    cloudConversationId,
    originDeviceId,
    originConversationId,
    description,
    agentType,
    placement: record.placement === "computer" ? "computer" : "cloud",
    executorDeviceId: readString(record, "executorDeviceId"),
    ownerGeneration,
    attemptGeneration,
    status,
    resultJson: readString(record, "resultJson"),
    errorMessage: readString(record, "errorMessage"),
    createdAt,
    updatedAt,
  };
};

const readResult = (row: CloudAgentThreadRow): string => {
  if (!row.resultJson) return "";
  try {
    const parsed = asRecord(JSON.parse(row.resultJson));
    const finalText = parsed ? readString(parsed, "finalText") : null;
    return finalText ?? row.resultJson;
  } catch {
    return row.resultJson;
  }
};

const toLifecycleEvent = (
  row: CloudAgentThreadRow,
): AgentLifecycleEvent | null => {
  const base = {
    conversationId: row.originConversationId,
    agentId: row.threadId,
    agentType: row.agentType,
    description: row.description,
    attemptGeneration: row.attemptGeneration,
    ownerGeneration: row.ownerGeneration,
    // Cloud rows already feed the shared Activity surface directly. This
    // bridge exists only to wake the local orchestrator, so duplicating the
    // same thread into local Activity would render it twice.
    audience: "orchestrator-only" as const,
  };
  if (row.status === "running") {
    return null;
  }
  if (row.status === "completed") {
    return {
      ...base,
      type: "agent-completed",
      eventId: `${row.threadId}:${row.ownerGeneration}:${row.attemptGeneration}:agent-completed`,
      result: readResult(row) || "The cloud agent completed without a report.",
    };
  }
  if (row.status === "canceled") {
    return {
      ...base,
      type: "agent-canceled",
      eventId: `${row.threadId}:${row.ownerGeneration}:${row.attemptGeneration}:agent-canceled`,
      error: row.errorMessage ?? "The cloud agent was canceled.",
    };
  }
  if (row.status === "failed") {
    return {
      ...base,
      type: "agent-failed",
      eventId: `${row.threadId}:${row.ownerGeneration}:${row.attemptGeneration}:agent-failed`,
      error: row.errorMessage ?? "The cloud agent failed.",
    };
  }
  return null;
};

/**
 * Mirrors desktop-originated cloud threads into the local runtime's existing
 * lifecycle channel. The backend keeps terminal rows in the view until the
 * local event and its orchestrator reminder are durable, so closing Stella
 * while an agent runs does not lose the completion.
 */
export const createCloudAgentLifecycleMonitor = (
  options: CloudAgentLifecycleMonitorOptions,
) => {
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let epoch = 0;
  let activeOwnerGeneration: string | null = null;
  const inFlight = new Map<string, Promise<void>>();
  /** Cancel thunks for pending per-row retry fibers (the old timer Set). */
  const retryCancels = new Map<string, () => void>();
  const failedAttempts = new Map<string, number>();
  let restartCancel: (() => void) | null = null;

  const scheduleRetry = (row: CloudAgentThreadRow) => {
    if (stopped || row.ownerGeneration !== activeOwnerGeneration) return;
    const event = toLifecycleEvent(row);
    const retryKey = event?.eventId;
    if (!retryKey || retryCancels.has(retryKey)) return;
    const failures = failedAttempts.get(retryKey) ?? 0;
    failedAttempts.set(retryKey, failures + 1);
    const cancel = forkDelayedCall(
      Math.min(
        MAX_RETRY_DELAY_MS,
        (options.retryDelayMs ?? RETRY_DELAY_MS) * 2 ** Math.min(failures, 16),
      ),
      () => {
        retryCancels.delete(retryKey);
        if (row.ownerGeneration === activeOwnerGeneration) {
          void processRow(row);
        }
      },
    );
    retryCancels.set(retryKey, cancel);
  };

  const acknowledge = async (row: CloudAgentThreadRow): Promise<boolean> => {
    try {
      await options.acknowledge({
        threadId: row.threadId,
        originDeviceId: options.deviceId,
        ownerGeneration: row.ownerGeneration,
        attemptGeneration: row.attemptGeneration,
        terminalUpdatedAt: row.updatedAt,
      });
      const event = toLifecycleEvent(row);
      if (event?.eventId) failedAttempts.delete(event.eventId);
      return true;
    } catch {
      scheduleRetry(row);
      return false;
    }
  };

  const deliverRow = async (
    row: CloudAgentThreadRow,
    event: AgentLifecycleEvent | null,
  ) => {
    try {
      if (options.reportsLocally?.(row)) {
        if (event) await acknowledge(row);
        return;
      }
      await options.onControlReceipt?.(row);
      if (!event?.eventId) return;
      const failures = failedAttempts.get(event.eventId) ?? 0;
      if (
        failures >= MAX_DELIVERY_ATTEMPTS &&
        !options.hasDurableLifecycleEvent(event)
      ) {
        console.warn(
          `[cloud-agent-lifecycle] giving up on ${event.type} for ${event.agentId} after ${failures} failed deliveries`,
        );
        await acknowledge(row);
        return;
      }
      if (!options.hasDurableLifecycleEvent(event)) {
        await options.onLifecycleEvent(event);
      }
      if (options.hasDurableLifecycleEvent(event)) {
        await acknowledge(row);
      } else {
        // Admission and local persistence are distinct phases. Keep the
        // backend row unacknowledged and retry until the exact event is durably visible;
        // a callback that merely started an async turn is not an ACK.
        scheduleRetry(row);
      }
    } catch {
      if (event) scheduleRetry(row);
    }
  };

  const processRow = async (row: CloudAgentThreadRow): Promise<void> => {
    const event = toLifecycleEvent(row);
    const processingKey =
      event?.eventId ??
      `${row.threadId}:${row.ownerGeneration}:${row.attemptGeneration}:${row.updatedAt}:control`;
    const existing = inFlight.get(processingKey);
    if (existing) {
      await existing;
      return;
    }
    if (stopped || row.ownerGeneration !== activeOwnerGeneration) return;
    const delivery = deliverRow(row, event);
    inFlight.set(processingKey, delivery);
    try {
      await delivery;
    } finally {
      inFlight.delete(processingKey);
    }
  };

  const cancelRowRetries = () => {
    for (const cancel of retryCancels.values()) cancel();
    retryCancels.clear();
  };

  const scheduleRestart = () => {
    if (stopped || restartCancel || options.canStart?.() === false) return;
    restartCancel = forkDelayedCall(
      options.retryDelayMs ?? RETRY_DELAY_MS,
      () => {
        restartCancel = null;
        start();
      },
    );
  };

  const start = () => {
    if (options.canStart?.() === false) {
      stop();
      return;
    }
    stopped = false;
    const startEpoch = ++epoch;
    unsubscribe?.();
    unsubscribe = null;
    activeOwnerGeneration = null;
    restartCancel?.();
    restartCancel = null;
    cancelRowRetries();
    void options
      .getOwnerGeneration()
      .then((value) => {
        if (stopped || startEpoch !== epoch) return;
        const ownerGeneration = value.trim() || null;
        if (!ownerGeneration) {
          scheduleRestart();
          return;
        }
        activeOwnerGeneration = ownerGeneration;
        unsubscribe = options.watchDeviceThreads(
          {
            originDeviceId: options.deviceId,
            ownerGeneration,
            limit: 100,
          },
          (rows) => {
            if (
              stopped ||
              startEpoch !== epoch ||
              activeOwnerGeneration !== ownerGeneration ||
              !Array.isArray(rows)
            ) {
              return;
            }
            for (const entry of rows) {
              const row = parseThreadRow(entry, options.deviceId);
              if (row?.ownerGeneration === ownerGeneration) {
                void processRow(row);
              }
            }
          },
          () => {
            if (startEpoch !== epoch) return;
            unsubscribe?.();
            unsubscribe = null;
            activeOwnerGeneration = null;
            cancelRowRetries();
            scheduleRestart();
          },
        );
      })
      .catch(() => {
        if (stopped || startEpoch !== epoch) return;
        scheduleRestart();
      });
  };

  const stop = () => {
    stopped = true;
    epoch += 1;
    unsubscribe?.();
    unsubscribe = null;
    activeOwnerGeneration = null;
    restartCancel?.();
    restartCancel = null;
    cancelRowRetries();
  };

  return { start, stop };
};
