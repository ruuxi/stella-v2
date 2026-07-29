import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";

type CloudAgentThreadRow = {
  threadId: string;
  originDeviceId: string;
  originConversationId: string;
  description: string;
  agentType: string;
  status: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type CloudAgentLifecycleMonitorOptions = {
  convexApi: unknown;
  deviceId: string;
  subscribeQuery: (
    query: unknown,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => (() => void) | null;
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  hasDurableLifecycleEvent: (event: AgentLifecycleEvent) => boolean;
  onLifecycleEvent: (event: AgentLifecycleEvent) => void;
};

const RETRY_DELAY_MS = 5_000;

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

const parseThreadRow = (
  value: unknown,
  deviceId: string,
): CloudAgentThreadRow | null => {
  const record = asRecord(value);
  if (!record) return null;
  const threadId = readString(record, "threadId");
  const originDeviceId = readString(record, "originDeviceId");
  const originConversationId = readString(record, "originConversationId");
  const description = readString(record, "description");
  const agentType = readString(record, "agentType");
  const status = readString(record, "status");
  const createdAt = readTimestamp(record, "createdAt");
  const updatedAt = readTimestamp(record, "updatedAt");
  if (
    !threadId ||
    originDeviceId !== deviceId ||
    !originConversationId ||
    !description ||
    !agentType ||
    !status ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    threadId,
    originDeviceId,
    originConversationId,
    description,
    agentType,
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
      eventId: `cloud:${row.threadId}:completed:${row.updatedAt}`,
      result: readResult(row) || "The cloud agent completed without a report.",
    };
  }
  if (row.status === "canceled") {
    return {
      ...base,
      type: "agent-canceled",
      eventId: `cloud:${row.threadId}:canceled:${row.updatedAt}`,
      error: row.errorMessage ?? "The cloud agent was canceled.",
    };
  }
  if (row.status === "failed") {
    return {
      ...base,
      type: "agent-failed",
      eventId: `cloud:${row.threadId}:failed:${row.updatedAt}`,
      error: row.errorMessage ?? "The cloud agent failed.",
    };
  }
  return null;
};

/**
 * Mirrors desktop-originated cloud threads into the local runtime's existing
 * lifecycle channel. Convex keeps terminal rows in the subscription until the
 * local event and its orchestrator reminder are durable, so closing Stella
 * while an agent runs does not lose the completion.
 */
export const createCloudAgentLifecycleMonitor = (
  options: CloudAgentLifecycleMonitorOptions,
) => {
  const queryRef = () =>
    (
      options.convexApi as {
        cloud_apps: { listMyDeviceAgentThreads: unknown };
      }
    ).cloud_apps.listMyDeviceAgentThreads;
  const acknowledgeRef = () =>
    (
      options.convexApi as {
        cloud_apps: {
          acknowledgeMyDeviceAgentThreadDelivery: unknown;
        };
      }
    ).cloud_apps.acknowledgeMyDeviceAgentThreadDelivery;

  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  const processing = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();

  const scheduleRetry = (row: CloudAgentThreadRow) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      void processRow(row);
    }, RETRY_DELAY_MS);
    timer.unref?.();
    retryTimers.add(timer);
  };

  const acknowledge = async (row: CloudAgentThreadRow) => {
    try {
      await options.mutation(acknowledgeRef(), {
        threadId: row.threadId,
        originDeviceId: options.deviceId,
      });
    } catch {
      scheduleRetry(row);
    }
  };

  const processRow = async (row: CloudAgentThreadRow) => {
    const event = toLifecycleEvent(row);
    if (!event?.eventId || processing.has(event.eventId) || stopped) return;
    processing.add(event.eventId);
    try {
      if (!options.hasDurableLifecycleEvent(event)) {
        options.onLifecycleEvent(event);
      }
      if (options.hasDurableLifecycleEvent(event)) {
        await acknowledge(row);
      }
    } finally {
      processing.delete(event.eventId);
    }
  };

  const start = () => {
    stopped = false;
    unsubscribe?.();
    unsubscribe = options.subscribeQuery(
      queryRef(),
      { originDeviceId: options.deviceId, limit: 100 },
      (value) => {
        if (!Array.isArray(value)) return;
        for (const entry of value) {
          const row = parseThreadRow(entry, options.deviceId);
          if (row) void processRow(row);
        }
      },
    );
  };

  const stop = () => {
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    processing.clear();
  };

  return { start, stop };
};
