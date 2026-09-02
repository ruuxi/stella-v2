/**
 * Execution placement for the web shell.
 *
 *   POST {socketOrigin}/owners/me/dispatches
 *   GET  {socketOrigin}/owners/me/dispatches/{dispatchId}
 *   POST {socketOrigin}/owners/me/dispatches/{dispatchId}/cancel
 *   GET  {socketOrigin}/owners/me/devices
 *
 * The per-owner Durable Object on the cloud-builder decides where a turn
 * runs: an eligible computer that claims the offer inside the window, else
 * Stella's cloud. Convex is not on this path — it only projects what the gate
 * reports — so the browser talks to the gate with the same Better Auth JWT
 * the conversation socket presents.
 *
 * Mirrors `turn-start-client.ts`: typed refusals, one silent retry after a
 * 401 with a freshly minted token, and transport failures kept distinct from
 * definitive answers.
 */

import {
  DEVICES_PATH,
  DISPATCH_SUBMIT_PATH,
  PLACEMENT_PROTOCOL,
  dispatchCancelPath,
  dispatchPath,
  type DevicesResponse,
  type DispatchCancelRequest,
  type DispatchError,
  type DispatchErrorCode,
  type DispatchStatusResponse,
  type DispatchSubmitRequest,
  type DispatchSubmitResponse,
  type DispatchSummary,
} from "@stella/contracts/turn-plane/placement";

/** Bound on one owner-gate round trip. Placement answers before the run. */
export const PLACEMENT_REQUEST_TIMEOUT_MS = 30_000;

export type PlacementTokenOptions = { forceRefresh?: boolean };
export type PlacementGetToken = (
  options?: PlacementTokenOptions,
) => Promise<string | null>;

export const PLACEMENT_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Stella to send cloud messages.";

/** Readable fallbacks per contract code; the gate's own message wins. */
const FALLBACK_MESSAGES: Record<DispatchErrorCode, string> = {
  unauthorized: PLACEMENT_SIGN_IN_REQUIRED_MESSAGE,
  forbidden: "This account can't send to that conversation.",
  bad_request:
    "That message couldn't be sent as written. Edit it and try again.",
  conflict:
    "This message was already sent with different content. Send it again as a new message.",
  not_found: "That cloud turn is no longer available.",
  owner_purged:
    "This account's cloud data was reset. Start a new conversation.",
  generation_stale: "This request started before the account data was reset.",
  capability_unavailable:
    "No computer with what this needs is online right now.",
  quota_burst: "You're sending messages quickly. Wait a moment and try again.",
  quota_daily: "You've reached today's cloud chat limit. Try again tomorrow.",
  quota_concurrency:
    "Stella is still working on an earlier turn. Wait for it to finish, then try again.",
  sign_in_required: "Sign in to Stella to use cloud agents.",
  owner_suspended: "This account can't use Stella's cloud right now.",
  internal: "That didn't send. Try again.",
};

const ERROR_CODES = new Set<string>(Object.keys(FALLBACK_MESSAGES));

const isErrorCode = (value: unknown): value is DispatchErrorCode =>
  typeof value === "string" && ERROR_CODES.has(value);

/**
 * The owner gate answered and refused. Definitive: nothing was committed, so
 * an idempotent retry sends the exact same bytes again.
 */
export class PlacementClientError extends Error {
  readonly code: DispatchErrorCode;
  /** HTTP status, or 0 when the request never left the client. */
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(args: {
    code: DispatchErrorCode;
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
    this.name = "PlacementClientError";
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
}

/**
 * The request may or may not have reached the gate (network drop, timeout).
 * The optimistic row replays safely under the same idempotency key.
 */
export class PlacementTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlacementTransportError";
  }
}

const codeForStatus = (status: number): DispatchErrorCode => {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
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

const readErrorBody = async (
  response: Response,
): Promise<DispatchError["error"] | null> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const error = (payload as Partial<DispatchError> | null)?.error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<DispatchError["error"]>;
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

const toClientError = async (
  response: Response,
): Promise<PlacementClientError> => {
  const body = await readErrorBody(response);
  const status = response.status;
  const code = body?.code ?? codeForStatus(status);
  const retryAfterMs =
    body?.retryAfterMs ??
    (status === 429 ? retryAfterHeaderMs(response) : null);
  return new PlacementClientError({
    code,
    status,
    message: body?.message,
    retryable:
      body?.retryable ?? (status === 409 || status === 429 || status >= 500),
    retryAfterMs,
  });
};

const isDispatchSummary = (value: unknown): value is DispatchSummary => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DispatchSummary>;
  return (
    typeof candidate.dispatchId === "string" &&
    candidate.dispatchId.length > 0 &&
    (candidate.kind === "chat" || candidate.kind === "agent") &&
    typeof candidate.conversationId === "string" &&
    typeof candidate.state === "string"
  );
};

export type PlacementRequestBase = {
  /** Builder origin from `getCloudRealtimeConfig`. */
  socketOrigin: string;
  /** Resolves the Better Auth JWT; `forceRefresh` bypasses every cache. */
  getToken: PlacementGetToken;
  /** Test seam. */
  fetch?: typeof fetch;
};

const requestOnce = async (
  args: PlacementRequestBase & {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  },
  token: string,
): Promise<Response> => {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  try {
    return await fetchImpl(
      `${args.socketOrigin.replace(/\/+$/, "")}${args.path}`,
      {
        method: args.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(args.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        signal: AbortSignal.timeout(PLACEMENT_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const name = (error as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new PlacementTransportError(
        "The cloud placement request timed out. Try again.",
        { cause: error },
      );
    }
    throw new PlacementTransportError(
      "Stella's cloud could not be reached. Check the connection and try again.",
      { cause: error },
    );
  }
};

/** One authenticated owner-gate call; a 401 is retried once with a fresh JWT. */
const placementRequest = async (
  args: PlacementRequestBase & {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  },
): Promise<Response> => {
  const token = (await args.getToken())?.trim();
  if (!token) {
    throw new PlacementClientError({ code: "unauthorized", status: 0 });
  }
  let response = await requestOnce(args, token);
  if (response.status === 401) {
    const refreshed = (await args.getToken({ forceRefresh: true }))?.trim();
    if (refreshed && refreshed !== token) {
      response = await requestOnce(args, refreshed);
    }
  }
  return response;
};

const readDispatch = async (response: Response): Promise<DispatchSummary> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const dispatch = (
    payload as Partial<DispatchSubmitResponse | DispatchStatusResponse> | null
  )?.dispatch;
  if (!isDispatchSummary(dispatch)) {
    throw new PlacementClientError({
      code: "internal",
      status: response.status,
      message: "Stella's cloud returned a malformed dispatch receipt.",
      retryable: true,
    });
  }
  return dispatch;
};

/** Submits (or replays) one dispatch. A replay is the same success. */
export const submitDispatch = async (
  args: PlacementRequestBase & { request: DispatchSubmitRequest },
): Promise<DispatchSummary> => {
  const response = await placementRequest({
    ...args,
    path: DISPATCH_SUBMIT_PATH,
    method: "POST",
    body: args.request,
  });
  if (!response.ok) throw await toClientError(response);
  return await readDispatch(response);
};

/** One status read. `null` means the gate has no such dispatch for this owner. */
export const getDispatchStatus = async (
  args: PlacementRequestBase & { dispatchId: string },
): Promise<DispatchSummary | null> => {
  const response = await placementRequest({
    ...args,
    path: dispatchPath(args.dispatchId),
    method: "GET",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await toClientError(response);
  return await readDispatch(response);
};

export const cancelDispatch = async (
  args: PlacementRequestBase & {
    dispatchId: string;
    cancelRequestId: string;
    reason?: string;
  },
): Promise<DispatchSummary> => {
  const body: DispatchCancelRequest = {
    protocol: PLACEMENT_PROTOCOL,
    cancelRequestId: args.cancelRequestId,
    ...(args.reason ? { reason: args.reason } : {}),
  };
  const response = await placementRequest({
    ...args,
    path: dispatchCancelPath(args.dispatchId),
    method: "POST",
    body,
  });
  if (!response.ok) throw await toClientError(response);
  return await readDispatch(response);
};

/** The owner's execution destinations with live presence. */
export const listExecutionDevices = async (
  args: PlacementRequestBase,
): Promise<DevicesResponse> => {
  const response = await placementRequest({
    ...args,
    path: DEVICES_PATH,
    method: "GET",
  });
  if (!response.ok) throw await toClientError(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const devices = (payload as Partial<DevicesResponse> | null)?.devices;
  if (!Array.isArray(devices)) {
    throw new PlacementClientError({
      code: "internal",
      status: response.status,
      message: "Stella's cloud returned a malformed device list.",
      retryable: true,
    });
  }
  const cloud = (payload as Partial<DevicesResponse> | null)?.cloud;
  return {
    protocol: PLACEMENT_PROTOCOL,
    devices: devices.filter(
      (device): device is DevicesResponse["devices"][number] =>
        Boolean(device) &&
        typeof device === "object" &&
        typeof (device as { deviceId?: unknown }).deviceId === "string",
    ),
    cloud: {
      capabilities: Array.isArray(cloud?.capabilities)
        ? cloud.capabilities
        : [],
    },
  };
};
