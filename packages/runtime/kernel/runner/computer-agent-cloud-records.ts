import type { RuntimeStore } from "../storage/runtime-store.js";
import type { AgentToolSnapshot } from "../tools/types.js";

const CLOUD_RECORD_TIMEOUT_MS = 30_000;
const NO_AUTH_RETRY_MS = 4_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 60_000;

type LocalTerminalStatus = "completed" | "error" | "canceled";

type ComputerAgentStartPayload = {
  conversationId: string;
  description: string;
  agentType: string;
};

type ComputerAgentTerminalPayload = {
  status: LocalTerminalStatus;
  result?: string;
  error?: string;
};

type ComputerAgentCancelPayload = {
  reason?: string;
};

type ComputerAgentCloudOutboxStore = Pick<
  RuntimeStore,
  | "putComputerAgentCloudOutbox"
  | "listComputerAgentCloudOutbox"
  | "countComputerAgentCloudOutbox"
  | "markComputerAgentCloudOutboxRetry"
  | "resumeComputerAgentCloudOutbox"
  | "getComputerAgentCloudThreadOwnerScope"
  | "hasUnscopedComputerAgentCloudOutbox"
  | "bindComputerAgentCloudThreadOwnerScope"
  | "deleteComputerAgentCloudOutbox"
>;

export type ComputerAgentCloudRecords = {
  create: (args: {
    agentId: string;
    conversationId: string;
    description: string;
    agentType: string;
    attemptGeneration: number;
  }) => Promise<{ agentId: string }>;
  complete: (args: {
    agentId: string;
    attemptGeneration: number;
    status: LocalTerminalStatus;
    result?: string;
    error?: string;
  }) => Promise<void>;
  get: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancel: (
    agentId: string,
    reason?: string,
    attemptGeneration?: number,
  ) => Promise<{ canceled: boolean }>;
  pending: () => number;
  resume: () => void;
  stop: () => void;
};

type ComputerAgentCloudRecordOptions = {
  convexApi: unknown;
  deviceId: string;
  store: ComputerAgentCloudOutboxStore;
  getAuthToken: () => string | null;
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  query: (ref: unknown, args: unknown) => Promise<unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Stella's cloud did not acknowledge the computer agent within 30s.",
              ),
            ),
          CLOUD_RECORD_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const parseSnapshot = (value: unknown): AgentToolSnapshot | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = record.id;
  const status = record.status;
  const description = record.description;
  const startedAt = record.startedAt;
  const completedAt = record.completedAt;
  if (
    typeof id !== "string" ||
    !["running", "completed", "error", "canceled"].includes(
      typeof status === "string" ? status : "",
    ) ||
    typeof description !== "string" ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    (completedAt !== null &&
      (typeof completedAt !== "number" || !Number.isFinite(completedAt)))
  ) {
    return null;
  }
  return {
    id,
    status: status as AgentToolSnapshot["status"],
    description,
    startedAt,
    completedAt,
    ...(typeof record.result === "string" ? { result: record.result } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
};

const outboxId = (
  deviceId: string,
  threadId: string,
  attemptGeneration: number,
  kind: "start" | "terminal" | "cancel",
): string =>
  `computer-agent-cloud:${JSON.stringify([
    deviceId,
    threadId,
    attemptGeneration,
    kind,
  ])}`;

const retryDelay = (attempts: number): number =>
  Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts, 7));

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error);

const parsePayload = <T>(payloadJson: string): T => JSON.parse(payloadJson) as T;

/**
 * Stable routing lane for one Convex identity. This is not an authentication
 * decision: Convex still verifies the JWT. It only prevents a durable row
 * admitted under account A from ever being attempted with account B's client.
 */
export const resolveConvexJwtOwnerScope = (
  token: string | null | undefined,
): string | null => {
  const normalized = token?.trim();
  if (!normalized) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(normalized.split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    const tokenIdentifier =
      typeof payload.tokenIdentifier === "string"
        ? payload.tokenIdentifier.trim()
        : "";
    if (tokenIdentifier) {
      return `token:${JSON.stringify(tokenIdentifier)}`;
    }
    const issuer = typeof payload.iss === "string" ? payload.iss.trim() : "";
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!issuer || !subject) return null;
    return `subject:${JSON.stringify([issuer, subject])}`;
  } catch {
    return null;
  }
};

/**
 * Authenticated lifecycle projection for agents that execute on this
 * computer while their conversation is cloud-owned.
 *
 * Every mutation is admitted to the runtime's operational SQLite outbox
 * before network I/O. The ordered drain survives worker restarts and retries
 * on auth/config/connectivity recovery. Convex independently fences each
 * transition by attemptGeneration, so an acknowledged response lost locally
 * or a late old-generation retry is idempotent.
 */
export const createComputerAgentCloudRecords = (
  options: ComputerAgentCloudRecordOptions,
): ComputerAgentCloudRecords => {
  const api = options.convexApi as {
    local_agent_threads: {
      startMyComputerAgentThread: unknown;
      completeMyComputerAgentThread: unknown;
      getMyComputerAgentThread: unknown;
      cancelMyComputerAgentThread: unknown;
    };
  };

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let draining = false;
  let stopped = false;
  let lastKnownOwnerScope = resolveConvexJwtOwnerScope(
    options.getAuthToken(),
  );

  const currentOwnerScope = (): string | null => {
    const scope = resolveConvexJwtOwnerScope(options.getAuthToken());
    if (scope) lastKnownOwnerScope = scope;
    return scope;
  };

  const ownerScopeForThread = (threadId: string): string | null => {
    const existing =
      options.store.getComputerAgentCloudThreadOwnerScope(threadId);
    if (existing) return existing;
    // Rows written by the first unscoped outbox build have no trustworthy
    // identity evidence. Never adopt them into whichever account happens to
    // be signed in after upgrade.
    if (options.store.hasUnscopedComputerAgentCloudOutbox(threadId)) {
      return null;
    }
    const candidate = currentOwnerScope() ?? lastKnownOwnerScope;
    return candidate
      ? options.store.bindComputerAgentCloudThreadOwnerScope(
          threadId,
          candidate,
        )
      : null;
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
    retryTimer.unref?.();
  };

  const deliver = async (
    entry: ReturnType<
      ComputerAgentCloudOutboxStore["listComputerAgentCloudOutbox"]
    >[number],
  ): Promise<void> => {
    if (entry.kind === "start") {
      const payload = parsePayload<ComputerAgentStartPayload>(
        entry.payloadJson,
      );
      const raw = await withTimeout(
        options.mutation(api.local_agent_threads.startMyComputerAgentThread, {
          threadId: entry.threadId,
          conversationId: payload.conversationId,
          originDeviceId: options.deviceId,
          description: payload.description,
          agentType: payload.agentType,
          attemptGeneration: entry.attemptGeneration,
        }),
      );
      if (asRecord(raw)?.agentId !== entry.threadId) {
        throw new Error(
          "Stella's cloud returned the wrong computer-agent thread id.",
        );
      }
      return;
    }

    if (entry.kind === "terminal") {
      const payload = parsePayload<ComputerAgentTerminalPayload>(
        entry.payloadJson,
      );
      await withTimeout(
        options.mutation(
          api.local_agent_threads.completeMyComputerAgentThread,
          {
            threadId: entry.threadId,
            originDeviceId: options.deviceId,
            attemptGeneration: entry.attemptGeneration,
            status: payload.status === "error" ? "failed" : payload.status,
            ...(payload.result ? { result: payload.result } : {}),
            ...(payload.error ? { error: payload.error } : {}),
          },
        ),
      );
      return;
    }

    const payload = parsePayload<ComputerAgentCancelPayload>(entry.payloadJson);
    await withTimeout(
      options.mutation(api.local_agent_threads.cancelMyComputerAgentThread, {
        threadId: entry.threadId,
        originDeviceId: options.deviceId,
        attemptGeneration: entry.attemptGeneration,
        ...(payload.reason ? { reason: payload.reason } : {}),
      }),
    );
  };

  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        const ownerScope = currentOwnerScope();
        if (!ownerScope) {
          scheduleDrain(NO_AUTH_RETRY_MS);
          return;
        }
        const entry = options.store.listComputerAgentCloudOutbox(
          ownerScope,
          1,
        )[0];
        if (!entry) return;
        const now = Date.now();
        if (entry.nextAttemptAt > now) {
          scheduleDrain(entry.nextAttemptAt - now);
          return;
        }
        try {
          await deliver(entry);
          if (stopped) return;
          if (currentOwnerScope() !== ownerScope) {
            options.store.markComputerAgentCloudOutboxRetry({
              id: entry.id,
              error: "auth_identity_changed_during_delivery",
              nextAttemptAt: Date.now() + BASE_RETRY_MS,
            });
            scheduleDrain(0);
            return;
          }
          options.store.deleteComputerAgentCloudOutbox(entry.id);
        } catch (error) {
          if (stopped) return;
          const delayMs = retryDelay(entry.attempts);
          options.store.markComputerAgentCloudOutboxRetry({
            id: entry.id,
            error: errorMessage(error),
            nextAttemptAt: Date.now() + delayMs,
          });
          scheduleDrain(
            currentOwnerScope() === ownerScope ? delayMs : 0,
          );
          return;
        }
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = async (args: {
    kind: "start" | "terminal" | "cancel";
    threadId: string;
    attemptGeneration: number;
    payload: unknown;
  }): Promise<void> => {
    const ownerScope = ownerScopeForThread(args.threadId);
    options.store.putComputerAgentCloudOutbox({
      id: outboxId(
        options.deviceId,
        args.threadId,
        args.attemptGeneration,
        args.kind,
      ),
      kind: args.kind,
      threadId: args.threadId,
      attemptGeneration: args.attemptGeneration,
      ownerScope,
      payloadJson: JSON.stringify(args.payload),
    });
    await drain();
  };

  const records: ComputerAgentCloudRecords = {
    create: async (args) => {
      await enqueue({
        kind: "start",
        threadId: args.agentId,
        attemptGeneration: args.attemptGeneration,
        payload: {
          conversationId: args.conversationId,
          description: args.description,
          agentType: args.agentType,
        } satisfies ComputerAgentStartPayload,
      });
      return { agentId: args.agentId };
    },

    complete: async (args) => {
      await enqueue({
        kind: "terminal",
        threadId: args.agentId,
        attemptGeneration: args.attemptGeneration,
        payload: {
          status: args.status,
          ...(args.result ? { result: args.result } : {}),
          ...(args.error ? { error: args.error } : {}),
        } satisfies ComputerAgentTerminalPayload,
      });
    },

    get: async (agentId) => {
      if (!currentOwnerScope()) return null;
      try {
        return parseSnapshot(
          await withTimeout(
            options.query(api.local_agent_threads.getMyComputerAgentThread, {
              threadId: agentId,
              originDeviceId: options.deviceId,
            }),
          ),
        );
      } catch {
        return null;
      }
    },

    cancel: async (agentId, reason, attemptGeneration) => {
      if (attemptGeneration === undefined) {
        const ownerScope = currentOwnerScope();
        const boundOwner =
          options.store.getComputerAgentCloudThreadOwnerScope(agentId);
        if (!ownerScope || (boundOwner && boundOwner !== ownerScope)) {
          return { canceled: false };
        }
        try {
          const raw = await withTimeout(
            options.mutation(
              api.local_agent_threads.cancelMyComputerAgentThread,
              {
                threadId: agentId,
                originDeviceId: options.deviceId,
                ...(reason ? { reason } : {}),
              },
            ),
          );
          return { canceled: asRecord(raw)?.canceled === true };
        } catch {
          return { canceled: false };
        }
      }
      await enqueue({
        kind: "cancel",
        threadId: agentId,
        attemptGeneration,
        payload: {
          ...(reason ? { reason } : {}),
        } satisfies ComputerAgentCancelPayload,
      });
      // The local cancellation is durable even if Convex is temporarily
      // unavailable; canonical convergence continues in the background.
      return { canceled: true };
    },

    pending: () => options.store.countComputerAgentCloudOutbox(),
    resume: () => {
      stopped = false;
      const ownerScope = currentOwnerScope();
      if (ownerScope) {
        options.store.resumeComputerAgentCloudOutbox(ownerScope);
      }
      scheduleDrain(0);
    },
    stop: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };

  records.resume();
  return records;
};
