/**
 * Validation of `POST /conversations/:id/turns` bodies, shared by the Worker
 * route (early 400/403s) and the OrchestratorSession (the DO trusts nothing
 * it did not check itself). The body never names the owner: identity rides
 * on trusted headers the Worker stamps after verifying the caller.
 */

import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { isCloudBrowserResumeReceipt } from "@stella/contracts/cloud-browser";
import { isManagedModelAudience } from "@stella/contracts/gateway/capability";
import {
  CLIENT_MSG_ID_PATTERN,
  TURN_ATTACHMENTS_MAX,
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  TURN_TITLE_MAX_CHARS,
  type CloudAgentThreadControl,
  type CloudAgentTurnSource,
  type CloudAgentTurnStartRequest,
  type CloudTurnLane,
  type CloudTurnSource,
  type CloudTurnStartError,
  type CloudTurnStartErrorCode,
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";

/**
 * How the Worker authenticated the caller of a forwarded turn start. Stamped
 * after `stripStellaHeaders`, so its presence proves the route was taken.
 */
export const HEADER_TURN_AUTH_KIND = "x-stella-turn-auth";
export type TurnAuthKind = "user" | "service";

const MAX_EXECUTION_FIELD_LENGTH = 2048;
const MAX_ATTACHMENT_PATH_CHARS = 1024;
const MAX_THREAD_ID_CHARS = 256;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const LANES: readonly CloudTurnLane[] = ["chat", "wake", "schedule"];
const SOURCES: readonly CloudTurnSource[] = [
  "desktop",
  "web",
  "mobile",
  "schedule",
  "agent-thread",
  "placement",
  "probe",
];
/** What a user-authenticated caller may claim to be. */
const CLIENT_SOURCES: readonly CloudTurnSource[] = ["desktop", "web", "mobile"];
const THREAD_STATUSES: readonly CloudAgentThreadControl["status"][] = [
  "running",
  "waiting_for_user",
  "resuming",
  "completed",
  "failed",
  "canceled",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A pinned execution: engine and provider agree and every field is a bounded
 * non-empty string. Model availability is the owner snapshot's call.
 */
export const parseCloudExecutionSelection = (
  value: unknown,
): CloudExecutionSelection | null => {
  if (!isRecord(value)) return null;
  const bounded = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.trim().length > 0 &&
    candidate.length <= MAX_EXECUTION_FIELD_LENGTH;
  if (!bounded(value.model) || !bounded(value.reasoningEffort)) return null;
  const pair = `${String(value.engine)}/${String(value.provider)}`;
  if (
    pair !== "stella/stella" &&
    pair !== "anthropic/anthropic" &&
    pair !== "openai-codex/openai-codex"
  ) {
    return null;
  }
  return {
    engine: value.engine,
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  } as CloudExecutionSelection;
};

export const parseAgentThreadControl = (
  value: unknown,
): CloudAgentThreadControl | null => {
  if (!isRecord(value)) return null;
  const threadId =
    typeof value.threadId === "string" ? value.threadId.trim() : "";
  if (
    !threadId ||
    threadId.length > MAX_THREAD_ID_CHARS ||
    !Number.isSafeInteger(value.attemptGeneration) ||
    (value.attemptGeneration as number) < 1 ||
    !Number.isSafeInteger(value.threadUpdatedAt) ||
    (value.threadUpdatedAt as number) < 0 ||
    !THREAD_STATUSES.includes(value.status as CloudAgentThreadControl["status"])
  ) {
    return null;
  }
  if (
    value.lifecycleReport !== undefined &&
    (typeof value.lifecycleReport !== "string" ||
      value.lifecycleReport.length > TURN_PROMPT_MAX_CHARS)
  )
    return null;
  return {
    ...(typeof value.lifecycleReport === "string"
      ? { lifecycleReport: value.lifecycleReport }
      : {}),
    threadId,
    attemptGeneration: value.attemptGeneration as number,
    threadUpdatedAt: value.threadUpdatedAt as number,
    status: value.status as CloudAgentThreadControl["status"],
  };
};

export type ParsedTurnStartRequest =
  | { ok: true; request: CloudTurnStartRequest }
  | { ok: false; message: string };

export const parseCloudTurnStartRequest = (
  value: unknown,
): ParsedTurnStartRequest => {
  const fail = (message: string): ParsedTurnStartRequest => ({
    ok: false,
    message,
  });
  if (!isRecord(value)) return fail("A JSON object is required.");
  if (value.protocol !== TURN_PLANE_PROTOCOL) {
    return fail(`protocol must be ${TURN_PLANE_PROTOCOL}.`);
  }
  const clientMsgId =
    typeof value.clientMsgId === "string" ? value.clientMsgId : "";
  if (!CLIENT_MSG_ID_PATTERN.test(clientMsgId)) {
    return fail("clientMsgId is required (8-64 URL-safe characters).");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  if (!prompt.trim()) return fail("prompt is required.");
  if (prompt.length > TURN_PROMPT_MAX_CHARS) {
    return fail(`prompt must be at most ${TURN_PROMPT_MAX_CHARS} characters.`);
  }
  const request: CloudTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    clientMsgId,
    prompt,
  };
  if (value.execution !== undefined) {
    const execution = parseCloudExecutionSelection(value.execution);
    if (!execution) return fail("execution is malformed.");
    request.execution = execution;
  }
  if (value.locale !== undefined) {
    const locale = typeof value.locale === "string" ? value.locale.trim() : "";
    if (!LOCALE_PATTERN.test(locale)) return fail("locale is malformed.");
    request.locale = locale;
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      return fail("attachments must be an array of drive paths.");
    }
    if (value.attachments.length > TURN_ATTACHMENTS_MAX) {
      return fail(
        `attachments must have at most ${TURN_ATTACHMENTS_MAX} entries.`,
      );
    }
    const attachments: string[] = [];
    for (const entry of value.attachments) {
      const path = typeof entry === "string" ? entry.trim() : "";
      if (!path || path.length > MAX_ATTACHMENT_PATH_CHARS) {
        return fail("attachments must be non-empty drive paths.");
      }
      attachments.push(path);
    }
    request.attachments = attachments;
  }
  if (value.lane !== undefined) {
    if (!LANES.includes(value.lane as CloudTurnLane)) {
      return fail("lane must be chat, wake, or schedule.");
    }
    request.lane = value.lane as CloudTurnLane;
  }
  if (value.source !== undefined) {
    if (!SOURCES.includes(value.source as CloudTurnSource)) {
      return fail("source is not recognized.");
    }
    request.source = value.source as CloudTurnSource;
  }
  if (value.title !== undefined) {
    const title = typeof value.title === "string" ? value.title.trim() : null;
    if (title === null || title.length > TURN_TITLE_MAX_CHARS) {
      return fail(
        `title must be a string of at most ${TURN_TITLE_MAX_CHARS} characters.`,
      );
    }
    if (title) request.title = title;
  }
  if (value.hiddenMessage !== undefined) {
    if (typeof value.hiddenMessage !== "boolean") {
      return fail("hiddenMessage must be a boolean.");
    }
    request.hiddenMessage = value.hiddenMessage;
  }
  if (value.agentThreadControl !== undefined) {
    const control = parseAgentThreadControl(value.agentThreadControl);
    if (!control) return fail("agentThreadControl is malformed.");
    request.agentThreadControl = control;
  }
  return { ok: true, request };
};

/**
 * Fields a user-authenticated caller may never set. Listed by name so the
 * 403 says which one, and so the DO and the Worker agree on exactly one list.
 */
export const serviceOnlyTurnFields = (
  request: CloudTurnStartRequest,
): string[] => {
  const fields: string[] = [];
  if (request.lane !== undefined && request.lane !== "chat") {
    fields.push("lane");
  }
  if (
    request.source !== undefined &&
    !CLIENT_SOURCES.includes(request.source)
  ) {
    fields.push("source");
  }
  if (request.hiddenMessage !== undefined) fields.push("hiddenMessage");
  if (request.agentThreadControl !== undefined) {
    fields.push("agentThreadControl");
  }
  return fields;
};

/** The title a brand-new conversation gets from its first turn. */
export const conversationTitleFor = (
  request: Pick<CloudTurnStartRequest, "title" | "prompt">,
): string => {
  const explicit = request.title?.trim() ?? "";
  if (explicit) return explicit.slice(0, TURN_TITLE_MAX_CHARS);
  const collapsed = request.prompt.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
};

/** HTTP status for each turn-start refusal, shared by the Worker and the DO. */
export const TURN_START_ERROR_STATUS: Record<CloudTurnStartErrorCode, number> =
  {
    unauthorized: 401,
    forbidden: 403,
    owner_mismatch: 403,
    generation_stale: 403,
    bad_request: 400,
    conversation_locked: 423,
    idempotency_conflict: 409,
    owner_purged: 410,
    sign_in_required: 403,
    owner_suspended: 403,
    execution_unavailable: 409,
    internal: 503,
  };

export const turnStartErrorResponse = (
  code: CloudTurnStartErrorCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): Response => {
  const body: CloudTurnStartError = {
    error: {
      code,
      message,
      retryable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
  return Response.json(body, {
    status: TURN_START_ERROR_STATUS[code],
    headers: {
      "cache-control": "no-store",
      ...(retryAfterMs !== undefined
        ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
        : {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Agent turns (`POST /sessions/:threadId/turns` and the orchestrator's direct
// `BuildSession` dispatch).
// ---------------------------------------------------------------------------

/**
 * Set by the OrchestratorSession on the spawn/continuation it dispatches
 * straight to a `BuildSession`. It means "this owner gate admission already
 * happened, and the caller releases it if the dispatch fails" — so the session
 * must not admit a second time for the same turn. It is an internal Durable
 * Object-to-Durable Object header: the public `/sessions/:id/turns` route
 * builds its forwarded headers from scratch and never copies it.
 */
export const HEADER_GATE_ADMITTED = "x-stella-gate-admitted";

const AGENT_SOURCES: readonly CloudAgentTurnSource[] = [
  "desktop",
  "placement",
  "browser-resume",
  "agent-thread",
];

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_AGENT_PROMPT_CHARS = 1024 * 1024;

export type ParsedAgentTurnStartRequest =
  | { ok: true; request: CloudAgentTurnStartRequest }
  | { ok: false; message: string };

/**
 * The one admission shape for an agent attempt, whether it arrived from the
 * orchestrator's direct dispatch or from Convex through the public service
 * route. Identity is in the body here (unlike a chat turn) because both
 * callers are already inside the service boundary; the Worker route proves
 * that with the shared secret before it forwards.
 */
export const parseCloudAgentTurnStartRequest = (
  value: unknown,
): ParsedAgentTurnStartRequest => {
  const fail = (message: string): ParsedAgentTurnStartRequest => ({
    ok: false,
    message,
  });
  if (!isRecord(value)) return fail("A JSON object is required.");
  if (value.protocol !== TURN_PLANE_PROTOCOL) {
    return fail(`protocol must be ${TURN_PLANE_PROTOCOL}.`);
  }
  if (value.kind !== "agent") return fail('kind must be "agent".');
  const bounded = (candidate: unknown, max = 512): string =>
    typeof candidate === "string" &&
    candidate.trim().length > 0 &&
    candidate.length <= max
      ? candidate.trim()
      : "";
  const ownerId = bounded(value.ownerId);
  const ownerGeneration = bounded(value.ownerGeneration);
  const conversationId = bounded(value.conversationId);
  const threadId = bounded(value.threadId, MAX_THREAD_ID_CHARS);
  if (!ownerId) return fail("ownerId is required.");
  if (!ownerGeneration) return fail("ownerGeneration is required.");
  if (!conversationId) return fail("conversationId is required.");
  if (!threadId) return fail("threadId is required.");
  if (
    !Number.isSafeInteger(value.agentDepth) ||
    (value.agentDepth as number) < 1 ||
    (value.agentDepth as number) > 2
  ) {
    return fail("agentDepth must be 1 or 2.");
  }
  if (
    !Number.isSafeInteger(value.attemptGeneration) ||
    (value.attemptGeneration as number) < 1
  ) {
    return fail("attemptGeneration must be a positive integer.");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  if (!prompt.trim()) return fail("prompt is required.");
  if (prompt.length > MAX_AGENT_PROMPT_CHARS) {
    return fail("prompt is too large.");
  }
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION_CHARS) {
    return fail(
      `description is required and must be at most ${MAX_DESCRIPTION_CHARS} characters.`,
    );
  }
  const execution = parseCloudExecutionSelection(value.execution);
  if (!execution) return fail("execution is malformed.");
  if (!isManagedModelAudience(value.audience)) {
    return fail("audience is not a managed model audience.");
  }
  if (
    typeof value.budgetMicroCents !== "number" ||
    !Number.isFinite(value.budgetMicroCents)
  ) {
    return fail("budgetMicroCents must be a finite number.");
  }
  if (!AGENT_SOURCES.includes(value.source as CloudAgentTurnSource)) {
    return fail("source is not recognized.");
  }
  const request: CloudAgentTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    kind: "agent",
    ownerId,
    ownerGeneration,
    conversationId,
    threadId,
    agentDepth: value.agentDepth as number,
    attemptGeneration: value.attemptGeneration as number,
    prompt,
    description,
    execution,
    audience: value.audience as string,
    budgetMicroCents: value.budgetMicroCents,
    source: value.source as CloudAgentTurnSource,
  };
  if (value.turnId !== undefined) {
    const turnId = bounded(value.turnId);
    if (!turnId) return fail("turnId is malformed.");
    request.turnId = turnId;
  }
  if (value.clientMsgId !== undefined) {
    const clientMsgId = bounded(value.clientMsgId);
    if (!clientMsgId) return fail("clientMsgId is malformed.");
    request.clientMsgId = clientMsgId;
  }
  if (value.parentTurnId !== undefined) {
    const parentTurnId = bounded(value.parentTurnId);
    if (!parentTurnId) return fail("parentTurnId is malformed.");
    request.parentTurnId = parentTurnId;
  }
  if (value.parentThreadId !== undefined) {
    const parentThreadId = bounded(value.parentThreadId, MAX_THREAD_ID_CHARS);
    if (!parentThreadId) return fail("parentThreadId is malformed.");
    request.parentThreadId = parentThreadId;
  }
  if (value.workspace !== undefined) {
    if (
      value.workspace !== "shared" &&
      value.workspace !== "new" &&
      value.workspace !== "fork"
    ) {
      return fail("workspace must be shared, new, or fork.");
    }
    request.workspace = value.workspace;
  }
  if (value.workspaceForkId !== undefined) {
    const workspaceForkId = bounded(value.workspaceForkId);
    if (!/^fork-[0-9a-f-]{36}$/u.test(workspaceForkId)) {
      return fail("workspaceForkId is malformed.");
    }
    request.workspaceForkId = workspaceForkId;
  }
  if (request.workspace === "shared" && request.workspaceForkId !== undefined) {
    return fail("A shared workspace cannot name a workspaceForkId.");
  }
  if (
    request.workspaceForkId !== undefined &&
    request.workspace === undefined
  ) {
    return fail("workspace is required when workspaceForkId is present.");
  }
  if (
    (request.workspace === "new" || request.workspace === "fork") &&
    request.workspaceForkId === undefined
  ) {
    return fail("An isolated workspace requires workspaceForkId.");
  }
  if (
    (request.agentDepth === 1 && request.parentThreadId !== undefined) ||
    (request.agentDepth === 2 && request.parentThreadId === undefined)
  ) {
    return fail(
      "parentThreadId must be absent at depth 1 and present at depth 2.",
    );
  }
  if (value.originDeviceId !== undefined) {
    const originDeviceId = bounded(value.originDeviceId);
    if (!originDeviceId) return fail("originDeviceId is malformed.");
    request.originDeviceId = originDeviceId;
  }
  if (value.originConversationId !== undefined) {
    const originConversationId = bounded(value.originConversationId);
    if (!originConversationId)
      return fail("originConversationId is malformed.");
    request.originConversationId = originConversationId;
  }
  if (value.browserResume !== undefined) {
    if (!isCloudBrowserResumeReceipt(value.browserResume)) {
      return fail("browserResume is malformed.");
    }
    request.browserResume = value.browserResume;
  }
  return { ok: true, request };
};
