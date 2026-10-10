import type { OwnerCaller } from "../owner-store/registry.js";
import {
  HEADER_ANONYMOUS,
  HEADER_IDENTITY_LEVEL,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  HEADER_TOKEN_IAT,
} from "../conversation-types.js";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type {
  DispatchError,
  DispatchState,
  DispatchSummary,
  ExecutionIngress,
  ExecutionKind,
  ExecutionSubject,
  ExecutionTargetMode,
} from "@stella/contracts/turn-plane/placement";
import { dispatchError } from "../dispatch-policy.js";
import type {
  OwnerGateRefusalCode,
  OwnerGateRefusal,
  DispatchRow,
} from "./types.js";

/** Reject with `message` after `ms`; the underlying work is not cancelled. */
export const withTimeout = <T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

export const ownerFenceRequest = (
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Request =>
  new Request(`https://owner-gate/owner-fence/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** How the snapshot fetch failed. `owner_purged` is definite; the rest are not. */
export class OwnerGateSnapshotError extends Error {
  constructor(
    readonly code: "owner_purged" | "internal",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OwnerGateSnapshotError";
  }
}

export const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      component: "owner-gate",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when the snapshot lets a turn pin this execution's engine. */
export const snapshotAllowsExecutionEngine = (
  snapshot: Pick<OwnerSnapshot, "connectedEngines">,
  engine: OwnerSnapshot["execution"]["engine"],
): boolean =>
  engine === "stella" || (snapshot.connectedEngines ?? []).includes(engine);

export const snapshotAllowsCloudSandbox = (
  snapshot: Pick<OwnerSnapshot, "cloudSandbox">,
): boolean => snapshot.cloudSandbox?.enabled !== false;

export const refuse = (
  code: OwnerGateRefusalCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): OwnerGateRefusal => ({
  ok: false,
  code,
  message,
  retryable,
  ...(retryAfterMs !== undefined
    ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) }
    : {}),
});

const optional = <T>(value: T | null | undefined, key: string) =>
  value === null || value === undefined || value === "" ? {} : { [key]: value };

export const dispatchSummary = (row: DispatchRow): DispatchSummary => ({
  dispatchId: row.dispatch_id,
  idempotencyKey: row.idempotency_key,
  kind: row.kind as ExecutionKind,
  ingress: row.ingress as ExecutionIngress,
  subject: row.subject as ExecutionSubject,
  ...(optional(row.requested_target_mode, "requestedTargetMode") as {
    requestedTargetMode?: ExecutionTargetMode;
  }),
  ...optional(row.requested_executor_device_id, "requestedExecutorDeviceId"),
  conversationId: row.conversation_id,
  ...optional(row.parent_turn_id, "parentTurnId"),
  ...optional(row.thread_id, "threadId"),
  state: row.state as DispatchState,
  ...(optional(row.placement, "placement") as {
    placement?: "computer" | "cloud";
  }),
  ...optional(row.executor_device_id, "executorDeviceId"),
  ...optional(row.executor_presence_session_id, "executorPresenceSessionId"),
  revision: row.revision,
  ...optional(row.fallback_reason, "fallbackReason"),
  ...optional(row.cancel_request_id, "cancelRequestId"),
  ...optional(row.cancel_reason, "cancelReason"),
  ...optional(row.error_code, "errorCode"),
  ...optional(row.error_message, "errorMessage"),
  ...optional(row.result_json, "resultJson"),
  ...optional(row.cloud_turn_id, "cloudTurnId"),
  ...optional(row.cloud_thread_id, "cloudThreadId"),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fail = (
  code: DispatchError["error"]["code"],
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): { ok: false; error: DispatchError["error"] } => ({
  ok: false,
  error: dispatchError(code, message, retryable, retryAfterMs).error,
});

/**
 * The caller the Worker verified, rebuilt from the `x-stella-*` headers it
 * stamps after stripping the client's own. Null when any part is missing.
 */
export const trustedOwnerCaller = (request: Request): OwnerCaller | null => {
  const ownerId = request.headers.get(HEADER_OWNER)?.trim() ?? "";
  const subject = request.headers.get(HEADER_SUBJECT)?.trim() ?? "";
  const sessionId = request.headers.get(HEADER_SESSION)?.trim() ?? "";
  const expiresAtMs = Number(request.headers.get(HEADER_TOKEN_EXP));
  const identityLevel = Number(
    request.headers.get(HEADER_IDENTITY_LEVEL) ?? NaN,
  );
  const issuedAtMs = Number(request.headers.get(HEADER_TOKEN_IAT) ?? NaN);
  if (
    !ownerId ||
    !subject ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    return null;
  }
  return {
    ownerId,
    subject,
    sessionId,
    expiresAtMs,
    isAnonymous: request.headers.get(HEADER_ANONYMOUS) === "1",
    ...(identityLevel === 0 ||
    identityLevel === 1 ||
    identityLevel === 2 ||
    identityLevel === 3
      ? { identityLevel }
      : {}),
    ...(Number.isSafeInteger(issuedAtMs) ? { issuedAtMs } : {}),
  };
};
