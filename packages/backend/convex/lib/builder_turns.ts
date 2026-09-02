import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
  TURN_PLANE_PROTOCOL,
  agentTurnStartPath,
  turnStartPath,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
  type CloudTurnStartErrorCode,
  type CloudTurnStartRequest,
  type CloudTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import type { CloudExecutionSelection } from "./cloud_execution";

/**
 * Convex's client for turn starts on the cloud-builder worker.
 *
 * Chat/schedule turns: `POST /conversations/:id/turns` with the service
 * secret plus the trusted owner headers (the worker forwards them to the
 * conversation Durable Object, which admits the turn).
 *
 * Agent turns: `POST /sessions/:threadId/turns` for BuildSession-hosted
 * agents Convex starts itself (desktop-dispatched cloud agents, placement's
 * agent branch, hosted-browser resumes).
 *
 * There is no retry ladder here by design: the DO's admission is idempotent
 * on `clientMsgId`, so a caller that lost a response simply calls again with
 * the same id, and every caller has its own durable record of what it asked
 * for (schedule fire, execution dispatch, thread row).
 */

export type BuilderEndpoint = { url: string; secret: string };

export const resolveBuilderEndpoint = (
  env: Record<string, string | undefined> = process.env,
): BuilderEndpoint | null => {
  const url = env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

export type BuilderTurnErrorCode = CloudTurnStartErrorCode | "unconfigured";

export class BuilderTurnError extends Error {
  readonly code: BuilderTurnErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(args: {
    code: BuilderTurnErrorCode;
    message: string;
    status: number;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(args.message);
    this.name = "BuilderTurnError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable;
    if (args.retryAfterMs !== undefined) this.retryAfterMs = args.retryAfterMs;
  }
}

export const isBuilderTurnError = (error: unknown): error is BuilderTurnError =>
  error instanceof BuilderTurnError;

const ERROR_CODES: ReadonlySet<string> = new Set<CloudTurnStartErrorCode>([
  "unauthorized",
  "forbidden",
  "owner_mismatch",
  "bad_request",
  "conversation_locked",
  "idempotency_conflict",
  "quota_burst",
  "quota_daily",
  "quota_concurrency",
  "owner_purged",
  "generation_stale",
  "execution_unavailable",
  "internal",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Status classes the DO cannot have admitted for: safe to treat as retryable. */
const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * Codes that describe the request, not the moment: retrying cannot change
 * them, whatever `retryable` the worker happened to send. `execution_unavailable`
 * is the builder's 409 for a native engine the owner has not connected.
 */
const DEFINITIVE_CODES: ReadonlySet<CloudTurnStartErrorCode> = new Set([
  "unauthorized",
  "forbidden",
  "owner_mismatch",
  "bad_request",
  "idempotency_conflict",
  "owner_purged",
  "generation_stale",
  "execution_unavailable",
]);

const parseError = (status: number, body: unknown): BuilderTurnError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code =
    error && typeof error.code === "string" && ERROR_CODES.has(error.code)
      ? (error.code as CloudTurnStartErrorCode)
      : status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 400
            ? "bad_request"
            : "internal";
  const retryable = DEFINITIVE_CODES.has(code)
    ? false
    : error && typeof error.retryable === "boolean"
      ? error.retryable
      : retryableStatus(status);
  const retryAfterMs =
    error && typeof error.retryAfterMs === "number" && error.retryAfterMs >= 0
      ? error.retryAfterMs
      : undefined;
  const message =
    error && typeof error.message === "string" && error.message.trim()
      ? error.message
      : `Cloud builder refused the turn (${status}).`;
  return new BuilderTurnError({
    code,
    message,
    status,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
};

/**
 * Convex's execution type is structurally looser than the contract's
 * discriminated union (engine and provider are validated equal at runtime by
 * `normalizeCloudExecutionSelection`); the wire shape is identical.
 */
export type BuilderTurnRequest = Omit<
  CloudTurnStartRequest,
  "protocol" | "execution"
> & { execution?: CloudExecutionSelection };

export type BuilderAgentTurnRequest = Omit<
  CloudAgentTurnStartRequest,
  "protocol" | "kind" | "execution"
> & { execution: CloudExecutionSelection };

export type BuilderTurnStartArgs = {
  endpoint?: BuilderEndpoint | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  request: BuilderTurnRequest;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const postJson = async (
  args: {
    endpoint?: BuilderEndpoint | null;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> => {
  const endpoint = args.endpoint === undefined ? resolveBuilderEndpoint() : args.endpoint;
  if (!endpoint) {
    throw new BuilderTurnError({
      code: "unconfigured",
      message:
        "Cloud builder is not configured (CLOUD_BUILDER_URL / BUILDER_SERVICE_SECRET).",
      status: 503,
      retryable: false,
    });
  }
  const timeout = AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const doFetch = args.fetch ?? fetch;
  const response = await doFetch(`${endpoint.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.secret}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
};

const parseTurnStartResponse = (
  status: number,
  body: unknown,
  conversationId: string,
): CloudTurnStartResponse => {
  if (status < 200 || status >= 300) throw parseError(status, body);
  if (
    !isRecord(body) ||
    typeof body.turnId !== "string" ||
    !body.turnId.trim() ||
    (body.conversationId !== undefined &&
      typeof body.conversationId !== "string")
  ) {
    throw new BuilderTurnError({
      code: "internal",
      message: "Cloud builder returned a malformed turn receipt.",
      status,
      retryable: false,
    });
  }
  return {
    protocol: TURN_PLANE_PROTOCOL,
    conversationId:
      typeof body.conversationId === "string" && body.conversationId
        ? body.conversationId
        : conversationId,
    turnId: body.turnId,
    accepted: true,
    replayed: body.replayed === true,
    createdConversation: body.createdConversation === true,
  };
};

/** `POST /conversations/:id/turns` with the service secret and owner headers. */
export const startBuilderTurn = async (
  args: BuilderTurnStartArgs,
): Promise<CloudTurnStartResponse> => {
  const request = {
    protocol: TURN_PLANE_PROTOCOL,
    ...args.request,
  } as CloudTurnStartRequest;
  const { status, body } = await postJson(
    args,
    turnStartPath(args.conversationId),
    {
      [TURN_OWNER_ID_HEADER]: args.ownerId,
      [TURN_OWNER_GENERATION_HEADER]: args.ownerGeneration,
    },
    request,
  );
  return parseTurnStartResponse(status, body, args.conversationId);
};

export type BuilderAgentTurnStartArgs = {
  endpoint?: BuilderEndpoint | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  request: BuilderAgentTurnRequest;
};

const parseAgentTurnStartResponse = (
  status: number,
  body: unknown,
  request: BuilderAgentTurnRequest,
): CloudAgentTurnStartResponse => {
  if (status < 200 || status >= 300) throw parseError(status, body);
  if (
    !isRecord(body) ||
    typeof body.turnId !== "string" ||
    !body.turnId.trim() ||
    (body.threadId !== undefined && typeof body.threadId !== "string") ||
    (body.attemptGeneration !== undefined &&
      !Number.isSafeInteger(body.attemptGeneration))
  ) {
    throw new BuilderTurnError({
      code: "internal",
      message: "Cloud builder returned a malformed agent turn receipt.",
      status,
      retryable: false,
    });
  }
  if (request.turnId && body.turnId !== request.turnId) {
    throw new BuilderTurnError({
      code: "idempotency_conflict",
      message: "Cloud builder admitted a different turn id than requested.",
      status,
      retryable: false,
    });
  }
  return {
    protocol: TURN_PLANE_PROTOCOL,
    threadId:
      typeof body.threadId === "string" && body.threadId
        ? body.threadId
        : request.threadId,
    turnId: body.turnId,
    attemptGeneration:
      typeof body.attemptGeneration === "number"
        ? body.attemptGeneration
        : request.attemptGeneration,
    accepted: true,
    replayed: body.replayed === true,
  };
};

/** `POST /sessions/:threadId/turns` (`kind: "agent"`) with the service secret. */
export const startBuilderAgentTurn = async (
  args: BuilderAgentTurnStartArgs,
): Promise<CloudAgentTurnStartResponse> => {
  const request = {
    protocol: TURN_PLANE_PROTOCOL,
    kind: "agent",
    ...args.request,
  } as CloudAgentTurnStartRequest;
  const { status, body } = await postJson(
    args,
    agentTurnStartPath(args.request.threadId),
    {
      [TURN_OWNER_ID_HEADER]: args.request.ownerId,
      [TURN_OWNER_GENERATION_HEADER]: args.request.ownerGeneration,
    },
    request,
  );
  return parseAgentTurnStartResponse(status, body, args.request);
};
