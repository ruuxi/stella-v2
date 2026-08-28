import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  requireSensitiveConnectedUserIdentity,
  requireSensitiveConnectedUserIdentityAction,
} from "./auth";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import { enforceActionRateLimit } from "./lib/rate_limits";
import { hashSha256Hex } from "./lib/crypto_utils";
import { cloudAgentSandboxLeaseExpiresAt } from "./lib/computer_agent_thread";
import {
  cloudBrowserInteractionKindValidator,
  cloudBrowserInteractionStateValidator,
  cloudBrowserResumeReceiptValidator,
  cloudBrowserResumeResultValidator,
} from "./schema/cloud_browser";

const DEFAULT_BROWSER_PROFILE_ID = "default" as const;
const MAX_ACTIVE_INTERACTIONS = 24;
const TURN_TOKEN_ATTEMPT_LIMIT = 8;
const MAX_INTERACTION_LIFETIME_MS = 24 * 60 * 60_000;

type BrowserInteractionKind = "login_takeover" | "device_code";
type BrowserInteractionState =
  | "pending"
  | "human_control"
  | "resuming"
  | "completed"
  | "canceled"
  | "expired"
  | "failed";
type BrowserDecision = "done" | "cancel";
type BrowserResumeResult = "approved" | "canceled" | "expired" | "failed";

type BrowserSuspension = {
  schemaVersion: 1;
  outcome: "waiting_for_user";
  interactionId: string;
  interactionRevision: number;
  interactionKind: BrowserInteractionKind;
  toolCallId: string;
  requestDigest: string;
  profileId: string;
  profileEpoch: number;
  displayOrigin: string;
  displayTitle?: string;
  expiresAt: number;
};

type BrowserResumeReceipt = {
  schemaVersion: 1;
  interactionId: string;
  interactionRevision: number;
  profileId: string;
  profileEpoch: number;
  toolCallId: string;
  requestDigest: string;
  result: BrowserResumeResult;
  safeMessage: string;
};

type BrowserInteractionSummary = {
  schemaVersion: 1;
  interactionId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  kind: BrowserInteractionKind;
  state: BrowserInteractionState;
  displayOrigin: string;
  displayTitle?: string;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

const browserSuspensionValidator = v.object({
  schemaVersion: v.literal(1),
  outcome: v.literal("waiting_for_user"),
  interactionId: v.string(),
  interactionRevision: v.number(),
  interactionKind: cloudBrowserInteractionKindValidator,
  toolCallId: v.string(),
  requestDigest: v.string(),
  profileId: v.string(),
  profileEpoch: v.number(),
  displayOrigin: v.string(),
  displayTitle: v.optional(v.string()),
  expiresAt: v.number(),
});

const browserInteractionSummaryValidator = v.object({
  schemaVersion: v.literal(1),
  interactionId: v.string(),
  conversationId: v.string(),
  threadId: v.string(),
  turnId: v.string(),
  kind: cloudBrowserInteractionKindValidator,
  state: cloudBrowserInteractionStateValidator,
  displayOrigin: v.string(),
  displayTitle: v.optional(v.string()),
  revision: v.number(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const browserInteractionControlValidator = v.object({
  summary: browserInteractionSummaryValidator,
  ownerId: v.string(),
  ownerGeneration: v.string(),
  attemptGeneration: v.number(),
  toolCallId: v.string(),
  requestDigest: v.string(),
  profileId: v.string(),
  profileEpoch: v.number(),
  decision: v.optional(v.union(v.literal("done"), v.literal("cancel"))),
  decisionRequestId: v.optional(v.string()),
  decisionBaseRevision: v.optional(v.number()),
  resolution: v.optional(cloudBrowserResumeResultValidator),
  resumeTurnId: v.optional(v.string()),
  resumeAttemptGeneration: v.optional(v.number()),
});

const browserDeviceDetailValidator = v.object({
  schemaVersion: v.literal(1),
  interactionId: v.string(),
  conversationId: v.string(),
  threadId: v.string(),
  turnId: v.string(),
  kind: v.literal("device_code"),
  state: cloudBrowserInteractionStateValidator,
  displayOrigin: v.string(),
  displayTitle: v.optional(v.string()),
  revision: v.number(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  verificationUri: v.string(),
  verificationUriComplete: v.optional(v.string()),
  userCode: v.string(),
});

const browserLoginDetailValidator = v.object({
  schemaVersion: v.literal(1),
  interactionId: v.string(),
  conversationId: v.string(),
  threadId: v.string(),
  turnId: v.string(),
  kind: v.literal("login_takeover"),
  state: cloudBrowserInteractionStateValidator,
  displayOrigin: v.string(),
  displayTitle: v.optional(v.string()),
  revision: v.number(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const browserInteractionDetailValidator = v.union(
  browserLoginDetailValidator,
  browserDeviceDetailValidator,
);

const browserLiveViewCapabilityValidator = v.object({
  schemaVersion: v.literal(1),
  interactionId: v.string(),
  revision: v.number(),
  url: v.string(),
  expiresAt: v.number(),
});

const browserProfileResetValidator = v.object({
  schemaVersion: v.literal(1),
  profileId: v.literal(DEFAULT_BROWSER_PROFILE_ID),
  profileEpoch: v.number(),
  reset: v.literal(true),
});

const getInteractionControlRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; interactionId: string },
  ReturnType<typeof projectInteractionControl> | null
>("cloud_browser:getBrowserInteractionControlInternal");

const claimLiveViewRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    interactionId: string;
    expectedRevision: number;
    now: number;
  },
  BrowserInteractionSummary
>("cloud_browser:claimBrowserInteractionInternal");

const claimResumeRef = makeFunctionReference<"mutation", any, any>(
  "cloud_browser:claimBrowserInteractionResumeInternal",
);
const cancelInteractionRef = makeFunctionReference<"mutation", any, any>(
  "cloud_browser:cancelBrowserInteractionInternal",
);
const applyProfileResetRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    profileEpoch: number;
    now: number;
  },
  null
>("cloud_browser:applyBrowserProfileResetInternal");
const activateResumeTurnRef = makeFunctionReference<"mutation", any, null>(
  "cloud_browser:activateBrowserResumeTurnInternal",
);
const runCloudAgentTurnRef = makeFunctionReference<"action", any, null>(
  "cloud_apps:runCloudAgentTurnInternal",
);

const projectSummary = (
  row: Doc<"cloud_browser_interactions">,
): BrowserInteractionSummary => ({
  schemaVersion: 1,
  interactionId: row.interactionId,
  conversationId: row.conversationId,
  threadId: row.threadId,
  turnId: row.turnId,
  kind: row.kind,
  state: row.state,
  displayOrigin: row.displayOrigin,
  ...(row.displayTitle ? { displayTitle: row.displayTitle } : {}),
  revision: row.revision,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function projectInteractionControl(row: Doc<"cloud_browser_interactions">) {
  return {
    summary: projectSummary(row),
    ownerId: row.ownerId,
    ownerGeneration: row.ownerGeneration,
    attemptGeneration: row.attemptGeneration,
    toolCallId: row.toolCallId,
    requestDigest: row.requestDigest,
    profileId: row.profileId,
    profileEpoch: row.profileEpoch,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.decisionRequestId
      ? { decisionRequestId: row.decisionRequestId }
      : {}),
    ...(row.decisionBaseRevision !== undefined
      ? { decisionBaseRevision: row.decisionBaseRevision }
      : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.resumeTurnId ? { resumeTurnId: row.resumeTurnId } : {}),
    ...(row.resumeAttemptGeneration !== undefined
      ? { resumeAttemptGeneration: row.resumeAttemptGeneration }
      : {}),
  };
}

const browserGatewayEndpoint = (): { url: string; secret: string } => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  if (!url || !secret) {
    throw new ConvexError("Cloud browser is not configured.");
  }
  return { url, secret };
};

const postBrowserGateway = async (
  route: string,
  body: unknown,
): Promise<unknown> => {
  const gateway = browserGatewayEndpoint();
  let response: Response;
  try {
    response = await fetch(`${gateway.url}${route}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${gateway.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ConvexError(
      "Stella could not reach the secure browser. Try again.",
    );
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 409) {
    throw new ConvexError(
      "This browser request changed. Refresh it and try again.",
    );
  }
  if (!response.ok || !payload) {
    throw new ConvexError(
      "The secure browser could not complete that request. Try again.",
    );
  }
  return payload;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  record: Record<string, unknown>,
  key: string,
  maxLength = 512,
): string => {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new ConvexError(`Invalid browser ${key}.`);
  }
  return value;
};

const requiredSafeInteger = (
  record: Record<string, unknown>,
  key: string,
  minimum = 1,
): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ConvexError(`Invalid browser ${key}.`);
  }
  return value as number;
};

const safeHttpUrl = (value: string, expectedOrigin?: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError("Invalid secure browser URL.");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (expectedOrigin !== undefined && parsed.origin !== expectedOrigin)
  ) {
    throw new ConvexError("Invalid secure browser URL.");
  }
  return parsed.toString();
};

const safeHttpsUrl = (value: string): string => {
  const normalized = safeHttpUrl(value);
  if (new URL(normalized).protocol !== "https:") {
    throw new ConvexError("Invalid secure browser URL.");
  }
  return normalized;
};

const parseBrowserSuspension = (payloadJson: string): BrowserSuspension => {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new ConvexError("Invalid browser waiting event.");
  }
  if (!isRecord(payload) || !isRecord(payload.suspension)) {
    throw new ConvexError("Invalid browser waiting event.");
  }
  const value = payload.suspension;
  if (value.schemaVersion !== 1 || value.outcome !== "waiting_for_user") {
    throw new ConvexError("Invalid browser waiting event.");
  }
  const interactionKind = value.interactionKind;
  if (
    interactionKind !== "login_takeover" &&
    interactionKind !== "device_code"
  ) {
    throw new ConvexError("Invalid browser interaction kind.");
  }
  const requestDigest = requiredString(value, "requestDigest", 64);
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new ConvexError("Invalid browser request digest.");
  }
  const displayOrigin = requiredString(value, "displayOrigin", 512);
  if (safeHttpUrl(displayOrigin) !== `${new URL(displayOrigin).origin}/`) {
    throw new ConvexError("Browser displayOrigin must be an origin.");
  }
  const displayTitle =
    value.displayTitle === undefined
      ? undefined
      : requiredString(value, "displayTitle", 200);
  const suspension: BrowserSuspension = {
    schemaVersion: 1,
    outcome: "waiting_for_user",
    interactionId: requiredString(value, "interactionId", 256),
    interactionRevision: requiredSafeInteger(value, "interactionRevision"),
    interactionKind,
    toolCallId: requiredString(value, "toolCallId", 256),
    requestDigest,
    profileId: requiredString(value, "profileId", 64),
    profileEpoch: requiredSafeInteger(value, "profileEpoch"),
    displayOrigin: new URL(displayOrigin).origin,
    ...(displayTitle ? { displayTitle } : {}),
    expiresAt: requiredSafeInteger(value, "expiresAt"),
  };
  if (
    suspension.profileId !== DEFAULT_BROWSER_PROFILE_ID ||
    suspension.interactionRevision !== 1
  ) {
    throw new ConvexError("Invalid browser profile or initial revision.");
  }
  return suspension;
};

const exactSuspensionMatches = (
  row: Doc<"cloud_browser_interactions">,
  args: {
    ownerId: string;
    ownerGeneration: string;
    turnId: string;
    threadId: string;
    attemptGeneration: number;
    tokenHash: string;
    payloadHash: string;
    suspension: BrowserSuspension;
  },
): boolean =>
  row.ownerId === args.ownerId &&
  row.ownerGeneration === args.ownerGeneration &&
  row.turnId === args.turnId &&
  row.threadId === args.threadId &&
  row.attemptGeneration === args.attemptGeneration &&
  row.suspensionTokenHash === args.tokenHash &&
  row.suspensionEventPayloadHash === args.payloadHash &&
  row.interactionId === args.suspension.interactionId &&
  row.revision >= args.suspension.interactionRevision &&
  row.kind === args.suspension.interactionKind &&
  row.toolCallId === args.suspension.toolCallId &&
  row.requestDigest === args.suspension.requestDigest &&
  row.profileId === args.suspension.profileId &&
  row.profileEpoch === args.suspension.profileEpoch &&
  row.displayOrigin === args.suspension.displayOrigin &&
  row.displayTitle === args.suspension.displayTitle &&
  row.expiresAt === args.suspension.expiresAt;

export const browserSuspensionReplayMatches = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    turnId: string;
    threadId: string;
    attemptGeneration: number;
    tokenHash: string;
    payloadJson: string;
  },
): Promise<boolean> => {
  const suspension = parseBrowserSuspension(args.payloadJson);
  const rows = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_interactionId", (q) =>
      q.eq("interactionId", suspension.interactionId),
    )
    .take(2);
  if (rows.length !== 1) return false;
  return exactSuspensionMatches(rows[0]!, {
    ...args,
    suspension,
    payloadHash: await hashSha256Hex(args.payloadJson),
  });
};

export const projectCloudBrowserSuspension = async (
  ctx: MutationCtx,
  args: {
    turn: Doc<"agent_turns">;
    tokenHash: string;
    payloadJson: string;
    connectedAccount: boolean;
    now: number;
  },
): Promise<{ replayed: boolean; suspension: BrowserSuspension }> => {
  const suspension = parseBrowserSuspension(args.payloadJson);
  const turn = args.turn;
  if (!args.connectedAccount) {
    throw new ConvexError("Sign in with an account to use the cloud browser.");
  }
  if (
    turn.kind !== "agent" ||
    !turn.threadId ||
    !turn.conversationId ||
    !turn.ownerGeneration ||
    !Number.isSafeInteger(turn.attemptGeneration) ||
    turn.attemptGeneration! < 1
  ) {
    throw new ConvexError("Browser handoff requires a hosted agent turn.");
  }
  await assertOwnerMigrationWriteAllowed(
    ctx,
    turn.ownerId,
    turn.ownerGeneration,
  );
  const payloadHash = await hashSha256Hex(args.payloadJson);
  const existingById = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_interactionId", (q) =>
      q.eq("interactionId", suspension.interactionId),
    )
    .take(2);
  if (existingById.length > 1) {
    throw new ConvexError("Browser interaction authority is ambiguous.");
  }
  const exactArgs = {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    threadId: turn.threadId,
    attemptGeneration: turn.attemptGeneration!,
    tokenHash: args.tokenHash,
    payloadHash,
    suspension,
  };
  if (existingById[0]) {
    if (!exactSuspensionMatches(existingById[0], exactArgs)) {
      throw new ConvexError("Browser interaction id was reused differently.");
    }
    return { replayed: true, suspension };
  }
  const existingForRequest = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_turnId_and_requestDigest", (q) =>
      q.eq("turnId", turn.turnId).eq("requestDigest", suspension.requestDigest),
    )
    .take(2);
  if (existingForRequest.length > 0) {
    throw new ConvexError("Browser request was already projected differently.");
  }
  const existingForTurn = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_turnId_and_requestDigest", (q) =>
      q.eq("turnId", turn.turnId),
    )
    .take(1);
  if (existingForTurn.length > 0) {
    throw new ConvexError("That hosted turn is already waiting for a browser.");
  }
  const [authorityTokenRows, sessionPolicy] = await Promise.all([
    ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .take(2),
    ctx.db
      .query("auth_session_policies")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", turn.ownerId))
      .unique(),
  ]);
  const token =
    authorityTokenRows.length === 1 ? authorityTokenRows[0] : undefined;
  if (
    !token ||
    token.ownerId !== turn.ownerId ||
    token.ownerGeneration !== turn.ownerGeneration ||
    token.turnId !== turn.turnId
  ) {
    throw new ConvexError("Cloud turn is no longer active.");
  }
  // A browser handoff is a new sensitive capability even though it arrives
  // through the executor's service route rather than a live user JWT. Bind it
  // to the time the turn capability was minted so revokeActiveSessions also
  // fences an executor that was already running when the user revoked access.
  if (
    sessionPolicy &&
    Math.floor(token.createdAt / 1000) < sessionPolicy.minIssuedAtSec
  ) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Session has been revoked. Please sign in again.",
    });
  }
  if (
    turn.status !== "running" ||
    turn.terminalKind ||
    turn.activeTokenHash !== args.tokenHash ||
    suspension.expiresAt <= args.now ||
    suspension.expiresAt > args.now + MAX_INTERACTION_LIFETIME_MS
  ) {
    throw new ConvexError("Cloud turn is no longer active.");
  }
  const thread = await ctx.db
    .query("cloud_agent_threads")
    .withIndex("by_threadId", (q) => q.eq("threadId", turn.threadId!))
    .unique();
  if (
    !thread ||
    thread.ownerId !== turn.ownerId ||
    thread.ownerGeneration !== turn.ownerGeneration ||
    thread.conversationId !== turn.conversationId ||
    thread.attemptGeneration !== turn.attemptGeneration ||
    thread.status !== "running"
  ) {
    throw new ConvexError("Hosted agent thread is no longer active.");
  }
  const activeRows = await Promise.all(
    (["pending", "human_control", "resuming"] as const).map((state) =>
      ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_ownerId_and_state_and_createdAt", (q) =>
          q.eq("ownerId", turn.ownerId).eq("state", state),
        )
        .take(MAX_ACTIVE_INTERACTIONS + 1),
    ),
  );
  if (activeRows.flat().length >= MAX_ACTIVE_INTERACTIONS) {
    throw new ConvexError("Too many browser requests are waiting.");
  }
  await ctx.db.insert("cloud_browser_interactions", {
    interactionId: suspension.interactionId,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    conversationId: turn.conversationId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    toolCallId: suspension.toolCallId,
    requestDigest: suspension.requestDigest,
    profileId: suspension.profileId,
    profileEpoch: suspension.profileEpoch,
    kind: suspension.interactionKind,
    state: "pending",
    displayOrigin: suspension.displayOrigin,
    ...(suspension.displayTitle
      ? { displayTitle: suspension.displayTitle }
      : {}),
    revision: suspension.interactionRevision,
    expiresAt: suspension.expiresAt,
    suspensionTokenHash: args.tokenHash,
    suspensionEventPayloadHash: payloadHash,
    createdAt: args.now,
    updatedAt: args.now,
  });
  const tokenRows = await ctx.db
    .query("cloud_turn_tokens")
    .withIndex("by_turnId_and_ownerId", (q) =>
      q.eq("turnId", turn.turnId).eq("ownerId", turn.ownerId),
    )
    .take(TURN_TOKEN_ATTEMPT_LIMIT + 1);
  if (tokenRows.length > TURN_TOKEN_ATTEMPT_LIMIT) {
    throw new ConvexError("Cloud turn token authority is ambiguous.");
  }
  for (const token of tokenRows) await ctx.db.delete(token._id);
  await ctx.db.patch(turn._id, {
    status: "waiting_for_user",
    activeTokenHash: undefined,
    updatedAt: args.now,
  });
  await ctx.db.patch(thread._id, {
    status: "waiting_for_user",
    sandboxLeaseExpiresAt: 0,
    updatedAt: args.now,
  });
  return { replayed: false, suspension };
};

const authorityBody = (
  control: ReturnType<typeof projectInteractionControl>,
) => ({
  ownerId: control.ownerId,
  ownerGeneration: control.ownerGeneration,
  conversationId: control.summary.conversationId,
  threadId: control.summary.threadId,
  turnId: control.summary.turnId,
  attemptGeneration: control.attemptGeneration,
});

const gatewayInteractionBody = (
  control: ReturnType<typeof projectInteractionControl>,
) => ({
  schemaVersion: 1,
  authority: authorityBody(control),
  profileId: control.profileId,
  profileEpoch: control.profileEpoch,
  interactionId: control.summary.interactionId,
  interactionRevision: control.summary.revision,
});

const requireActionOwner = async (ctx: ActionCtx) => {
  const identity = await requireSensitiveConnectedUserIdentityAction(ctx);
  const ownerId = identity.tokenIdentifier;
  const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
  return { ownerId, ownerGeneration: generation };
};

const loadActionControl = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
  interactionId: string,
) =>
  await ctx.runQuery(getInteractionControlRef, {
    ownerId,
    ownerGeneration,
    interactionId,
  });

const validateGatewayDetail = (
  payload: unknown,
  control: ReturnType<typeof projectInteractionControl>,
) => {
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    !isRecord(payload.interaction)
  ) {
    throw new ConvexError("The secure browser returned an invalid status.");
  }
  const detail = payload.interaction;
  const summary = control.summary;
  if (
    detail.schemaVersion !== 1 ||
    detail.interactionId !== summary.interactionId ||
    detail.kind !== summary.kind ||
    detail.revision !== summary.revision
  ) {
    throw new ConvexError("The secure browser returned a stale status.");
  }
  if (summary.kind === "login_takeover") {
    return { ...summary, kind: "login_takeover" as const };
  }
  const verificationUri = safeHttpsUrl(
    requiredString(detail, "verificationUri", 2048),
  );
  const verificationUriComplete =
    detail.verificationUriComplete === undefined
      ? undefined
      : safeHttpsUrl(requiredString(detail, "verificationUriComplete", 4096));
  const userCode = requiredString(detail, "userCode", 256);
  return {
    ...summary,
    kind: "device_code" as const,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    userCode,
  };
};

const validateLiveViewCapability = (
  payload: unknown,
  interactionId: string,
  expectedRevision: number,
) => {
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw new ConvexError("The secure browser returned an invalid Live View.");
  }
  const returnedInteractionId = requiredString(payload, "interactionId", 256);
  const revision = requiredSafeInteger(payload, "revision");
  const expiresAt = requiredSafeInteger(payload, "expiresAt");
  const url = safeHttpUrl(requiredString(payload, "url", 8192));
  const parsed = new URL(url);
  if (
    returnedInteractionId !== interactionId ||
    revision !== expectedRevision ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "live.browser.run" ||
    expiresAt <= Date.now()
  ) {
    throw new ConvexError("The secure browser returned a stale Live View.");
  }
  return {
    schemaVersion: 1 as const,
    interactionId,
    revision,
    url,
    expiresAt,
  };
};

const validateResumeReceipt = (
  payload: unknown,
  control: ReturnType<typeof projectInteractionControl>,
  decision: BrowserDecision,
): BrowserResumeReceipt => {
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    !isRecord(payload.receipt)
  ) {
    throw new ConvexError("The secure browser returned an invalid decision.");
  }
  const value = payload.receipt;
  const result = value.result;
  if (
    !(["approved", "canceled", "expired", "failed"] as const).includes(
      result as BrowserResumeResult,
    )
  ) {
    throw new ConvexError("The secure browser returned an invalid result.");
  }
  const receipt: BrowserResumeReceipt = {
    schemaVersion: 1,
    interactionId: requiredString(value, "interactionId", 256),
    interactionRevision: requiredSafeInteger(value, "interactionRevision"),
    profileId: requiredString(value, "profileId", 64),
    profileEpoch: requiredSafeInteger(value, "profileEpoch"),
    // The Gateway may only know the inner browser-command id. Convex stored
    // the authoritative outer Code tool-call id with the suspension, so never
    // trust or compare the Gateway's value when constructing the resume.
    toolCallId: control.toolCallId,
    requestDigest: requiredString(value, "requestDigest", 64),
    result: result as BrowserResumeResult,
    safeMessage: requiredString(value, "safeMessage", 500),
  };
  if (
    receipt.interactionId !== control.summary.interactionId ||
    receipt.interactionRevision !== control.summary.revision ||
    receipt.profileId !== control.profileId ||
    receipt.profileEpoch !== control.profileEpoch ||
    receipt.requestDigest !== control.requestDigest ||
    !/^[a-f0-9]{64}$/.test(receipt.requestDigest) ||
    (decision === "cancel" && receipt.result !== "canceled") ||
    (decision === "done" && receipt.result === "canceled")
  ) {
    throw new ConvexError("The secure browser returned a stale decision.");
  }
  return receipt;
};

export const listMyPendingBrowserInteractions = query({
  args: {},
  returns: v.array(browserInteractionSummaryValidator),
  handler: async (ctx) => {
    const identity = await requireSensitiveConnectedUserIdentity(ctx);
    const ownerId = identity.tokenIdentifier;
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const pages = await Promise.all(
      (["pending", "human_control", "resuming"] as const).map((state) =>
        ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_ownerId_and_state_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("state", state),
          )
          .order("desc")
          .take(MAX_ACTIVE_INTERACTIONS),
      ),
    );
    return pages
      .flat()
      .filter((row) => row.ownerGeneration === generation)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ACTIVE_INTERACTIONS)
      .map(projectSummary);
  },
});

export const getMyBrowserInteraction = action({
  args: { interactionId: v.string() },
  returns: v.union(v.null(), browserInteractionDetailValidator),
  handler: async (ctx, args) => {
    const owner = await requireActionOwner(ctx);
    const interactionId = args.interactionId.trim();
    if (!interactionId || interactionId.length > 256) {
      throw new ConvexError("interactionId is required.");
    }
    await enforceActionRateLimit(
      ctx,
      "cloud_browser_status",
      owner.ownerId,
      { rate: 60, periodMs: 60_000 },
      "Too many browser status checks. Wait a moment and try again.",
    );
    const control = await loadActionControl(
      ctx,
      owner.ownerId,
      owner.ownerGeneration,
      interactionId,
    );
    if (!control) return null;
    const payload = await postBrowserGateway(
      "/internal/interactions/status",
      gatewayInteractionBody(control),
    );
    return validateGatewayDetail(payload, control);
  },
});

export const mintMyBrowserLiveViewCapability = action({
  args: { interactionId: v.string(), expectedRevision: v.number() },
  returns: browserLiveViewCapabilityValidator,
  handler: async (ctx, args) => {
    const owner = await requireActionOwner(ctx);
    await enforceActionRateLimit(
      ctx,
      "cloud_browser_live_view",
      owner.ownerId,
      { rate: 20, periodMs: 60_000 },
      "Too many Live View requests. Wait a moment and try again.",
    );
    const control = await loadActionControl(
      ctx,
      owner.ownerId,
      owner.ownerGeneration,
      args.interactionId.trim(),
    );
    if (
      !control ||
      control.summary.revision !== args.expectedRevision ||
      !["pending", "human_control"].includes(control.summary.state) ||
      control.summary.expiresAt <= Date.now()
    ) {
      throw new ConvexError("This browser request is no longer available.");
    }
    const payload = await postBrowserGateway(
      "/internal/interactions/live-view",
      gatewayInteractionBody(control),
    );
    const capability = validateLiveViewCapability(
      payload,
      control.summary.interactionId,
      args.expectedRevision,
    );
    await ctx.runMutation(claimLiveViewRef, {
      ...owner,
      interactionId: control.summary.interactionId,
      expectedRevision: args.expectedRevision,
      now: Date.now(),
    });
    return capability;
  },
});

export const decideMyBrowserInteraction = action({
  args: {
    interactionId: v.string(),
    expectedRevision: v.number(),
    requestId: v.string(),
    decision: v.union(v.literal("done"), v.literal("cancel")),
  },
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args): Promise<BrowserInteractionSummary> => {
    const owner = await requireActionOwner(ctx);
    const interactionId = args.interactionId.trim();
    const requestId = args.requestId.trim();
    if (!interactionId || interactionId.length > 256) {
      throw new ConvexError("interactionId is required.");
    }
    if (!requestId || requestId.length > 256) {
      throw new ConvexError("A browser decision needs a request id.");
    }
    await enforceActionRateLimit(
      ctx,
      "cloud_browser_decision",
      owner.ownerId,
      { rate: 30, periodMs: 10 * 60_000 },
      "Too many browser decisions. Wait a moment and try again.",
    );
    const control = await loadActionControl(
      ctx,
      owner.ownerId,
      owner.ownerGeneration,
      interactionId,
    );
    if (!control) throw new ConvexError("Browser request not found.");
    if (control.decisionRequestId) {
      if (
        control.decisionRequestId !== requestId ||
        control.decision !== args.decision ||
        control.decisionBaseRevision !== args.expectedRevision
      ) {
        throw new ConvexError(
          "That browser decision id was reused differently.",
        );
      }
      return control.summary;
    }
    if (
      control.summary.revision !== args.expectedRevision ||
      !["pending", "human_control"].includes(control.summary.state) ||
      (args.decision === "done" && control.summary.expiresAt <= Date.now())
    ) {
      throw new ConvexError(
        "This browser request changed. Refresh it and try again.",
      );
    }
    const payload = await postBrowserGateway(
      "/internal/interactions/decision",
      { ...gatewayInteractionBody(control), decision: args.decision },
    );
    const receipt = validateResumeReceipt(payload, control, args.decision);
    const ref =
      args.decision === "cancel" ? cancelInteractionRef : claimResumeRef;
    return (await ctx.runMutation(ref, {
      ...owner,
      interactionId,
      expectedRevision: args.expectedRevision,
      requestId,
      decision: args.decision,
      receipt,
      now: Date.now(),
    })) as BrowserInteractionSummary;
  },
});

export const resetMyBrowserProfile = action({
  args: { requestId: v.string() },
  returns: browserProfileResetValidator,
  handler: async (ctx, args) => {
    const owner = await requireActionOwner(ctx);
    const requestId = args.requestId.trim();
    if (!requestId || requestId.length > 256) {
      throw new ConvexError("A browser reset needs a request id.");
    }
    await enforceActionRateLimit(
      ctx,
      "cloud_browser_reset",
      owner.ownerId,
      { rate: 3, periodMs: 60 * 60_000 },
      "Too many browser resets. Wait before trying again.",
    );
    const payload = await postBrowserGateway("/internal/owners/profile/reset", {
      schemaVersion: 1,
      authority: owner,
      requestId,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    if (
      !isRecord(payload) ||
      payload.schemaVersion !== 1 ||
      payload.profileId !== DEFAULT_BROWSER_PROFILE_ID ||
      payload.reset !== true
    ) {
      throw new ConvexError(
        "The secure browser returned an invalid reset receipt.",
      );
    }
    const profileEpoch = requiredSafeInteger(payload, "profileEpoch");
    await ctx.runMutation(applyProfileResetRef, {
      ...owner,
      requestId,
      profileEpoch,
      now: Date.now(),
    });
    return {
      schemaVersion: 1 as const,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
      profileEpoch,
      reset: true as const,
    };
  },
});

export const getBrowserInteractionControlInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    interactionId: v.string(),
  },
  returns: v.union(v.null(), browserInteractionControlValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const rows = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_ownerId_and_interactionId", (q) =>
        q.eq("ownerId", args.ownerId).eq("interactionId", args.interactionId),
      )
      .take(2);
    if (rows.length > 1) {
      throw new ConvexError("Browser interaction authority is ambiguous.");
    }
    const row = rows[0];
    return row?.ownerGeneration === args.ownerGeneration
      ? projectInteractionControl(row)
      : null;
  },
});

export const getBrowserSuspensionReplayAuthorityInternal = internalQuery({
  args: {
    interactionId: v.string(),
    turnId: v.string(),
    threadId: v.string(),
    attemptGeneration: v.number(),
    tokenHash: v.string(),
    payloadHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      tokenHash: v.string(),
      ownerId: v.string(),
      ownerGeneration: v.string(),
      turnId: v.string(),
      agentType: v.string(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_interactionId", (q) =>
        q.eq("interactionId", args.interactionId),
      )
      .take(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (
      row.turnId !== args.turnId ||
      row.threadId !== args.threadId ||
      row.attemptGeneration !== args.attemptGeneration ||
      row.suspensionTokenHash !== args.tokenHash ||
      row.suspensionEventPayloadHash !== args.payloadHash
    ) {
      return null;
    }
    return {
      tokenHash: args.tokenHash,
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      turnId: row.turnId,
      agentType: "general",
      expiresAt: row.expiresAt,
    };
  },
});

export const createBrowserInteractionInternal = internalMutation({
  args: {
    tokenHash: v.string(),
    turnId: v.string(),
    payloadJson: v.string(),
    connectedAccount: v.boolean(),
    now: v.number(),
  },
  returns: v.object({
    replayed: v.boolean(),
    suspension: browserSuspensionValidator,
  }),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) throw new ConvexError("Unknown hosted agent turn.");
    return await projectCloudBrowserSuspension(ctx, { ...args, turn });
  },
});

export const claimBrowserInteractionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    interactionId: v.string(),
    expectedRevision: v.number(),
    now: v.number(),
  },
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_ownerId_and_interactionId", (q) =>
        q.eq("ownerId", args.ownerId).eq("interactionId", args.interactionId),
      )
      .unique();
    if (
      !row ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.revision !== args.expectedRevision ||
      !["pending", "human_control"].includes(row.state) ||
      row.expiresAt <= args.now
    ) {
      throw new ConvexError("This browser request is no longer available.");
    }
    if (row.state === "pending") {
      await ctx.db.patch(row._id, {
        state: "human_control",
        updatedAt: args.now,
      });
      return projectSummary({
        ...row,
        state: "human_control",
        updatedAt: args.now,
      });
    }
    return projectSummary(row);
  },
});

const assertReceiptMatchesRow = (
  row: Doc<"cloud_browser_interactions">,
  receipt: BrowserResumeReceipt,
) => {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.interactionId !== row.interactionId ||
    receipt.interactionRevision !== row.revision ||
    receipt.profileId !== row.profileId ||
    receipt.profileEpoch !== row.profileEpoch ||
    receipt.toolCallId !== row.toolCallId ||
    receipt.requestDigest !== row.requestDigest ||
    !/^[a-f0-9]{64}$/.test(receipt.requestDigest) ||
    !Number.isSafeInteger(receipt.profileEpoch) ||
    receipt.profileEpoch < 1 ||
    !receipt.safeMessage ||
    receipt.safeMessage.length > 500
  ) {
    throw new ConvexError("Browser resume receipt does not match the wait.");
  }
};

const resolvedReceiptMatchesRow = (
  row: Doc<"cloud_browser_interactions">,
  receipt: BrowserResumeReceipt,
): boolean =>
  receipt.schemaVersion === 1 &&
  receipt.interactionId === row.interactionId &&
  receipt.interactionRevision === row.decisionBaseRevision &&
  receipt.profileId === row.profileId &&
  receipt.profileEpoch === row.profileEpoch &&
  receipt.toolCallId === row.toolCallId &&
  receipt.requestDigest === row.requestDigest &&
  receipt.result === row.resolution &&
  receipt.safeMessage === row.safeMessage;

const applyBrowserResumeReceipt = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    interactionId: string;
    expectedRevision: number;
    requestId: string;
    decision: BrowserDecision;
    receipt: BrowserResumeReceipt;
    now: number;
  },
): Promise<BrowserInteractionSummary> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const row = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_ownerId_and_interactionId", (q) =>
      q.eq("ownerId", args.ownerId).eq("interactionId", args.interactionId),
    )
    .unique();
  if (!row || row.ownerGeneration !== args.ownerGeneration) {
    throw new ConvexError("Browser request not found.");
  }
  if (row.decisionRequestId) {
    if (
      row.decisionRequestId !== args.requestId ||
      row.decision !== args.decision ||
      row.decisionBaseRevision !== args.expectedRevision ||
      row.resolution !== args.receipt.result ||
      row.safeMessage !== args.receipt.safeMessage
    ) {
      throw new ConvexError("That browser decision id was reused differently.");
    }
    return projectSummary(row);
  }
  if (
    row.revision !== args.expectedRevision ||
    !["pending", "human_control"].includes(row.state)
  ) {
    throw new ConvexError(
      "This browser request changed. Refresh it and try again.",
    );
  }
  assertReceiptMatchesRow(row, args.receipt);
  const [turn, thread] = await Promise.all([
    ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", row.turnId))
      .unique(),
    ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", row.threadId))
      .unique(),
  ]);
  if (
    !turn ||
    !thread ||
    turn.ownerId !== args.ownerId ||
    turn.ownerGeneration !== args.ownerGeneration ||
    turn.threadId !== row.threadId ||
    turn.attemptGeneration !== row.attemptGeneration ||
    turn.status !== "waiting_for_user" ||
    thread.ownerId !== args.ownerId ||
    thread.ownerGeneration !== args.ownerGeneration ||
    thread.conversationId !== row.conversationId ||
    thread.attemptGeneration !== row.attemptGeneration ||
    thread.status !== "waiting_for_user"
  ) {
    throw new ConvexError("Hosted agent wait is no longer resumable.");
  }
  const conflicting = await Promise.all(
    (["running", "resuming"] as const).map((status) =>
      ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_ownerId_and_workspace_and_status", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("workspace", thread.workspace)
            .eq("status", status),
        )
        .take(2),
    ),
  );
  if (
    conflicting.flat().some((candidate) => candidate.threadId !== row.threadId)
  ) {
    throw new ConvexError(
      `Another agent is working in the "${thread.workspace}" workspace. Wait for it to finish, then try again.`,
    );
  }
  const attemptGeneration = row.attemptGeneration + 1;
  if (!Number.isSafeInteger(attemptGeneration)) {
    throw new ConvexError("Hosted agent attempt generation is exhausted.");
  }
  const resumeTurnId = crypto.randomUUID();
  const turnToken =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const prompt = `[Browser ${args.receipt.result}] ${args.receipt.safeMessage}`;
  await ctx.db.insert("agent_turns", {
    turnId: resumeTurnId,
    sessionId: row.threadId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    attemptGeneration,
    conversationId: row.conversationId,
    prompt,
    status: "resuming",
    lane: "agent",
    kind: "agent",
    agentType: turn.agentType ?? "general",
    workspace: thread.workspace,
    threadId: row.threadId,
    ...(turn.parentTurnId ? { parentTurnId: turn.parentTurnId } : {}),
    source: "browser-resume",
    execution: turn.execution ?? thread.execution,
    hidden: true,
    browserResume: args.receipt,
    createdAt: args.now,
    updatedAt: args.now,
  });
  await ctx.db.patch(thread._id, {
    status: "resuming",
    attemptGeneration,
    resultJson: undefined,
    errorMessage: undefined,
    originDeliveryAckAt: undefined,
    sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt(
      thread.workspace,
      args.now,
    ),
    updatedAt: args.now,
  });
  const nextRevision = row.revision + 1;
  await ctx.db.patch(row._id, {
    state: "resuming",
    revision: nextRevision,
    decision: args.decision,
    decisionRequestId: args.requestId,
    decisionBaseRevision: args.expectedRevision,
    resolution: args.receipt.result,
    safeMessage: args.receipt.safeMessage,
    resumeTurnId,
    resumeAttemptGeneration: attemptGeneration,
    updatedAt: args.now,
  });
  await ctx.scheduler.runAfter(0, activateResumeTurnRef, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    interactionId: row.interactionId,
    expectedRevision: nextRevision,
    resumeTurnId,
    attemptGeneration,
    turnToken,
    now: args.now,
  });
  return projectSummary({
    ...row,
    state: "resuming",
    revision: nextRevision,
    decision: args.decision,
    decisionRequestId: args.requestId,
    decisionBaseRevision: args.expectedRevision,
    resolution: args.receipt.result,
    safeMessage: args.receipt.safeMessage,
    resumeTurnId,
    resumeAttemptGeneration: attemptGeneration,
    updatedAt: args.now,
  });
};

const resumeMutationArgs = {
  ownerId: v.string(),
  ownerGeneration: v.string(),
  interactionId: v.string(),
  expectedRevision: v.number(),
  requestId: v.string(),
  decision: v.union(v.literal("done"), v.literal("cancel")),
  receipt: cloudBrowserResumeReceiptValidator,
  now: v.number(),
} as const;

export const claimBrowserInteractionResumeInternal = internalMutation({
  args: resumeMutationArgs,
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args) => {
    if (args.decision !== "done" || args.receipt.result === "canceled") {
      throw new ConvexError("Invalid browser approval receipt.");
    }
    return await applyBrowserResumeReceipt(ctx, args);
  },
});

export const cancelBrowserInteractionInternal = internalMutation({
  args: resumeMutationArgs,
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args) => {
    if (args.decision !== "cancel" || args.receipt.result !== "canceled") {
      throw new ConvexError("Invalid browser cancellation receipt.");
    }
    return await applyBrowserResumeReceipt(ctx, args);
  },
});

export const expireBrowserInteractionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    interactionId: v.string(),
    expectedRevision: v.number(),
    requestId: v.string(),
    receipt: cloudBrowserResumeReceiptValidator,
    now: v.number(),
  },
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args) => {
    if (args.receipt.result !== "expired") {
      throw new ConvexError("Invalid browser expiry receipt.");
    }
    const row = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_ownerId_and_interactionId", (q) =>
        q.eq("ownerId", args.ownerId).eq("interactionId", args.interactionId),
      )
      .unique();
    if (!row || row.ownerGeneration !== args.ownerGeneration) {
      throw new ConvexError("Browser request not found.");
    }
    if (row.expiresAt > args.now) {
      throw new ConvexError("Browser request has not expired.");
    }
    return await applyBrowserResumeReceipt(ctx, {
      ...args,
      decision: "cancel",
    });
  },
});

export const activateBrowserResumeTurnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    interactionId: v.string(),
    expectedRevision: v.number(),
    resumeTurnId: v.string(),
    attemptGeneration: v.number(),
    turnToken: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const [row, turn] = await Promise.all([
      ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_interactionId", (q) =>
          q.eq("interactionId", args.interactionId),
        )
        .unique(),
      ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", args.resumeTurnId))
        .unique(),
    ]);
    if (
      !row ||
      !turn ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.revision !== args.expectedRevision ||
      row.state !== "resuming" ||
      row.resumeTurnId !== args.resumeTurnId ||
      row.resumeAttemptGeneration !== args.attemptGeneration ||
      turn.ownerId !== args.ownerId ||
      turn.ownerGeneration !== args.ownerGeneration ||
      turn.attemptGeneration !== args.attemptGeneration ||
      turn.threadId !== row.threadId ||
      !turn.browserResume ||
      !resolvedReceiptMatchesRow(
        row,
        turn.browserResume as BrowserResumeReceipt,
      )
    ) {
      return null;
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", row.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      thread.attemptGeneration !== args.attemptGeneration ||
      !["resuming", "running"].includes(thread.status) ||
      !["resuming", "running"].includes(turn.status)
    ) {
      return null;
    }
    if (turn.status === "resuming") {
      await ctx.db.patch(turn._id, { status: "running", updatedAt: args.now });
    }
    if (thread.status === "resuming") {
      await ctx.db.patch(thread._id, {
        status: "running",
        updatedAt: args.now,
      });
    }
    await ctx.scheduler.runAfter(0, runCloudAgentTurnRef, {
      ownerId: args.ownerId,
      conversationId: row.conversationId,
      threadId: row.threadId,
      turnId: turn.turnId,
      prompt: turn.prompt,
      workspace: turn.workspace ?? thread.workspace,
      turnToken: args.turnToken,
      ownerGeneration: args.ownerGeneration,
      attemptGeneration: args.attemptGeneration,
      ...(turn.execution ? { execution: turn.execution } : {}),
      ...(turn.browserResume ? { browserResume: turn.browserResume } : {}),
      ...(process.env.CONVEX_SITE_URL?.trim()
        ? { convexCallbackBase: process.env.CONVEX_SITE_URL.trim() }
        : {}),
    });
    return null;
  },
});

const completedStateForResult = (
  result: BrowserResumeResult,
): BrowserInteractionState =>
  result === "approved"
    ? "completed"
    : result === "canceled"
      ? "canceled"
      : result === "expired"
        ? "expired"
        : "failed";

export const completeCloudBrowserInteractionForResumeTurn = async (
  ctx: MutationCtx,
  args: { turn: Doc<"agent_turns">; now: number },
): Promise<void> => {
  const receipt = args.turn.browserResume as BrowserResumeReceipt | undefined;
  if (!receipt) return;
  const rows = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_resumeTurnId", (q) => q.eq("resumeTurnId", args.turn.turnId))
    .take(2);
  if (rows.length !== 1) {
    throw new ConvexError("Browser resume interaction authority is ambiguous.");
  }
  const row = rows[0]!;
  await assertOwnerMigrationWriteAllowed(ctx, row.ownerId, row.ownerGeneration);
  if (
    row.ownerId !== args.turn.ownerId ||
    row.ownerGeneration !== args.turn.ownerGeneration ||
    row.threadId !== args.turn.threadId ||
    row.resumeAttemptGeneration !== args.turn.attemptGeneration ||
    !resolvedReceiptMatchesRow(row, receipt)
  ) {
    throw new ConvexError(
      "Browser resume turn does not match its interaction.",
    );
  }
  const targetState = completedStateForResult(receipt.result);
  if (row.state === targetState) return;
  if (row.state !== "resuming") {
    throw new ConvexError("Browser interaction is no longer resuming.");
  }
  await ctx.db.patch(row._id, {
    state: targetState,
    revision: row.revision + 1,
    updatedAt: args.now,
    completedAt: args.now,
  });
};

export const completeBrowserInteractionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    interactionId: v.string(),
    expectedRevision: v.number(),
    resumeTurnId: v.string(),
    now: v.number(),
  },
  returns: browserInteractionSummaryValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_ownerId_and_interactionId", (q) =>
        q.eq("ownerId", args.ownerId).eq("interactionId", args.interactionId),
      )
      .unique();
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.resumeTurnId))
      .unique();
    if (
      !row ||
      !turn ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.revision !== args.expectedRevision ||
      row.resumeTurnId !== args.resumeTurnId
    ) {
      throw new ConvexError("Browser interaction changed before completion.");
    }
    await completeCloudBrowserInteractionForResumeTurn(ctx, {
      turn,
      now: args.now,
    });
    const completed = await ctx.db.get(row._id);
    if (!completed) throw new ConvexError("Browser interaction disappeared.");
    return projectSummary(completed);
  },
});

export const markBrowserResumeDispatchFailed = async (
  ctx: MutationCtx,
  args: { turn: Doc<"agent_turns">; now: number; safeMessage: string },
): Promise<void> => {
  if (!args.turn.browserResume) return;
  const rows = await ctx.db
    .query("cloud_browser_interactions")
    .withIndex("by_resumeTurnId", (q) => q.eq("resumeTurnId", args.turn.turnId))
    .take(2);
  if (rows.length !== 1) return;
  const row = rows[0]!;
  if (
    row.state !== "resuming" ||
    row.ownerId !== args.turn.ownerId ||
    row.ownerGeneration !== args.turn.ownerGeneration ||
    row.threadId !== args.turn.threadId ||
    row.resumeAttemptGeneration !== args.turn.attemptGeneration
  ) {
    return;
  }
  await ctx.db.patch(row._id, {
    state: "failed",
    resolution: "failed",
    safeMessage: args.safeMessage.slice(0, 500),
    revision: row.revision + 1,
    updatedAt: args.now,
    completedAt: args.now,
  });
};

export const applyBrowserProfileResetInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    profileEpoch: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (!Number.isSafeInteger(args.profileEpoch) || args.profileEpoch < 1) {
      throw new ConvexError("Invalid browser profile epoch.");
    }
    const pages = await Promise.all(
      (["pending", "human_control", "resuming"] as const).map((state) =>
        ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_ownerId_and_state_and_createdAt", (q) =>
            q.eq("ownerId", args.ownerId).eq("state", state),
          )
          .take(MAX_ACTIVE_INTERACTIONS + 1),
      ),
    );
    const active = pages
      .flat()
      .filter((row) => row.ownerGeneration === args.ownerGeneration);
    if (active.length > MAX_ACTIVE_INTERACTIONS) {
      throw new ConvexError("Too many browser waits to reset safely.");
    }
    for (const row of active) {
      const safeMessage = "Browser profile reset canceled this request.";
      await ctx.db.patch(row._id, {
        state: "canceled",
        resolution: "canceled",
        safeMessage,
        revision: row.revision + 1,
        updatedAt: args.now,
        completedAt: args.now,
      });
      const turnId = row.resumeTurnId ?? row.turnId;
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
        .unique();
      if (
        turn &&
        turn.ownerId === args.ownerId &&
        turn.ownerGeneration === args.ownerGeneration &&
        !turn.terminalKind
      ) {
        const payloadJson = JSON.stringify({ message: safeMessage });
        const seqRows = await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turn.turnId))
          .order("desc")
          .take(1);
        await ctx.db.insert("agent_events", {
          ownerId: turn.ownerId,
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          seq: (seqRows[0]?.seq ?? -1) + 1,
          kind: "canceled",
          payloadJson,
          createdAt: args.now,
        });
        await ctx.db.patch(turn._id, {
          status: "canceled",
          terminalKind: "canceled",
          errorMessage: payloadJson,
          activeTokenHash: undefined,
          updatedAt: args.now,
        });
        const tokens = await ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_turnId_and_ownerId", (q) =>
            q.eq("turnId", turn.turnId).eq("ownerId", args.ownerId),
          )
          .take(TURN_TOKEN_ATTEMPT_LIMIT + 1);
        if (tokens.length > TURN_TOKEN_ATTEMPT_LIMIT) {
          throw new ConvexError("Cloud turn token authority is ambiguous.");
        }
        for (const token of tokens) await ctx.db.delete(token._id);
      }
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", row.threadId))
        .unique();
      if (
        thread &&
        thread.ownerId === args.ownerId &&
        thread.ownerGeneration === args.ownerGeneration &&
        ["waiting_for_user", "resuming"].includes(thread.status)
      ) {
        await ctx.db.patch(thread._id, {
          status: "canceled",
          errorMessage: safeMessage,
          sandboxLeaseExpiresAt: 0,
          updatedAt: args.now,
        });
      }
    }
    return null;
  },
});
