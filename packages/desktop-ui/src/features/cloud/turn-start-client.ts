/**
 * Turn starts for the desktop cloud path.
 *
 *   POST {socketOrigin}/conversations/{conversationId}/turns
 *
 * The cloud-builder worker is the turn gateway: it verifies the same Better
 * Auth JWT the conversation socket presents and hands the request to the
 * conversation's Durable Object, which owns admission (idempotency on
 * `clientMsgId`, owner adoption for a fresh conversation, quota, journaling)
 * and answers 202. Convex learns about the turn through the outbox, so no
 * Convex mutation is involved in starting one.
 *
 * Conversation ids are minted here, on the client: a brand-new conversation
 * is a UUID the renderer picked before the first turn was posted, and the
 * socket subscription, the route, and this request all carry the same id.
 */

import {
  CONVERSATION_ID_PATTERN,
  TURN_PLANE_PROTOCOL,
  TURN_TITLE_MAX_CHARS,
  turnStartPath,
  type CloudTurnStartError,
  type CloudTurnStartErrorCode,
  type CloudTurnStartRequest,
  type CloudTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import type { PendingCloudTurnSubmission } from "./conversation-outbox";

/** Bound on the admission round-trip. The DO answers before the model runs. */
export const TURN_START_TIMEOUT_MS = 30_000;

export type CloudTurnStartTokenOptions = { forceRefresh?: boolean };
export type CloudTurnStartGetToken = (
  options?: CloudTurnStartTokenOptions,
) => Promise<string | null>;

export const CLOUD_TURN_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Stella to send cloud messages.";

/**
 * Readable fallbacks per contract code. The gateway's own `message` wins
 * when it sends one; these cover a terse or missing body.
 */
const FALLBACK_MESSAGES: Record<CloudTurnStartErrorCode, string> = {
  unauthorized: CLOUD_TURN_SIGN_IN_REQUIRED_MESSAGE,
  forbidden: "This account can't send to that conversation.",
  owner_mismatch: "That conversation belongs to a different account.",
  bad_request:
    "That message couldn't be sent as written. Edit it and try again.",
  conversation_locked:
    "This conversation is busy. Wait for the current turn to finish, then try again.",
  idempotency_conflict:
    "This message was already sent with different content. Send it again as a new message.",
  quota_burst: "You're sending messages quickly. Wait a moment and try again.",
  quota_daily: "You've reached today's cloud chat limit. Try again tomorrow.",
  quota_concurrency:
    "Stella is still working on an earlier turn. Wait for it to finish, then try again.",
  owner_purged:
    "This account's cloud data was reset. Start a new conversation.",
  generation_stale: "This request started before the account data was reset.",
  execution_unavailable:
    "That model isn't available for cloud turns right now. Choose another and try again.",
  sign_in_required: "Sign in to Stella to use cloud agents.",
  owner_suspended: "This account can't use Stella's cloud right now.",
  internal: "That didn't send. Try again.",
};

const ERROR_CODES = new Set<string>(Object.keys(FALLBACK_MESSAGES));

const isErrorCode = (value: unknown): value is CloudTurnStartErrorCode =>
  typeof value === "string" && ERROR_CODES.has(value);

/**
 * The gateway answered and refused the turn. Definitive: the server did not
 * commit anything, so the row is not transport-ambiguous and a retry sends
 * the exact same payload again.
 */
export class CloudTurnStartClientError extends Error {
  readonly code: CloudTurnStartErrorCode;
  /** HTTP status, or 0 when the request never left the client. */
  readonly status: number;
  readonly retryable: boolean;
  /** Set on quota refusals that name a wait; already folded into `message`. */
  readonly retryAfterMs: number | null;

  constructor(args: {
    code: CloudTurnStartErrorCode;
    status: number;
    message?: string;
    retryable?: boolean;
    retryAfterMs?: number | null;
  }) {
    const retryAfterMs =
      typeof args.retryAfterMs === "number" &&
      Number.isFinite(args.retryAfterMs) &&
      args.retryAfterMs > 0
        ? Math.round(args.retryAfterMs)
        : null;
    const base = args.message?.trim() || FALLBACK_MESSAGES[args.code];
    super(
      retryAfterMs !== null
        ? `${base} Try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`
        : base,
    );
    this.name = "CloudTurnStartClientError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable ?? false;
    this.retryAfterMs = retryAfterMs;
  }

  get isQuota(): boolean {
    return this.code.startsWith("quota_");
  }

  get isAuth(): boolean {
    return (
      this.code === "unauthorized" ||
      this.code === "forbidden" ||
      this.code === "sign_in_required"
    );
  }

  get isConflict(): boolean {
    return (
      this.code === "conversation_locked" ||
      this.code === "idempotency_conflict"
    );
  }
}

/**
 * The request may or may not have reached the DO (network drop, timeout).
 * The optimistic row is re-armed on the next process load because the same
 * `clientMsgId` replays safely.
 */
export class CloudTurnStartTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudTurnStartTransportError";
  }
}

/** A fresh conversation id. Satisfies `CONVERSATION_ID_PATTERN` by construction. */
export const newCloudConversationId = (): string => {
  const id = crypto.randomUUID();
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw new Error("Minted conversation id does not satisfy the contract.");
  }
  return id;
};

/**
 * Title hint for the conversation this turn may create: the visible prompt,
 * whitespace-collapsed, the way the tab strip derives titles. The DO ignores
 * it when the conversation already exists.
 */
export const cloudTurnTitleHint = (text: string): string | undefined => {
  const title = text.replace(/\s+/g, " ").trim().slice(0, TURN_TITLE_MAX_CHARS);
  return title || undefined;
};

/**
 * Wire body for one turn. Built only from the frozen submission and the
 * visible prompt text, so an idempotent retry sends identical bytes.
 */
export const cloudTurnStartRequest = (
  clientMsgId: string,
  submission: PendingCloudTurnSubmission,
  visibleText: string,
): CloudTurnStartRequest => {
  const title = cloudTurnTitleHint(visibleText);
  return {
    protocol: TURN_PLANE_PROTOCOL,
    clientMsgId,
    prompt: submission.prompt,
    ...(submission.execution ? { execution: submission.execution } : {}),
    ...(submission.locale ? { locale: submission.locale } : {}),
    ...(submission.imagePaths.length
      ? { attachments: [...submission.imagePaths] }
      : {}),
    source: "desktop",
    ...(title ? { title } : {}),
  };
};

const readErrorBody = async (
  response: Response,
): Promise<CloudTurnStartError["error"] | null> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const error = (payload as Partial<CloudTurnStartError> | null)?.error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<CloudTurnStartError["error"]>;
  if (!isErrorCode(candidate.code)) return null;
  return {
    code: candidate.code,
    message: typeof candidate.message === "string" ? candidate.message : "",
    retryable: candidate.retryable === true,
    ...(typeof candidate.retryAfterMs === "number"
      ? { retryAfterMs: candidate.retryAfterMs }
      : {}),
  };
};

const codeForStatus = (status: number): CloudTurnStartErrorCode => {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 409:
      return "conversation_locked";
    case 429:
      return "quota_burst";
    default:
      return "internal";
  }
};

const retryAfterHeaderMs = (response: Response): number | null => {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
};

const toClientError = async (
  response: Response,
): Promise<CloudTurnStartClientError> => {
  const body = await readErrorBody(response);
  const status = response.status;
  const code = body?.code ?? codeForStatus(status);
  const retryAfterMs =
    body?.retryAfterMs ??
    (status === 429 ? retryAfterHeaderMs(response) : null);
  return new CloudTurnStartClientError({
    code,
    status,
    message: body?.message,
    retryable:
      body?.retryable ?? (status === 409 || status === 429 || status >= 500),
    retryAfterMs,
  });
};

const isStartResponse = (
  value: unknown,
  conversationId: string,
): value is CloudTurnStartResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CloudTurnStartResponse>;
  return (
    candidate.protocol === TURN_PLANE_PROTOCOL &&
    candidate.accepted === true &&
    candidate.conversationId === conversationId &&
    typeof candidate.turnId === "string" &&
    candidate.turnId.length > 0 &&
    typeof candidate.replayed === "boolean" &&
    typeof candidate.createdConversation === "boolean"
  );
};

export type StartCloudTurnArgs = {
  /** Builder origin from `getCloudRealtimeConfig`, e.g. `https://build.example`. */
  socketOrigin: string;
  conversationId: string;
  request: CloudTurnStartRequest;
  /** Resolves the Better Auth JWT; `forceRefresh` bypasses every cache. */
  getToken: CloudTurnStartGetToken;
  /** Test seam. */
  fetch?: typeof fetch;
};

const postOnce = async (
  args: StartCloudTurnArgs,
  token: string,
): Promise<Response> => {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  try {
    return await fetchImpl(
      `${args.socketOrigin.replace(/\/+$/, "")}${turnStartPath(args.conversationId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args.request),
        signal: AbortSignal.timeout(TURN_START_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const name = (error as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new CloudTurnStartTransportError(
        "The cloud turn request timed out. Try again.",
        { cause: error },
      );
    }
    throw new CloudTurnStartTransportError(
      "Stella's cloud could not be reached. Check the connection and try again.",
      { cause: error },
    );
  }
};

/**
 * Starts (or replays) one turn. Resolves with the DO's admission receipt;
 * `replayed: true` is the same success from the caller's point of view. A
 * 401 is retried exactly once with a freshly minted JWT before it surfaces.
 */
export const startCloudTurn = async (
  args: StartCloudTurnArgs,
): Promise<CloudTurnStartResponse> => {
  if (!CONVERSATION_ID_PATTERN.test(args.conversationId)) {
    throw new CloudTurnStartClientError({
      code: "bad_request",
      status: 0,
      message: "That conversation id is not valid.",
    });
  }
  const token = (await args.getToken())?.trim();
  if (!token) {
    throw new CloudTurnStartClientError({ code: "unauthorized", status: 0 });
  }
  let response = await postOnce(args, token);
  if (response.status === 401) {
    const refreshed = (await args.getToken({ forceRefresh: true }))?.trim();
    if (refreshed && refreshed !== token) {
      response = await postOnce(args, refreshed);
    }
  }
  if (!response.ok) throw await toClientError(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!isStartResponse(payload, args.conversationId)) {
    throw new CloudTurnStartClientError({
      code: "internal",
      status: response.status,
      message: "Stella's cloud returned a malformed turn receipt.",
      retryable: true,
    });
  }
  return payload;
};
