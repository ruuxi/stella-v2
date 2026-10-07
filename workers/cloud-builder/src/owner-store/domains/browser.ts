/**
 * Hosted-browser handoffs. A cloud agent's browser command suspends its turn
 * on a sign-in or device-code page; the BuildSession reports the wait as a
 * nonterminal `waiting_for_user` turn event, and `recordBrowserSuspension`
 * records it here as an interaction (`browser.pending`).
 *
 * Everything secret stays in the private Browser Gateway (the login URL, the
 * Live View, the session itself); the calls below fetch it on demand over the
 * `BROWSER_GATEWAY` binding with the interaction's exact turn authority.
 * `browser.decide` (or the `browser.expire` job at the deadline) takes the
 * gateway's resume receipt and resumes the parked agent thread as its next
 * attempt, which leaves the interaction in a final state.
 */

import type { BrowserCalls } from "@stella/contracts/backend/browser";
import {
  isCloudBrowserSuspension,
  type CloudBrowserInteractionDetail,
  type CloudBrowserInteractionKind,
  type CloudBrowserInteractionState,
  type CloudBrowserInteractionSummary,
  type CloudBrowserLiveViewCapability,
  type CloudBrowserResumeReceipt,
  type CloudBrowserSessionTransferCapability,
} from "@stella/contracts/cloud-browser";
import type { TurnEventEvent } from "@stella/contracts/turn-plane/owner-events";
import { empty, literal, number, object, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";
import { cancelWaitingAgentThread, resumeWaitingAgentThread } from "./agent-threads.js";

const PROFILE_ID = "default";
const MAX_ACTIVE = 24;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;
const TRANSFER_CIPHERTEXT_MAX = 48 * 1024;
const EXPIRE_JOB = "browser.expire";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATES = "('pending', 'human_control')";

export const BROWSER_MIGRATION = {
  id: "browser.1-init",
  statements: [
    `CREATE TABLE browser_interactions (
       interaction_id TEXT PRIMARY KEY,
       owner_generation TEXT NOT NULL,
       conversation_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       turn_id TEXT NOT NULL UNIQUE,
       attempt_generation INTEGER NOT NULL,
       tool_call_id TEXT NOT NULL,
       request_digest TEXT NOT NULL,
       profile_epoch INTEGER NOT NULL,
       kind TEXT NOT NULL,
       state TEXT NOT NULL,
       display_origin TEXT NOT NULL,
       display_title TEXT,
       revision INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       decision TEXT,
       decision_request_id TEXT,
       decision_base_revision INTEGER,
       resolution TEXT,
       safe_message TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    "CREATE INDEX browser_interactions_state ON browser_interactions (state, created_at DESC)",
  ],
};

type InteractionRow = {
  interaction_id: string;
  owner_generation: string;
  conversation_id: string;
  thread_id: string;
  turn_id: string;
  attempt_generation: number;
  tool_call_id: string;
  request_digest: string;
  profile_epoch: number;
  kind: CloudBrowserInteractionKind;
  state: CloudBrowserInteractionState;
  display_origin: string;
  display_title: string | null;
  revision: number;
  expires_at: number;
  decision: string | null;
  decision_request_id: string | null;
  decision_base_revision: number | null;
  resolution: string | null;
  safe_message: string | null;
  created_at: number;
  updated_at: number;
};

type ResumeResult = CloudBrowserResumeReceipt["result"];
type Decision = "done" | "cancel";

const summary = (row: InteractionRow): CloudBrowserInteractionSummary => ({
  schemaVersion: 1,
  interactionId: row.interaction_id,
  conversationId: row.conversation_id,
  threadId: row.thread_id,
  turnId: row.turn_id,
  kind: row.kind,
  state: row.state,
  displayOrigin: row.display_origin,
  ...(row.display_title ? { displayTitle: row.display_title } : {}),
  revision: row.revision,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readRow = (db: OwnerDbReader, interactionId: string): InteractionRow | null =>
  db.one<InteractionRow>("SELECT * FROM browser_interactions WHERE interaction_id = ?", interactionId);

const listPending = (db: OwnerDbReader): CloudBrowserInteractionSummary[] =>
  db
    .all<InteractionRow>(
      `SELECT * FROM browser_interactions WHERE state IN ${ACTIVE_STATES} ORDER BY created_at DESC LIMIT ?`,
      MAX_ACTIVE,
    )
    .map(summary);

const expireJobId = (interactionId: string): string => `${EXPIRE_JOB}:${interactionId}`;

const log = (event: string, fields: Record<string, unknown>): void =>
  console.error(JSON.stringify({ service: "owner-browser", event, ...fields }));

// ── Recording a wait ──────────────────────────────────────────────────────

/**
 * A `waiting_for_user` turn event. Never throws: a malformed or replayed
 * event is logged and dropped, since its producer would redeliver it forever.
 */
export const recordBrowserSuspension = (
  ctx: Pick<OwnerContext, "db" | "jobs" | "now">,
  event: TurnEventEvent,
): void => {
  const suspension = (event.payload as { suspension?: unknown } | null)?.suspension;
  if (!isCloudBrowserSuspension(suspension) || suspension.interactionRevision !== 1) {
    log("browser_suspension_invalid", { turnId: event.turnId });
    return;
  }
  if (readRow(ctx.db, suspension.interactionId)) return;
  const turn = ctx.db.one<{
    thread_id: string | null;
    conversation_id: string | null;
    attempt_generation: number | null;
    owner_generation: string | null;
  }>(
    "SELECT thread_id, conversation_id, attempt_generation, owner_generation FROM agent_turns WHERE turn_id = ?",
    event.turnId,
  );
  if (
    !turn?.thread_id ||
    !turn.conversation_id ||
    turn.attempt_generation === null ||
    (event.attemptGeneration !== undefined && event.attemptGeneration !== turn.attempt_generation)
  ) {
    log("browser_suspension_unknown_turn", { turnId: event.turnId });
    return;
  }
  if (suspension.expiresAt <= ctx.now || suspension.expiresAt > ctx.now + MAX_LIFETIME_MS) {
    log("browser_suspension_expired", { turnId: event.turnId });
    return;
  }
  if (ctx.db.one("SELECT 1 AS found FROM browser_interactions WHERE turn_id = ?", event.turnId)) {
    log("browser_suspension_turn_reused", { turnId: event.turnId });
    return;
  }
  const active =
    ctx.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM browser_interactions WHERE state IN ${ACTIVE_STATES}`)
      ?.n ?? 0;
  if (active >= MAX_ACTIVE) {
    log("browser_suspension_too_many", { turnId: event.turnId });
    return;
  }
  ctx.db.run(
    `INSERT INTO browser_interactions
       (interaction_id, owner_generation, conversation_id, thread_id, turn_id, attempt_generation,
        tool_call_id, request_digest, profile_epoch, kind, state, display_origin, display_title,
        revision, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    suspension.interactionId,
    turn.owner_generation ?? event.ownerGeneration,
    turn.conversation_id,
    turn.thread_id,
    event.turnId,
    turn.attempt_generation,
    suspension.toolCallId,
    suspension.requestDigest,
    suspension.profileEpoch,
    suspension.interactionKind,
    suspension.displayOrigin,
    suspension.displayTitle || null,
    suspension.interactionRevision,
    suspension.expiresAt,
    ctx.now,
    ctx.now,
  );
  ctx.jobs.schedule(
    EXPIRE_JOB,
    suspension.expiresAt,
    { interactionId: suspension.interactionId },
    { id: expireJobId(suspension.interactionId) },
  );
};

// ── The gateway ───────────────────────────────────────────────────────────

const invalid = (message: string) => new RpcError("UNAVAILABLE", message, { retryable: false });
const changed = () => new RpcError("CONFLICT", "This browser request changed. Refresh it and try again.");
const gone = () => new RpcError("NOT_FOUND", "This browser request is no longer available.");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string, max = 512): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw invalid("The secure browser returned an invalid response.");
  }
  return value;
};

const requiredInteger = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid("The secure browser returned an invalid response.");
  }
  return value as number;
};

const httpsUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("Invalid secure browser URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw invalid("Invalid secure browser URL.");
  }
  return parsed.toString();
};

const gateway = async (env: Cloudflare.Env, route: string, body: unknown): Promise<unknown> => {
  if (!env.BROWSER_GATEWAY) {
    throw new RpcError("UNAVAILABLE", "Cloud browser is unavailable.");
  }
  let response: Response;
  try {
    response = await env.BROWSER_GATEWAY.fetch(`https://browser-gateway${route}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new RpcError("UNAVAILABLE", "Stella could not reach the secure browser. Try again.");
  }
  const text = await response.text().catch(() => "");
  if (response.status === 409) throw changed();
  let payload: unknown = null;
  if (text.length <= GATEWAY_RESPONSE_MAX_BYTES) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok || !payload) {
    throw new RpcError("UNAVAILABLE", "The secure browser could not complete that request. Try again.");
  }
  return payload;
};

const interactionBody = (ownerId: string, row: InteractionRow) => ({
  schemaVersion: 1,
  authority: {
    ownerId,
    ownerGeneration: row.owner_generation,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    attemptGeneration: row.attempt_generation,
  },
  profileId: PROFILE_ID,
  profileEpoch: row.profile_epoch,
  interactionId: row.interaction_id,
  interactionRevision: row.revision,
});

/** The row, still open at `expectedRevision`, or a refusal. */
const openRow = (ctx: OwnerContext, interactionId: string, expectedRevision: number): InteractionRow => {
  const row = readRow(ctx.db, interactionId);
  if (
    !row ||
    row.revision !== expectedRevision ||
    (row.state !== "pending" && row.state !== "human_control") ||
    row.expires_at <= ctx.now
  ) {
    throw gone();
  }
  return row;
};

const markHumanControl = (ctx: OwnerContext, interactionId: string, revision: number): void => {
  ctx.db.run(
    `UPDATE browser_interactions SET state = 'human_control', updated_at = ?
      WHERE interaction_id = ? AND revision = ? AND state = 'pending'`,
    ctx.now,
    interactionId,
    revision,
  );
};

// ── Calls ─────────────────────────────────────────────────────────────────

const detail = async (
  ctx: OwnerContext,
  args: { interactionId: string },
): Promise<CloudBrowserInteractionDetail | null> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.detail",
    { count: 60, windowMs: 60_000 },
    "Too many browser status checks. Wait a moment and try again.",
  );
  const row = readRow(ctx.db, args.interactionId);
  if (!row) return null;
  const payload = await gateway(ctx.env, "/internal/interactions/status", interactionBody(ctx.ownerId, row));
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.interaction)) {
    throw invalid("The secure browser returned an invalid status.");
  }
  const value = payload.interaction;
  const base = summary(row);
  if (
    value.schemaVersion !== 1 ||
    value.interactionId !== row.interaction_id ||
    value.kind !== row.kind ||
    value.revision !== row.revision
  ) {
    throw invalid("The secure browser returned a stale status.");
  }
  if (row.kind === "login_takeover") {
    const loginUrl = httpsUrl(requiredString(value, "loginUrl", 4096));
    if (new URL(loginUrl).origin !== row.display_origin) {
      throw invalid("The secure browser returned an invalid login URL.");
    }
    return { ...base, kind: "login_takeover", loginUrl };
  }
  const verificationUriComplete =
    value.verificationUriComplete === undefined
      ? undefined
      : httpsUrl(requiredString(value, "verificationUriComplete", 4096));
  return {
    ...base,
    kind: "device_code",
    verificationUri: httpsUrl(requiredString(value, "verificationUri", 2048)),
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    userCode: requiredString(value, "userCode", 256),
  };
};

const liveView = async (
  ctx: OwnerContext,
  args: { interactionId: string; expectedRevision: number },
): Promise<CloudBrowserLiveViewCapability> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.liveView",
    { count: 20, windowMs: 60_000 },
    "Too many Live View requests. Wait a moment and try again.",
  );
  const row = openRow(ctx, args.interactionId, args.expectedRevision);
  const payload = await gateway(ctx.env, "/internal/interactions/live-view", interactionBody(ctx.ownerId, row));
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw invalid("The secure browser returned an invalid Live View.");
  }
  const url = httpsUrl(requiredString(payload, "url", 8192));
  const expiresAt = requiredInteger(payload, "expiresAt");
  if (
    requiredString(payload, "interactionId", 256) !== row.interaction_id ||
    requiredInteger(payload, "revision") !== args.expectedRevision ||
    new URL(url).hostname !== "live.browser.run" ||
    expiresAt <= Date.now()
  ) {
    throw invalid("The secure browser returned a stale Live View.");
  }
  markHumanControl(ctx, row.interaction_id, args.expectedRevision);
  return { schemaVersion: 1, interactionId: row.interaction_id, revision: args.expectedRevision, url, expiresAt };
};

const loginRow = (ctx: OwnerContext, interactionId: string, expectedRevision: number): InteractionRow => {
  const row = openRow(ctx, interactionId, expectedRevision);
  if (row.kind !== "login_takeover") throw gone();
  return row;
};

const sessionTransferKey = async (
  ctx: OwnerContext,
  args: { interactionId: string; expectedRevision: number },
): Promise<CloudBrowserSessionTransferCapability> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.sessionTransferKey",
    { count: 12, windowMs: 60_000 },
    "Too many browser transfer requests. Wait a moment and try again.",
  );
  const row = loginRow(ctx, args.interactionId, args.expectedRevision);
  const payload = await gateway(
    ctx.env,
    "/internal/interactions/session-transfer-capability",
    interactionBody(ctx.ownerId, row),
  );
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw invalid("The secure browser returned an invalid transfer key.");
  }
  const publicKey = requiredString(payload, "publicKey", 128);
  const expiresAt = requiredInteger(payload, "expiresAt");
  if (
    payload.algorithm !== "x25519-hkdf-sha256-aes-256-gcm-v1" ||
    requiredString(payload, "interactionId", 256) !== row.interaction_id ||
    requiredInteger(payload, "revision") !== args.expectedRevision ||
    !/^[A-Za-z0-9_-]{43}$/u.test(publicKey) ||
    expiresAt <= Date.now()
  ) {
    throw invalid("The secure browser returned a stale transfer key.");
  }
  markHumanControl(ctx, row.interaction_id, args.expectedRevision);
  return {
    schemaVersion: 1,
    algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1",
    capabilityId: requiredString(payload, "capabilityId", 128),
    interactionId: row.interaction_id,
    revision: args.expectedRevision,
    publicKey,
    expiresAt,
  };
};

type ImportArgs = BrowserCalls["browser.importSessionTransfer"]["args"];

const importSessionTransfer = async (
  ctx: OwnerContext,
  args: ImportArgs,
): Promise<BrowserCalls["browser.importSessionTransfer"]["result"]> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.importSessionTransfer",
    { count: 12, windowMs: 60_000 },
    "Too many browser transfer attempts. Wait a moment and try again.",
  );
  const row = loginRow(ctx, args.interactionId, args.expectedRevision);
  const payload = await gateway(ctx.env, "/internal/interactions/session-transfer", {
    ...interactionBody(ctx.ownerId, row),
    sessionTransfer: args.transfer,
  });
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    payload.interactionId !== row.interaction_id ||
    payload.revision !== args.expectedRevision ||
    payload.verified !== true
  ) {
    throw invalid("The secure browser could not verify that sign-in.");
  }
  return { schemaVersion: 1, interactionId: row.interaction_id, revision: args.expectedRevision, verified: true };
};

const finalState = (result: ResumeResult): CloudBrowserInteractionState =>
  result === "approved" ? "completed" : result === "canceled" ? "canceled" : result === "expired" ? "expired" : "failed";

/**
 * Resume the parked thread with `receipt` and close the interaction. When
 * the thread is no longer waiting, the interaction still closes (as failed)
 * so it leaves the pending list.
 */
const resolve = (
  ctx: OwnerContext,
  row: InteractionRow,
  receipt: CloudBrowserResumeReceipt,
  decision: { decision: Decision; requestId: string },
): void => {
  const resumed = resumeWaitingAgentThread(ctx, {
    threadId: row.thread_id,
    attemptGeneration: row.attempt_generation,
    ownerGeneration: row.owner_generation,
    clientMsgId: decision.requestId,
    browserResume: receipt,
  });
  if (!resumed) log("browser_resume_thread_changed", { threadId: row.thread_id });
  ctx.db.run(
    `UPDATE browser_interactions SET
       state = ?, revision = revision + 1, decision = ?, decision_request_id = ?,
       decision_base_revision = ?, resolution = ?, safe_message = ?, updated_at = ?
     WHERE interaction_id = ?`,
    resumed ? finalState(receipt.result) : "failed",
    decision.decision,
    decision.requestId,
    row.revision,
    receipt.result,
    receipt.safeMessage,
    ctx.now,
    row.interaction_id,
  );
  ctx.jobs.cancel(expireJobId(row.interaction_id));
};

type DecideArgs = BrowserCalls["browser.decide"]["args"];

const decide = async (ctx: OwnerContext, args: DecideArgs): Promise<CloudBrowserInteractionSummary> => {
  const replay = (row: InteractionRow): CloudBrowserInteractionSummary => {
    if (
      row.decision_request_id !== args.requestId ||
      row.decision !== args.decision ||
      row.decision_base_revision !== args.expectedRevision
    ) {
      throw new RpcError("CONFLICT", "That browser decision id was reused differently.");
    }
    return summary(row);
  };
  const row = readRow(ctx.db, args.interactionId);
  if (!row) throw new RpcError("NOT_FOUND", "Browser request not found.");
  if (row.decision_request_id) return replay(row);
  if (
    row.revision !== args.expectedRevision ||
    (row.state !== "pending" && row.state !== "human_control") ||
    (args.decision === "done" && row.expires_at <= ctx.now)
  ) {
    throw changed();
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.decide",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many browser decisions. Wait a moment and try again.",
  );
  const payload = await gateway(ctx.env, "/internal/interactions/decision", {
    ...interactionBody(ctx.ownerId, row),
    decision: args.decision,
  });
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.receipt)) {
    throw invalid("The secure browser returned an invalid decision.");
  }
  const value = payload.receipt;
  const result = value.result as ResumeResult;
  const receipt: CloudBrowserResumeReceipt = {
    schemaVersion: 1,
    interactionId: requiredString(value, "interactionId", 256),
    interactionRevision: requiredInteger(value, "interactionRevision"),
    profileId: requiredString(value, "profileId", 64),
    profileEpoch: requiredInteger(value, "profileEpoch"),
    // The gateway may know only the inner command id; the outer Code
    // tool-call id recorded with the wait is authoritative.
    toolCallId: row.tool_call_id,
    requestDigest: requiredString(value, "requestDigest", 64),
    result,
    safeMessage: requiredString(value, "safeMessage", 500),
  };
  if (
    !["approved", "canceled", "expired", "failed"].includes(result) ||
    receipt.interactionId !== row.interaction_id ||
    receipt.interactionRevision !== row.revision ||
    receipt.profileId !== PROFILE_ID ||
    receipt.profileEpoch !== row.profile_epoch ||
    receipt.requestDigest !== row.request_digest ||
    (args.decision === "cancel" && result !== "canceled") ||
    (args.decision === "done" && result === "canceled")
  ) {
    throw invalid("The secure browser returned a stale decision.");
  }
  // Another request may have decided while the gateway answered.
  const current = readRow(ctx.db, row.interaction_id)!;
  if (current.decision_request_id) return replay(current);
  if (current.revision !== row.revision) throw changed();
  resolve(ctx, current, receipt, { decision: args.decision, requestId: args.requestId });
  return summary(readRow(ctx.db, row.interaction_id)!);
};

/** At the deadline: resume the agent with `expired`. */
const expire = (ctx: OwnerContext, payload: unknown): void => {
  const interactionId = (payload as { interactionId?: unknown } | null)?.interactionId;
  if (typeof interactionId !== "string") return;
  const row = readRow(ctx.db, interactionId);
  if (!row || (row.state !== "pending" && row.state !== "human_control") || row.expires_at > ctx.now) return;
  resolve(
    ctx,
    row,
    {
      schemaVersion: 1,
      interactionId: row.interaction_id,
      interactionRevision: row.revision,
      profileId: PROFILE_ID,
      profileEpoch: row.profile_epoch,
      toolCallId: row.tool_call_id,
      requestDigest: row.request_digest,
      result: "expired",
      safeMessage: "Browser request expired.",
    },
    { decision: "cancel", requestId: `deadline:${row.interaction_id}` },
  );
};

const resetProfile = async (
  ctx: OwnerContext,
  args: { requestId: string },
): Promise<BrowserCalls["browser.resetProfile"]["result"]> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "browser.resetProfile",
    { count: 3, windowMs: 60 * 60_000 },
    "Too many browser resets. Wait before trying again.",
  );
  const { ownerGeneration } = await ctx.host.snapshot();
  const payload = await gateway(ctx.env, "/internal/owners/profile/reset", {
    schemaVersion: 1,
    authority: { ownerId: ctx.ownerId, ownerGeneration },
    requestId: args.requestId,
    profileId: PROFILE_ID,
  });
  if (!isRecord(payload) || payload.schemaVersion !== 1 || payload.profileId !== PROFILE_ID || payload.reset !== true) {
    throw invalid("The secure browser returned an invalid reset receipt.");
  }
  const profileEpoch = requiredInteger(payload, "profileEpoch");
  const message = "Browser profile reset canceled this request.";
  for (const row of ctx.db.all<InteractionRow>(
    `SELECT * FROM browser_interactions WHERE state IN ${ACTIVE_STATES}`,
  )) {
    ctx.db.run(
      `UPDATE browser_interactions SET state = 'canceled', resolution = 'canceled', safe_message = ?,
         revision = revision + 1, updated_at = ?
       WHERE interaction_id = ?`,
      message,
      ctx.now,
      row.interaction_id,
    );
    ctx.jobs.cancel(expireJobId(row.interaction_id));
    cancelWaitingAgentThread(ctx, {
      threadId: row.thread_id,
      attemptGeneration: row.attempt_generation,
      message,
    });
  }
  return { schemaVersion: 1, profileId: PROFILE_ID, profileEpoch, reset: true };
};

const interactionId = string({ min: 1, max: 256 });
const expectedRevision = number({ int: true, min: 1 });
const requestId = string({ pattern: UUID_PATTERN, max: 64 });

export const browserDomain = {
  name: "browser",
  migrations: [BROWSER_MIGRATION],
  calls: {
    "browser.detail": {
      scope: "owner",
      parse: object({ interactionId }),
      handler: detail,
    },
    "browser.liveView": {
      scope: "owner",
      parse: object({ interactionId, expectedRevision }),
      handler: liveView,
    },
    "browser.sessionTransferKey": {
      scope: "owner",
      parse: object({ interactionId, expectedRevision }),
      handler: sessionTransferKey,
    },
    "browser.importSessionTransfer": {
      scope: "owner",
      parse: object({
        interactionId,
        expectedRevision,
        transfer: object({
          schemaVersion: literal(1),
          algorithm: literal("x25519-hkdf-sha256-aes-256-gcm-v1"),
          capabilityId: string({ min: 1, max: 128 }),
          clientPublicKey: string({ min: 1, max: 128 }),
          iv: string({ min: 1, max: 64 }),
          ciphertext: string({ min: 1, max: TRANSFER_CIPHERTEXT_MAX }),
        }),
      }),
      handler: importSessionTransfer,
    },
    "browser.decide": {
      scope: "owner",
      parse: object({
        interactionId,
        expectedRevision,
        requestId,
        decision: literal("done", "cancel"),
      }),
      handler: decide,
    },
    "browser.resetProfile": {
      scope: "owner",
      parse: object({ requestId }),
      handler: resetProfile,
    },
  },
  views: {
    "browser.pending": {
      parse: empty(),
      read: (ctx) => listPending(ctx.db),
    },
  },
  jobs: {
    [EXPIRE_JOB]: { run: expire },
  },
  purge: (ctx: OwnerContext) => {
    for (const { interaction_id } of ctx.db.all<{ interaction_id: string }>(
      "SELECT interaction_id FROM browser_interactions",
    )) {
      ctx.jobs.cancel(expireJobId(interaction_id));
    }
    ctx.db.run("DELETE FROM browser_interactions");
    return { pending: false };
  },
} satisfies OwnerDomain;
