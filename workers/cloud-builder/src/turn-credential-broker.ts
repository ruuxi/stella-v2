import {
  TURN_BROKER_AUTH_SCHEME,
  TURN_BROKER_HEADERS,
  TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
  TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
  TURN_BROKER_RESPONSE_HEADERS,
  TURN_BROKER_TURN_TOKEN_HEADER,
  TURN_BROKER_VERSION,
  type TurnBrokerHandoff,
  type TurnBrokerIdentity,
} from "@stella/contracts/turn-credential-broker";
import { sha256Hex } from "./hash.js";

/**
 * The reusable Convex turn token never crosses the BuildSession boundary.
 * A sandbox gets this independently random, short-lived capability instead;
 * it can only ask the owning BuildSession to perform one of the bounded
 * turn-scoped requests below.
 */
export const TURN_BROKER_MAX_TTL_MS = 30 * 60_000;
export const TURN_BROKER_MAX_REQUESTS = 4_096;
export const TURN_BROKER_MAX_RELAY_REQUESTS = 1_024;

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_PATH_PATTERN =
  /^\/api\/stella\/relay(?:\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{1,768})?$/;
const MAX_RELAY_QUERY_BYTES = 2_048;
const MAX_CALLBACK_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RELAY_BODY_BYTES = 24 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_TURN_STATE_CHECKPOINT_BODY_BYTES = 5 * 1024 * 1024;

const CALLBACK_PATHS = new Set([
  "/api/cloud/drive/files",
  "/api/cloud/drive/sync",
  "/api/cloud/events",
  "/api/cloud/messages",
  "/api/cloud/web-search",
]);

/** Raw-token-free durable state owned by one BuildSession. */
export type TurnBrokerRecord = TurnBrokerIdentity & {
  version: typeof TURN_BROKER_VERSION;
  capabilityHash: string;
  createdAt: number;
  expiresAt: number;
  nextSequence: number;
  requestCount: number;
  relayRequestCount: number;
  state: "active" | "revoked";
  revokedAt?: number;
  lastClaim?: {
    sequence: number;
    requestId: string;
    method: string;
    targetPath: string;
    bodySha256: string;
  };
};

export type TurnBrokerLiveFence = TurnBrokerIdentity & {
  active: boolean;
  canceled: boolean;
  terminal: boolean;
};

export type TurnBrokerTarget = {
  kind:
    | "browser-gateway"
    | "builder-callback"
    | "callback"
    | "interior-build-request"
    | "model-resolution"
    | "model-relay";
  method: "POST" | "GET" | "DELETE";
  path: string;
  maxBodyBytes: number;
};

export type TurnBrokerEngine = "stella" | "anthropic" | "openai-codex";

export type TurnBrokerClaimFailure = {
  ok: false;
  status: 400 | 401 | 403 | 409 | 410 | 413 | 429;
  code:
    | "malformed"
    | "unauthorized"
    | "expired"
    | "wrong_owner"
    | "wrong_generation"
    | "wrong_turn"
    | "wrong_attempt"
    | "inactive"
    | "canceled"
    | "terminal"
    | "replay"
    | "out_of_order"
    | "limit_exceeded"
    | "target_denied"
    | "body_too_large";
};

export type TurnBrokerClaimResult =
  | {
      ok: true;
      disposition: "claim" | "replay";
      record: TurnBrokerRecord;
      target: TurnBrokerTarget;
    }
  | TurnBrokerClaimFailure;

export type TurnBrokerPreflightResult =
  | {
      ok: true;
      target: TurnBrokerTarget;
      sequence: number;
      requestId: string;
    }
  | TurnBrokerClaimFailure;

const failure = (
  status: TurnBrokerClaimFailure["status"],
  code: TurnBrokerClaimFailure["code"],
): TurnBrokerClaimFailure => ({ ok: false, status, code });

const boundedIdentityPart = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const validIdentity = (identity: TurnBrokerIdentity): boolean =>
  boundedIdentityPart(identity.sessionId) &&
  boundedIdentityPart(identity.ownerId) &&
  boundedIdentityPart(identity.ownerGeneration) &&
  boundedIdentityPart(identity.turnId) &&
  Number.isSafeInteger(identity.attemptGeneration) &&
  identity.attemptGeneration > 0;

const validRecord = (record: TurnBrokerRecord): boolean => {
  const validLastClaim =
    record.requestCount === 0
      ? record.lastClaim === undefined
      : record.lastClaim !== undefined &&
        record.lastClaim.sequence === record.nextSequence - 1 &&
        UUID_PATTERN.test(record.lastClaim.requestId) &&
        ["POST", "GET", "DELETE"].includes(record.lastClaim.method) &&
        boundedIdentityPart(record.lastClaim.targetPath, 2_048) &&
        /^[0-9a-f]{64}$/.test(record.lastClaim.bodySha256);
  return (
    validIdentity(record) &&
    record.version === TURN_BROKER_VERSION &&
    /^[0-9a-f]{64}$/.test(record.capabilityHash) &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt > record.createdAt &&
    record.expiresAt - record.createdAt <= TURN_BROKER_MAX_TTL_MS &&
    Number.isSafeInteger(record.nextSequence) &&
    record.nextSequence > 0 &&
    Number.isSafeInteger(record.requestCount) &&
    record.requestCount >= 0 &&
    record.nextSequence === record.requestCount + 1 &&
    Number.isSafeInteger(record.relayRequestCount) &&
    record.relayRequestCount >= 0 &&
    record.relayRequestCount <= record.requestCount &&
    ((record.state === "active" && record.revokedAt === undefined) ||
      (record.state === "revoked" &&
        Number.isSafeInteger(record.revokedAt) &&
        Number(record.revokedAt) >= record.createdAt)) &&
    validLastClaim
  );
};

const capabilityFromAuthorization = (headers: Headers): string | null => {
  const authorization = headers.get("authorization")?.trim() ?? "";
  const prefix = `${TURN_BROKER_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return null;
  const capability = authorization.slice(prefix.length);
  return CAPABILITY_PATTERN.test(capability) ? capability : null;
};

/** Fixed-work comparison for already-hashed, equal-length capability values. */
const equalHash = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const randomCapability = (
  randomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string => {
  const bytes = randomBytes(new Uint8Array(32));
  if (bytes.byteLength !== 32) {
    throw new Error("Turn broker entropy source returned the wrong length.");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const normalizedBrokerEndpoint = (value: string): string => {
  const endpoint = new URL(value);
  const localHttp =
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost");
  if (
    (endpoint.protocol !== "https:" && !localHttp) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Error(
      "Turn broker endpoint must be a credential-free HTTPS URL.",
    );
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  return endpoint.toString().replace(/\/$/u, "");
};

export const issueTurnBrokerCredential = async (args: {
  identity: TurnBrokerIdentity;
  endpoint: string;
  now: number;
  ttlMs: number;
  randomBytes?: (bytes: Uint8Array) => Uint8Array;
}): Promise<{ handoff: TurnBrokerHandoff; record: TurnBrokerRecord }> => {
  if (!validIdentity(args.identity)) {
    throw new Error("Turn broker requires an exact bounded turn identity.");
  }
  if (
    !Number.isSafeInteger(args.now) ||
    args.now < 0 ||
    !Number.isSafeInteger(args.ttlMs) ||
    args.ttlMs <= 0 ||
    args.ttlMs > TURN_BROKER_MAX_TTL_MS
  ) {
    throw new Error("Turn broker lifetime is outside the bounded window.");
  }
  const endpoint = normalizedBrokerEndpoint(args.endpoint);
  const capability = randomCapability(args.randomBytes);
  if (!CAPABILITY_PATTERN.test(capability)) {
    throw new Error("Turn broker generated an invalid capability.");
  }
  const capabilityHash = await sha256Hex(capability);
  const expiresAt = args.now + args.ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Turn broker expiry is outside the safe integer range.");
  }
  return {
    handoff: {
      ...args.identity,
      version: TURN_BROKER_VERSION,
      endpoint,
      capability,
      expiresAt,
      initialSequence: 1,
    },
    record: {
      ...args.identity,
      version: TURN_BROKER_VERSION,
      capabilityHash,
      createdAt: args.now,
      expiresAt,
      nextSequence: 1,
      requestCount: 0,
      relayRequestCount: 0,
      state: "active",
    },
  };
};

export const revokeTurnBrokerCredential = (
  record: TurnBrokerRecord,
  now: number,
): TurnBrokerRecord => {
  if (!validRecord(record) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Turn broker record cannot be revoked safely.");
  }
  return {
    ...record,
    state: "revoked",
    revokedAt: Math.max(record.createdAt, now),
  };
};

export const turnBrokerStorageKey = (
  identity: Pick<TurnBrokerIdentity, "turnId" | "attemptGeneration">,
): string =>
  `turn-broker:${encodeURIComponent(identity.turnId)}:${identity.attemptGeneration}`;

const exactPath = (targetPath: string): URL | null => {
  if (
    !targetPath.startsWith("/") ||
    targetPath.startsWith("//") ||
    targetPath.includes("\\") ||
    targetPath.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(targetPath)
  ) {
    return null;
  }
  try {
    const parsed = new URL(targetPath, "https://turn-broker.invalid");
    const rawPathname = targetPath.split("?", 1)[0]!;
    // URL normalisation must not turn traversal or alternate encodings into an
    // allowed route after the policy check.
    if (
      parsed.origin !== "https://turn-broker.invalid" ||
      parsed.pathname !== rawPathname ||
      /%(?:2e|2f|5c)/iu.test(rawPathname)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const validateTurnBrokerTarget = (
  methodValue: unknown,
  targetPath: unknown,
): TurnBrokerTarget | null => {
  if (typeof methodValue !== "string" || typeof targetPath !== "string") {
    return null;
  }
  const method = methodValue.toUpperCase();
  if (method !== methodValue || !["POST", "GET", "DELETE"].includes(method)) {
    return null;
  }
  const parsed = exactPath(targetPath);
  if (!parsed) return null;

  if (CALLBACK_PATHS.has(parsed.pathname)) {
    return method === "POST" && !parsed.search
      ? {
          kind: "callback",
          method,
          path: parsed.pathname,
          maxBodyBytes: MAX_CALLBACK_BODY_BYTES,
        }
      : null;
  }
  if (parsed.pathname === "/api/stella/cloud-model") {
    return method === "POST" && !parsed.search
      ? {
          kind: "model-resolution",
          method,
          path: parsed.pathname,
          maxBodyBytes: MAX_CONTROL_BODY_BYTES,
        }
      : null;
  }
  if (parsed.pathname === TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH) {
    return method === "POST" && !parsed.search
      ? {
          kind: "builder-callback",
          method,
          path: parsed.pathname,
          maxBodyBytes: MAX_TURN_STATE_CHECKPOINT_BODY_BYTES,
        }
      : null;
  }
  if (parsed.pathname === TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH) {
    return method === "POST" && !parsed.search
      ? {
          kind: "interior-build-request",
          method,
          path: parsed.pathname,
          maxBodyBytes: MAX_CONTROL_BODY_BYTES,
        }
      : null;
  }
  if (parsed.pathname === "/api/cloud/browser/command") {
    return method === "POST" && !parsed.search
      ? {
          kind: "browser-gateway",
          method,
          path: parsed.pathname,
          maxBodyBytes: MAX_CONTROL_BODY_BYTES,
        }
      : null;
  }
  if (
    RELAY_PATH_PATTERN.test(parsed.pathname) &&
    !parsed.pathname.includes("//") &&
    !parsed.pathname
      .split("/")
      .some((segment) => segment === "." || segment === "..") &&
    parsed.search.length <= MAX_RELAY_QUERY_BYTES
  ) {
    return {
      kind: "model-relay",
      method: method as TurnBrokerTarget["method"],
      path: `${parsed.pathname}${parsed.search}`,
      maxBodyBytes:
        method === "POST" ? MAX_RELAY_BODY_BYTES : MAX_CONTROL_BODY_BYTES,
    };
  }
  return null;
};

/** Bind model-shaped routes to the exact engine Convex selected at dispatch. */
export const turnBrokerTargetMatchesEngine = (
  target: TurnBrokerTarget,
  engine: TurnBrokerEngine,
): boolean => {
  if (
    target.kind === "callback" ||
    target.kind === "builder-callback" ||
    // The agent asks for an interior build; the engine it ran on is irrelevant.
    target.kind === "interior-build-request"
  ) {
    return true;
  }
  if (target.kind === "browser-gateway") return engine === "stella";
  if (target.kind === "model-resolution") return engine === "stella";
  if (engine === "stella") return true;
  const pathname = new URL(target.path, "https://turn-broker.invalid").pathname;
  if (engine === "anthropic") {
    return (
      target.method === "POST" &&
      (pathname.endsWith("/v1/messages") ||
        pathname.endsWith("/v1/messages/count_tokens"))
    );
  }
  return (
    pathname.endsWith("/responses") ||
    pathname.endsWith("/v1/responses") ||
    pathname.endsWith("/responses/compact") ||
    pathname.endsWith("/v1/responses/compact") ||
    /^\/api\/stella\/relay\/(?:v1\/)?responses\/[A-Za-z0-9._~-]{1,200}$/.test(
      pathname,
    )
  );
};

const integerHeader = (headers: Headers, name: string): number | null => {
  const raw = headers.get(name)?.trim() ?? "";
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * Cheap authentication before reading a potentially large streaming body.
 * The full claim repeats these checks after the body hash and live fences are
 * available, so this is an anti-DoS gate rather than the authority decision.
 */
export const preflightTurnBrokerRequest = async (args: {
  record: TurnBrokerRecord;
  headers: Headers;
  now: number;
}): Promise<TurnBrokerPreflightResult> => {
  const { record, headers } = args;
  if (!validRecord(record) || !Number.isSafeInteger(args.now) || args.now < 0) {
    return failure(400, "malformed");
  }
  const capability = capabilityFromAuthorization(headers);
  if (!capability) return failure(401, "unauthorized");
  if (!equalHash(await sha256Hex(capability), record.capabilityHash)) {
    return failure(401, "unauthorized");
  }
  if (record.state !== "active") return failure(410, "inactive");
  if (args.now >= record.expiresAt) return failure(401, "expired");
  if (headers.get(TURN_BROKER_HEADERS.ownerId) !== record.ownerId) {
    return failure(403, "wrong_owner");
  }
  if (
    headers.get(TURN_BROKER_HEADERS.ownerGeneration) !== record.ownerGeneration
  ) {
    return failure(403, "wrong_generation");
  }
  if (headers.get(TURN_BROKER_HEADERS.turnId) !== record.turnId) {
    return failure(403, "wrong_turn");
  }
  if (
    integerHeader(headers, TURN_BROKER_HEADERS.attemptGeneration) !==
    record.attemptGeneration
  ) {
    return failure(403, "wrong_attempt");
  }
  const sequence = integerHeader(headers, TURN_BROKER_HEADERS.sequence);
  const requestId = headers.get(TURN_BROKER_HEADERS.requestId)?.trim() ?? "";
  if (sequence === null || !UUID_PATTERN.test(requestId)) {
    return failure(400, "malformed");
  }
  const target = validateTurnBrokerTarget(
    headers.get(TURN_BROKER_HEADERS.targetMethod),
    headers.get(TURN_BROKER_HEADERS.targetPath),
  );
  if (!target) return failure(403, "target_denied");
  if (sequence > record.nextSequence) return failure(409, "out_of_order");
  if (
    sequence < record.nextSequence &&
    !(
      (target.kind === "builder-callback" ||
        target.kind === "browser-gateway") &&
      sequence === record.nextSequence - 1 &&
      record.lastClaim?.sequence === sequence &&
      record.lastClaim.requestId === requestId &&
      record.lastClaim.method === target.method &&
      record.lastClaim.targetPath === target.path
    )
  ) {
    return failure(409, "replay");
  }
  return { ok: true, target, sequence, requestId };
};

/**
 * Authorize and consume exactly one broker sequence. The caller must persist
 * the returned record atomically before any upstream I/O; a crash after that
 * point may fail the turn, but it can never replay the authority.
 */
export const claimTurnBrokerRequest = async (args: {
  record: TurnBrokerRecord;
  live: TurnBrokerLiveFence;
  headers: Headers;
  now: number;
  bodyBytes: number;
  bodySha256: string;
}): Promise<TurnBrokerClaimResult> => {
  const { record, live, headers } = args;
  if (
    !validIdentity(live) ||
    typeof live.active !== "boolean" ||
    typeof live.canceled !== "boolean" ||
    typeof live.terminal !== "boolean" ||
    !Number.isSafeInteger(args.bodyBytes) ||
    args.bodyBytes < 0 ||
    !/^[0-9a-f]{64}$/.test(args.bodySha256)
  ) {
    return failure(400, "malformed");
  }

  const preflight = await preflightTurnBrokerRequest({
    record,
    headers,
    now: args.now,
  });
  if (!preflight.ok) return preflight;

  const ownerId = headers.get(TURN_BROKER_HEADERS.ownerId);
  const ownerGeneration = headers.get(TURN_BROKER_HEADERS.ownerGeneration);
  const turnId = headers.get(TURN_BROKER_HEADERS.turnId);
  const attemptGeneration = integerHeader(
    headers,
    TURN_BROKER_HEADERS.attemptGeneration,
  );
  if (ownerId !== record.ownerId || ownerId !== live.ownerId) {
    return failure(403, "wrong_owner");
  }
  if (
    ownerGeneration !== record.ownerGeneration ||
    ownerGeneration !== live.ownerGeneration
  ) {
    return failure(403, "wrong_generation");
  }
  if (turnId !== record.turnId || turnId !== live.turnId) {
    return failure(403, "wrong_turn");
  }
  if (
    attemptGeneration !== record.attemptGeneration ||
    attemptGeneration !== live.attemptGeneration
  ) {
    return failure(403, "wrong_attempt");
  }
  if (record.sessionId !== live.sessionId) return failure(403, "wrong_turn");
  if (!live.active) return failure(410, "inactive");
  if (live.canceled) return failure(410, "canceled");
  if (live.terminal) return failure(410, "terminal");

  const { sequence, requestId, target } = preflight;
  if (args.bodyBytes > target.maxBodyBytes) {
    return failure(413, "body_too_large");
  }
  if (sequence < record.nextSequence) {
    const exactReplay =
      (target.kind === "builder-callback" ||
        target.kind === "browser-gateway") &&
      sequence === record.nextSequence - 1 &&
      record.lastClaim?.sequence === sequence &&
      record.lastClaim.requestId === requestId &&
      record.lastClaim.method === target.method &&
      record.lastClaim.targetPath === target.path &&
      record.lastClaim.bodySha256 === args.bodySha256;
    return exactReplay
      ? { ok: true, disposition: "replay", record, target }
      : failure(409, "replay");
  }
  if (sequence > record.nextSequence) return failure(409, "out_of_order");
  if (
    record.requestCount >= TURN_BROKER_MAX_REQUESTS ||
    (target.kind === "model-relay" &&
      record.relayRequestCount >= TURN_BROKER_MAX_RELAY_REQUESTS)
  ) {
    return failure(429, "limit_exceeded");
  }

  return {
    ok: true,
    disposition: "claim",
    target,
    record: {
      ...record,
      nextSequence: record.nextSequence + 1,
      requestCount: record.requestCount + 1,
      relayRequestCount:
        record.relayRequestCount + (target.kind === "model-relay" ? 1 : 0),
      lastClaim: {
        sequence,
        requestId,
        method: target.method,
        targetPath: target.path,
        bodySha256: args.bodySha256,
      },
    },
  };
};

export class TurnBrokerBodyTooLargeError extends Error {
  constructor() {
    super("Turn broker request body exceeded its route limit.");
    this.name = "TurnBrokerBodyTooLargeError";
  }
}

/** Bounded streaming read; Content-Length is advisory, never the only gate. */
export const readTurnBrokerRequestBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Turn broker body limit is invalid.");
  }
  const declared = request.headers.get("content-length");
  if (declared) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new TurnBrokerBodyTooLargeError();
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TurnBrokerBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const forbiddenUpstreamHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  const allowedStellaHeader =
    lower === "x-stella-relay-request-id" || lower === "x-stella-relay-resume";
  return (
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "x-api-key" ||
    lower === "x-goog-api-key" ||
    lower === "cookie" ||
    lower === "set-cookie" ||
    lower === "host" ||
    lower === "content-length" ||
    lower === TURN_BROKER_TURN_TOKEN_HEADER ||
    lower.startsWith("x-stella-broker-") ||
    (lower.startsWith("x-stella-") && !allowedStellaHeader) ||
    lower.startsWith("cf-") ||
    lower === "forwarded" ||
    lower.startsWith("x-forwarded-") ||
    lower === "x-real-ip" ||
    lower === "connection" ||
    lower === "transfer-encoding" ||
    lower === "upgrade"
  );
};

/** Strip every caller credential and transport hop before Builder mediation. */
export const turnBrokerUpstreamHeaders = (
  incoming: Headers,
  rawTurnToken: string,
  engine: TurnBrokerEngine,
): Headers => {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    if (!forbiddenUpstreamHeader(name)) headers.set(name, value);
  });
  headers.set(TURN_BROKER_TURN_TOKEN_HEADER, rawTurnToken);
  headers.set("x-stella-agent-type", "general");
  if (engine === "anthropic" || engine === "openai-codex") {
    headers.set("x-stella-llm-credential", engine);
  } else {
    headers.delete("x-stella-llm-credential");
  }
  return headers;
};

/** Never send backend cookies or broker metadata back into the sandbox. */
export const turnBrokerSandboxResponseHeaders = (
  incoming: Headers,
): Headers => {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    const allowedStellaResponseHeader =
      lower === "x-stella-relay-request-id" ||
      lower === "x-stella-response-id" ||
      lower === "x-stella-upstream-request-id";
    if (
      lower !== "set-cookie" &&
      lower !== "authorization" &&
      lower !== TURN_BROKER_TURN_TOKEN_HEADER &&
      !lower.startsWith("x-stella-broker-") &&
      (!lower.startsWith("x-stella-") || allowedStellaResponseHeader) &&
      !lower.startsWith("cf-")
    ) {
      headers.set(name, value);
    }
  });
  return headers;
};

const finiteTurnBrokerUpstreamErrorResponse = (upstream: Response): Response => {
  const headers = turnBrokerSandboxResponseHeaders(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  // A managed relay can publish its non-OK status before the upstream body
  // reaches EOF. Do not carry that live body across the BuildSession Durable
  // Object/service-binding boundary: the outer Worker (and therefore the
  // sandbox fetch) can otherwise wait forever before the executor gets a
  // chance to apply its own finite error-body guard.
  void upstream.body?.cancel().catch(() => undefined);
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: upstream.status === 429 ? "rate_limit_error" : "api_error",
        message: `Managed model relay returned HTTP ${upstream.status}.`,
      },
    }),
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    },
  );
};

export const turnBrokerDenialResponse = (
  denied: TurnBrokerClaimFailure,
): Response =>
  Response.json(
    { error: "Turn broker authority is unavailable." },
    {
      status: denied.status,
      headers: {
        "cache-control": "no-store",
        [TURN_BROKER_RESPONSE_HEADERS.denial]: "1",
      },
    },
  );

export const turnBrokerUpstreamUrl = (
  convexCallbackBase: string,
  expectedConvexOrigin: string,
  target: TurnBrokerTarget,
): string => {
  if (
    target.kind === "builder-callback" ||
    target.kind === "interior-build-request"
  ) {
    throw new Error("Builder-local broker callbacks have no upstream URL.");
  }
  if (target.kind === "browser-gateway") {
    throw new Error("Browser Gateway broker calls have no Convex URL.");
  }
  const base = new URL(convexCallbackBase);
  const expected = new URL(expectedConvexOrigin);
  if (
    base.protocol !== "https:" ||
    expected.protocol !== "https:" ||
    base.username ||
    base.password ||
    expected.username ||
    expected.password ||
    base.search ||
    base.hash ||
    expected.search ||
    expected.hash ||
    base.pathname !== "/" ||
    expected.pathname !== "/" ||
    base.origin !== expected.origin
  ) {
    throw new Error("Turn callback base must be a credential-free HTTPS URL.");
  }
  const upstream = new URL(target.path, base.origin);
  if (upstream.origin !== base.origin) {
    throw new Error("Turn broker target escaped the callback origin.");
  }
  return upstream.toString();
};

/**
 * The only place a raw turn token is attached to a sandbox-originated call.
 * It runs inside Builder after the durable claim and final live revalidation.
 */
export const forwardTurnBrokerRequest = async (args: {
  target: TurnBrokerTarget;
  body: Uint8Array;
  incomingHeaders: Headers;
  convexCallbackBase: string;
  expectedConvexOrigin: string;
  rawTurnToken: string;
  engine: TurnBrokerEngine;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> => {
  if (
    args.target.kind === "builder-callback" ||
    args.target.kind === "browser-gateway" ||
    args.target.kind === "interior-build-request"
  ) {
    throw new Error("Builder-local callback cannot be forwarded to Convex.");
  }
  if (!turnBrokerTargetMatchesEngine(args.target, args.engine)) {
    throw new Error("Turn broker target does not match the dispatched engine.");
  }
  const upstream = await (args.fetchImpl ?? fetch)(
    turnBrokerUpstreamUrl(
      args.convexCallbackBase,
      args.expectedConvexOrigin,
      args.target,
    ),
    {
      method: args.target.method,
      headers: turnBrokerUpstreamHeaders(
        args.incomingHeaders,
        args.rawTurnToken,
        args.engine,
      ),
      ...(args.body.byteLength > 0 ? { body: args.body } : {}),
      signal: args.signal,
      // Never forward the reusable raw authority to a redirect target.
      redirect: "manual",
    },
  );
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new Error("Turn broker upstream redirect was refused.");
  }
  if (!upstream.ok) return finiteTurnBrokerUpstreamErrorResponse(upstream);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: turnBrokerSandboxResponseHeaders(upstream.headers),
  });
};
