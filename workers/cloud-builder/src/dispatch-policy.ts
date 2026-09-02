/**
 * Placement policy, ported verbatim from Convex's
 * `decideServerExecutionPlacement` and its eligibility predicates.
 *
 * Two things live here and nothing else: the pure routing decision (which
 * never consults reachability — an `offer` is resolved later by a fenced
 * claim) and the eligibility predicate that turns live presence rows into the
 * set of devices an offer may go to. Both are pure so the owner gate's state
 * machine can be tested against the same matrix the Convex implementation
 * was, and so a routing change is a diff in one readable function.
 */

import {
  DEVICE_PRESENCE_PROTOCOL_VERSION,
  TERMINAL_DISPATCH_STATES,
  type DispatchError,
  type DispatchErrorCode,
  type DispatchPayload,
  type DispatchState,
  type DispatchSubmitRequest,
  type ExecutionCapability,
  type ExecutionIngress,
  type ExecutionKind,
  type ExecutionSubject,
  type ExecutionTargetMode,
  PLACEMENT_PROTOCOL,
} from "@stella/contracts/turn-plane/placement";
import { parseCloudExecutionSelection } from "./turn-start-request.js";

export const EXECUTION_CAPABILITIES: readonly ExecutionCapability[] = [
  "chat",
  "agent",
  "computer-use",
  "local-files",
  "local-apps",
  "attachments",
];

/**
 * Capabilities the cloud sandbox has by construction. A dispatch requiring
 * anything else can never be honoured in the cloud, so falling back to it
 * would silently execute a materially different request.
 */
export const CLOUD_PROVIDED_CAPABILITIES: readonly ExecutionCapability[] = [
  "chat",
  "agent",
  "attachments",
];

export const MAX_DISPATCH_ID_CHARS = 64;
export const MAX_DEVICE_ID_CHARS = 256;
export const MAX_IDEMPOTENCY_KEY_CHARS = 128;
export const MAX_CONVERSATION_ID_CHARS = 256;
export const MAX_REQUIRED_CAPABILITIES = 8;
export const MAX_OFFERS_PER_DISPATCH = 8;
export const MAX_DISPATCH_PAYLOAD_BYTES = 128 * 1024;
export const MAX_DISPATCH_PROMPT_CHARS = 8_000;
export const MAX_DISPATCH_DESCRIPTION_CHARS = 1_000;
export const MAX_DISPATCH_ATTACHMENTS = 4;

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type DispatchPolicyDecision =
  | { kind: "commit"; placement: "computer" | "cloud"; reason: string }
  | {
      kind: "offer";
      onNoEligibleComputer: "cloud" | "blocked";
      reason: string;
    }
  | { kind: "blocked"; reason: string };

/**
 * `subject` says what the work is about; `targetMode` is the independent,
 * user-facing executor choice. Keeping them separate is what stops a portable
 * prompt from changing meaning when it is sent somewhere else.
 */
export const decideDispatchPlacement = (args: {
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  targetMode?: ExecutionTargetMode;
}): DispatchPolicyDecision => {
  if (args.targetMode === "cloud") {
    return { kind: "commit", placement: "cloud", reason: "explicit-cloud" };
  }
  if (args.targetMode === "device") {
    return {
      kind: "offer",
      onNoEligibleComputer: "blocked",
      reason: "explicit-device",
    };
  }
  if (args.subject === "cloud") {
    return { kind: "commit", placement: "cloud", reason: "hosted-subject" };
  }
  if (args.ingress === "desktop") {
    return { kind: "commit", placement: "computer", reason: "desktop-ingress" };
  }
  if (args.ingress === "mobile") {
    return {
      kind: "offer",
      onNoEligibleComputer: "cloud",
      reason:
        args.subject === "computer"
          ? "paired-computer-preferred-for-computer-work"
          : "paired-computer-preferred",
    };
  }
  if (args.subject === "computer") {
    return { kind: "blocked", reason: "computer-unavailable-for-ingress" };
  }
  return {
    kind: "commit",
    placement: "cloud",
    reason: `${args.ingress}-ingress`,
  };
};

/** Ingresses with a device behind them, so a claim to local work is credible. */
export const ingressMayClaimComputerSubject = (
  ingress: ExecutionIngress,
): boolean => ingress === "desktop" || ingress === "mobile";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** A device's live presence as the owner gate keeps it. */
export type DevicePresenceState = {
  deviceId: string;
  presenceSessionId: string;
  connected: boolean;
  ready: boolean;
  chatSlots: number;
  agentSlots: number;
  capabilities: ExecutionCapability[];
  protocolVersion: number;
  lastSeenAt: number;
};

/** The device as the owner snapshot registered it. */
export type DeviceRegistration = {
  deviceId: string;
  publicKey: string;
  remoteExecutionEnabled: boolean;
  label?: string;
};

export const hasCapabilities = (
  advertised: readonly ExecutionCapability[],
  required: readonly ExecutionCapability[],
): boolean =>
  required.every((capability) => advertised.includes(capability));

/**
 * Online, ready, protocol-current, capable, and holding a free slot of the
 * kind — plus remote execution enabled on the registration. Every clause is
 * one Convex checked; dropping any of them offers work to a device that
 * cannot run it and costs the user a four-second stall before the fallback.
 */
export const isEligibleDevice = (args: {
  presence: DevicePresenceState | undefined;
  device: DeviceRegistration | undefined;
  kind: ExecutionKind;
  requiredCapabilities: readonly ExecutionCapability[];
  now: number;
  staleAfterMs: number;
}): boolean => {
  const { presence, device } = args;
  if (!presence || !device || !device.remoteExecutionEnabled) return false;
  if (!presence.connected || !presence.ready) return false;
  if (presence.protocolVersion !== DEVICE_PRESENCE_PROTOCOL_VERSION) {
    return false;
  }
  if (presence.lastSeenAt + args.staleAfterMs <= args.now) return false;
  if (!hasCapabilities(presence.capabilities, args.requiredCapabilities)) {
    return false;
  }
  const slots =
    args.kind === "chat" ? presence.chatSlots : presence.agentSlots;
  return slots > 0;
};

/** Requirements the cloud sandbox cannot honour; a fallback would lie. */
export const cloudUnsupportedCapabilities = (
  required: readonly ExecutionCapability[],
): ExecutionCapability[] =>
  required.filter(
    (capability) => !CLOUD_PROVIDED_CAPABILITIES.includes(capability),
  );

export const isTerminalDispatchState = (state: DispatchState): boolean =>
  TERMINAL_DISPATCH_STATES.includes(state);

/** Placement may only change while local execution is provably unaccepted. */
export const mayFallbackToCloud = (state: DispatchState): boolean =>
  state === "offering" || state === "computer_claimed";

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const INGRESSES: readonly ExecutionIngress[] = [
  "desktop",
  "mobile",
  "browser",
  "cloud",
  "schedule",
];
const SUBJECTS: readonly ExecutionSubject[] = ["portable", "computer", "cloud"];
const TARGET_MODES: readonly ExecutionTargetMode[] = [
  "automatic",
  "cloud",
  "device",
];

const bounded = (value: unknown, max: number): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : "";
};

export type ParsedDispatchPayload =
  | { ok: true; payload: DispatchPayload }
  | { ok: false; message: string };

/**
 * The payload is frozen behind its own hash, so a replay parses the same
 * bytes to the same verdict. Strict, never truncating: a quietly shortened
 * attachment list executes a different request than the one the user sent.
 */
export const parseDispatchPayload = (
  value: unknown,
  kind: ExecutionKind,
): ParsedDispatchPayload => {
  const fail = (message: string): ParsedDispatchPayload => ({
    ok: false,
    message,
  });
  if (!isRecord(value)) return fail("payload must be an object.");
  if (value.schemaVersion !== 1) return fail("payload.schemaVersion must be 1.");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_DISPATCH_PROMPT_CHARS) {
    return fail(
      `payload.prompt must be 1-${MAX_DISPATCH_PROMPT_CHARS} characters.`,
    );
  }
  const conversationId = bounded(
    value.conversationId,
    MAX_CONVERSATION_ID_CHARS,
  );
  if (!conversationId) return fail("payload.conversationId is required.");
  const clientMsgId = bounded(value.clientMsgId, MAX_IDEMPOTENCY_KEY_CHARS);
  if (!clientMsgId) return fail("payload.clientMsgId is required.");
  const payload: DispatchPayload = {
    schemaVersion: 1,
    prompt,
    conversationId,
    clientMsgId,
  };
  if (value.userMessageEventId !== undefined) {
    const eventId = bounded(value.userMessageEventId, 256);
    if (!eventId) return fail("payload.userMessageEventId is malformed.");
    payload.userMessageEventId = eventId;
  }
  if (value.locale !== undefined && value.locale !== null) {
    const locale = bounded(value.locale, 64);
    if (!locale) return fail("payload.locale is malformed.");
    payload.locale = locale;
  }
  if (value.attachments !== undefined && value.attachments !== null) {
    if (
      !Array.isArray(value.attachments) ||
      value.attachments.length > MAX_DISPATCH_ATTACHMENTS
    ) {
      return fail(
        `payload.attachments must be at most ${MAX_DISPATCH_ATTACHMENTS} drive paths.`,
      );
    }
    const attachments: string[] = [];
    for (const entry of value.attachments) {
      const path = bounded(entry, 1024);
      if (!path) return fail("payload.attachments must be drive paths.");
      attachments.push(path);
    }
    if (attachments.length > 0) payload.attachments = attachments;
  }
  if (value.execution !== undefined && value.execution !== null) {
    const execution = parseCloudExecutionSelection(value.execution);
    if (!execution) return fail("payload.execution is malformed.");
    payload.execution = execution;
  }
  if (kind === "agent") {
    const description =
      typeof value.description === "string" ? value.description.trim() : "";
    if (!description || description.length > MAX_DISPATCH_DESCRIPTION_CHARS) {
      return fail(
        `payload.description must be 1-${MAX_DISPATCH_DESCRIPTION_CHARS} characters for an agent dispatch.`,
      );
    }
    payload.description = description;
  } else if (value.description !== undefined) {
    const description = bounded(
      value.description,
      MAX_DISPATCH_DESCRIPTION_CHARS,
    );
    if (!description) return fail("payload.description is malformed.");
    payload.description = description;
  }
  return { ok: true, payload };
};

export type ParsedDispatchSubmitRequest =
  | { ok: true; request: DispatchSubmitRequest }
  | { ok: false; message: string };

/**
 * The body of `POST /owners/me/dispatches`. It never names an owner: identity
 * rides on the trusted headers the Worker stamps after verifying the caller,
 * exactly like a turn start.
 */
export const parseDispatchSubmitRequest = (
  value: unknown,
): ParsedDispatchSubmitRequest => {
  const fail = (message: string): ParsedDispatchSubmitRequest => ({
    ok: false,
    message,
  });
  if (!isRecord(value)) return fail("A JSON object is required.");
  if (value.protocol !== PLACEMENT_PROTOCOL) {
    return fail(`protocol must be ${PLACEMENT_PROTOCOL}.`);
  }
  const idempotencyKey =
    typeof value.idempotencyKey === "string" ? value.idempotencyKey.trim() : "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return fail("idempotencyKey must be 8-128 URL-safe characters.");
  }
  const kind = value.kind;
  if (kind !== "chat" && kind !== "agent") {
    return fail("kind must be chat or agent.");
  }
  if (!INGRESSES.includes(value.ingress as ExecutionIngress)) {
    return fail("ingress is not recognized.");
  }
  const ingress = value.ingress as ExecutionIngress;
  if (!SUBJECTS.includes(value.subject as ExecutionSubject)) {
    return fail("subject must be portable, computer, or cloud.");
  }
  const subject = value.subject as ExecutionSubject;
  // A deviceless ingress has no local machine behind it, so a local subject
  // is a claim it cannot make. Collapsing it silently would change what the
  // work means; refusing says so.
  if (!ingressMayClaimComputerSubject(ingress) && subject !== "cloud") {
    return fail(`${ingress} ingress cannot claim a local execution subject.`);
  }
  let targetMode: ExecutionTargetMode | undefined;
  if (value.targetMode !== undefined) {
    if (!TARGET_MODES.includes(value.targetMode as ExecutionTargetMode)) {
      return fail("targetMode must be automatic, cloud, or device.");
    }
    targetMode = value.targetMode as ExecutionTargetMode;
  }
  const targetDeviceId =
    value.targetDeviceId === undefined
      ? ""
      : bounded(value.targetDeviceId, MAX_DEVICE_ID_CHARS);
  if (value.targetDeviceId !== undefined && !targetDeviceId) {
    return fail("targetDeviceId is malformed.");
  }
  if (((targetMode ?? "automatic") === "device") !== Boolean(targetDeviceId)) {
    return fail("A device execution target requires exactly one device id.");
  }
  const conversationId = bounded(
    value.conversationId,
    MAX_CONVERSATION_ID_CHARS,
  );
  if (!conversationId) return fail("conversationId is required.");
  const requiredCapabilitiesRaw =
    value.requiredCapabilities === undefined ? [] : value.requiredCapabilities;
  if (
    !Array.isArray(requiredCapabilitiesRaw) ||
    requiredCapabilitiesRaw.length > MAX_REQUIRED_CAPABILITIES ||
    requiredCapabilitiesRaw.some(
      (capability) =>
        !EXECUTION_CAPABILITIES.includes(capability as ExecutionCapability),
    )
  ) {
    return fail("requiredCapabilities contains an unsupported requirement.");
  }
  // The kind is itself a capability every executor must advertise.
  const requiredCapabilities = [
    ...new Set<ExecutionCapability>([
      kind,
      ...(requiredCapabilitiesRaw as ExecutionCapability[]),
    ]),
  ];
  const payload = parseDispatchPayload(value.payload, kind);
  if (!payload.ok) return fail(payload.message);
  if (payload.payload.conversationId !== conversationId) {
    return fail("payload.conversationId does not match the dispatch.");
  }
  const request: DispatchSubmitRequest = {
    protocol: PLACEMENT_PROTOCOL,
    idempotencyKey,
    kind,
    ingress,
    subject,
    conversationId,
    requiredCapabilities,
    payload: payload.payload,
  };
  if (targetMode !== undefined) request.targetMode = targetMode;
  if (targetDeviceId) request.targetDeviceId = targetDeviceId;
  if (value.requestingDeviceId !== undefined) {
    const requestingDeviceId = bounded(
      value.requestingDeviceId,
      MAX_DEVICE_ID_CHARS,
    );
    if (!requestingDeviceId) return fail("requestingDeviceId is malformed.");
    request.requestingDeviceId = requestingDeviceId;
  }
  if (value.parentTurnId !== undefined) {
    const parentTurnId = bounded(value.parentTurnId, 256);
    if (!parentTurnId) return fail("parentTurnId is malformed.");
    request.parentTurnId = parentTurnId;
  }
  if (value.threadId !== undefined) {
    const threadId = bounded(value.threadId, 256);
    if (!threadId) return fail("threadId is malformed.");
    request.threadId = threadId;
  }
  return { ok: true, request };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const DISPATCH_ERROR_STATUS: Record<DispatchErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  bad_request: 400,
  conflict: 409,
  not_found: 404,
  owner_purged: 410,
  generation_stale: 403,
  capability_unavailable: 409,
  quota_burst: 429,
  quota_daily: 429,
  quota_concurrency: 429,
  internal: 503,
};

export const dispatchError = (
  code: DispatchErrorCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): DispatchError => ({
  error: {
    code,
    message,
    retryable,
    ...(retryAfterMs !== undefined
      ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) }
      : {}),
  },
});

export const dispatchErrorResponse = (
  code: DispatchErrorCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): Response =>
  Response.json(dispatchError(code, message, retryable, retryAfterMs), {
    status: DISPATCH_ERROR_STATUS[code],
    headers: {
      "cache-control": "no-store",
      ...(retryAfterMs !== undefined
        ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
        : {}),
    },
  });

/** True when a JSON body carries the `DispatchError` shape. */
export const isDispatchError = (value: unknown): value is DispatchError =>
  isRecord(value) &&
  isRecord(value.error) &&
  typeof value.error.code === "string";
