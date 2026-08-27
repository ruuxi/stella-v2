/**
 * Desktop admission and exact-replay boundary for cloud agent tools.
 *
 * Every tool call captures its owner-data generation and expected thread
 * receipt in SQLite before the first network request. A process restart or a
 * lost response therefore reuses the original authority instead of reading a
 * successor attempt and accidentally steering/canceling it (ABA).
 */

import type {
  CloudAgentControlReceipt,
  CloudDispatchRequest,
  CloudDispatchResult,
} from "../tools/types.js";
import type {
  CloudAgentThreadControlRecord,
  CloudAgentToolOperationRecord,
} from "../storage/session-store.js";
import { raceWithTimeoutError } from "./cloud-effect-runtime.js";

const CLOUD_SPAWN_TIMEOUT_MS = 30_000;

type CloudAgentControlStore = {
  getCloudAgentThreadControl: (
    threadId: string,
    ownerGeneration: string,
  ) => CloudAgentThreadControlRecord | null;
  putCloudAgentThreadControl: (record: {
    threadId: string;
    ownerGeneration: string;
    cloudConversationId: string;
    originConversationId: string;
    attemptGeneration: number;
    threadUpdatedAt: number;
    status: CloudAgentControlReceipt["status"];
  }) => CloudAgentThreadControlRecord;
  getCloudAgentToolOperation: (
    operationId: string,
  ) => CloudAgentToolOperationRecord | null;
  putCloudAgentToolOperation: (record: {
    operationId: string;
    kind: CloudAgentToolOperationRecord["kind"];
    fingerprint: string;
    ownerGeneration: string;
    requestJson: string;
  }) => CloudAgentToolOperationRecord;
  updatePendingCloudAgentToolOperationRequest: (
    operationId: string,
    expectedRequestJson: string,
    replacementRequestJson: string,
  ) => CloudAgentToolOperationRecord;
  completeCloudAgentToolOperation: (
    operationId: string,
    resultJson: string,
  ) => CloudAgentToolOperationRecord;
};

export type CloudSpawnDispatcherOptions = {
  convexApi: unknown;
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  action: (ref: unknown, args: unknown) => Promise<unknown>;
  query?: (ref: unknown, args: unknown) => Promise<unknown>;
  isSignedIn: () => boolean;
  deviceId: string;
  /** Reads the active epoch once; the operation ledger makes it immutable. */
  getOwnerGeneration: () => Promise<string>;
  store: CloudAgentControlStore;
};

type StoredSpawnRequest = {
  ownerGeneration: string;
  clientMsgId: string;
  workspace: string;
  description: string;
  prompt: string;
  originDeviceId: string;
  originConversationId: string;
  execution: CloudDispatchRequest["execution"];
  conversationId?: string;
};

type StoredContinueRequest = {
  ownerGeneration: string;
  threadId: string;
  expectedAttemptGeneration: number;
  expectedTerminalUpdatedAt: number;
  description: string;
  prompt: string;
  originDeviceId: string;
  originConversationId: string;
  controlRequestId: string;
};

type StoredCancelRequest = {
  ownerGeneration: string;
  threadId: string;
  expectedAttemptGeneration: number;
  expectedThreadUpdatedAt: number;
  originDeviceId: string;
  originConversationId: string;
  controlRequestId: string;
};

type CancelResponse = {
  canceled: boolean;
  status: CloudAgentControlReceipt["status"];
  threadId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  currentControl: Omit<CloudAgentControlReceipt, "ownerGeneration">;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const readString = (
  record: Record<string, unknown> | null,
  key: string,
): string | null => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const readGeneration = (
  record: Record<string, unknown> | null,
  key: string,
): number | null => {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
};

const readTimestamp = (
  record: Record<string, unknown> | null,
  key: string,
): number | null => {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const readStatus = (
  record: Record<string, unknown> | null,
  key = "status",
): CloudAgentControlReceipt["status"] | null => {
  const status = record?.[key];
  return status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "canceled"
    ? status
    : null;
};

const parseJsonRecord = (json: string, label: string): Record<string, unknown> => {
  try {
    const record = asRecord(JSON.parse(json));
    if (record) return record;
  } catch {
    // Fall through to the protocol error below.
  }
  throw new Error(`Stored cloud ${label} receipt is invalid.`);
};

const readConvexErrorText = (error: unknown): string => {
  const data = asRecord(error)?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  const dataMessage = asRecord(data)?.message;
  if (typeof dataMessage === "string" && dataMessage.trim()) {
    return dataMessage.trim();
  }
  const message = error instanceof Error ? error.message : String(error);
  const uncaught = /Uncaught ConvexError:\s*([\s\S]*?)(?:\n\s+at\s|$)/.exec(
    message,
  );
  return (uncaught?.[1] ?? message).trim();
};

const withTimeout = <T>(promise: Promise<T>, workspace: string): Promise<T> =>
  raceWithTimeoutError(
    promise,
    CLOUD_SPAWN_TIMEOUT_MS,
    () =>
      new Error(
        `Stella's cloud did not accept the ${workspace} agent within 30s — this device may be offline. Check the running agents before retrying so the same work does not start twice.`,
      ),
  );

const withControlTimeout = <T>(
  promise: Promise<T>,
  operation: string,
): Promise<T> =>
  raceWithTimeoutError(
    promise,
    CLOUD_SPAWN_TIMEOUT_MS,
    () =>
      new Error(
        `Stella's cloud did not ${operation} within 30s. Check the thread before retrying so the same control is not applied twice.`,
      ),
  );

const normalizeOwnerGeneration = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Cloud owner generation is unavailable.");
  }
  return value.trim();
};

const operationFingerprint = (value: Record<string, unknown>): string =>
  JSON.stringify(value);

const validateOperation = (
  operation: CloudAgentToolOperationRecord,
  kind: CloudAgentToolOperationRecord["kind"],
  fingerprint: string,
  explicitOwnerGeneration?: string,
): CloudAgentToolOperationRecord => {
  if (operation.kind !== kind || operation.fingerprint !== fingerprint) {
    throw new Error(
      "Cloud agent tool-call id was reused with different parameters.",
    );
  }
  if (
    explicitOwnerGeneration?.trim() &&
    explicitOwnerGeneration.trim() !== operation.ownerGeneration
  ) {
    throw new Error(
      "Cloud agent tool-call replay belongs to a different owner generation.",
    );
  }
  return operation;
};

const parseRunningResult = (
  raw: unknown,
  ownerGeneration: string,
): CloudDispatchResult => {
  const result = asRecord(raw);
  const threadId = readString(result, "threadId");
  const conversationId = readString(result, "conversationId");
  const attemptGeneration = readGeneration(result, "attemptGeneration");
  const threadUpdatedAt = readTimestamp(result, "threadUpdatedAt");
  const status = readStatus(result);
  if (
    !threadId ||
    !conversationId ||
    attemptGeneration === null ||
    threadUpdatedAt === null ||
    status !== "running"
  ) {
    throw new Error(
      "Stella's cloud accepted the agent turn but returned no exact control receipt.",
    );
  }
  return {
    threadId,
    conversationId,
    ownerGeneration,
    attemptGeneration,
    threadUpdatedAt,
    status,
  };
};

const parseCancelResponse = (raw: unknown): CancelResponse => {
  const result = asRecord(raw);
  const current = asRecord(result?.currentControl);
  const threadId = readString(result, "threadId");
  const status = readStatus(result);
  const attemptGeneration = readGeneration(result, "attemptGeneration");
  const threadUpdatedAt = readTimestamp(result, "threadUpdatedAt");
  const currentThreadId = readString(current, "threadId");
  const currentStatus = readStatus(current);
  const currentAttemptGeneration = readGeneration(
    current,
    "attemptGeneration",
  );
  const currentThreadUpdatedAt = readTimestamp(current, "threadUpdatedAt");
  if (
    typeof result?.canceled !== "boolean" ||
    !threadId ||
    !status ||
    attemptGeneration === null ||
    threadUpdatedAt === null ||
    currentThreadId !== threadId ||
    !currentStatus ||
    currentAttemptGeneration === null ||
    currentThreadUpdatedAt === null
  ) {
    throw new Error(
      "Stella's cloud returned no exact receipt for that pause request.",
    );
  }
  return {
    canceled: result.canceled,
    status,
    threadId,
    attemptGeneration,
    threadUpdatedAt,
    currentControl: {
      threadId,
      attemptGeneration: currentAttemptGeneration,
      threadUpdatedAt: currentThreadUpdatedAt,
      status: currentStatus,
    },
  };
};

const persistControl = (
  options: CloudSpawnDispatcherOptions,
  receipt: CloudDispatchResult,
  originConversationId: string,
): CloudAgentControlReceipt => {
  options.store.putCloudAgentThreadControl({
    threadId: receipt.threadId,
    ownerGeneration: receipt.ownerGeneration,
    cloudConversationId: receipt.conversationId,
    originConversationId,
    attemptGeneration: receipt.attemptGeneration,
    threadUpdatedAt: receipt.threadUpdatedAt,
    status: receipt.status,
  });
  // The tool outcome is the immutable receipt for this operation, even if a
  // terminal subscription raced ahead and the mutable thread-control row is
  // already newer. Returning the merged row here would make the first call
  // and its durable lost-response replay disagree.
  return {
    threadId: receipt.threadId,
    ownerGeneration: receipt.ownerGeneration,
    attemptGeneration: receipt.attemptGeneration,
    threadUpdatedAt: receipt.threadUpdatedAt,
    status: receipt.status,
  };
};

const beginOperation = async (
  options: CloudSpawnDispatcherOptions,
  args: {
    operationId: string;
    kind: CloudAgentToolOperationRecord["kind"];
    fingerprint: string;
    explicitOwnerGeneration?: string;
    buildRequest: (ownerGeneration: string) => Promise<Record<string, unknown>>;
  },
): Promise<CloudAgentToolOperationRecord> => {
  const existing = options.store.getCloudAgentToolOperation(args.operationId);
  if (existing) {
    return validateOperation(
      existing,
      args.kind,
      args.fingerprint,
      args.explicitOwnerGeneration,
    );
  }
  const ownerGeneration = normalizeOwnerGeneration(
    args.explicitOwnerGeneration ?? (await options.getOwnerGeneration()),
  );
  const requestJson = JSON.stringify(await args.buildRequest(ownerGeneration));
  return validateOperation(
    options.store.putCloudAgentToolOperation({
      operationId: args.operationId,
      kind: args.kind,
      fingerprint: args.fingerprint,
      ownerGeneration,
      requestJson,
    }),
    args.kind,
    args.fingerprint,
    args.explicitOwnerGeneration,
  );
};

const completeOperation = (
  options: CloudSpawnDispatcherOptions,
  operationId: string,
  result: unknown,
): void => {
  options.store.completeCloudAgentToolOperation(
    operationId,
    JSON.stringify(result),
  );
};

export const createCloudSpawnDispatcher = (
  options: CloudSpawnDispatcherOptions,
) => {
  const cloudConversationIds = new Map<string, string>();
  const conversationsRef = () =>
    (options.convexApi as { cloud_apps: { listMyConversations: unknown } })
      .cloud_apps.listMyConversations;

  const activeCloudConversationId = async (): Promise<string | undefined> => {
    if (!options.query) return undefined;
    try {
      const rows = await options.query(conversationsRef(), {});
      if (!Array.isArray(rows)) return undefined;
      return readString(asRecord(rows[0]), "conversationId") ?? undefined;
    } catch {
      return undefined;
    }
  };

  return async (
    request: CloudDispatchRequest,
  ): Promise<CloudDispatchResult> => {
    const fingerprint = operationFingerprint({
      kind: "spawn",
      workspace: request.workspace,
      originConversationId: request.conversationId,
      description: request.description,
      prompt: request.prompt,
      execution: {
        engine: request.execution.engine,
        provider: request.execution.provider,
        model: request.execution.model,
        reasoningEffort: request.execution.reasoningEffort,
      },
    });
    const persisted = options.store.getCloudAgentToolOperation(
      request.requestId,
    );
    let operation = persisted
      ? validateOperation(
          persisted,
          "spawn",
          fingerprint,
          request.ownerGeneration,
        )
      : null;
    if (!operation?.resultJson && !options.isSignedIn()) {
      throw new Error(
        `The ${request.workspace} workspace runs in your Stella cloud, and this device is signed out. Sign in, or use workspace "computer" to run the work here.`,
      );
    }
    operation ??= await beginOperation(options, {
      operationId: request.requestId,
      kind: "spawn",
      fingerprint,
      ...(request.ownerGeneration
        ? { explicitOwnerGeneration: request.ownerGeneration }
        : {}),
      buildRequest: async (ownerGeneration) => {
        const conversationId =
          (await activeCloudConversationId()) ??
          cloudConversationIds.get(request.conversationId);
        return {
          ownerGeneration,
          clientMsgId: request.requestId,
          workspace: request.workspace,
          description: request.description,
          prompt: request.prompt,
          originDeviceId: options.deviceId,
          originConversationId: request.conversationId,
          execution: request.execution,
          ...(conversationId ? { conversationId } : {}),
        } satisfies StoredSpawnRequest;
      },
    });

    if (operation.resultJson) {
      const replay = parseRunningResult(
        parseJsonRecord(operation.resultJson, "spawn result"),
        operation.ownerGeneration,
      );
      cloudConversationIds.set(request.conversationId, replay.conversationId);
      return replay;
    }

    const ref = (
      options.convexApi as {
        cloud_apps: { spawnCloudAgentFromDesktop: unknown };
      }
    ).cloud_apps.spawnCloudAgentFromDesktop;
    let requestJson = operation.requestJson;
    let requestArgs = parseJsonRecord(requestJson, "spawn request");
    const send = async () =>
      parseRunningResult(
        await withTimeout(
          options.mutation(ref, requestArgs),
          request.workspace,
        ),
        operation.ownerGeneration,
      );
    let result: CloudDispatchResult;
    try {
      result = await send();
    } catch (error) {
      const text = readConvexErrorText(error);
      if (
        Object.hasOwn(requestArgs, "conversationId") &&
        /conversation not found/i.test(text)
      ) {
        const { conversationId: _staleConversationId, ...replacement } =
          requestArgs;
        const replacementJson = JSON.stringify(replacement);
        const updated =
          options.store.updatePendingCloudAgentToolOperationRequest(
            request.requestId,
            requestJson,
            replacementJson,
          );
        requestJson = updated.requestJson;
        requestArgs = parseJsonRecord(requestJson, "spawn request");
        result = await send();
      } else {
        throw new Error(text);
      }
    }
    persistControl(options, result, request.conversationId);
    completeOperation(options, request.requestId, result);
    cloudConversationIds.set(request.conversationId, result.conversationId);
    return result;
  };
};

export const createCloudThreadController = (
  options: CloudSpawnDispatcherOptions,
) => ({
  continueThread: async (request: {
    threadId: string;
    description: string;
    message: string;
    conversationId: string;
    requestId: string;
    ownerGeneration?: string;
  }): Promise<{
    delivered: boolean;
    reason?: string;
    control?: CloudAgentControlReceipt;
  }> => {
    try {
      const fingerprint = operationFingerprint({
        kind: "continue",
        threadId: request.threadId,
        description: request.description,
        message: request.message,
        originConversationId: request.conversationId,
      });
      const persisted = options.store.getCloudAgentToolOperation(
        request.requestId,
      );
      let operation = persisted
        ? validateOperation(
            persisted,
            "continue",
            fingerprint,
            request.ownerGeneration,
          )
        : null;
      if (!operation?.resultJson && !options.isSignedIn()) {
        return {
          delivered: false,
          reason:
            "This cloud thread cannot be continued while this device is signed out.",
        };
      }
      operation ??= await beginOperation(options, {
        operationId: request.requestId,
        kind: "continue",
        fingerprint,
        ...(request.ownerGeneration
          ? { explicitOwnerGeneration: request.ownerGeneration }
          : {}),
        buildRequest: async (ownerGeneration) => {
          const current = options.store.getCloudAgentThreadControl(
            request.threadId,
            ownerGeneration,
          );
          if (!current || current.originConversationId !== request.conversationId) {
            throw new Error(
              `No durable cloud control receipt is available for thread ${request.threadId}.`,
            );
          }
          if (current.status === "running") {
            throw new Error(
              `Thread ${request.threadId} is still running and cannot be continued yet.`,
            );
          }
          return {
            ownerGeneration,
            threadId: request.threadId,
            expectedAttemptGeneration: current.attemptGeneration,
            expectedTerminalUpdatedAt: current.threadUpdatedAt,
            description: request.description,
            prompt: request.message,
            originDeviceId: options.deviceId,
            originConversationId: request.conversationId,
            controlRequestId: request.requestId,
          } satisfies StoredContinueRequest;
        },
      });
      if (operation.resultJson) {
        const replay = parseRunningResult(
          parseJsonRecord(operation.resultJson, "continuation result"),
          operation.ownerGeneration,
        );
        return {
          delivered: true,
          control: {
            threadId: replay.threadId,
            ownerGeneration: replay.ownerGeneration,
            attemptGeneration: replay.attemptGeneration,
            threadUpdatedAt: replay.threadUpdatedAt,
            status: replay.status,
          },
        };
      }
      const args = parseJsonRecord(operation.requestJson, "continuation request");
      const expectedAttemptGeneration = readGeneration(
        args,
        "expectedAttemptGeneration",
      );
      const ref = (
        options.convexApi as {
          cloud_apps: { continueMyCloudAgentFromDesktop: unknown };
        }
      ).cloud_apps.continueMyCloudAgentFromDesktop;
      const result = parseRunningResult(
        await withControlTimeout(
          options.mutation(ref, args),
          "continue that agent",
        ),
        operation.ownerGeneration,
      );
      if (
        result.threadId !== request.threadId ||
        expectedAttemptGeneration === null ||
        result.attemptGeneration !== expectedAttemptGeneration + 1
      ) {
        throw new Error(
          "Stella's cloud returned a continuation receipt for a different attempt.",
        );
      }
      const previous = options.store.getCloudAgentThreadControl(
        request.threadId,
        operation.ownerGeneration,
      );
      if (!previous || previous.cloudConversationId !== result.conversationId) {
        throw new Error(
          "Stella's cloud returned a continuation in a different conversation.",
        );
      }
      const control = persistControl(options, result, request.conversationId);
      completeOperation(options, request.requestId, result);
      return { delivered: true, control };
    } catch (error) {
      return { delivered: false, reason: readConvexErrorText(error) };
    }
  },

  cancelThread: async (request: {
    threadId: string;
    conversationId: string;
    requestId: string;
    ownerGeneration?: string;
  }): Promise<{
    canceled: boolean;
    reason?: string;
    control?: CloudAgentControlReceipt;
  }> => {
    try {
      const fingerprint = operationFingerprint({
        kind: "cancel",
        threadId: request.threadId,
        originConversationId: request.conversationId,
      });
      const persisted = options.store.getCloudAgentToolOperation(
        request.requestId,
      );
      let operation = persisted
        ? validateOperation(
            persisted,
            "cancel",
            fingerprint,
            request.ownerGeneration,
          )
        : null;
      if (!operation?.resultJson && !options.isSignedIn()) {
        return {
          canceled: false,
          reason:
            "This cloud thread cannot be paused while this device is signed out.",
        };
      }
      operation ??= await beginOperation(options, {
        operationId: request.requestId,
        kind: "cancel",
        fingerprint,
        ...(request.ownerGeneration
          ? { explicitOwnerGeneration: request.ownerGeneration }
          : {}),
        buildRequest: async (ownerGeneration) => {
          const current = options.store.getCloudAgentThreadControl(
            request.threadId,
            ownerGeneration,
          );
          if (!current || current.originConversationId !== request.conversationId) {
            throw new Error(
              `No durable cloud control receipt is available for thread ${request.threadId}.`,
            );
          }
          return {
            ownerGeneration,
            threadId: request.threadId,
            expectedAttemptGeneration: current.attemptGeneration,
            expectedThreadUpdatedAt: current.threadUpdatedAt,
            originDeviceId: options.deviceId,
            originConversationId: request.conversationId,
            controlRequestId: request.requestId,
          } satisfies StoredCancelRequest;
        },
      });
      const args = parseJsonRecord(operation.requestJson, "pause request");
      const expectedAttemptGeneration = readGeneration(
        args,
        "expectedAttemptGeneration",
      );
      let result: CancelResponse;
      if (operation.resultJson) {
        result = parseCancelResponse(
          parseJsonRecord(operation.resultJson, "pause result"),
        );
      } else {
        const ref = (
          options.convexApi as {
            cloud_apps: { cancelMyCloudAgentThread: unknown };
          }
        ).cloud_apps.cancelMyCloudAgentThread;
        result = parseCancelResponse(
          await withControlTimeout(
            options.action(ref, args),
            "pause that agent",
          ),
        );
        if (
          result.threadId !== request.threadId ||
          expectedAttemptGeneration === null ||
          result.attemptGeneration !== expectedAttemptGeneration
        ) {
          throw new Error(
            "Stella's cloud returned a pause receipt for a different attempt.",
          );
        }
        const previous = options.store.getCloudAgentThreadControl(
          request.threadId,
          operation.ownerGeneration,
        );
        if (!previous) {
          throw new Error(
            `No durable cloud control receipt is available for thread ${request.threadId}.`,
          );
        }
        options.store.putCloudAgentThreadControl({
          threadId: request.threadId,
          ownerGeneration: operation.ownerGeneration,
          cloudConversationId: previous.cloudConversationId,
          originConversationId: previous.originConversationId,
          attemptGeneration: result.currentControl.attemptGeneration,
          threadUpdatedAt: result.currentControl.threadUpdatedAt,
          status: result.currentControl.status,
        });
        completeOperation(options, request.requestId, result);
      }

      const current = result.currentControl;
      const control: CloudAgentControlReceipt = {
        ...current,
        ownerGeneration: operation.ownerGeneration,
      };
      if (
        expectedAttemptGeneration === null ||
        current.attemptGeneration > expectedAttemptGeneration
      ) {
        return {
          canceled: false,
          control,
          reason:
            "The cloud thread advanced to a newer attempt while the pause was completing; the newer attempt was not changed.",
        };
      }
      if (
        current.attemptGeneration < expectedAttemptGeneration ||
        !result.canceled
      ) {
        return {
          canceled: false,
          control,
          reason: "The cloud thread was not paused.",
        };
      }
      if (current.status === "completed" || current.status === "failed") {
        return {
          canceled: false,
          control,
          reason: `The cloud thread had already ${current.status}; no running attempt was paused.`,
        };
      }
      if (current.status === "running") {
        return {
          canceled: false,
          control,
          reason: "The cloud thread was not paused.",
        };
      }
      return { canceled: true, control };
    } catch (error) {
      return { canceled: false, reason: readConvexErrorText(error) };
    }
  },
});
