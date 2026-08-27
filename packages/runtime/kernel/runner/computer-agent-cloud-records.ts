import type { RuntimeStore } from "../storage/runtime-store.js";
import type { AgentToolSnapshot } from "../tools/types.js";
import {
  forkDelayedCall,
  raceWithTimeoutError,
} from "./cloud-effect-runtime.js";

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
  | "getComputerAgentCloudThreadAuthority"
  | "hasUnscopedComputerAgentCloudOutbox"
  | "isComputerAgentCloudGenerationRetired"
  | "bindComputerAgentCloudThreadAuthority"
  | "retireComputerAgentCloudGeneration"
  | "deleteComputerAgentCloudOutbox"
>;

export type ComputerAgentCloudRecords = {
  create: (args: {
    agentId: string;
    conversationId: string;
    description: string;
    agentType: string;
    attemptGeneration: number;
    ownerGeneration: string;
  }) => Promise<{ agentId: string }>;
  complete: (args: {
    agentId: string;
    attemptGeneration: number;
    status: LocalTerminalStatus;
    result?: string;
    error?: string;
    ownerGeneration: string;
  }) => Promise<void>;
  get: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancel: (
    agentId: string,
    reason?: string,
    attemptGeneration?: number,
    ownerGeneration?: string,
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

const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
  raceWithTimeoutError(
    promise,
    CLOUD_RECORD_TIMEOUT_MS,
    () =>
      new Error(
        "Stella's cloud did not acknowledge the computer agent within 30s.",
      ),
  );

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
  ownerGeneration: string,
  kind: "start" | "terminal" | "cancel",
): string =>
  `computer-agent-cloud:${JSON.stringify([
    deviceId,
    threadId,
    attemptGeneration,
    ownerGeneration,
    kind,
  ])}`;

const retryDelay = (attempts: number): number =>
  Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts, 7));

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error);

const parsePayload = <T>(payloadJson: string): T =>
  JSON.parse(payloadJson) as T;

const isOwnerGenerationStale = (error: unknown): boolean => {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return (
    data?.code === "OWNER_DATA_GENERATION_STALE" ||
    errorMessage(error).includes("OWNER_DATA_GENERATION_STALE")
  );
};

const convexErrorCode = (error: unknown): string | null => {
  const record = asRecord(error);
  const direct = record?.code;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = asRecord(record?.data)?.code;
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
};

export class CloudAgentStartAdmissionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(args: {
    code: string;
    message: string;
    retryable: boolean;
  }) {
    super(args.message);
    this.name = "CloudAgentStartAdmissionError";
    this.code = args.code;
    this.retryable = args.retryable;
  }
}

export const isCloudAgentStartAdmissionError = (
  error: unknown,
): error is CloudAgentStartAdmissionError =>
  error instanceof CloudAgentStartAdmissionError ||
  (asRecord(error)?.name === "CloudAgentStartAdmissionError" &&
    typeof asRecord(error)?.code === "string" &&
    typeof asRecord(error)?.retryable === "boolean");

type StartAdmissionWaiter = {
  state: "pending" | "acknowledged" | "rejected";
  error?: CloudAgentStartAdmissionError;
};

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
      Buffer.from(normalized.split(".")[1] ?? "", "base64url").toString("utf8"),
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

  /** Cancel thunk for the pending drain-delay fiber (the old `clearTimeout`). */
  let cancelRetryDelay: (() => void) | null = null;
  let activeDrainPromise: Promise<void> | null = null;
  let stopped = false;
  let lastKnownOwnerScope = resolveConvexJwtOwnerScope(options.getAuthToken());
  const startAdmissionWaiters = new Map<string, Set<StartAdmissionWaiter>>();

  const settleStartAdmission = (
    id: string,
    state: "acknowledged" | "rejected",
    error?: CloudAgentStartAdmissionError,
  ): void => {
    const waiters = startAdmissionWaiters.get(id);
    if (!waiters) return;
    for (const waiter of waiters) {
      waiter.state = state;
      waiter.error = error;
    }
    startAdmissionWaiters.delete(id);
  };

  const admissionError = (args: {
    code: string;
    retryable: boolean;
    message: string;
  }): CloudAgentStartAdmissionError =>
    new CloudAgentStartAdmissionError(args);

  const currentOwnerScope = (): string | null => {
    const scope = resolveConvexJwtOwnerScope(options.getAuthToken());
    if (scope) lastKnownOwnerScope = scope;
    return scope;
  };

  const authorityForThread = (
    threadId: string,
    ownerGeneration: string,
    allowBind: boolean,
  ): { ownerScope: string; ownerGeneration: string } | null => {
    const existing =
      options.store.getComputerAgentCloudThreadAuthority(threadId);
    if (
      existing &&
      existing?.ownerGeneration === ownerGeneration &&
      existing.ownerScope === (currentOwnerScope() ?? lastKnownOwnerScope)
    ) {
      return existing;
    }
    // Rows written by the first unscoped outbox build have no trustworthy
    // identity evidence. Never adopt them into whichever account happens to
    // be signed in after upgrade.
    if (options.store.hasUnscopedComputerAgentCloudOutbox(threadId)) {
      return null;
    }
    const candidate = currentOwnerScope() ?? lastKnownOwnerScope;
    if (
      !candidate ||
      options.store.isComputerAgentCloudGenerationRetired({
        threadId,
        ownerScope: candidate,
        ownerGeneration,
      })
    ) {
      return null;
    }
    return allowBind
      ? options.store.bindComputerAgentCloudThreadAuthority(
          threadId,
          candidate,
          ownerGeneration,
        )
      : null;
  };

  const scheduleDrain = (delayMs = 0): void => {
    if (stopped) return;
    if (cancelRetryDelay) cancelRetryDelay();
    cancelRetryDelay = forkDelayedCall(Math.max(0, delayMs), () => {
      cancelRetryDelay = null;
      void drain();
    });
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
          ownerGeneration: entry.ownerGeneration,
        }),
      );
      if (asRecord(raw)?.agentId !== entry.threadId) {
        throw admissionError({
          code: "COMPUTER_AGENT_START_PROTOCOL_INVALID",
          retryable: false,
          message:
            "Stella's cloud returned the wrong computer-agent thread id.",
        });
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
            ownerGeneration: entry.ownerGeneration,
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
        ownerGeneration: entry.ownerGeneration,
        ...(payload.reason ? { reason: payload.reason } : {}),
      }),
    );
  };

  const runDrain = async (): Promise<void> => {
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
      const authority = options.store.getComputerAgentCloudThreadAuthority(
        entry.threadId,
      );
      if (
        !entry.ownerGeneration ||
        !authority ||
        authority.ownerScope !== ownerScope ||
        authority.ownerGeneration !== entry.ownerGeneration
      ) {
        if (entry.kind === "start") {
          settleStartAdmission(
            entry.id,
            "rejected",
            admissionError({
              code: "OWNER_DATA_GENERATION_STALE",
              retryable: false,
              message:
                "OWNER_DATA_GENERATION_STALE: computer-agent start was rejected for a retired or mismatched owner generation.",
            }),
          );
        }
        if (entry.ownerGeneration) {
          options.store.retireComputerAgentCloudGeneration({
            threadId: entry.threadId,
            ownerScope,
            ownerGeneration: entry.ownerGeneration,
          });
        } else {
          options.store.deleteComputerAgentCloudOutbox(entry.id);
        }
        continue;
      }
      const now = Date.now();
      if (entry.nextAttemptAt > now) {
        scheduleDrain(entry.nextAttemptAt - now);
        return;
      }
      try {
        await deliver(entry);
        if (stopped) return;
        const ownerScopeAfterDelivery = currentOwnerScope();
        const authorityAfterDelivery =
          options.store.getComputerAgentCloudThreadAuthority(entry.threadId);
        if (
          !authorityAfterDelivery ||
          authorityAfterDelivery.ownerScope !== ownerScope ||
          authorityAfterDelivery.ownerGeneration !== entry.ownerGeneration
        ) {
          if (entry.kind === "start") {
            settleStartAdmission(
              entry.id,
              "rejected",
              admissionError({
                code: "OWNER_DATA_GENERATION_STALE",
                retryable: false,
                message:
                  "OWNER_DATA_GENERATION_STALE: computer-agent ownership changed before the exact start acknowledgement was durable locally.",
              }),
            );
          }
          if (entry.ownerGeneration) {
            options.store.retireComputerAgentCloudGeneration({
              threadId: entry.threadId,
              ownerScope,
              ownerGeneration: entry.ownerGeneration,
            });
          }
          continue;
        }
        if (ownerScopeAfterDelivery !== ownerScope) {
          options.store.markComputerAgentCloudOutboxRetry({
            id: entry.id,
            error: "auth_identity_changed_during_delivery",
            nextAttemptAt: Date.now() + BASE_RETRY_MS,
          });
          if (entry.kind === "start") {
            settleStartAdmission(
              entry.id,
              "rejected",
              admissionError({
                code: "COMPUTER_AGENT_START_ACK_PENDING",
                retryable: true,
                message:
                  "Computer-agent start may have reached the cloud, but authentication changed before its exact acknowledgement was durable locally.",
              }),
            );
          }
          scheduleDrain(0);
          return;
        }
        options.store.deleteComputerAgentCloudOutbox(entry.id);
        if (entry.kind === "start") {
          settleStartAdmission(entry.id, "acknowledged");
        }
      } catch (error) {
        if (stopped) return;
        if (isOwnerGenerationStale(error) && entry.ownerGeneration) {
          if (entry.kind === "start") {
            settleStartAdmission(
              entry.id,
              "rejected",
              admissionError({
                code: "OWNER_DATA_GENERATION_STALE",
                retryable: false,
                message: errorMessage(error),
              }),
            );
          }
          options.store.retireComputerAgentCloudGeneration({
            threadId: entry.threadId,
            ownerScope,
            ownerGeneration: entry.ownerGeneration,
          });
          continue;
        }
        const code = convexErrorCode(error);
        if (
          entry.kind === "start" &&
          (isCloudAgentStartAdmissionError(error) ||
            code === "COMPUTER_AGENT_START_REJECTED")
        ) {
          const rejected = isCloudAgentStartAdmissionError(error)
            ? error
            : admissionError({
                code: code ?? "COMPUTER_AGENT_START_REJECTED",
                retryable: false,
                message: errorMessage(error),
              });
          options.store.deleteComputerAgentCloudOutbox(entry.id);
          settleStartAdmission(entry.id, "rejected", rejected);
          continue;
        }
        const delayMs = retryDelay(entry.attempts);
        options.store.markComputerAgentCloudOutboxRetry({
          id: entry.id,
          error: errorMessage(error),
          nextAttemptAt: Date.now() + delayMs,
        });
        if (entry.kind === "start") {
          settleStartAdmission(
            entry.id,
            "rejected",
            admissionError({
              code: "COMPUTER_AGENT_START_ACK_PENDING",
              retryable: true,
              message: errorMessage(error),
            }),
          );
        }
        scheduleDrain(currentOwnerScope() === ownerScope ? delayMs : 0);
        return;
      }
    }
  };

  const drain = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeDrainPromise) return activeDrainPromise;
    const pending = runDrain().finally(() => {
      if (activeDrainPromise === pending) activeDrainPromise = null;
    });
    activeDrainPromise = pending;
    return pending;
  };

  const enqueue = async (args: {
    kind: "start" | "terminal" | "cancel";
    threadId: string;
    attemptGeneration: number;
    ownerGeneration: string;
    payload: unknown;
  }): Promise<void> => {
    const authority = authorityForThread(
      args.threadId,
      args.ownerGeneration,
      args.kind === "start",
    );
    const ownerScope = currentOwnerScope() ?? lastKnownOwnerScope;
    if (!authority && (ownerScope || args.kind !== "start")) {
      const message = `OWNER_DATA_GENERATION_STALE: ${args.kind} was rejected for a retired or mismatched computer-agent generation.`;
      throw args.kind === "start"
        ? admissionError({
            code: "OWNER_DATA_GENERATION_STALE",
            retryable: false,
            message,
          })
        : new Error(message);
    }
    const id = outboxId(
      options.deviceId,
      args.threadId,
      args.attemptGeneration,
      args.ownerGeneration,
      args.kind,
    );
    const startWaiter: StartAdmissionWaiter | null =
      args.kind === "start" ? { state: "pending" } : null;
    if (startWaiter) {
      const waiters = startAdmissionWaiters.get(id) ?? new Set();
      waiters.add(startWaiter);
      startAdmissionWaiters.set(id, waiters);
    }
    try {
      options.store.putComputerAgentCloudOutbox({
        id,
        kind: args.kind,
        threadId: args.threadId,
        attemptGeneration: args.attemptGeneration,
        ownerScope: authority?.ownerScope ?? null,
        // The expected lifecycle epoch is known at local admission even during
        // an auth refresh gap. Keep it on the durable row; only ownerScope may
        // remain null (and such a legacy/unattributed row is never adopted).
        ownerGeneration: args.ownerGeneration,
        payloadJson: JSON.stringify(args.payload),
      });
      const joinedExistingDrain = activeDrainPromise !== null;
      await drain();
      // If this enqueue joined a drain that had already observed an empty
      // queue, make one fresh pass so the newly durable row cannot sleep until
      // an unrelated resume/enqueue wakes it.
      if (joinedExistingDrain && !stopped) await drain();
      if (
        authority &&
        options.store.isComputerAgentCloudGenerationRetired({
          threadId: args.threadId,
          ownerScope: authority.ownerScope,
          ownerGeneration: args.ownerGeneration,
        })
      ) {
        const message = `OWNER_DATA_GENERATION_STALE: ${args.kind} was rejected by the canonical owner lifecycle.`;
        throw args.kind === "start"
          ? admissionError({
              code: "OWNER_DATA_GENERATION_STALE",
              retryable: false,
              message,
            })
          : new Error(message);
      }
      if (startWaiter?.state === "pending") {
        startWaiter.state = "rejected";
        startWaiter.error = admissionError({
          code: "COMPUTER_AGENT_START_ACK_PENDING",
          retryable: true,
          message:
            "Computer-agent execution was not started because the cloud did not durably acknowledge its exact start attempt.",
        });
      }
      if (startWaiter?.state === "rejected") {
        throw (
          startWaiter.error ??
          admissionError({
            code: "COMPUTER_AGENT_START_ACK_PENDING",
            retryable: true,
            message:
              "Computer-agent execution was not started because its exact cloud acknowledgement is still pending.",
          })
        );
      }
    } finally {
      if (startWaiter) {
        const waiters = startAdmissionWaiters.get(id);
        waiters?.delete(startWaiter);
        if (waiters?.size === 0) startAdmissionWaiters.delete(id);
      }
    }
  };

  const records: ComputerAgentCloudRecords = {
    create: async (args) => {
      await enqueue({
        kind: "start",
        threadId: args.agentId,
        attemptGeneration: args.attemptGeneration,
        ownerGeneration: args.ownerGeneration,
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
        ownerGeneration: args.ownerGeneration,
        payload: {
          status: args.status,
          ...(args.result ? { result: args.result } : {}),
          ...(args.error ? { error: args.error } : {}),
        } satisfies ComputerAgentTerminalPayload,
      });
    },

    get: async (agentId) => {
      if (!currentOwnerScope()) return null;
      const authority =
        options.store.getComputerAgentCloudThreadAuthority(agentId);
      if (!authority || authority.ownerScope !== currentOwnerScope())
        return null;
      try {
        return parseSnapshot(
          await withTimeout(
            options.query(api.local_agent_threads.getMyComputerAgentThread, {
              threadId: agentId,
              originDeviceId: options.deviceId,
              ownerGeneration: authority.ownerGeneration,
            }),
          ),
        );
      } catch (error) {
        if (isOwnerGenerationStale(error)) {
          options.store.retireComputerAgentCloudGeneration({
            threadId: agentId,
            ownerScope: authority.ownerScope,
            ownerGeneration: authority.ownerGeneration,
          });
        }
        return null;
      }
    },

    cancel: async (agentId, reason, attemptGeneration, ownerGeneration) => {
      if (attemptGeneration === undefined) {
        // A thread id is reusable across attempts, so owner generation alone
        // cannot identify the execution being canceled. Never let an
        // unknown-agent fallback mutate whichever attempt happens to be
        // current after an ABA replacement.
        return { canceled: false };
      }
      const expectedGeneration =
        ownerGeneration ??
        options.store.getComputerAgentCloudThreadAuthority(agentId)
          ?.ownerGeneration;
      if (!expectedGeneration) return { canceled: false };
      await enqueue({
        kind: "cancel",
        threadId: agentId,
        attemptGeneration,
        ownerGeneration: expectedGeneration,
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
      if (cancelRetryDelay) {
        cancelRetryDelay();
        cancelRetryDelay = null;
      }
      const error = admissionError({
        code: "COMPUTER_AGENT_START_ACK_PENDING",
        retryable: true,
        message:
          "Computer-agent execution was not started because cloud admission stopped before an exact acknowledgement.",
      });
      for (const id of startAdmissionWaiters.keys()) {
        settleStartAdmission(id, "rejected", error);
      }
    },
  };

  records.resume();
  return records;
};
