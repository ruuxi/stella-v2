import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  assertOwnerMigrationWriteAllowed,
  assertSensitiveSessionPolicy,
  hasOwnerMigrationSourceFence,
  isAnonymousIdentity,
  requireSensitiveUserIdentity,
  requireUserIdentity,
} from "./auth";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeOperation,
} from "./owner_lifecycle";
import { constantTimeEqual, hashSha256Hex } from "./lib/crypto_utils";
import { requireBoundedString } from "./shared_validators";
import {
  executionCapabilityValidator,
  executionDeviceProofOperationValidator,
  executionDispatchStateValidator,
  executionIngressValidator,
  executionPlacementValidator,
  executionPresenceTransportValidator,
  executionRequestKindValidator,
  executionSubjectValidator,
  executionTargetModeValidator,
  noEligibleComputerActionValidator,
} from "./schema/execution_placement";
import {
  cloudExecutionSelectionValidator,
  normalizeCloudExecutionSelection,
  type CloudExecutionSelection,
} from "./lib/cloud_execution";
import { parseChatAttachmentPaths } from "./lib/chat_attachments";

export const EXECUTION_PRESENCE_LEASE_MS = 75_000;
export const EXECUTION_OFFER_WINDOW_MS = 4_000;
export const EXECUTION_CLAIM_LEASE_MS = 30_000;
export const EXECUTION_ACCEPTED_LEASE_MS = 2 * 60_000;
export const EXECUTION_PURGE_CANCEL_GRACE_MS =
  EXECUTION_ACCEPTED_LEASE_MS + EXECUTION_PRESENCE_LEASE_MS;
export const EXECUTION_PAYLOAD_TTL_MS = 15 * 60_000;
export const EXECUTION_ROUTING_POLICY_VERSION = 2;
export const EXECUTION_PROTOCOL_VERSION = 1;
export const EXECUTION_SOCKET_CONFIRMATION_LEASE_MS = 30_000;
export const EXECUTION_SOCKET_MAX_AUTH_LEASE_MS = 2 * 60 * 60_000;

const MAX_DEVICE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_APP_VERSION_LENGTH = 64;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_DISPATCH_PAYLOAD_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_REQUIRED_CAPABILITIES = 8;
const MAX_PAIRED_DESKTOP_CANDIDATES = 8;
const MAX_OFFERS_PER_DISPATCH = 8;
const MAX_ACTIVE_DISPATCHES_PER_DEVICE = 32;
const MAX_ACTIVITY_ROWS = 100;
const MAX_PURGE_ROWS_PER_STATE = 16;
const MAX_PURGE_PRESENCE_ROWS = 64;
const MAX_PURGE_OFFER_ROWS = 64;

type ExecutionIngress = "desktop" | "mobile" | "browser" | "cloud" | "schedule";
type ExecutionKind = "chat" | "agent";
type ExecutionSubject = "portable" | "computer" | "cloud";
type ExecutionTargetMode = "automatic" | "cloud" | "device";
type ExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";
type NoEligibleComputerAction = "cloud" | "blocked";
type DeviceProofOperation =
  | "presence-register"
  | "presence-heartbeat"
  | "presence-socket-connect"
  | "presence-drain"
  | "presence-clear"
  | "execution-submit"
  | "claim"
  | "claim-release"
  | "claim-ack"
  | "running"
  | "renew"
  | "complete";

const dispatchSummaryFields = {
  dispatchId: v.string(),
  idempotencyKey: v.string(),
  kind: executionRequestKindValidator,
  ingress: executionIngressValidator,
  subject: executionSubjectValidator,
  requestedTargetMode: v.optional(executionTargetModeValidator),
  requestedExecutorDeviceId: v.optional(v.string()),
  conversationId: v.string(),
  parentTurnId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  state: executionDispatchStateValidator,
  placement: v.optional(executionPlacementValidator),
  executorDeviceId: v.optional(v.string()),
  executorPresenceSessionId: v.optional(v.string()),
  revision: v.number(),
  fallbackReason: v.optional(v.string()),
  cancelRequestId: v.optional(v.string()),
  cancelReason: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  cloudTurnId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

const dispatchSummaryValidator = v.object(dispatchSummaryFields);
const dispatchStatusValidator = v.object({
  ...dispatchSummaryFields,
  resultJson: v.optional(v.string()),
  terminalAt: v.optional(v.number()),
});

const presenceResultValidator = v.object({
  ok: v.literal(true),
  ownerGeneration: v.string(),
  presenceSessionId: v.string(),
  leaseExpiresAt: v.number(),
  replayed: v.boolean(),
});

const offerSummaryValidator = v.object({
  dispatch: dispatchSummaryValidator,
  requiredCapabilities: v.array(executionCapabilityValidator),
  expiresAt: v.number(),
});

const claimedPayloadValidator = v.object({
  dispatch: dispatchSummaryValidator,
  payloadJson: v.string(),
  payloadHash: v.string(),
  claimExpiresAt: v.number(),
  replayed: v.boolean(),
});

const executionActivityValidator = v.object({
  dispatch: dispatchSummaryValidator,
  placementLabel: v.union(
    v.literal("routing"),
    v.literal("computer"),
    v.literal("cloud"),
  ),
});

const executionDestinationValidator = v.object({
  deviceId: v.string(),
  name: v.string(),
  platform: v.optional(v.string()),
  online: v.boolean(),
  ready: v.boolean(),
  busy: v.boolean(),
  remoteExecutionEnabled: v.boolean(),
  availableChatSlots: v.number(),
  availableAgentSlots: v.number(),
  updatedAt: v.optional(v.number()),
});

const projectDispatch = (row: Doc<"execution_dispatches">) => ({
  dispatchId: row.dispatchId,
  idempotencyKey: row.idempotencyKey,
  kind: row.kind,
  ingress: row.ingress,
  subject: row.subject,
  ...(row.requestedTargetMode !== undefined
    ? { requestedTargetMode: row.requestedTargetMode }
    : {}),
  ...(row.requestedExecutorDeviceId !== undefined
    ? { requestedExecutorDeviceId: row.requestedExecutorDeviceId }
    : {}),
  conversationId: row.conversationId,
  ...(row.parentTurnId !== undefined ? { parentTurnId: row.parentTurnId } : {}),
  ...(row.threadId !== undefined ? { threadId: row.threadId } : {}),
  state: row.state,
  ...(row.placement !== undefined ? { placement: row.placement } : {}),
  ...(row.targetDeviceId !== undefined
    ? { executorDeviceId: row.targetDeviceId }
    : {}),
  ...(row.targetPresenceSessionId !== undefined
    ? { executorPresenceSessionId: row.targetPresenceSessionId }
    : {}),
  revision: row.revision,
  ...(row.fallbackReason !== undefined
    ? { fallbackReason: row.fallbackReason }
    : {}),
  ...(row.cancelRequestId !== undefined
    ? { cancelRequestId: row.cancelRequestId }
    : {}),
  ...(row.cancelReason !== undefined ? { cancelReason: row.cancelReason } : {}),
  ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
  ...(row.errorMessage !== undefined ? { errorMessage: row.errorMessage } : {}),
  ...(row.cloudTurnId !== undefined ? { cloudTurnId: row.cloudTurnId } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const projectDispatchStatus = (row: Doc<"execution_dispatches">) => ({
  ...projectDispatch(row),
  ...(row.resultJson !== undefined ? { resultJson: row.resultJson } : {}),
  ...(row.terminalAt !== undefined ? { terminalAt: row.terminalAt } : {}),
});

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

function conflict(message: string): never {
  throw new ConvexError({ code: "CONFLICT", message });
}

function forbidden(message: string): never {
  throw new ConvexError({ code: "FORBIDDEN", message });
}

const requirePlacementOwner = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    forbidden("Sign in with an account to use execution placement.");
  }
  if (await hasOwnerMigrationSourceFence(ctx, identity.tokenIdentifier)) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATED",
      message:
        "This session was linked to another account. Refresh authentication and retry.",
    });
  }
  return identity.tokenIdentifier;
};

/**
 * Ordinary hosted chat supports the Better Auth anonymous owner established
 * by the server. Keep that narrow exception separate from device presence and
 * computer claims: an anonymous caller may only submit a browser/cloud chat
 * with the exact generic-chat capability.
 */
const requireBrowserPlacementOwner = async (
  ctx: MutationCtx,
  args: {
    kind: ExecutionKind;
    subject: ExecutionSubject;
    requiredCapabilities: readonly ExecutionCapability[];
  },
) => {
  const identity = await requireUserIdentity(ctx);
  if (!isAnonymousIdentity(identity)) {
    await assertSensitiveSessionPolicy(ctx, identity);
  } else {
    const capabilities = normalizeCapabilities(args.requiredCapabilities);
    if (
      args.kind !== "chat" ||
      args.subject !== "cloud" ||
      capabilities.length !== 1 ||
      capabilities[0] !== "chat"
    ) {
      forbidden(
        "Anonymous browser execution is limited to ordinary cloud chat.",
      );
    }
  }
  if (await hasOwnerMigrationSourceFence(ctx, identity.tokenIdentifier)) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATED",
      message:
        "This session was linked to another account. Refresh authentication and retry.",
    });
  }
  return identity;
};

const requireBrowserDispatchControlIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  if (isAnonymousIdentity(identity)) {
    // Anonymous hosted chat follows the ordinary owner lifecycle policy.
    await requireUserIdentity(ctx);
  } else {
    // Connected executors must still be able to read/ack cancellation after
    // the owner lifecycle write fence closes during reset/delete.
    await assertSensitiveSessionPolicy(ctx, identity);
    if (await hasOwnerMigrationSourceFence(ctx, identity.tokenIdentifier)) {
      throw new ConvexError({
        code: "OWNERSHIP_MIGRATED",
        message:
          "This session was linked to another account. Refresh authentication and retry.",
      });
    }
  }
  return identity;
};

const assertAnonymousBrowserChatDispatch = (
  identity: Awaited<ReturnType<typeof requireUserIdentity>>,
  dispatch: Doc<"execution_dispatches"> | null,
) => {
  if (!isAnonymousIdentity(identity) || !dispatch) return;
  if (
    dispatch.ownerId !== identity.tokenIdentifier ||
    dispatch.ingress !== "browser" ||
    dispatch.kind !== "chat" ||
    dispatch.subject !== "cloud" ||
    dispatch.placement !== "cloud"
  ) {
    forbidden(
      "Anonymous browser execution control is limited to ordinary cloud chat.",
    );
  }
};

/**
 * Cancellation receipts and accepted-work subscriptions must remain reachable
 * after an owner purge or account-link fence closes. This helper preserves
 * strict authentication, connected-account, and sensitive-session checks while
 * deliberately skipping only the ordinary owner-data and migration admission
 * guards. Each caller must prove the exact lifecycle operation before writing.
 */
const requirePlacementOwnerForPurgeControl = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  await assertSensitiveSessionPolicy(ctx, identity);
  if (isAnonymousIdentity(identity)) {
    forbidden("Sign in with an account to use execution placement.");
  }
  return identity.tokenIdentifier;
};

const boundedTrimmed = (value: string, name: string, maxLength: number) => {
  const trimmed = value.trim();
  if (!trimmed) invalid(`${name} is required.`);
  requireBoundedString(trimmed, name, maxLength);
  return trimmed;
};

const requireSafeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${name} must be a non-negative safe integer.`);
  }
  return value;
};

const utf8Size = (value: string) => new TextEncoder().encode(value).byteLength;

const normalizeCapabilities = (
  raw: readonly ExecutionCapability[],
): ExecutionCapability[] => {
  const unique = [...new Set(raw)].sort();
  if (unique.length > MAX_REQUIRED_CAPABILITIES) {
    invalid("Too many execution capabilities were supplied.");
  }
  return unique;
};

const normalizeSlots = (value: number, name: string) => {
  const normalized = requireSafeInteger(value, name);
  if (normalized > 16) invalid(`${name} exceeds the supported limit.`);
  return normalized;
};

const normalizeIdempotencyKey = (value: string) => {
  const normalized = boundedTrimmed(
    value,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    invalid("idempotencyKey contains unsupported characters.");
  }
  return normalized;
};

/**
 * The subject arrives on the wire, so it is a claim until this runs. Browser,
 * cloud, and schedule callers have no device behind them and may never name
 * the computer; anything else they send collapses to the hosted subject.
 */
const assertExecutionSubjectAuthority = (args: {
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
}) => {
  if (
    args.ingress === "browser" ||
    args.ingress === "cloud" ||
    args.ingress === "schedule"
  ) {
    if (args.subject !== "cloud") {
      invalid(
        "Browser, cloud, and schedule ingress may only submit hosted execution.",
      );
    }
  }
};

const normalizePayload = async (payloadJson: string, payloadHash: string) => {
  const size = utf8Size(payloadJson);
  if (size === 0 || size > MAX_DISPATCH_PAYLOAD_BYTES) {
    invalid(
      `Execution payload must be 1-${MAX_DISPATCH_PAYLOAD_BYTES} UTF-8 bytes.`,
    );
  }
  try {
    JSON.parse(payloadJson);
  } catch {
    invalid("Execution payload must be valid JSON.");
  }
  const normalizedHash = payloadHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    invalid("payloadHash must be a SHA-256 hex digest.");
  }
  const actualHash = await hashSha256Hex(payloadJson);
  if (!constantTimeEqual(actualHash, normalizedHash)) {
    conflict("Execution payload hash does not match the exact payload bytes.");
  }
  return { payloadHash: normalizedHash, payloadSizeBytes: size };
};

const decodeBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    invalid("Invalid base64 device proof material.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const exactArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const proofMessage = (args: {
  operation: DeviceProofOperation;
  ownerGeneration: string;
  deviceId: string;
  presenceSessionId: string;
  sequence: number;
  bodyHash: string;
}) =>
  JSON.stringify([
    "stella-execution-placement",
    EXECUTION_PROTOCOL_VERSION,
    args.operation,
    args.ownerGeneration,
    args.deviceId,
    args.presenceSessionId,
    args.sequence,
    args.bodyHash,
  ]);

const bodyHash = async (parts: readonly unknown[]) =>
  await hashSha256Hex(JSON.stringify(parts));

const verifyEd25519 = async (args: {
  publicKey: string;
  message: string;
  signature: string;
}) => {
  const publicKeyBytes = decodeBase64(args.publicKey);
  const signatureBytes = decodeBase64(args.signature);
  if (publicKeyBytes.byteLength > 256 || signatureBytes.byteLength !== 64) {
    invalid("Invalid Ed25519 device proof material.");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      exactArrayBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    invalid("Invalid Ed25519 device public key.");
  }
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    exactArrayBuffer(signatureBytes),
    new TextEncoder().encode(args.message),
  );
  if (!valid) forbidden("Device signature verification failed.");
};

const loadPresence = async (ctx: QueryCtx, ownerId: string, deviceId: string) =>
  await ctx.db
    .query("desktop_execution_presence")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();

const loadDispatch = async (ctx: QueryCtx, dispatchId: string) =>
  await ctx.db
    .query("execution_dispatches")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();

const loadPayload = async (ctx: QueryCtx, dispatchId: string) =>
  await ctx.db
    .query("execution_dispatch_payloads")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();

const verifyExistingDeviceProof = async (
  ctx: QueryCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    deviceId: string;
    presenceSessionId: string;
    sequence: number;
    operation: DeviceProofOperation;
    bodyHash: string;
    signature: string;
  },
) => {
  const deviceId = boundedTrimmed(
    args.deviceId,
    "deviceId",
    MAX_DEVICE_ID_LENGTH,
  );
  const presenceSessionId = boundedTrimmed(
    args.presenceSessionId,
    "presenceSessionId",
    MAX_SESSION_ID_LENGTH,
  );
  const sequence = requireSafeInteger(args.sequence, "sequence");
  const presence = await loadPresence(ctx, args.ownerId, deviceId);
  if (
    !presence ||
    presence.ownerGeneration !== args.ownerGeneration ||
    presence.presenceSessionId !== presenceSessionId
  ) {
    forbidden("Execution presence session is not current.");
  }
  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("deviceId", deviceId),
    )
    .unique();
  if (!device?.devicePublicKey) {
    forbidden("This desktop has no registered device identity key.");
  }
  const replayed =
    sequence === presence.proofSeq &&
    args.operation === presence.lastProofOperation &&
    args.bodyHash === presence.lastProofBodyHash;
  if (
    sequence < presence.proofSeq ||
    (sequence === presence.proofSeq && !replayed)
  ) {
    conflict(
      "Device proof sequence is stale or was reused with different data.",
    );
  }
  await verifyEd25519({
    publicKey: device.devicePublicKey,
    message: proofMessage({
      operation: args.operation,
      ownerGeneration: args.ownerGeneration,
      deviceId,
      presenceSessionId,
      sequence,
      bodyHash: args.bodyHash,
    }),
    signature: args.signature,
  });
  return { presence, deviceId, presenceSessionId, sequence, replayed };
};

const recordProof = async (
  ctx: MutationCtx,
  presence: Doc<"desktop_execution_presence">,
  args: {
    sequence: number;
    operation: DeviceProofOperation;
    bodyHash: string;
    now: number;
  },
) => {
  if (args.sequence > presence.proofSeq) {
    await ctx.db.patch(presence._id, {
      proofSeq: args.sequence,
      lastProofOperation: args.operation,
      lastProofBodyHash: args.bodyHash,
      updatedAt: args.now,
    });
  }
};

const releaseReservedSlot = async (
  ctx: MutationCtx,
  dispatch: Doc<"execution_dispatches">,
  now: number,
) => {
  if (!dispatch.targetDeviceId || !dispatch.targetPresenceSessionId) return;
  const presence = await loadPresence(
    ctx,
    dispatch.ownerId,
    dispatch.targetDeviceId,
  );
  if (
    !presence ||
    presence.presenceSessionId !== dispatch.targetPresenceSessionId
  ) {
    return;
  }
  if (dispatch.kind === "chat") {
    await ctx.db.patch(presence._id, {
      availableChatSlots: Math.min(
        presence.chatSlotCapacity,
        presence.availableChatSlots + 1,
      ),
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(presence._id, {
      availableAgentSlots: Math.min(
        presence.agentSlotCapacity,
        presence.availableAgentSlots + 1,
      ),
      updatedAt: now,
    });
  }
};

const closeOpenOffers = async (
  ctx: MutationCtx,
  dispatchId: string,
  claimedDeviceId: string | null,
  now: number,
) => {
  const offers = await ctx.db
    .query("execution_offers")
    .withIndex("by_dispatchId_and_status", (q) =>
      q.eq("dispatchId", dispatchId).eq("status", "open"),
    )
    .take(MAX_OFFERS_PER_DISPATCH + 1);
  if (offers.length > MAX_OFFERS_PER_DISPATCH) {
    conflict("Execution offer set exceeded its bounded invariant.");
  }
  for (const offer of offers) {
    await ctx.db.patch(offer._id, {
      status:
        claimedDeviceId !== null && offer.deviceId === claimedDeviceId
          ? "claimed"
          : "closed",
      updatedAt: now,
    });
  }
};

type PolicyDecision =
  | { kind: "commit"; placement: "computer" | "cloud"; reason: string }
  | {
      kind: "offer";
      onNoEligibleComputer: NoEligibleComputerAction;
      reason: string;
    }
  | { kind: "blocked"; reason: string };

export const decideServerExecutionPlacement = (args: {
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  targetMode?: ExecutionTargetMode;
}): PolicyDecision => {
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
    return {
      kind: "commit",
      placement: "computer",
      reason: "desktop-ingress",
    };
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

const hasCapabilities = (
  presence: Doc<"desktop_execution_presence">,
  required: readonly ExecutionCapability[],
) => required.every((capability) => presence.capabilities.includes(capability));

const presenceIsOnline = (
  presence: Doc<"desktop_execution_presence">,
  now: number,
) =>
  presence.presenceTransport === "socket"
    ? Boolean(
        presence.socketConnectionId &&
          presence.socketLeaseExpiresAt &&
          presence.socketLeaseExpiresAt > now,
      )
    : presence.leaseExpiresAt > now;

const findEligiblePairedPresence = async (
  ctx: QueryCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    mobileDeviceId: string;
    pairGrantDeviceId: string;
    kind: ExecutionKind;
    requiredCapabilities: ExecutionCapability[];
    now: number;
  },
) => {
  const pairings = await ctx.db
    .query("paired_mobile_devices")
    .withIndex("by_ownerId_and_mobileDeviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("mobileDeviceId", args.mobileDeviceId),
    )
    .order("desc")
    .take(MAX_PAIRED_DESKTOP_CANDIDATES * 2);
  const active = pairings
    .filter(
      (pairing) =>
        pairing.revokedAt === undefined &&
        pairing.desktopDeviceId === args.pairGrantDeviceId,
    )
    .slice(0, MAX_PAIRED_DESKTOP_CANDIDATES);
  const candidates: Doc<"desktop_execution_presence">[] = [];
  for (const pairing of active) {
    const presence = await loadPresence(
      ctx,
      args.ownerId,
      pairing.desktopDeviceId,
    );
    if (
      !presence ||
      presence.ownerGeneration !== args.ownerGeneration ||
      presence.status !== "ready" ||
      !presenceIsOnline(presence, args.now) ||
      presence.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
      !hasCapabilities(presence, args.requiredCapabilities)
    ) {
      continue;
    }
    const available =
      args.kind === "chat"
        ? presence.availableChatSlots
        : presence.availableAgentSlots;
    if (available <= 0) continue;
    candidates.push(presence);
  }
  return candidates;
};

const findEligibleOwnedPresence = async (
  ctx: QueryCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    deviceId: string;
    kind: ExecutionKind;
    requiredCapabilities: ExecutionCapability[];
    now: number;
  },
) => {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
    )
    .unique();
  if (!device || device.remoteExecutionEnabled === false) return [];
  const presence = await loadPresence(ctx, args.ownerId, args.deviceId);
  if (
    !presence ||
    presence.ownerGeneration !== args.ownerGeneration ||
    presence.status !== "ready" ||
    !presenceIsOnline(presence, args.now) ||
    presence.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !hasCapabilities(presence, args.requiredCapabilities)
  ) {
    return [];
  }
  const available =
    args.kind === "chat"
      ? presence.availableChatSlots
      : presence.availableAgentSlots;
  return available > 0 ? [presence] : [];
};

type SubmitDispatchArgs = {
  ownerId: string;
  ownerGeneration: string;
  idempotencyKey: string;
  payloadJson: string;
  payloadHash: string;
  kind: ExecutionKind;
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  requestingDeviceId?: string;
  pairGrantDeviceId?: string;
  requestedTargetMode?: ExecutionTargetMode;
  requestedExecutorDeviceId?: string;
  requiredCapabilities: ExecutionCapability[];
  now: number;
};

const executeCloudDispatchRef = makeFunctionReference<
  "action",
  { ownerId: string; ownerGeneration: string; dispatchId: string },
  null
>("execution_placement:executeCloudCommittedDispatchInternal");

const resolveOfferDeadlineRef = makeFunctionReference<
  "mutation",
  { ownerId: string; ownerGeneration: string; dispatchId: string; now: number },
  null
>("execution_placement:resolveOfferDeadlineInternal");

const cancelCloudDispatchRef = makeFunctionReference<
  "action",
  { ownerId: string; ownerGeneration: string; dispatchId: string },
  null
>("execution_placement:cancelCloudExecutionDispatchInternal");

const scheduleCloudDispatch = async (
  ctx: MutationCtx,
  dispatch: Pick<
    Doc<"execution_dispatches">,
    "ownerId" | "ownerGeneration" | "dispatchId"
  >,
) => {
  await ctx.scheduler.runAfter(0, executeCloudDispatchRef, {
    ownerId: dispatch.ownerId,
    ownerGeneration: dispatch.ownerGeneration,
    dispatchId: dispatch.dispatchId,
  });
};

/**
 * The one legal local-to-cloud transition. Callers must prove the local
 * executor has not acknowledged durable ownership before entering here.
 */
const resolveUnacceptedComputerDispatch = async (
  ctx: MutationCtx,
  dispatch: Doc<"execution_dispatches">,
  now: number,
  fallbackReason: string,
) => {
  if (dispatch.state !== "offering" && dispatch.state !== "computer_claimed") {
    return false;
  }
  if (dispatch.state === "computer_claimed") {
    await releaseReservedSlot(ctx, dispatch, now);
  }
  await closeOpenOffers(ctx, dispatch.dispatchId, null, now);
  const common = {
    targetDeviceId: undefined,
    targetPresenceSessionId: undefined,
    claimRequestId: undefined,
    claimTokenHash: undefined,
    claimExpiresAt: undefined,
    fallbackReason,
    revision: dispatch.revision + 1,
    updatedAt: now,
  };
  if (dispatch.onNoEligibleComputer === "cloud") {
    await ctx.db.patch(dispatch._id, {
      ...common,
      state: "cloud_committed",
      placement: "cloud",
    });
    await scheduleCloudDispatch(ctx, dispatch);
  } else {
    await ctx.db.patch(dispatch._id, {
      ...common,
      state: "failed",
      errorCode:
        dispatch.requestedTargetMode === "device"
          ? "SELECTED_DEVICE_UNAVAILABLE"
          : "COMPUTER_REQUIRED_UNAVAILABLE",
      errorMessage:
        dispatch.requestedTargetMode === "device"
          ? "The selected computer did not accept the request."
          : "No eligible paired computer durably accepted this computer-only work.",
      terminalAt: now,
    });
    const payload = await loadPayload(ctx, dispatch.dispatchId);
    if (payload) await ctx.db.delete(payload._id);
  }
  return true;
};

const submitExecutionDispatchCore = async (
  ctx: MutationCtx,
  raw: SubmitDispatchArgs,
) => {
  await assertOwnerMigrationWriteAllowed(ctx, raw.ownerId, raw.ownerGeneration);
  const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey);
  const conversationId = boundedTrimmed(
    raw.conversationId,
    "conversationId",
    256,
  );
  const subject = raw.subject;
  assertExecutionSubjectAuthority({ ingress: raw.ingress, subject });
  const parentTurnId = raw.parentTurnId?.trim() || undefined;
  const threadId = raw.threadId?.trim() || undefined;
  const requestingDeviceId = raw.requestingDeviceId?.trim() || undefined;
  const pairGrantDeviceId = raw.pairGrantDeviceId?.trim() || undefined;
  const requestedTargetMode = raw.requestedTargetMode ?? "automatic";
  const requestedExecutorDeviceId =
    raw.requestedExecutorDeviceId?.trim() || undefined;
  if (
    (requestedTargetMode === "device") !==
    Boolean(requestedExecutorDeviceId)
  ) {
    invalid("A device execution target requires exactly one device id.");
  }
  if (requestedExecutorDeviceId) {
    boundedTrimmed(
      requestedExecutorDeviceId,
      "requestedExecutorDeviceId",
      MAX_DEVICE_ID_LENGTH,
    );
  }
  const requiredCapabilities = normalizeCapabilities([
    raw.kind,
    ...raw.requiredCapabilities,
  ]);
  const normalizedPayload = await normalizePayload(
    raw.payloadJson,
    raw.payloadHash,
  );

  // A durable thread is authoritative for where its work runs. A caller may
  // repeat that placement, but cannot retarget the thread by relabelling an
  // admission payload. Local-only thread ids simply have no cloud row.
  if (threadId) {
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    if (thread) {
      if (
        thread.ownerId !== raw.ownerId ||
        thread.conversationId !== conversationId
      ) {
        forbidden("Execution thread is not owned by this conversation.");
      }
      const threadSubject: ExecutionSubject =
        thread.placement === "computer" ? "computer" : "cloud";
      if (subject !== threadSubject) {
        conflict("Execution subject does not match the durable thread.");
      }
    }
  }

  const existing = await ctx.db
    .query("execution_dispatches")
    .withIndex("by_ownerId_and_idempotencyKey", (q) =>
      q.eq("ownerId", raw.ownerId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();
  if (existing) {
    const sameRequest =
      existing.ownerGeneration === raw.ownerGeneration &&
      existing.payloadHash === normalizedPayload.payloadHash &&
      existing.kind === raw.kind &&
      existing.ingress === raw.ingress &&
      existing.subject === subject &&
      existing.conversationId === conversationId &&
      existing.parentTurnId === parentTurnId &&
      existing.threadId === threadId &&
      existing.requestingDeviceId === requestingDeviceId &&
      existing.pairGrantDeviceId === pairGrantDeviceId &&
      (existing.requestedTargetMode ?? "automatic") === requestedTargetMode &&
      existing.requestedExecutorDeviceId === requestedExecutorDeviceId &&
      JSON.stringify(existing.requiredCapabilities) ===
        JSON.stringify(requiredCapabilities);
    if (!sameRequest) {
      conflict(
        "This idempotency key was already used for different execution bytes or routing metadata.",
      );
    }
    return existing;
  }

  const conversation = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", conversationId),
    )
    .unique();
  if (
    !conversation ||
    conversation.ownerId !== raw.ownerId ||
    conversation.deletedAt !== undefined
  ) {
    forbidden("Execution conversation is not owned by this account.");
  }

  const decision = decideServerExecutionPlacement({
    ingress: raw.ingress,
    subject,
    targetMode: requestedTargetMode,
  });
  let candidates: Doc<"desktop_execution_presence">[] = [];
  if (decision.kind === "offer") {
    if (
      raw.ingress === "mobile" &&
      Boolean(requestingDeviceId) !== Boolean(pairGrantDeviceId)
    ) {
      invalid(
        "Mobile execution admission requires both sides of a verified desktop pairing.",
      );
    }
    if (
      requestedTargetMode === "device" &&
      raw.ingress === "mobile" &&
      requestedExecutorDeviceId !== pairGrantDeviceId
    ) {
      forbidden("The selected computer does not match the verified pairing.");
    }
    if (raw.ingress === "mobile" && requestingDeviceId && pairGrantDeviceId) {
      candidates = await findEligiblePairedPresence(ctx, {
        ownerId: raw.ownerId,
        ownerGeneration: raw.ownerGeneration,
        mobileDeviceId: requestingDeviceId,
        pairGrantDeviceId,
        kind: raw.kind,
        requiredCapabilities,
        now: raw.now,
      });
    } else if (
      raw.ingress === "desktop" &&
      requestedTargetMode === "device" &&
      requestedExecutorDeviceId
    ) {
      candidates = await findEligibleOwnedPresence(ctx, {
        ownerId: raw.ownerId,
        ownerGeneration: raw.ownerGeneration,
        deviceId: requestedExecutorDeviceId,
        kind: raw.kind,
        requiredCapabilities,
        now: raw.now,
      });
    }
  }

  const dispatchId = `exec:${crypto.randomUUID()}`;
  let state: Doc<"execution_dispatches">["state"];
  let placement: "computer" | "cloud" | undefined;
  let onNoEligibleComputer: NoEligibleComputerAction =
    subject === "computer" ? "blocked" : "cloud";
  let fallbackReason: string | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let terminalAt: number | undefined;
  let offerDeadlineAt: number | undefined;

  if (decision.kind === "commit") {
    placement = decision.placement;
    state =
      decision.placement === "cloud" ? "cloud_committed" : "computer_accepted";
    fallbackReason = decision.reason;
  } else if (decision.kind === "blocked") {
    state = "failed";
    fallbackReason = decision.reason;
    errorCode = "COMPUTER_REQUIRED_UNAVAILABLE";
    errorMessage =
      "This work requires a computer, but this execution surface cannot safely provide one.";
    terminalAt = raw.now;
    onNoEligibleComputer = "blocked";
  } else {
    onNoEligibleComputer = decision.onNoEligibleComputer;
    if (candidates.length > 0) {
      state = "offering";
      fallbackReason = decision.reason;
      offerDeadlineAt = raw.now + EXECUTION_OFFER_WINDOW_MS;
    } else if (decision.onNoEligibleComputer === "cloud") {
      state = "cloud_committed";
      placement = "cloud";
      fallbackReason = "no-eligible-paired-computer";
    } else {
      state = "failed";
      const explicitDevice = requestedTargetMode === "device";
      fallbackReason = explicitDevice
        ? "selected-device-unavailable"
        : "no-eligible-paired-computer";
      errorCode = explicitDevice
        ? "SELECTED_DEVICE_UNAVAILABLE"
        : "COMPUTER_REQUIRED_UNAVAILABLE";
      errorMessage = explicitDevice
        ? "The selected computer is offline, busy, or unavailable."
        : "This work requires your paired computer, but no eligible computer is reachable.";
      terminalAt = raw.now;
    }
  }

  const insert = {
    dispatchId,
    ownerId: raw.ownerId,
    ownerGeneration: raw.ownerGeneration,
    idempotencyKey,
    payloadHash: normalizedPayload.payloadHash,
    payloadSizeBytes: normalizedPayload.payloadSizeBytes,
    kind: raw.kind,
    ingress: raw.ingress,
    subject,
    conversationId,
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(requestingDeviceId ? { requestingDeviceId } : {}),
    ...(pairGrantDeviceId ? { pairGrantDeviceId } : {}),
    requestedTargetMode,
    ...(requestedExecutorDeviceId ? { requestedExecutorDeviceId } : {}),
    requiredCapabilities,
    routingPolicyVersion: EXECUTION_ROUTING_POLICY_VERSION,
    onNoEligibleComputer,
    state,
    revision: 1,
    attemptGeneration: 1,
    ...(placement ? { placement } : {}),
    ...(offerDeadlineAt !== undefined ? { offerDeadlineAt } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(terminalAt !== undefined ? { terminalAt } : {}),
    createdAt: raw.now,
    updatedAt: raw.now,
  };
  const documentId = await ctx.db.insert("execution_dispatches", insert);
  const dispatch = await ctx.db.get(documentId);
  if (!dispatch) throw new Error("Execution dispatch insert was not readable.");

  if (state !== "failed") {
    await ctx.db.insert("execution_dispatch_payloads", {
      ownerId: raw.ownerId,
      ownerGeneration: raw.ownerGeneration,
      dispatchId,
      payloadJson: raw.payloadJson,
      payloadHash: normalizedPayload.payloadHash,
      expiresAt: raw.now + EXECUTION_PAYLOAD_TTL_MS,
      createdAt: raw.now,
    });
  }

  if (state === "offering" && offerDeadlineAt !== undefined) {
    for (const candidate of candidates.slice(0, MAX_OFFERS_PER_DISPATCH)) {
      await ctx.db.insert("execution_offers", {
        ownerId: raw.ownerId,
        ownerGeneration: raw.ownerGeneration,
        dispatchId,
        deviceId: candidate.deviceId,
        presenceSessionId: candidate.presenceSessionId,
        status: "open",
        expiresAt: offerDeadlineAt,
        createdAt: raw.now,
        updatedAt: raw.now,
      });
    }
    await ctx.scheduler.runAt(offerDeadlineAt, resolveOfferDeadlineRef, {
      ownerId: raw.ownerId,
      ownerGeneration: raw.ownerGeneration,
      dispatchId,
      now: offerDeadlineAt,
    });
  } else if (state === "cloud_committed") {
    await scheduleCloudDispatch(ctx, dispatch);
  }

  return dispatch;
};

const submitArgsValidator = {
  ownerId: v.string(),
  ownerGeneration: v.string(),
  idempotencyKey: v.string(),
  payloadJson: v.string(),
  payloadHash: v.string(),
  kind: executionRequestKindValidator,
  ingress: executionIngressValidator,
  subject: executionSubjectValidator,
  conversationId: v.string(),
  parentTurnId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  requestingDeviceId: v.optional(v.string()),
  pairGrantDeviceId: v.optional(v.string()),
  requestedTargetMode: v.optional(executionTargetModeValidator),
  requestedExecutorDeviceId: v.optional(v.string()),
  requiredCapabilities: v.array(executionCapabilityValidator),
  now: v.number(),
};

export const submitExecutionDispatchInternal = internalMutation({
  args: submitArgsValidator,
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) =>
    projectDispatch(await submitExecutionDispatchCore(ctx, args)),
});

export const submitMyBrowserExecution = mutation({
  args: {
    idempotencyKey: v.string(),
    expectedOwnerGeneration: v.string(),
    payloadJson: v.string(),
    payloadHash: v.string(),
    kind: executionRequestKindValidator,
    subject: executionSubjectValidator,
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    requiredCapabilities: v.array(executionCapabilityValidator),
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const identity = await requireBrowserPlacementOwner(ctx, args);
    const ownerId = identity.tokenIdentifier;
    const { expectedOwnerGeneration, ...dispatchArgs } = args;
    const lifecycle = await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      expectedOwnerGeneration,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(args.payloadJson);
    } catch {
      invalid("Execution payload must be valid JSON.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).expectedOwnerGeneration !==
        expectedOwnerGeneration
    ) {
      conflict(
        "Browser execution payload generation does not match its admission authority.",
      );
    }
    const dispatch = await submitExecutionDispatchCore(ctx, {
      ...dispatchArgs,
      ownerId,
      ownerGeneration: lifecycle.generation,
      ingress: "browser",
      now: Date.now(),
    });
    return projectDispatch(dispatch);
  },
});

export const submitMyDesktopExecution = mutation({
  args: {
    idempotencyKey: v.string(),
    expectedOwnerGeneration: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    bodyHash: v.string(),
    signature: v.string(),
    requestedTargetMode: v.union(v.literal("cloud"), v.literal("device")),
    requestedExecutorDeviceId: v.optional(v.string()),
    payloadJson: v.string(),
    payloadHash: v.string(),
    kind: executionRequestKindValidator,
    subject: executionSubjectValidator,
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    requiredCapabilities: v.array(executionCapabilityValidator),
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    if (args.expectedOwnerGeneration !== args.ownerGeneration) {
      conflict(
        "Desktop execution proof generation does not match its payload.",
      );
    }
    const lifecycle = await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.ownerGeneration,
    );
    const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
    const normalizedPayloadHash = args.payloadHash.trim().toLowerCase();
    const conversationId = boundedTrimmed(
      args.conversationId,
      "conversationId",
      256,
    );
    const parentTurnId = args.parentTurnId?.trim() || undefined;
    const threadId = args.threadId?.trim() || undefined;
    const requestedExecutorDeviceId =
      args.requestedExecutorDeviceId?.trim() || undefined;
    if (
      (args.requestedTargetMode === "device") !==
      Boolean(requestedExecutorDeviceId)
    ) {
      invalid("A device execution target requires exactly one device id.");
    }
    if (requestedExecutorDeviceId) {
      boundedTrimmed(
        requestedExecutorDeviceId,
        "requestedExecutorDeviceId",
        MAX_DEVICE_ID_LENGTH,
      );
    }
    const requiredCapabilities = normalizeCapabilities([
      args.kind,
      ...args.requiredCapabilities,
    ]);
    const expectedBodyHash = await bodyHash([
      idempotencyKey,
      normalizedPayloadHash,
      args.kind,
      args.subject,
      conversationId,
      parentTurnId ?? null,
      threadId ?? null,
      args.requestedTargetMode,
      requestedExecutorDeviceId ?? null,
      requiredCapabilities,
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict(
        "Desktop execution proof body does not match its signed fields.",
      );
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "execution-submit",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const now = Date.now();
    if (!presenceIsOnline(proof.presence, now)) {
      forbidden("This desktop execution presence is no longer live.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(args.payloadJson);
    } catch {
      invalid("Execution payload must be valid JSON.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).expectedOwnerGeneration !==
        args.expectedOwnerGeneration
    ) {
      conflict(
        "Desktop execution payload generation does not match its admission authority.",
      );
    }
    const {
      expectedOwnerGeneration: _expectedOwnerGeneration,
      ownerGeneration: _ownerGeneration,
      deviceId: _deviceId,
      presenceSessionId: _presenceSessionId,
      sequence: _sequence,
      bodyHash: _bodyHash,
      signature: _signature,
      ...dispatchArgs
    } = args;
    const dispatch = await submitExecutionDispatchCore(ctx, {
      ...dispatchArgs,
      idempotencyKey,
      payloadHash: normalizedPayloadHash,
      conversationId,
      parentTurnId,
      threadId,
      requestedExecutorDeviceId,
      requiredCapabilities,
      ownerId,
      ownerGeneration: lifecycle.generation,
      requestingDeviceId: proof.deviceId,
      ingress: "desktop",
      now,
    });
    await recordProof(ctx, proof.presence, {
      sequence: proof.sequence,
      operation: "execution-submit",
      bodyHash: expectedBodyHash,
      now,
    });
    return projectDispatch(dispatch);
  },
});

export const getMyExecutionPlacementIdentity = query({
  args: {},
  returns: v.object({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    protocolVersion: v.number(),
    serverTime: v.number(),
    presenceSocketBaseUrl: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const ownerId = await requirePlacementOwner(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    // Coordinate rollout: a new desktop must not stop its legacy heartbeat
    // until the Worker route and Durable Object migration are deployed.
    const builderUrl =
      process.env.EXECUTION_PRESENCE_SOCKET_ENABLED === "1"
        ? process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "")
        : undefined;
    const presenceSocketBaseUrl =
      builderUrl && /^https:\/\/[^/]+$/u.test(builderUrl)
        ? `${builderUrl.replace(/^https:/u, "wss:")}/execution-devices`
        : undefined;
    return {
      ownerId,
      ownerGeneration: lifecycle.generation,
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      serverTime: Date.now(),
      ...(presenceSocketBaseUrl ? { presenceSocketBaseUrl } : {}),
    };
  },
});

export const listMyExecutionDestinations = query({
  args: {},
  returns: v.array(executionDestinationValidator),
  handler: async (ctx) => {
    const ownerId = await requirePlacementOwner(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(65);
    if (devices.length > 64) {
      conflict("Execution device list exceeded its bounded invariant.");
    }
    const now = Date.now();
    const destinations = [];
    for (const device of devices) {
      if (!device.devicePublicKey) continue;
      const presence = await loadPresence(ctx, ownerId, device.deviceId);
      const bridge = await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", device.deviceId),
        )
        .unique();
      const online = Boolean(
        presence &&
        presence.ownerGeneration === lifecycle.generation &&
        presenceIsOnline(presence, now),
      );
      const ready = Boolean(
        online &&
        presence?.status === "ready" &&
        presence.protocolVersion === EXECUTION_PROTOCOL_VERSION,
      );
      const availableChatSlots = ready
        ? (presence?.availableChatSlots ?? 0)
        : 0;
      const availableAgentSlots = ready
        ? (presence?.availableAgentSlots ?? 0)
        : 0;
      const platform = device.platform ?? bridge?.platform;
      destinations.push({
        deviceId: device.deviceId,
        name:
          device.deviceName?.trim() ||
          platform?.trim() ||
          `Computer ${device.deviceId.slice(0, 4).toUpperCase()}`,
        ...(platform?.trim() ? { platform: platform.trim() } : {}),
        online,
        ready,
        busy: online && (!ready || availableChatSlots <= 0),
        remoteExecutionEnabled: device.remoteExecutionEnabled !== false,
        availableChatSlots,
        availableAgentSlots,
        ...(presence ? { updatedAt: presence.updatedAt } : {}),
      });
    }
    return destinations.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  },
});

export const setMyExecutionDeviceRemoteEnabled = mutation({
  args: { deviceId: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const deviceId = boundedTrimmed(
      args.deviceId,
      "deviceId",
      MAX_DEVICE_ID_LENGTH,
    );
    const device = await ctx.db
      .query("devices")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", ownerId).eq("deviceId", deviceId),
      )
      .unique();
    if (!device) forbidden("Execution device not found.");
    await ctx.db.patch(device._id, { remoteExecutionEnabled: args.enabled });
    return null;
  },
});

export const registerMyExecutionPresence = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    devicePublicKey: v.string(),
    presenceSessionId: v.string(),
    protocolVersion: v.number(),
    appVersion: v.string(),
    deviceName: v.optional(v.string()),
    platform: v.optional(v.string()),
    presenceTransport: v.optional(executionPresenceTransportValidator),
    capabilities: v.array(executionCapabilityValidator),
    status: v.union(v.literal("ready"), v.literal("draining")),
    sequence: v.number(),
    chatSlotCapacity: v.number(),
    agentSlotCapacity: v.number(),
    availableChatSlots: v.number(),
    availableAgentSlots: v.number(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: presenceResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const deviceId = boundedTrimmed(
      args.deviceId,
      "deviceId",
      MAX_DEVICE_ID_LENGTH,
    );
    const presenceSessionId = boundedTrimmed(
      args.presenceSessionId,
      "presenceSessionId",
      MAX_SESSION_ID_LENGTH,
    );
    const appVersion = boundedTrimmed(
      args.appVersion,
      "appVersion",
      MAX_APP_VERSION_LENGTH,
    );
    const deviceName = args.deviceName?.trim()
      ? boundedTrimmed(args.deviceName, "deviceName", 96)
      : undefined;
    const platform = args.platform?.trim()
      ? boundedTrimmed(args.platform, "platform", 32)
      : undefined;
    if (args.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
      conflict("Desktop execution protocol version is not supported.");
    }
    const sequence = requireSafeInteger(args.sequence, "sequence");
    const capabilities = normalizeCapabilities(args.capabilities);
    const chatSlotCapacity = normalizeSlots(
      args.chatSlotCapacity,
      "chatSlotCapacity",
    );
    const agentSlotCapacity = normalizeSlots(
      args.agentSlotCapacity,
      "agentSlotCapacity",
    );
    const availableChatSlots = normalizeSlots(
      args.availableChatSlots,
      "availableChatSlots",
    );
    const availableAgentSlots = normalizeSlots(
      args.availableAgentSlots,
      "availableAgentSlots",
    );
    if (
      availableChatSlots > chatSlotCapacity ||
      availableAgentSlots > agentSlotCapacity
    ) {
      invalid("Available execution slots cannot exceed capacity.");
    }
    const devicePublicKey = boundedTrimmed(
      args.devicePublicKey,
      "devicePublicKey",
      512,
    );
    const expectedBodyHash = await bodyHash([
      devicePublicKey,
      args.protocolVersion,
      appVersion,
      capabilities,
      args.status,
      chatSlotCapacity,
      agentSlotCapacity,
      availableChatSlots,
      availableAgentSlots,
      ...(args.presenceTransport ? [args.presenceTransport] : []),
      ...(deviceName || platform ? [deviceName ?? null, platform ?? null] : []),
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Presence proof body does not match its signed fields.");
    }
    await verifyEd25519({
      publicKey: devicePublicKey,
      message: proofMessage({
        operation: "presence-register",
        ownerGeneration: args.ownerGeneration,
        deviceId,
        presenceSessionId,
        sequence,
        bodyHash: expectedBodyHash,
      }),
      signature: args.signature,
    });

    const device = await ctx.db
      .query("devices")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", ownerId).eq("deviceId", deviceId),
      )
      .unique();
    if (device?.devicePublicKey && device.devicePublicKey !== devicePublicKey) {
      conflict("This device id is already bound to another identity key.");
    }
    if (!device) {
      await ctx.db.insert("devices", {
        ownerId,
        ownerGeneration: args.ownerGeneration,
        deviceId,
        devicePublicKey,
        ...(deviceName ? { deviceName } : {}),
        ...(platform ? { platform } : {}),
      });
    } else if (
      !device.devicePublicKey ||
      device.ownerGeneration !== args.ownerGeneration ||
      (deviceName !== undefined && device.deviceName !== deviceName) ||
      (platform !== undefined && device.platform !== platform)
    ) {
      await ctx.db.patch(device._id, {
        ownerGeneration: args.ownerGeneration,
        ...(!device.devicePublicKey ? { devicePublicKey } : {}),
        ...(deviceName ? { deviceName } : {}),
        ...(platform ? { platform } : {}),
      });
    }

    const existing = await loadPresence(ctx, ownerId, deviceId);
    const replayed = Boolean(
      existing &&
      existing.ownerGeneration === args.ownerGeneration &&
      existing.presenceSessionId === presenceSessionId &&
      existing.proofSeq === sequence &&
      existing.lastProofOperation === "presence-register" &&
      existing.lastProofBodyHash === expectedBodyHash,
    );
    if (
      existing &&
      existing.presenceSessionId === presenceSessionId &&
      (sequence < existing.proofSeq ||
        (sequence === existing.proofSeq && !replayed))
    ) {
      conflict("Presence registration proof sequence is stale.");
    }
    const now = Date.now();
    const leaseExpiresAt = now + EXECUTION_PRESENCE_LEASE_MS;
    const deviceKeyFingerprint = await hashSha256Hex(devicePublicKey);
    const record = {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId,
      devicePublicKey,
      deviceKeyFingerprint,
      presenceSessionId,
      protocolVersion: args.protocolVersion,
      appVersion,
      capabilities,
      status: args.status,
      heartbeatSeq: sequence,
      proofSeq: sequence,
      lastProofOperation: "presence-register" as const,
      lastProofBodyHash: expectedBodyHash,
      chatSlotCapacity,
      agentSlotCapacity,
      availableChatSlots,
      availableAgentSlots,
      ...(args.presenceTransport
        ? { presenceTransport: args.presenceTransport }
        : {}),
      leaseExpiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, record);
    else await ctx.db.insert("desktop_execution_presence", record);
    return {
      ok: true as const,
      ownerGeneration: args.ownerGeneration,
      presenceSessionId,
      leaseExpiresAt,
      replayed,
    };
  },
});

export const heartbeatMyExecutionPresence = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    status: v.union(v.literal("ready"), v.literal("draining")),
    chatSlotCapacity: v.number(),
    agentSlotCapacity: v.number(),
    availableChatSlots: v.number(),
    availableAgentSlots: v.number(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: presenceResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const capacities = {
      chat: normalizeSlots(args.chatSlotCapacity, "chatSlotCapacity"),
      agent: normalizeSlots(args.agentSlotCapacity, "agentSlotCapacity"),
      availableChat: normalizeSlots(
        args.availableChatSlots,
        "availableChatSlots",
      ),
      availableAgent: normalizeSlots(
        args.availableAgentSlots,
        "availableAgentSlots",
      ),
    };
    if (
      capacities.availableChat > capacities.chat ||
      capacities.availableAgent > capacities.agent
    ) {
      invalid("Available execution slots cannot exceed capacity.");
    }
    const expectedBodyHash = await bodyHash([
      args.status,
      capacities.chat,
      capacities.agent,
      capacities.availableChat,
      capacities.availableAgent,
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Heartbeat proof body does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "presence-heartbeat",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const now = Date.now();
    const leaseExpiresAt =
      proof.presence.presenceTransport === "socket"
        ? proof.presence.leaseExpiresAt
        : now + EXECUTION_PRESENCE_LEASE_MS;
    if (!proof.replayed) {
      await ctx.db.patch(proof.presence._id, {
        status: args.status,
        heartbeatSeq: proof.sequence,
        proofSeq: proof.sequence,
        lastProofOperation: "presence-heartbeat",
        lastProofBodyHash: expectedBodyHash,
        chatSlotCapacity: capacities.chat,
        agentSlotCapacity: capacities.agent,
        availableChatSlots: capacities.availableChat,
        availableAgentSlots: capacities.availableAgent,
        leaseExpiresAt,
        updatedAt: now,
      });
    }
    return {
      ok: true as const,
      ownerGeneration: args.ownerGeneration,
      presenceSessionId: proof.presenceSessionId,
      leaseExpiresAt: proof.replayed
        ? proof.presence.leaseExpiresAt
        : leaseExpiresAt,
      replayed: proof.replayed,
    };
  },
});

export const connectMyExecutionPresenceSocket = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    connectionId: v.string(),
    nonce: v.string(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: v.object({ ok: v.literal(true), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const connectionId = boundedTrimmed(args.connectionId, "connectionId", 128);
    const nonce = boundedTrimmed(args.nonce, "nonce", 128);
    const expectedBodyHash = await bodyHash([connectionId, nonce]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Presence socket proof does not match its connection.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "presence-socket-connect",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    if (proof.presence.presenceTransport !== "socket") {
      conflict("This execution presence does not use socket liveness.");
    }
    const replayed =
      proof.replayed && proof.presence.socketConnectionId === connectionId;
    if (proof.replayed && !replayed) {
      conflict("The replayed socket proof no longer names this connection.");
    }
    if (!replayed) {
      const now = Date.now();
      const socketLeaseExpiresAt =
        now + EXECUTION_SOCKET_CONFIRMATION_LEASE_MS;
      await ctx.db.patch(proof.presence._id, {
        socketConnectionId: connectionId,
        socketConnectedAt: now,
        socketLeaseExpiresAt,
        proofSeq: proof.sequence,
        lastProofOperation: "presence-socket-connect",
        lastProofBodyHash: expectedBodyHash,
        updatedAt: now,
      });
      await ctx.scheduler.runAt(
        socketLeaseExpiresAt,
        disconnectExecutionPresenceSocketRef,
        {
          ownerId,
          deviceId: proof.deviceId,
          presenceSessionId: proof.presenceSessionId,
          connectionId,
          now: socketLeaseExpiresAt,
          expectedLeaseExpiresAt: socketLeaseExpiresAt,
        },
      );
    }
    return { ok: true as const, replayed };
  },
});

export const isExecutionPresenceSocketCurrentInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    connectionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const presence = await loadPresence(ctx, args.ownerId, args.deviceId);
    return Boolean(
      presence &&
        presence.presenceTransport === "socket" &&
        presence.presenceSessionId === args.presenceSessionId &&
        presence.socketConnectionId === args.connectionId &&
        presenceIsOnline(presence, Date.now()),
    );
  },
});

const disconnectExecutionPresenceSocketRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    deviceId: string;
    presenceSessionId: string;
    connectionId: string;
    now: number;
    expectedLeaseExpiresAt?: number;
  }
>("execution_placement:disconnectExecutionPresenceSocketInternal");

export const confirmExecutionPresenceSocketInternal = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    connectionId: v.string(),
    authExpiresAtMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const presence = await loadPresence(ctx, args.ownerId, args.deviceId);
    const now = Date.now();
    if (
      !presence ||
      presence.presenceTransport !== "socket" ||
      presence.presenceSessionId !== args.presenceSessionId ||
      presence.socketConnectionId !== args.connectionId ||
      !Number.isSafeInteger(args.authExpiresAtMs) ||
      args.authExpiresAtMs <= now ||
      args.authExpiresAtMs > now + EXECUTION_SOCKET_MAX_AUTH_LEASE_MS
    ) {
      return false;
    }
    await ctx.db.patch(presence._id, {
      socketLeaseExpiresAt: args.authExpiresAtMs,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      args.authExpiresAtMs,
      disconnectExecutionPresenceSocketRef,
      {
        ownerId: args.ownerId,
        deviceId: args.deviceId,
        presenceSessionId: args.presenceSessionId,
        connectionId: args.connectionId,
        now: args.authExpiresAtMs,
        expectedLeaseExpiresAt: args.authExpiresAtMs,
      },
    );
    return true;
  },
});

export const disconnectExecutionPresenceSocketInternal = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    connectionId: v.string(),
    now: v.number(),
    expectedLeaseExpiresAt: v.optional(v.number()),
  },
  returns: v.object({ disconnected: v.boolean() }),
  handler: async (ctx, args) => {
    const presence = await loadPresence(ctx, args.ownerId, args.deviceId);
    if (
      !presence ||
      presence.presenceTransport !== "socket" ||
      presence.presenceSessionId !== args.presenceSessionId ||
      presence.socketConnectionId !== args.connectionId ||
      (args.expectedLeaseExpiresAt !== undefined &&
        (presence.socketLeaseExpiresAt !== args.expectedLeaseExpiresAt ||
          args.now < args.expectedLeaseExpiresAt))
    ) {
      return { disconnected: false };
    }
    await ctx.db.patch(presence._id, {
      socketConnectionId: undefined,
      socketLeaseExpiresAt: undefined,
      updatedAt: args.now,
    });
    return { disconnected: true };
  },
});

export const drainMyExecutionPresence = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: presenceResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const expectedBodyHash = await bodyHash(["draining"]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Presence drain proof does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "presence-drain",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const now = Date.now();
    if (!proof.replayed) {
      await ctx.db.patch(proof.presence._id, {
        status: "draining",
        proofSeq: proof.sequence,
        lastProofOperation: "presence-drain",
        lastProofBodyHash: expectedBodyHash,
        updatedAt: now,
      });
    }
    return {
      ok: true as const,
      ownerGeneration: args.ownerGeneration,
      presenceSessionId: proof.presenceSessionId,
      leaseExpiresAt: proof.presence.leaseExpiresAt,
      replayed: proof.replayed,
    };
  },
});

export const clearMyExecutionPresence = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: v.object({ ok: v.literal(true), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const expectedBodyHash = await bodyHash([]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Presence clear proof does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "presence-clear",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    if (proof.replayed) return { ok: true as const, replayed: true };
    const now = Date.now();

    // A claimed-but-unacknowledged payload is still safe to reroute. Once the
    // desktop accepted it, disappearance is a reconciliation problem and can
    // never authorize an alternate executor.
    for (const state of ["computer_claimed"] as const) {
      const rows = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_target_session_state_updated", (q) =>
          q
            .eq("targetDeviceId", proof.deviceId)
            .eq("targetPresenceSessionId", proof.presenceSessionId)
            .eq("state", state),
        )
        .take(MAX_ACTIVE_DISPATCHES_PER_DEVICE);
      for (const row of rows) {
        if (row.ownerId === ownerId) {
          await resolveUnacceptedComputerDispatch(
            ctx,
            row,
            now,
            "computer-presence-cleared-before-acceptance",
          );
        }
      }
    }
    for (const state of [
      "computer_accepted",
      "computer_running",
      "cancel_pending",
    ] as const) {
      const rows = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_target_session_state_updated", (q) =>
          q
            .eq("targetDeviceId", proof.deviceId)
            .eq("targetPresenceSessionId", proof.presenceSessionId)
            .eq("state", state),
        )
        .take(MAX_ACTIVE_DISPATCHES_PER_DEVICE);
      for (const row of rows) {
        if (row.ownerId !== ownerId || row.placement !== "computer") continue;
        await ctx.db.patch(row._id, {
          state: "reconciliation_required",
          errorCode:
            state === "cancel_pending"
              ? "COMPUTER_CANCEL_RECONCILIATION_REQUIRED"
              : "COMPUTER_PRESENCE_CLEARED",
          errorMessage:
            "The accepting computer disconnected and must reconnect to report the durable execution outcome.",
          revision: row.revision + 1,
          updatedAt: now,
        });
      }
    }

    const openOffers = await ctx.db
      .query("execution_offers")
      .withIndex(
        "by_ownerId_and_deviceId_and_presenceSessionId_and_status",
        (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("deviceId", proof.deviceId)
            .eq("presenceSessionId", proof.presenceSessionId)
            .eq("status", "open"),
      )
      .take(MAX_ACTIVE_DISPATCHES_PER_DEVICE);
    for (const offer of openOffers) {
      await ctx.db.patch(offer._id, { status: "closed", updatedAt: now });
    }

    // Keep the expired record as the proof replay tombstone. A new process
    // registers a fresh presence session and replaces it after possession of
    // the same device key is proven.
    await ctx.db.patch(proof.presence._id, {
      status: "draining",
      availableChatSlots: 0,
      availableAgentSlots: 0,
      socketConnectionId: undefined,
      socketLeaseExpiresAt: undefined,
      leaseExpiresAt: now,
      proofSeq: proof.sequence,
      lastProofOperation: "presence-clear",
      lastProofBodyHash: expectedBodyHash,
      updatedAt: now,
    });
    return { ok: true as const, replayed: false };
  },
});

export const listMyExecutionOffers = query({
  args: {
    deviceId: v.string(),
    presenceSessionId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(offerSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 16), 1), 32);
    const presence = await loadPresence(ctx, ownerId, args.deviceId.trim());
    if (
      !presence ||
      presence.presenceSessionId !== args.presenceSessionId.trim()
    ) {
      return [];
    }
    const offers = await ctx.db
      .query("execution_offers")
      .withIndex(
        "by_ownerId_and_deviceId_and_presenceSessionId_and_status",
        (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("deviceId", presence.deviceId)
            .eq("presenceSessionId", presence.presenceSessionId)
            .eq("status", "open"),
      )
      .order("asc")
      .take(limit);
    const now = Date.now();
    const output: Array<{
      dispatch: ReturnType<typeof projectDispatch>;
      requiredCapabilities: ExecutionCapability[];
      expiresAt: number;
    }> = [];
    for (const offer of offers) {
      if (offer.expiresAt <= now) continue;
      const dispatch = await loadDispatch(ctx, offer.dispatchId);
      if (
        !dispatch ||
        dispatch.ownerId !== ownerId ||
        dispatch.ownerGeneration !== presence.ownerGeneration ||
        dispatch.state !== "offering"
      ) {
        continue;
      }
      output.push({
        dispatch: projectDispatch(dispatch),
        requiredCapabilities: dispatch.requiredCapabilities,
        expiresAt: offer.expiresAt,
      });
    }
    return output;
  },
});

export const claimMyExecutionOffer = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    dispatchId: v.string(),
    claimRequestId: v.string(),
    claimToken: v.string(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: claimedPayloadValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const dispatchId = boundedTrimmed(args.dispatchId, "dispatchId", 64);
    const claimRequestId = boundedTrimmed(
      args.claimRequestId,
      "claimRequestId",
      128,
    );
    const claimToken = boundedTrimmed(args.claimToken, "claimToken", 256);
    if (utf8Size(claimToken) < 32)
      invalid("claimToken lacks sufficient entropy.");
    const claimTokenHash = await hashSha256Hex(claimToken);
    const expectedBodyHash = await bodyHash([
      dispatchId,
      claimRequestId,
      claimTokenHash,
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Claim proof body does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "claim",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const dispatch = await loadDispatch(ctx, dispatchId);
    if (!dispatch || dispatch.ownerId !== ownerId) {
      forbidden("Execution dispatch was not found.");
    }
    const now = Date.now();
    const sameClaim =
      dispatch.state === "computer_claimed" &&
      dispatch.targetDeviceId === proof.deviceId &&
      dispatch.targetPresenceSessionId === proof.presenceSessionId &&
      dispatch.claimRequestId === claimRequestId &&
      dispatch.claimTokenHash === claimTokenHash;
    if (proof.replayed && !sameClaim) {
      conflict("The replayed device proof no longer names the active claim.");
    }
    if (!sameClaim) {
      if (
        dispatch.state !== "offering" ||
        dispatch.offerDeadlineAt === undefined ||
        dispatch.offerDeadlineAt <= now
      ) {
        conflict("Execution offer is no longer claimable.");
      }
      const offer = await ctx.db
        .query("execution_offers")
        .withIndex(
          "by_ownerId_and_deviceId_and_presenceSessionId_and_status",
          (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("deviceId", proof.deviceId)
              .eq("presenceSessionId", proof.presenceSessionId)
              .eq("status", "open"),
        )
        .take(MAX_ACTIVE_DISPATCHES_PER_DEVICE);
      if (!offer.some((candidate) => candidate.dispatchId === dispatchId)) {
        forbidden("This runtime session was not offered the execution.");
      }
      if (
        proof.presence.status !== "ready" ||
        !presenceIsOnline(proof.presence, now) ||
        !hasCapabilities(proof.presence, dispatch.requiredCapabilities)
      ) {
        conflict("This runtime is no longer eligible for the execution.");
      }
      const device = await ctx.db
        .query("devices")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", proof.deviceId),
        )
        .unique();
      if (!device || device.remoteExecutionEnabled === false) {
        conflict("Remote execution is disabled on this computer.");
      }
      const available =
        dispatch.kind === "chat"
          ? proof.presence.availableChatSlots
          : proof.presence.availableAgentSlots;
      if (available <= 0) conflict("This runtime has no reservable capacity.");
      await ctx.db.patch(proof.presence._id, {
        ...(dispatch.kind === "chat"
          ? { availableChatSlots: available - 1 }
          : { availableAgentSlots: available - 1 }),
        proofSeq: proof.sequence,
        lastProofOperation: "claim",
        lastProofBodyHash: expectedBodyHash,
        updatedAt: now,
      });
      await closeOpenOffers(ctx, dispatchId, proof.deviceId, now);
      await ctx.db.patch(dispatch._id, {
        state: "computer_claimed",
        targetDeviceId: proof.deviceId,
        targetPresenceSessionId: proof.presenceSessionId,
        claimRequestId,
        claimTokenHash,
        claimExpiresAt: now + EXECUTION_CLAIM_LEASE_MS,
        revision: dispatch.revision + 1,
        updatedAt: now,
      });
    }
    const current = (await loadDispatch(ctx, dispatchId))!;
    const payload = await loadPayload(ctx, dispatchId);
    if (
      !payload ||
      payload.ownerId !== ownerId ||
      payload.ownerGeneration !== args.ownerGeneration ||
      payload.payloadHash !== current.payloadHash ||
      payload.expiresAt <= now
    ) {
      conflict("Execution payload is unavailable; the claim cannot start.");
    }
    return {
      dispatch: projectDispatch(current),
      payloadJson: payload.payloadJson,
      payloadHash: payload.payloadHash,
      claimExpiresAt: current.claimExpiresAt!,
      replayed: sameClaim,
    };
  },
});

export const releaseMyExecutionClaim = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    dispatchId: v.string(),
    claimToken: v.string(),
    reason: v.string(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const dispatchId = boundedTrimmed(args.dispatchId, "dispatchId", 64);
    const reason = boundedTrimmed(args.reason, "reason", 512);
    const claimTokenHash = await hashSha256Hex(args.claimToken);
    const expectedBodyHash = await bodyHash([
      dispatchId,
      claimTokenHash,
      reason,
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Claim release proof does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "claim-release",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const dispatch = await loadDispatch(ctx, dispatchId);
    if (!dispatch || dispatch.ownerId !== ownerId)
      forbidden("Dispatch not found.");
    if (
      dispatch.targetDeviceId !== proof.deviceId ||
      dispatch.targetPresenceSessionId !== proof.presenceSessionId ||
      dispatch.claimTokenHash !== claimTokenHash
    ) {
      forbidden("Claim release is not authorized for this executor.");
    }
    if (proof.replayed) return projectDispatch(dispatch);
    if (dispatch.state !== "computer_claimed") {
      conflict("A durably accepted execution cannot be released or rerouted.");
    }
    const now = Date.now();
    await recordProof(ctx, proof.presence, {
      sequence: proof.sequence,
      operation: "claim-release",
      bodyHash: expectedBodyHash,
      now,
    });
    await resolveUnacceptedComputerDispatch(
      ctx,
      dispatch,
      now,
      `computer-claim-released:${reason.slice(0, 160)}`,
    );
    return projectDispatch((await loadDispatch(ctx, dispatchId))!);
  },
});

export const ackMyExecutionClaim = mutation({
  args: {
    ownerGeneration: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    sequence: v.number(),
    dispatchId: v.string(),
    claimToken: v.string(),
    payloadHash: v.string(),
    bodyHash: v.string(),
    signature: v.string(),
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const dispatchId = boundedTrimmed(args.dispatchId, "dispatchId", 64);
    const claimTokenHash = await hashSha256Hex(args.claimToken);
    const expectedBodyHash = await bodyHash([
      dispatchId,
      claimTokenHash,
      args.payloadHash,
    ]);
    if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
      conflict("Claim acknowledgement proof does not match its signed fields.");
    }
    const proof = await verifyExistingDeviceProof(ctx, {
      ownerId,
      ownerGeneration: args.ownerGeneration,
      deviceId: args.deviceId,
      presenceSessionId: args.presenceSessionId,
      sequence: args.sequence,
      operation: "claim-ack",
      bodyHash: expectedBodyHash,
      signature: args.signature,
    });
    const dispatch = await loadDispatch(ctx, dispatchId);
    if (!dispatch || dispatch.ownerId !== ownerId)
      forbidden("Dispatch not found.");
    const sameExecutor =
      dispatch.targetDeviceId === proof.deviceId &&
      dispatch.targetPresenceSessionId === proof.presenceSessionId &&
      dispatch.claimTokenHash === claimTokenHash &&
      dispatch.payloadHash === args.payloadHash;
    if (!sameExecutor) forbidden("Claim acknowledgement is not authorized.");
    if (
      dispatch.state === "computer_accepted" ||
      dispatch.state === "computer_running" ||
      dispatch.state === "reconciliation_required"
    ) {
      if (!proof.replayed) {
        await recordProof(ctx, proof.presence, {
          sequence: proof.sequence,
          operation: "claim-ack",
          bodyHash: expectedBodyHash,
          now: Date.now(),
        });
      }
      return projectDispatch(dispatch);
    }
    const now = Date.now();
    if (
      dispatch.state !== "computer_claimed" ||
      dispatch.claimExpiresAt === undefined ||
      dispatch.claimExpiresAt <= now
    ) {
      conflict("Claim expired before durable local acceptance.");
    }
    await ctx.db.patch(dispatch._id, {
      state: "computer_accepted",
      placement: "computer",
      acceptedAt: now,
      claimExpiresAt: now + EXECUTION_ACCEPTED_LEASE_MS,
      revision: dispatch.revision + 1,
      updatedAt: now,
    });
    await recordProof(ctx, proof.presence, {
      sequence: proof.sequence,
      operation: "claim-ack",
      bodyHash: expectedBodyHash,
      now,
    });
    const payload = await loadPayload(ctx, dispatchId);
    if (payload) await ctx.db.delete(payload._id);
    return projectDispatch((await loadDispatch(ctx, dispatchId))!);
  },
});

const signedDispatchTransitionArgs = {
  ownerGeneration: v.string(),
  deviceId: v.string(),
  presenceSessionId: v.string(),
  sequence: v.number(),
  dispatchId: v.string(),
  claimToken: v.string(),
  bodyHash: v.string(),
  signature: v.string(),
};

const verifyDispatchTokenProof = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    deviceId: string;
    presenceSessionId: string;
    sequence: number;
    dispatchId: string;
    claimToken: string;
    bodyHash: string;
    signature: string;
    operation: DeviceProofOperation;
    extraBodyParts?: readonly unknown[];
  },
) => {
  const dispatchId = boundedTrimmed(args.dispatchId, "dispatchId", 64);
  const tokenHash = await hashSha256Hex(args.claimToken);
  const expectedBodyHash = await bodyHash([
    dispatchId,
    tokenHash,
    ...(args.extraBodyParts ?? []),
  ]);
  if (!constantTimeEqual(expectedBodyHash, args.bodyHash)) {
    conflict("Device proof does not match its dispatch fields.");
  }
  const proof = await verifyExistingDeviceProof(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    deviceId: args.deviceId,
    presenceSessionId: args.presenceSessionId,
    sequence: args.sequence,
    operation: args.operation,
    bodyHash: expectedBodyHash,
    signature: args.signature,
  });
  const dispatch = await loadDispatch(ctx, dispatchId);
  if (
    !dispatch ||
    dispatch.ownerId !== args.ownerId ||
    dispatch.ownerGeneration !== args.ownerGeneration ||
    dispatch.targetDeviceId !== proof.deviceId ||
    dispatch.targetPresenceSessionId !== proof.presenceSessionId ||
    dispatch.claimTokenHash !== tokenHash
  ) {
    forbidden("Device proof does not control this execution dispatch.");
  }
  return { dispatch, proof, expectedBodyHash };
};

export const markMyExecutionRunning = mutation({
  args: signedDispatchTransitionArgs,
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const verified = await verifyDispatchTokenProof(ctx, {
      ...args,
      ownerId,
      operation: "running",
    });
    if (
      verified.dispatch.state !== "computer_accepted" &&
      verified.dispatch.state !== "computer_running" &&
      verified.dispatch.state !== "reconciliation_required"
    ) {
      conflict("Only an accepted computer execution can start.");
    }
    const now = Date.now();
    if (verified.dispatch.state !== "computer_running") {
      await ctx.db.patch(verified.dispatch._id, {
        state: "computer_running",
        startedAt: verified.dispatch.startedAt ?? now,
        claimExpiresAt: now + EXECUTION_ACCEPTED_LEASE_MS,
        revision: verified.dispatch.revision + 1,
        updatedAt: now,
      });
    }
    await recordProof(ctx, verified.proof.presence, {
      sequence: verified.proof.sequence,
      operation: "running",
      bodyHash: verified.expectedBodyHash,
      now,
    });
    return projectDispatch((await loadDispatch(ctx, args.dispatchId))!);
  },
});

export const renewMyExecutionClaim = mutation({
  args: signedDispatchTransitionArgs,
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const verified = await verifyDispatchTokenProof(ctx, {
      ...args,
      ownerId,
      operation: "renew",
    });
    if (
      verified.dispatch.state !== "computer_accepted" &&
      verified.dispatch.state !== "computer_running" &&
      verified.dispatch.state !== "cancel_pending" &&
      verified.dispatch.state !== "reconciliation_required"
    ) {
      conflict("Execution is not renewable.");
    }
    const now = Date.now();
    await ctx.db.patch(verified.dispatch._id, {
      claimExpiresAt: now + EXECUTION_ACCEPTED_LEASE_MS,
      state:
        verified.dispatch.state === "reconciliation_required"
          ? verified.dispatch.startedAt
            ? "computer_running"
            : "computer_accepted"
          : verified.dispatch.state,
      revision: verified.dispatch.revision + 1,
      updatedAt: now,
    });
    await recordProof(ctx, verified.proof.presence, {
      sequence: verified.proof.sequence,
      operation: "renew",
      bodyHash: verified.expectedBodyHash,
      now,
    });
    return projectDispatch((await loadDispatch(ctx, args.dispatchId))!);
  },
});

export const completeMyExecutionDispatch = mutation({
  args: {
    ...signedDispatchTransitionArgs,
    outcome: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    resultJson: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwnerForPurgeControl(ctx);
    if (args.resultJson && utf8Size(args.resultJson) > MAX_RESULT_BYTES) {
      invalid("Execution result exceeds the durable result limit.");
    }
    const resultHash = args.resultJson
      ? await hashSha256Hex(args.resultJson)
      : "";
    const verified = await verifyDispatchTokenProof(ctx, {
      ...args,
      ownerId,
      operation: "complete",
      extraBodyParts: [
        args.outcome,
        resultHash,
        args.errorCode ?? "",
        args.errorMessage ?? "",
      ],
    });
    const purgeCancellation =
      verified.dispatch.purgeOperationId &&
      verified.dispatch.purgeGeneration &&
      (verified.dispatch.state === "cancel_pending" ||
        verified.dispatch.state === "canceled");
    const migrationCancellation =
      verified.dispatch.migrationId &&
      verified.dispatch.migrationOwnerGeneration &&
      (verified.dispatch.state === "cancel_pending" ||
        verified.dispatch.state === "canceled");
    const cancellationOutcomeRequired =
      verified.dispatch.state === "cancel_pending" ||
      verified.dispatch.state === "canceled";
    if (
      cancellationOutcomeRequired &&
      (args.outcome !== "canceled" || args.resultJson !== undefined)
    ) {
      conflict(
        "A canceled execution accepts only a signed cancellation acknowledgement.",
      );
    }
    if (purgeCancellation) {
      await assertOwnerPurgeOperation(ctx, {
        ownerId,
        operationId: verified.dispatch.purgeOperationId!,
        generation: verified.dispatch.purgeGeneration!,
      });
    } else if (migrationCancellation) {
      await requireExecutionPlacementMigration(ctx, {
        migrationId: verified.dispatch.migrationId!,
        ownerId,
        expectedOwnerGeneration: verified.dispatch.migrationOwnerGeneration!,
      });
    } else {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        ownerId,
        args.ownerGeneration,
      );
    }
    if (
      verified.dispatch.state === "completed" ||
      verified.dispatch.state === "failed" ||
      verified.dispatch.state === "canceled"
    ) {
      if (verified.dispatch.state !== args.outcome) {
        conflict("Execution already reached a different terminal outcome.");
      }
      return projectDispatch(verified.dispatch);
    }
    if (
      verified.dispatch.state !== "computer_accepted" &&
      verified.dispatch.state !== "computer_running" &&
      verified.dispatch.state !== "cancel_pending" &&
      verified.dispatch.state !== "reconciliation_required"
    ) {
      conflict("Execution is not owned by an accepted computer claim.");
    }
    const now = Date.now();
    await ctx.db.patch(verified.dispatch._id, {
      state: args.outcome,
      terminalAt: now,
      claimExpiresAt: undefined,
      ...(args.resultJson !== undefined ? { resultJson: args.resultJson } : {}),
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      revision: verified.dispatch.revision + 1,
      updatedAt: now,
    });
    await recordProof(ctx, verified.proof.presence, {
      sequence: verified.proof.sequence,
      operation: "complete",
      bodyHash: verified.expectedBodyHash,
      now,
    });
    await releaseReservedSlot(ctx, verified.dispatch, now);
    return projectDispatch((await loadDispatch(ctx, args.dispatchId))!);
  },
});

const cancelExecutionDispatchCore = async (
  ctx: MutationCtx,
  ownerId: string,
  args: { dispatchId: string; cancelRequestId: string; reason?: string },
) => {
  const dispatch = await loadDispatch(ctx, args.dispatchId.trim());
  if (!dispatch || dispatch.ownerId !== ownerId)
    forbidden("Dispatch not found.");
  const cancelRequestId = boundedTrimmed(
    args.cancelRequestId,
    "cancelRequestId",
    128,
  );
  if (
    dispatch.cancelRequestId &&
    dispatch.cancelRequestId !== cancelRequestId
  ) {
    conflict("A different cancellation request already owns this dispatch.");
  }
  if (
    dispatch.state === "completed" ||
    dispatch.state === "failed" ||
    dispatch.state === "canceled"
  ) {
    return projectDispatch(dispatch);
  }
  const now = Date.now();
  const wasUnacceptedComputer =
    dispatch.state === "queued" ||
    dispatch.state === "offering" ||
    dispatch.state === "computer_claimed";
  const cloudNeverAttempted =
    dispatch.state === "cloud_committed" &&
    dispatch.placement === "cloud" &&
    dispatch.cloudAttemptedAt === undefined;
  const canCancelImmediately = wasUnacceptedComputer || cloudNeverAttempted;
  if (dispatch.state === "computer_claimed") {
    await releaseReservedSlot(ctx, dispatch, now);
  }
  await closeOpenOffers(ctx, dispatch.dispatchId, null, now);
  await ctx.db.patch(dispatch._id, {
    state: canCancelImmediately ? "canceled" : "cancel_pending",
    cancelRequestId,
    ...(args.reason?.trim()
      ? { cancelReason: args.reason.trim().slice(0, 512) }
      : {}),
    ...(canCancelImmediately ? { terminalAt: now } : {}),
    revision: dispatch.revision + 1,
    updatedAt: now,
  });
  if (canCancelImmediately) {
    const payload = await loadPayload(ctx, dispatch.dispatchId);
    if (payload) await ctx.db.delete(payload._id);
  } else if (dispatch.placement === "cloud") {
    await ctx.scheduler.runAfter(0, cancelCloudDispatchRef, {
      ownerId: dispatch.ownerId,
      ownerGeneration: dispatch.ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
  }
  return projectDispatch((await loadDispatch(ctx, dispatch.dispatchId))!);
};

const cancelExecutionArgs = {
  dispatchId: v.string(),
  cancelRequestId: v.string(),
  reason: v.optional(v.string()),
};

export const cancelMyExecutionDispatch = mutation({
  args: cancelExecutionArgs,
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    const identity = await requireBrowserDispatchControlIdentity(ctx);
    const ownerId = identity.tokenIdentifier;
    const dispatch = await loadDispatch(ctx, args.dispatchId.trim());
    assertAnonymousBrowserChatDispatch(
      identity,
      dispatch?.ownerId === ownerId ? dispatch : null,
    );
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    return await cancelExecutionDispatchCore(ctx, ownerId, args);
  },
});

export const cancelExecutionDispatchForOwnerInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    ...cancelExecutionArgs,
  },
  returns: dispatchSummaryValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return await cancelExecutionDispatchCore(ctx, args.ownerId, args);
  },
});

const NONTERMINAL_EXECUTION_STATES = [
  "queued",
  "offering",
  "computer_claimed",
  "computer_accepted",
  "computer_running",
  "cloud_committed",
  "cloud_running",
  "cancel_pending",
  "reconciliation_required",
] as const satisfies readonly Doc<"execution_dispatches">["state"][];

const executionPurgeQuiescenceValidator = v.object({
  ready: v.boolean(),
  pendingDispatches: v.number(),
  terminalizedDispatches: v.number(),
  cancellationSignals: v.number(),
  hasMore: v.boolean(),
  nextCheckAt: v.optional(v.number()),
});

const requireExecutionPlacementMigration = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    migrationId: Id<"auth_owner_migrations">;
    ownerId: string;
    expectedOwnerGeneration?: string;
  },
): Promise<{ ownerGeneration: string }> => {
  const migration = await ctx.db.get(args.migrationId);
  if (
    !migration ||
    (migration.status !== "pending" && migration.status !== "running")
  ) {
    conflict("Execution placement migration is no longer active.");
  }
  const ownerGeneration =
    migration.fromOwnerId === args.ownerId
      ? migration.fromOwnerGeneration
      : migration.toOwnerId === args.ownerId
        ? migration.toOwnerGeneration
        : undefined;
  if (!ownerGeneration) {
    forbidden("Execution placement owner is outside this account migration.");
  }
  if (
    args.expectedOwnerGeneration !== undefined &&
    args.expectedOwnerGeneration !== ownerGeneration
  ) {
    conflict("Execution placement migration owner generation changed.");
  }
  await assertOwnerDataWriteAllowed(ctx, args.ownerId, ownerGeneration);
  return { ownerGeneration };
};

/**
 * Quiesces automatic placement before reset/account deletion drains locator
 * rows. The owner lifecycle fence is already closed when this runs, so every
 * public claim/ack/start/renew path loses its OCC race. Accepted work keeps its
 * control, payload locator, presence proof tombstone, and claim token hash
 * until the signed desktop cancellation arrives or the bounded executor lease
 * is reconciled. This mutation deliberately deletes no placement row.
 */
export const quiesceOwnerExecutionPlacementForPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    now: v.number(),
  },
  returns: executionPurgeQuiescenceValidator,
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    // A migration source fence permanently rejects ordinary placement writes,
    // but it must not reject the exact owner-purge operation that retires the
    // source. Ownership migration already quiesces both placement owners before
    // publishing the source-deletion handoff; this purge is the authorized
    // cleanup path for any terminal residue it leaves behind.

    const stateBatches = await Promise.all(
      NONTERMINAL_EXECUTION_STATES.map(async (state) => ({
        state,
        rows: await ctx.db
          .query("execution_dispatches")
          .withIndex("by_ownerId_and_state_and_updatedAt", (q) =>
            q.eq("ownerId", args.ownerId).eq("state", state),
          )
          .take(MAX_PURGE_ROWS_PER_STATE + 1),
      })),
    );
    const hasMoreDispatches = stateBatches.some(
      ({ rows }) => rows.length > MAX_PURGE_ROWS_PER_STATE,
    );
    const dispatches = stateBatches.flatMap(({ rows }) =>
      rows.slice(0, MAX_PURGE_ROWS_PER_STATE),
    );

    let pendingDispatches = 0;
    let terminalizedDispatches = 0;
    let cancellationSignals = 0;
    let nextCheckAt: number | undefined;

    for (const dispatch of dispatches) {
      if (
        dispatch.purgeOperationId &&
        (dispatch.purgeOperationId !== args.operationId ||
          dispatch.purgeGeneration !== args.generation)
      ) {
        conflict(
          "Execution placement is fenced by another owner purge operation.",
        );
      }
      await closeOpenOffers(ctx, dispatch.dispatchId, null, args.now);

      const canCancelImmediately =
        dispatch.state === "queued" ||
        dispatch.state === "offering" ||
        dispatch.state === "computer_claimed" ||
        (dispatch.state === "cloud_committed" &&
          dispatch.cloudAttemptedAt === undefined);
      if (canCancelImmediately) {
        if (dispatch.state === "computer_claimed") {
          await releaseReservedSlot(ctx, dispatch, args.now);
        }
        await ctx.db.patch(dispatch._id, {
          state: "canceled",
          cancelRequestId:
            dispatch.cancelRequestId ??
            `purge:${args.operationId}`.slice(0, 128),
          cancelReason:
            "Canceled because this account's data is being reset or deleted.",
          purgeOperationId: args.operationId,
          purgeGeneration: args.generation,
          purgeCancelDeadlineAt: args.now,
          claimExpiresAt: undefined,
          terminalAt: args.now,
          revision: dispatch.revision + 1,
          updatedAt: args.now,
        });
        terminalizedDispatches += 1;
        continue;
      }

      const purgeCancelDeadlineAt =
        dispatch.purgeCancelDeadlineAt ??
        Math.max(
          args.now + EXECUTION_PURGE_CANCEL_GRACE_MS,
          (dispatch.claimExpiresAt ?? args.now) + EXECUTION_PRESENCE_LEASE_MS,
        );
      if (purgeCancelDeadlineAt <= args.now) {
        await ctx.db.patch(dispatch._id, {
          state: "canceled",
          cancelRequestId:
            dispatch.cancelRequestId ??
            `purge:${args.operationId}`.slice(0, 128),
          cancelReason:
            "Canceled because this account's data is being reset or deleted.",
          purgeOperationId: args.operationId,
          purgeGeneration: args.generation,
          purgeCancelDeadlineAt,
          claimExpiresAt: undefined,
          cloudAttemptId: undefined,
          cloudAttemptLeaseExpiresAt: undefined,
          errorCode: "OWNER_PURGE_CANCEL_TIMEOUT",
          errorMessage:
            "The executor lease ended while account data was being purged.",
          terminalAt: args.now,
          revision: dispatch.revision + 1,
          updatedAt: args.now,
        });
        await releaseReservedSlot(ctx, dispatch, args.now);
        terminalizedDispatches += 1;
        continue;
      }

      const firstSignal =
        dispatch.state !== "cancel_pending" ||
        dispatch.purgeOperationId !== args.operationId;
      await ctx.db.patch(dispatch._id, {
        state: "cancel_pending",
        cancelRequestId:
          dispatch.cancelRequestId ?? `purge:${args.operationId}`.slice(0, 128),
        cancelReason:
          "Canceled because this account's data is being reset or deleted.",
        purgeOperationId: args.operationId,
        purgeGeneration: args.generation,
        purgeCancelDeadlineAt,
        revision: dispatch.revision + 1,
        updatedAt: args.now,
      });
      pendingDispatches += 1;
      if (firstSignal) cancellationSignals += 1;
      nextCheckAt = Math.min(
        nextCheckAt ?? purgeCancelDeadlineAt,
        purgeCancelDeadlineAt,
      );
      if (dispatch.placement === "cloud") {
        await ctx.scheduler.runAfter(0, cancelCloudDispatchRef, {
          ownerId: dispatch.ownerId,
          ownerGeneration: dispatch.ownerGeneration,
          dispatchId: dispatch.dispatchId,
        });
      }
    }

    const openOffers = await ctx.db
      .query("execution_offers")
      .withIndex("by_ownerId_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "open"),
      )
      .take(MAX_PURGE_OFFER_ROWS + 1);
    for (const offer of openOffers.slice(0, MAX_PURGE_OFFER_ROWS)) {
      await ctx.db.patch(offer._id, {
        status: "closed",
        updatedAt: args.now,
      });
    }
    const hasMoreOffers = openOffers.length > MAX_PURGE_OFFER_ROWS;

    const presenceRows = await ctx.db
      .query("desktop_execution_presence")
      .withIndex("by_ownerId_and_purgeOperationId", (q) =>
        q.eq("ownerId", args.ownerId).eq("purgeOperationId", undefined),
      )
      .take(MAX_PURGE_PRESENCE_ROWS + 1);
    for (const presence of presenceRows.slice(0, MAX_PURGE_PRESENCE_ROWS)) {
      await ctx.db.patch(presence._id, {
        status: "draining",
        availableChatSlots: 0,
        availableAgentSlots: 0,
        socketConnectionId: undefined,
        socketLeaseExpiresAt: undefined,
        leaseExpiresAt: Math.min(presence.leaseExpiresAt, args.now),
        purgeOperationId: args.operationId,
        purgeGeneration: args.generation,
        updatedAt: args.now,
      });
    }
    const hasMorePresence = presenceRows.length > MAX_PURGE_PRESENCE_ROWS;

    const hasMore = hasMoreDispatches || hasMoreOffers || hasMorePresence;
    return {
      ready: pendingDispatches === 0 && !hasMore,
      pendingDispatches: pendingDispatches + (hasMoreDispatches ? 1 : 0),
      terminalizedDispatches,
      cancellationSignals,
      hasMore,
      ...(nextCheckAt !== undefined ? { nextCheckAt } : {}),
    };
  },
});

/**
 * Account linking fences both principals before this mutation runs. Drain the
 * transient executor authority for each exact principal without rebinding it
 * to the destination account. Accepted work remains discoverable until a
 * signed cancellation receipt arrives, the exact cloud turn is terminal, or
 * its pre-fence lease plus grace has elapsed. Deletion is owned by the
 * migration only after this mutation reports ready for both principals.
 */
export const quiesceOwnerExecutionPlacementForMigrationInternal =
  internalMutation({
    args: {
      migrationId: v.id("auth_owner_migrations"),
      ownerId: v.string(),
      now: v.number(),
    },
    returns: executionPurgeQuiescenceValidator,
    handler: async (ctx, args) => {
      const { ownerGeneration } = await requireExecutionPlacementMigration(
        ctx,
        args,
      );
      const stateBatches = await Promise.all(
        NONTERMINAL_EXECUTION_STATES.map(async (state) => ({
          state,
          rows: await ctx.db
            .query("execution_dispatches")
            .withIndex("by_ownerId_and_state_and_updatedAt", (q) =>
              q.eq("ownerId", args.ownerId).eq("state", state),
            )
            .take(MAX_PURGE_ROWS_PER_STATE + 1),
        })),
      );
      const hasMoreDispatches = stateBatches.some(
        ({ rows }) => rows.length > MAX_PURGE_ROWS_PER_STATE,
      );
      const dispatches = stateBatches.flatMap(({ rows }) =>
        rows.slice(0, MAX_PURGE_ROWS_PER_STATE),
      );

      let pendingDispatches = 0;
      let terminalizedDispatches = 0;
      let cancellationSignals = 0;
      let nextCheckAt: number | undefined;

      for (const dispatch of dispatches) {
        if (dispatch.ownerGeneration !== ownerGeneration) {
          conflict(
            "Execution placement dispatch predates the account migration generation.",
          );
        }
        if (dispatch.purgeOperationId) {
          conflict(
            "Execution placement is already fenced by an owner purge operation.",
          );
        }
        if (
          (dispatch.migrationId && dispatch.migrationId !== args.migrationId) ||
          (dispatch.migrationOwnerGeneration &&
            dispatch.migrationOwnerGeneration !== ownerGeneration)
        ) {
          conflict(
            "Execution placement is fenced by another account migration.",
          );
        }
        await closeOpenOffers(ctx, dispatch.dispatchId, null, args.now);

        const canCancelImmediately =
          dispatch.state === "queued" ||
          dispatch.state === "offering" ||
          dispatch.state === "computer_claimed" ||
          (dispatch.state === "cloud_committed" &&
            dispatch.cloudAttemptedAt === undefined);
        if (canCancelImmediately) {
          if (dispatch.state === "computer_claimed") {
            await releaseReservedSlot(ctx, dispatch, args.now);
          }
          await ctx.db.patch(dispatch._id, {
            state: "canceled",
            cancelRequestId:
              dispatch.cancelRequestId ??
              `migration:${String(args.migrationId)}`.slice(0, 128),
            cancelReason: "Canceled because this account is being linked.",
            migrationId: args.migrationId,
            migrationOwnerGeneration: ownerGeneration,
            migrationCancelDeadlineAt: args.now,
            claimExpiresAt: undefined,
            terminalAt: args.now,
            revision: dispatch.revision + 1,
            updatedAt: args.now,
          });
          terminalizedDispatches += 1;
          continue;
        }

        if (
          dispatch.state === "cancel_pending" &&
          dispatch.placement === "cloud"
        ) {
          let turn: Doc<"agent_turns"> | null = null;
          if (dispatch.cloudTurnId) {
            const exact = await ctx.db
              .query("agent_turns")
              .withIndex("by_turnId", (q) =>
                q.eq("turnId", dispatch.cloudTurnId!),
              )
              .unique();
            if (exact?.ownerId === dispatch.ownerId) turn = exact;
          }
          if (!turn) {
            const candidates = await ctx.db
              .query("agent_turns")
              .withIndex("by_ownerId_and_clientMsgId", (q) =>
                q
                  .eq("ownerId", dispatch.ownerId)
                  .eq(
                    "clientMsgId",
                    dispatch.ingress === "desktop"
                      ? dispatch.idempotencyKey
                      : dispatch.dispatchId,
                  ),
              )
              .take(2);
            turn = candidates[0] ?? null;
          }
          const terminalOutcome =
            turn?.terminalKind === "completed" || turn?.status === "completed"
              ? ("completed" as const)
              : turn?.terminalKind === "canceled" || turn?.status === "canceled"
                ? ("canceled" as const)
                : turn?.terminalKind === "failed" ||
                    turn?.terminalKind === "timeout" ||
                    turn?.status === "failed" ||
                    turn?.status === "timeout"
                  ? ("failed" as const)
                  : null;
          if (turn && terminalOutcome) {
            await ctx.db.patch(dispatch._id, {
              state: terminalOutcome,
              cloudTurnId: turn.turnId,
              ...(turn.threadId ? { threadId: turn.threadId } : {}),
              ...(turn.resultJson ? { resultJson: turn.resultJson } : {}),
              ...(terminalOutcome !== "completed"
                ? {
                    errorCode:
                      turn.terminalKind === "timeout"
                        ? "CLOUD_EXECUTION_TIMEOUT"
                        : terminalOutcome === "canceled"
                          ? "CLOUD_EXECUTION_CANCELED"
                          : "CLOUD_EXECUTION_FAILED",
                    ...(turn.errorMessage
                      ? { errorMessage: turn.errorMessage.slice(0, 2_000) }
                      : {}),
                  }
                : {}),
              migrationId: args.migrationId,
              migrationOwnerGeneration: ownerGeneration,
              cloudAttemptId: undefined,
              cloudAttemptLeaseExpiresAt: undefined,
              terminalAt: args.now,
              revision: dispatch.revision + 1,
              updatedAt: args.now,
            });
            terminalizedDispatches += 1;
            continue;
          }
        }

        const migrationCancelDeadlineAt =
          dispatch.migrationCancelDeadlineAt ??
          Math.max(
            args.now + EXECUTION_PURGE_CANCEL_GRACE_MS,
            (dispatch.claimExpiresAt ?? args.now) + EXECUTION_PRESENCE_LEASE_MS,
            (dispatch.cloudAttemptLeaseExpiresAt ?? args.now) +
              EXECUTION_PRESENCE_LEASE_MS,
          );
        if (migrationCancelDeadlineAt <= args.now) {
          await ctx.db.patch(dispatch._id, {
            state: "canceled",
            cancelRequestId:
              dispatch.cancelRequestId ??
              `migration:${String(args.migrationId)}`.slice(0, 128),
            cancelReason: "Canceled because this account is being linked.",
            migrationId: args.migrationId,
            migrationOwnerGeneration: ownerGeneration,
            migrationCancelDeadlineAt,
            claimExpiresAt: undefined,
            cloudAttemptId: undefined,
            cloudAttemptLeaseExpiresAt: undefined,
            errorCode: "OWNER_MIGRATION_CANCEL_TIMEOUT",
            errorMessage:
              "The executor lease ended while account ownership was changing.",
            terminalAt: args.now,
            revision: dispatch.revision + 1,
            updatedAt: args.now,
          });
          await releaseReservedSlot(ctx, dispatch, args.now);
          terminalizedDispatches += 1;
          continue;
        }

        const firstSignal =
          dispatch.state !== "cancel_pending" ||
          dispatch.migrationId !== args.migrationId;
        await ctx.db.patch(dispatch._id, {
          state: "cancel_pending",
          cancelRequestId:
            dispatch.cancelRequestId ??
            `migration:${String(args.migrationId)}`.slice(0, 128),
          cancelReason: "Canceled because this account is being linked.",
          migrationId: args.migrationId,
          migrationOwnerGeneration: ownerGeneration,
          migrationCancelDeadlineAt,
          revision: dispatch.revision + 1,
          updatedAt: args.now,
        });
        pendingDispatches += 1;
        if (firstSignal) cancellationSignals += 1;
        nextCheckAt = Math.min(
          nextCheckAt ?? migrationCancelDeadlineAt,
          migrationCancelDeadlineAt,
        );
        if (dispatch.placement === "cloud") {
          await ctx.scheduler.runAfter(0, cancelCloudDispatchRef, {
            ownerId: dispatch.ownerId,
            ownerGeneration: dispatch.ownerGeneration,
            dispatchId: dispatch.dispatchId,
          });
        }
      }

      const openOffers = await ctx.db
        .query("execution_offers")
        .withIndex("by_ownerId_and_status", (q) =>
          q.eq("ownerId", args.ownerId).eq("status", "open"),
        )
        .take(MAX_PURGE_OFFER_ROWS + 1);
      for (const offer of openOffers.slice(0, MAX_PURGE_OFFER_ROWS)) {
        await ctx.db.patch(offer._id, {
          status: "closed",
          updatedAt: args.now,
        });
      }
      const hasMoreOffers = openOffers.length > MAX_PURGE_OFFER_ROWS;

      const presenceRows = await ctx.db
        .query("desktop_execution_presence")
        .withIndex("by_ownerId_and_migrationId", (q) =>
          q.eq("ownerId", args.ownerId).eq("migrationId", undefined),
        )
        .take(MAX_PURGE_PRESENCE_ROWS + 1);
      for (const presence of presenceRows.slice(0, MAX_PURGE_PRESENCE_ROWS)) {
        if (presence.purgeOperationId) {
          conflict(
            "Execution presence is already fenced by an owner purge operation.",
          );
        }
        await ctx.db.patch(presence._id, {
          status: "draining",
          availableChatSlots: 0,
          availableAgentSlots: 0,
          socketConnectionId: undefined,
          socketLeaseExpiresAt: undefined,
          leaseExpiresAt: Math.min(presence.leaseExpiresAt, args.now),
          migrationId: args.migrationId,
          updatedAt: args.now,
        });
      }
      const hasMorePresence = presenceRows.length > MAX_PURGE_PRESENCE_ROWS;

      const hasMore = hasMoreDispatches || hasMoreOffers || hasMorePresence;
      return {
        ready: pendingDispatches === 0 && !hasMore,
        pendingDispatches: pendingDispatches + (hasMoreDispatches ? 1 : 0),
        terminalizedDispatches,
        cancellationSignals,
        hasMore,
        ...(nextCheckAt !== undefined ? { nextCheckAt } : {}),
      };
    },
  });

const findCloudTurnForDispatch = async (
  ctx: QueryCtx,
  dispatch: Doc<"execution_dispatches">,
): Promise<Doc<"agent_turns"> | null> => {
  if (dispatch.cloudTurnId) {
    const exact = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", dispatch.cloudTurnId!))
      .unique();
    if (exact?.ownerId === dispatch.ownerId) return exact;
  }
  const candidates = await ctx.db
    .query("agent_turns")
    .withIndex("by_ownerId_and_clientMsgId", (q) =>
      q
        .eq("ownerId", dispatch.ownerId)
        .eq(
          "clientMsgId",
          dispatch.ingress === "desktop"
            ? dispatch.idempotencyKey
            : dispatch.dispatchId,
        ),
    )
    .take(2);
  return candidates[0] ?? null;
};

const cloudTurnTerminalOutcome = (
  turn: Doc<"agent_turns"> | null,
): "completed" | "failed" | "canceled" | null => {
  if (!turn) return null;
  if (turn.terminalKind === "completed" || turn.status === "completed") {
    return "completed";
  }
  if (turn.terminalKind === "canceled" || turn.status === "canceled") {
    return "canceled";
  }
  if (
    turn.terminalKind === "failed" ||
    turn.terminalKind === "timeout" ||
    turn.status === "failed" ||
    turn.status === "timeout"
  ) {
    return "failed";
  }
  return null;
};

const projectLiveDispatchStatus = async (
  ctx: QueryCtx,
  dispatch: Doc<"execution_dispatches">,
) => {
  const stored = projectDispatchStatus(dispatch);
  if (
    dispatch.placement !== "cloud" ||
    (dispatch.state !== "cloud_committed" &&
      dispatch.state !== "cloud_running" &&
      dispatch.state !== "cancel_pending")
  ) {
    return stored;
  }
  const turn = await findCloudTurnForDispatch(ctx, dispatch);
  if (!turn) return stored;
  const outcome = cloudTurnTerminalOutcome(turn);
  if (!outcome) {
    return dispatch.state === "cloud_committed"
      ? {
          ...stored,
          state: "cloud_running" as const,
          cloudTurnId: turn.turnId,
          ...(turn.threadId ? { threadId: turn.threadId } : {}),
        }
      : stored;
  }
  return {
    ...stored,
    state: outcome,
    cloudTurnId: turn.turnId,
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(turn.resultJson ? { resultJson: turn.resultJson } : {}),
    ...(outcome !== "completed"
      ? {
          errorCode:
            turn.terminalKind === "timeout"
              ? "CLOUD_EXECUTION_TIMEOUT"
              : outcome === "canceled"
                ? "CLOUD_EXECUTION_CANCELED"
                : "CLOUD_EXECUTION_FAILED",
          ...(turn.errorMessage
            ? { errorMessage: turn.errorMessage.slice(0, 2_000) }
            : {}),
        }
      : {}),
    terminalAt: turn.updatedAt,
  };
};

export const getExecutionDispatchStatusForOwnerInternal = internalQuery({
  args: { ownerId: v.string(), dispatchId: v.string() },
  returns: v.union(dispatchStatusValidator, v.null()),
  handler: async (ctx, args) => {
    if (await hasOwnerMigrationSourceFence(ctx, args.ownerId)) {
      throw new ConvexError({
        code: "OWNERSHIP_MIGRATED",
        message:
          "This session was linked to another account. Refresh authentication and retry.",
      });
    }
    const dispatch = await loadDispatch(ctx, args.dispatchId.trim());
    return dispatch && dispatch.ownerId === args.ownerId
      ? await projectLiveDispatchStatus(ctx, dispatch)
      : null;
  },
});

export const getMyExecutionDispatchStatus = query({
  args: { dispatchId: v.string() },
  returns: v.union(dispatchStatusValidator, v.null()),
  handler: async (ctx, args) => {
    const identity = await requireBrowserDispatchControlIdentity(ctx);
    const ownerId = identity.tokenIdentifier;
    const dispatch = await loadDispatch(ctx, args.dispatchId.trim());
    const ownedDispatch = dispatch?.ownerId === ownerId ? dispatch : null;
    assertAnonymousBrowserChatDispatch(identity, ownedDispatch);
    return ownedDispatch
      ? await projectLiveDispatchStatus(ctx, ownedDispatch)
      : null;
  },
});

export const listMyAcceptedExecutionDispatches = query({
  args: {
    deviceId: v.string(),
    presenceSessionId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(dispatchSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwnerForPurgeControl(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 32), 1), 64);
    const states = [
      "computer_accepted",
      "computer_running",
      "cancel_pending",
      "reconciliation_required",
    ] as const;
    const rows: Doc<"execution_dispatches">[] = [];
    for (const state of states) {
      const stateRows = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_target_session_state_updated", (q) =>
          q
            .eq("targetDeviceId", args.deviceId.trim())
            .eq("targetPresenceSessionId", args.presenceSessionId.trim())
            .eq("state", state),
        )
        .order("desc")
        .take(limit);
      rows.push(...stateRows.filter((row) => row.ownerId === ownerId));
    }
    return rows
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(projectDispatch);
  },
});

export const listMyExecutionActivity = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(executionActivityValidator),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 50), 1),
      MAX_ACTIVITY_ROWS,
    );
    const rows = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(limit);
    return rows.map((row) => ({
      dispatch: projectDispatch(row),
      placementLabel: (row.placement ?? "routing") as
        "routing" | "computer" | "cloud",
    }));
  },
});

const cloudCancellationInputValidator = v.union(
  v.null(),
  v.object({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    cancelRequestId: v.string(),
    attemptId: v.optional(v.string()),
    attemptGeneration: v.number(),
    kind: executionRequestKindValidator,
    conversationId: v.string(),
    threadId: v.optional(v.string()),
    turnId: v.optional(v.string()),
  }),
);

export const getCloudCancellationInputInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
  },
  returns: cloudCancellationInputValidator,
  handler: async (ctx, args) => {
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration ||
      dispatch.state !== "cancel_pending" ||
      dispatch.placement !== "cloud"
    ) {
      return null;
    }
    let turn: Doc<"agent_turns"> | null = null;
    if (dispatch.cloudTurnId) {
      turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", dispatch.cloudTurnId!))
        .unique();
    }
    if (!turn) {
      const candidates = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq(
              "clientMsgId",
              dispatch.ingress === "desktop"
                ? dispatch.idempotencyKey
                : dispatch.dispatchId,
            ),
        )
        .take(2);
      turn = candidates[0] ?? null;
    }
    return {
      ownerId: dispatch.ownerId,
      ownerGeneration: dispatch.ownerGeneration,
      dispatchId: dispatch.dispatchId,
      cancelRequestId:
        dispatch.cancelRequestId ??
        `cancel:${dispatch.dispatchId}`.slice(0, 128),
      ...(dispatch.cloudAttemptId
        ? { attemptId: dispatch.cloudAttemptId }
        : {}),
      attemptGeneration: dispatch.attemptGeneration,
      kind: dispatch.kind,
      conversationId: dispatch.conversationId,
      ...((turn?.threadId ?? dispatch.threadId)
        ? { threadId: turn?.threadId ?? dispatch.threadId }
        : {}),
      ...(turn?.turnId ? { turnId: turn.turnId } : {}),
    };
  },
});

const getCloudCancellationRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; dispatchId: string },
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    cancelRequestId: string;
    attemptId?: string;
    attemptGeneration: number;
    kind: ExecutionKind;
    conversationId: string;
    threadId?: string;
    turnId?: string;
  } | null
>("execution_placement:getCloudCancellationInputInternal");

const resolveCanceledCloudAdmissionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId?: string;
    attemptGeneration: number;
    now: number;
  },
  | null
  | { status: "canceled" }
  | {
      status: "turn";
      kind: ExecutionKind;
      conversationId: string;
      threadId?: string;
      turnId: string;
      attemptGeneration?: number;
    }
>("cloud_apps:resolveCanceledExecutionPlacementAdmissionInternal");

const cancelCloudAgentTurnForPlacementRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    turnId: string;
    attemptGeneration: number;
    controlRequestId: string;
    now: number;
  },
  { canceled: boolean; status: string }
>("cloud_apps:cancelCloudAgentTurnInternal");

export const cancelCloudExecutionDispatchInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(getCloudCancellationRef, args);
    if (!input) return null;
    const resolution = await ctx.runMutation(resolveCanceledCloudAdmissionRef, {
      ...args,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      attemptGeneration: input.attemptGeneration,
      now: Date.now(),
    });
    if (!resolution || resolution.status === "canceled") return null;
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim().replace(
      /\/+$/,
      "",
    );
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !builderSecret) return null;
    // The resolver serialized this cancellation against admission: there is a
    // stable turn to cancel, or it already terminalized a no-turn dispatch.
    if (
      resolution.kind === "agent" &&
      (!resolution.threadId ||
        !resolution.turnId ||
        !Number.isSafeInteger(resolution.attemptGeneration) ||
        resolution.attemptGeneration! < 1)
    ) {
      return null;
    }
    const path =
      resolution.kind === "agent"
        ? `/sessions/${encodeURIComponent(resolution.threadId!)}/cancel`
        : `/conversations/${encodeURIComponent(resolution.conversationId)}/cancel`;
    try {
      const response = await fetch(`${builderUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${builderSecret}`,
          "content-type": "application/json",
        },
        body:
          resolution.kind === "agent"
            ? JSON.stringify({
                ownerId: input.ownerId,
                ownerGeneration: input.ownerGeneration,
                turnId: resolution.turnId,
                attemptGeneration: resolution.attemptGeneration,
                cancelRequestId: input.cancelRequestId,
                reason: "Canceled by the user.",
              })
            : JSON.stringify({
                ownerId: input.ownerId,
                ownerGeneration: input.ownerGeneration,
                turnId: resolution.turnId,
                cancelRequestId: input.cancelRequestId,
              }),
      });
      if (!response.ok && response.status !== 404) {
        console.warn("execution-placement cloud cancellation deferred", {
          dispatchId: input.dispatchId,
          status: response.status,
        });
      } else if (
        response.ok &&
        resolution.kind === "agent" &&
        resolution.threadId
      ) {
        const committed = await ctx.runMutation(
          cancelCloudAgentTurnForPlacementRef,
          {
            ownerId: input.ownerId,
            ownerGeneration: input.ownerGeneration,
            threadId: resolution.threadId,
            turnId: resolution.turnId,
            attemptGeneration: resolution.attemptGeneration!,
            controlRequestId: input.cancelRequestId,
            now: Date.now(),
          },
        );
        if (!committed.canceled) {
          console.warn("execution-placement cloud cancellation deferred", {
            dispatchId: input.dispatchId,
            status: "agent_cancel_commit_conflict",
          });
        }
      }
    } catch (error) {
      console.warn("execution-placement cloud cancellation deferred", {
        dispatchId: input.dispatchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

export const resolveOfferDeadlineInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration
    ) {
      return null;
    }
    if (dispatch.state === "computer_claimed") {
      if (
        dispatch.claimExpiresAt !== undefined &&
        dispatch.claimExpiresAt > args.now
      ) {
        await ctx.scheduler.runAt(
          dispatch.claimExpiresAt,
          resolveOfferDeadlineRef,
          {
            ...args,
            now: dispatch.claimExpiresAt,
          },
        );
        return null;
      }
    } else if (dispatch.state !== "offering") {
      return null;
    }

    await resolveUnacceptedComputerDispatch(
      ctx,
      dispatch,
      args.now,
      "computer-offer-expired-unaccepted",
    );
    return null;
  },
});

const cloudExecutionInputValidator = v.union(
  v.null(),
  v.object({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    idempotencyKey: v.string(),
    attemptGeneration: v.number(),
    kind: executionRequestKindValidator,
    ingress: executionIngressValidator,
    subject: executionSubjectValidator,
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    requiredCapabilities: v.array(executionCapabilityValidator),
    payloadJson: v.string(),
  }),
);

export const getCloudExecutionInputInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
  },
  returns: cloudExecutionInputValidator,
  handler: async (ctx, args) => {
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration ||
      dispatch.state !== "cloud_committed" ||
      dispatch.placement !== "cloud"
    ) {
      return null;
    }
    const payload = await loadPayload(ctx, dispatch.dispatchId);
    if (
      !payload ||
      payload.ownerId !== args.ownerId ||
      payload.ownerGeneration !== args.ownerGeneration ||
      payload.payloadHash !== dispatch.payloadHash ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }
    return {
      ownerId: dispatch.ownerId,
      ownerGeneration: dispatch.ownerGeneration,
      dispatchId: dispatch.dispatchId,
      idempotencyKey: dispatch.idempotencyKey,
      attemptGeneration: dispatch.attemptGeneration,
      kind: dispatch.kind,
      ingress: dispatch.ingress,
      subject: dispatch.subject,
      conversationId: dispatch.conversationId,
      ...(dispatch.parentTurnId ? { parentTurnId: dispatch.parentTurnId } : {}),
      ...(dispatch.threadId ? { threadId: dispatch.threadId } : {}),
      requiredCapabilities: dispatch.requiredCapabilities,
      payloadJson: payload.payloadJson,
    };
  },
});

const startCloudChatRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    prompt: string;
    source: string;
    attachments?: string[];
    clientMsgId: string;
    placementAttempt: {
      dispatchId: string;
      attemptId: string;
      attemptGeneration: number;
    };
    now: number;
  },
  { conversationId: string; turnId: string }
>("cloud_apps:startCloudChatTurnInternal");

const startCloudComposerRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    prompt: string;
    locale?: string;
    attachments?: string[];
    execution?: CloudExecutionSelection;
    clientMsgId: string;
    placementAttempt: {
      dispatchId: string;
      attemptId: string;
      attemptGeneration: number;
    };
    now: number;
  },
  { conversationId: string; appId?: string; turnId: string }
>("cloud_apps:startCloudComposerTurnInternal");

const spawnCloudAgentRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    parentTurnId?: string;
    description: string;
    prompt: string;
    threadId?: string;
    source: string;
    clientMsgId: string;
    placementAttempt: {
      dispatchId: string;
      attemptId: string;
      attemptGeneration: number;
    };
    now: number;
  },
  { ok: boolean; threadId?: string; turnId?: string; error?: string }
>("cloud_apps:spawnCloudAgentInternal");

const markCloudStartedRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId: string;
    attemptGeneration: number;
    cloudTurnId: string;
    threadId?: string;
    now: number;
  },
  null
>("execution_placement:markCloudExecutionStartedInternal");

const markCloudFailedRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId: string;
    attemptGeneration: number;
    errorCode: string;
    errorMessage: string;
    now: number;
  },
  null
>("execution_placement:markCloudExecutionFailedInternal");

const markCloudAttemptedRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId: string;
    expectedAttemptGeneration: number;
    now: number;
  },
  boolean
>("execution_placement:markCloudExecutionAttemptedInternal");

const getCloudInputRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; dispatchId: string },
  {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    idempotencyKey: string;
    attemptGeneration: number;
    kind: ExecutionKind;
    ingress: ExecutionIngress;
    subject: ExecutionSubject;
    conversationId: string;
    parentTurnId?: string;
    threadId?: string;
    requiredCapabilities: ExecutionCapability[];
    payloadJson: string;
  } | null
>("execution_placement:getCloudExecutionInputInternal");

type CloudExecutionInput = {
  ownerId: string;
  ownerGeneration: string;
  dispatchId: string;
  idempotencyKey: string;
  attemptGeneration: number;
  kind: ExecutionKind;
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  requiredCapabilities: ExecutionCapability[];
  payloadJson: string;
};

/**
 * "attachments" is a capability the cloud sandbox has by construction — the
 * drive it hydrates from is the same drive the reference names — so it names a
 * requirement a computer may lack, never one that makes a turn cloud-ineligible.
 */
const CLOUD_PROVIDED_CAPABILITIES: ReadonlySet<ExecutionCapability> = new Set([
  "chat",
  "agent",
  "attachments",
]);

const cloudUnsupportedDeviceCapabilities = (
  input: CloudExecutionInput,
): ExecutionCapability[] =>
  input.requiredCapabilities.filter(
    (capability) => !CLOUD_PROVIDED_CAPABILITIES.has(capability),
  );

const cloudPlacementSource = (input: CloudExecutionInput): string =>
  ["execution-placement", input.ingress, input.subject].join(":");

const parseCloudExecutionSelection = (
  value: unknown,
): CloudExecutionSelection | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Cloud execution selection is invalid.");
  }
  const record = value as Record<string, unknown>;
  const engines = new Set(["stella", "anthropic", "openai-codex"]);
  const efforts = new Set([
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  if (
    typeof record.engine !== "string" ||
    !engines.has(record.engine) ||
    typeof record.provider !== "string" ||
    !engines.has(record.provider) ||
    typeof record.model !== "string" ||
    typeof record.reasoningEffort !== "string" ||
    !efforts.has(record.reasoningEffort)
  ) {
    invalid("Cloud execution selection is invalid.");
  }
  return normalizeCloudExecutionSelection({
    engine: record.engine as CloudExecutionSelection["engine"],
    provider: record.provider as CloudExecutionSelection["provider"],
    model: record.model,
    reasoningEffort:
      record.reasoningEffort as CloudExecutionSelection["reasoningEffort"],
  });
};

type CloudPayloadRejection = { errorCode: string; errorMessage: string };

type CloudPayloadOutcome =
  | { ok: true; payload: ReturnType<typeof parseCloudPayload> }
  | ({ ok: false } & CloudPayloadRejection);

/**
 * The payload is frozen behind its own hash, so a replay parses the same bytes
 * to the same verdict. A rejection is therefore terminal and must not reach
 * the reconcile path, which exists for start calls whose outcome is unknown.
 */
const readCloudPayload = (input: CloudExecutionInput): CloudPayloadOutcome => {
  try {
    return { ok: true, payload: parseCloudPayload(input) };
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    const data =
      typeof error.data === "object" && error.data !== null
        ? (error.data as { code?: unknown; message?: unknown })
        : {};
    if (data.code !== "INVALID_ARGUMENT" && data.code !== "CONFLICT") {
      throw error;
    }
    return {
      ok: false,
      errorCode:
        data.code === "CONFLICT"
          ? "CLOUD_PAYLOAD_CONFLICT"
          : "CLOUD_PAYLOAD_INVALID",
      errorMessage:
        typeof data.message === "string"
          ? data.message
          : "Cloud execution payload is invalid.",
    };
  }
};

const parseCloudPayload = (input: CloudExecutionInput) => {
  const parsed = JSON.parse(input.payloadJson) as Record<string, unknown>;
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (!prompt || prompt.length > 8_000) {
    invalid("Cloud execution payload needs a prompt of 1-8,000 characters.");
  }
  if (input.kind === "chat") {
    if (
      parsed.conversationId !== undefined &&
      parsed.conversationId !== input.conversationId
    ) {
      conflict("Cloud chat payload conversation does not match its dispatch.");
    }
    if (
      parsed.clientMsgId !== undefined &&
      parsed.clientMsgId !== input.idempotencyKey
    ) {
      conflict("Cloud chat payload client id does not match its dispatch.");
    }
    const locale =
      parsed.locale === null || parsed.locale === undefined
        ? undefined
        : typeof parsed.locale === "string" && parsed.locale.length <= 64
          ? parsed.locale
          : invalid("Cloud chat locale is invalid.");
    // Strict, not truncating: the payload hash covers this exact array, so a
    // quietly shortened one executes a materially different request than the
    // one the user sent and the one the fence signed.
    const parsedAttachments = parseChatAttachmentPaths(parsed.attachments);
    if (!parsedAttachments.ok) invalid(parsedAttachments.message);
    const attachments = parsedAttachments.paths;
    const execution = parseCloudExecutionSelection(parsed.execution);
    return {
      prompt,
      ...(locale ? { locale } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(execution ? { execution } : {}),
    };
  }
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!description || description.length > 1_000) {
    invalid("Cloud agent payload needs a bounded description.");
  }
  return { prompt, description };
};

export const executeCloudCommittedDispatchInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx: ActionCtx, args): Promise<null> => {
    const input = await ctx.runQuery(getCloudInputRef, args);
    if (!input) return null;
    const attemptId = crypto.randomUUID();
    const attemptGeneration = input.attemptGeneration + 1;
    const ownsAttempt = await ctx.runMutation(markCloudAttemptedRef, {
      ...args,
      attemptId,
      expectedAttemptGeneration: input.attemptGeneration,
      now: Date.now(),
    });
    if (!ownsAttempt) return null;
    try {
      const unsupportedCapabilities = cloudUnsupportedDeviceCapabilities(input);
      if (unsupportedCapabilities.length > 0) {
        await ctx.runMutation(markCloudFailedRef, {
          ...args,
          attemptId,
          attemptGeneration,
          errorCode: "CLOUD_CAPABILITY_UNAVAILABLE",
          errorMessage: `The cloud sandbox cannot provide the required device capability: ${unsupportedCapabilities.join(
            ", ",
          )}.`,
          now: Date.now(),
        });
        return null;
      }
      const outcome = readCloudPayload(input);
      if (!outcome.ok) {
        await ctx.runMutation(markCloudFailedRef, {
          ...args,
          attemptId,
          attemptGeneration,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          now: Date.now(),
        });
        return null;
      }
      const payload = outcome.payload;
      if (input.kind === "chat") {
        const chatPayload = payload as {
          prompt: string;
          locale?: string;
          attachments?: string[];
          execution?: CloudExecutionSelection;
        };
        const result = await ctx.runMutation(
          input.ingress === "browser"
            ? startCloudComposerRef
            : startCloudChatRef,
          {
            ownerId: input.ownerId,
            ownerGeneration: input.ownerGeneration,
            conversationId: input.conversationId,
            prompt: chatPayload.prompt,
            ...(chatPayload.attachments
              ? { attachments: chatPayload.attachments }
              : {}),
            ...(input.ingress === "browser"
              ? {
                  ...(chatPayload.locale ? { locale: chatPayload.locale } : {}),
                  ...(chatPayload.execution
                    ? { execution: chatPayload.execution }
                    : {}),
                }
              : { source: cloudPlacementSource(input) }),
            clientMsgId:
              input.ingress === "desktop"
                ? input.idempotencyKey
                : input.dispatchId,
            placementAttempt: {
              dispatchId: input.dispatchId,
              attemptId,
              attemptGeneration,
            },
            now: Date.now(),
          },
        );
        await ctx.runMutation(markCloudStartedRef, {
          ...args,
          attemptId,
          attemptGeneration,
          cloudTurnId: result.turnId,
          now: Date.now(),
        });
        return null;
      }
      const agentPayload = payload as { prompt: string; description: string };
      const result = await ctx.runMutation(spawnCloudAgentRef, {
        ownerId: input.ownerId,
        ownerGeneration: input.ownerGeneration,
        conversationId: input.conversationId,
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
        description: agentPayload.description,
        prompt: agentPayload.prompt,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        source: "execution-placement",
        clientMsgId: input.dispatchId,
        placementAttempt: {
          dispatchId: input.dispatchId,
          attemptId,
          attemptGeneration,
        },
        now: Date.now(),
      });
      if (!result.ok || !result.turnId) {
        await ctx.runMutation(markCloudFailedRef, {
          ...args,
          attemptId,
          attemptGeneration,
          errorCode: "CLOUD_ADMISSION_FAILED",
          errorMessage: result.error ?? "Cloud agent admission failed.",
          now: Date.now(),
        });
        return null;
      }
      await ctx.runMutation(markCloudStartedRef, {
        ...args,
        attemptId,
        attemptGeneration,
        cloudTurnId: result.turnId,
        ...(result.threadId ? { threadId: result.threadId } : {}),
        now: Date.now(),
      });
      return null;
    } catch (error) {
      // Do not guess that an ambiguous transport failure means cloud did not
      // start. The dispatch stays cloud_committed and is safe to reconcile by
      // replaying its stable clientMsgId.
      console.error("execution-placement cloud dispatch needs reconciliation", {
        dispatchId: args.dispatchId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
});

export const markCloudExecutionAttemptedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    expectedAttemptGeneration: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration ||
      dispatch.state !== "cloud_committed" ||
      dispatch.placement !== "cloud" ||
      dispatch.attemptGeneration !== args.expectedAttemptGeneration
    ) {
      return false;
    }
    if (
      dispatch.cloudAttemptLeaseExpiresAt !== undefined &&
      dispatch.cloudAttemptLeaseExpiresAt > args.now &&
      dispatch.cloudAttemptId !== args.attemptId
    ) {
      return false;
    }
    await ctx.db.patch(dispatch._id, {
      cloudAttemptedAt: dispatch.cloudAttemptedAt ?? args.now,
      cloudAttemptId: args.attemptId,
      cloudAttemptLeaseExpiresAt: args.now + 30_000,
      attemptGeneration: dispatch.attemptGeneration + 1,
      revision: dispatch.revision + 1,
      updatedAt: args.now,
    });
    return true;
  },
});

export const markCloudExecutionStartedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    attemptGeneration: v.number(),
    cloudTurnId: v.string(),
    threadId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration ||
      dispatch.cloudAttemptId !== args.attemptId ||
      dispatch.attemptGeneration !== args.attemptGeneration
    ) {
      return null;
    }
    if (dispatch.state === "cloud_running") {
      if (dispatch.cloudTurnId !== args.cloudTurnId) {
        conflict("Cloud dispatch replay resolved to a different turn.");
      }
      return null;
    }
    if (
      dispatch.state !== "cloud_committed" ||
      dispatch.placement !== "cloud"
    ) {
      return null;
    }
    await ctx.db.patch(dispatch._id, {
      state: "cloud_running",
      cloudTurnId: args.cloudTurnId,
      cloudAttemptId: undefined,
      cloudAttemptLeaseExpiresAt: undefined,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      startedAt: args.now,
      revision: dispatch.revision + 1,
      updatedAt: args.now,
    });
    const payload = await loadPayload(ctx, args.dispatchId);
    if (payload) await ctx.db.delete(payload._id);
    return null;
  },
});

export const markCloudExecutionFailedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    attemptGeneration: v.number(),
    errorCode: v.string(),
    errorMessage: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const dispatch = await loadDispatch(ctx, args.dispatchId);
    if (
      !dispatch ||
      dispatch.ownerId !== args.ownerId ||
      dispatch.ownerGeneration !== args.ownerGeneration ||
      dispatch.state !== "cloud_committed" ||
      dispatch.placement !== "cloud" ||
      dispatch.cloudAttemptId !== args.attemptId ||
      dispatch.attemptGeneration !== args.attemptGeneration
    ) {
      return null;
    }
    await ctx.db.patch(dispatch._id, {
      state: "failed",
      cloudAttemptId: undefined,
      cloudAttemptLeaseExpiresAt: undefined,
      errorCode: args.errorCode.slice(0, 128),
      errorMessage: args.errorMessage.slice(0, 2_000),
      terminalAt: args.now,
      revision: dispatch.revision + 1,
      updatedAt: args.now,
    });
    const payload = await loadPayload(ctx, args.dispatchId);
    if (payload) await ctx.db.delete(payload._id);
    return null;
  },
});

export const reconcileExecutionPlacementInternal = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    expiredOffers: v.number(),
    computerReconciliation: v.number(),
    cloudRetries: v.number(),
    cloudTerminals: v.number(),
    cloudCancellations: v.number(),
    expiredPayloads: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    let expiredOffers = 0;
    let computerReconciliation = 0;
    let cloudRetries = 0;
    let cloudTerminals = 0;
    let cloudCancellations = 0;
    let expiredPayloads = 0;

    const expiredOffering = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_state_and_offerDeadlineAt", (q) =>
        q.eq("state", "offering").lte("offerDeadlineAt", now),
      )
      .take(25);
    const expiredClaims = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_state_and_claimExpiresAt", (q) =>
        q.eq("state", "computer_claimed").lte("claimExpiresAt", now),
      )
      .take(25);
    for (const expired of [expiredOffering, expiredClaims]) {
      for (const dispatch of expired) {
        await assertOwnerMigrationWriteAllowed(
          ctx,
          dispatch.ownerId,
          dispatch.ownerGeneration,
        );
        await ctx.scheduler.runAfter(0, resolveOfferDeadlineRef, {
          ownerId: dispatch.ownerId,
          ownerGeneration: dispatch.ownerGeneration,
          dispatchId: dispatch.dispatchId,
          now,
        });
        expiredOffers += 1;
      }
    }

    for (const state of ["computer_accepted", "computer_running"] as const) {
      const expired = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_state_and_claimExpiresAt", (q) =>
          q.eq("state", state).lte("claimExpiresAt", now),
        )
        .take(25);
      for (const dispatch of expired) {
        await assertOwnerMigrationWriteAllowed(
          ctx,
          dispatch.ownerId,
          dispatch.ownerGeneration,
        );
        await ctx.db.patch(dispatch._id, {
          state: "reconciliation_required",
          errorCode: "COMPUTER_LEASE_EXPIRED",
          errorMessage:
            "The accepted computer execution must reconnect to resume or report its terminal result.",
          revision: dispatch.revision + 1,
          updatedAt: now,
        });
        computerReconciliation += 1;
      }
    }

    const cloud = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_state_and_claimExpiresAt", (q) =>
        q.eq("state", "cloud_committed"),
      )
      .take(25);
    for (const dispatch of cloud) {
      if (dispatch.updatedAt > now - 30_000) continue;
      await assertOwnerMigrationWriteAllowed(
        ctx,
        dispatch.ownerId,
        dispatch.ownerGeneration,
      );
      await scheduleCloudDispatch(ctx, dispatch);
      cloudRetries += 1;
    }

    const cloudRunning = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_state_and_claimExpiresAt", (q) =>
        q.eq("state", "cloud_running"),
      )
      .take(50);
    const cloudCancelPending = await ctx.db
      .query("execution_dispatches")
      .withIndex("by_state_and_claimExpiresAt", (q) =>
        q.eq("state", "cancel_pending"),
      )
      .take(50);
    for (const dispatch of [...cloudRunning, ...cloudCancelPending]) {
      if (dispatch.placement !== "cloud") continue;
      const turn = await findCloudTurnForDispatch(ctx, dispatch);
      const terminalKind = turn?.terminalKind;
      const outcome = cloudTurnTerminalOutcome(turn);
      if (outcome) {
        await assertOwnerMigrationWriteAllowed(
          ctx,
          dispatch.ownerId,
          dispatch.ownerGeneration,
        );
        await ctx.db.patch(dispatch._id, {
          state: outcome,
          cloudTurnId: turn!.turnId,
          ...(turn!.threadId ? { threadId: turn!.threadId } : {}),
          ...(turn!.resultJson ? { resultJson: turn!.resultJson } : {}),
          ...(outcome !== "completed"
            ? {
                errorCode:
                  terminalKind === "timeout"
                    ? "CLOUD_EXECUTION_TIMEOUT"
                    : outcome === "canceled"
                      ? "CLOUD_EXECUTION_CANCELED"
                      : "CLOUD_EXECUTION_FAILED",
                ...(turn!.errorMessage
                  ? { errorMessage: turn!.errorMessage.slice(0, 2_000) }
                  : {}),
              }
            : {}),
          cloudAttemptId: undefined,
          cloudAttemptLeaseExpiresAt: undefined,
          terminalAt: now,
          revision: dispatch.revision + 1,
          updatedAt: now,
        });
        cloudTerminals += 1;
        continue;
      }
      if (dispatch.state === "cancel_pending") {
        // Absence is not proof that an attempted cloud mutation did not
        // commit. Keep retrying the idempotent lookup/cancel path until the
        // cloud turn itself reports a terminal outcome.
        await assertOwnerMigrationWriteAllowed(
          ctx,
          dispatch.ownerId,
          dispatch.ownerGeneration,
        );
        await ctx.scheduler.runAfter(0, cancelCloudDispatchRef, {
          ownerId: dispatch.ownerId,
          ownerGeneration: dispatch.ownerGeneration,
          dispatchId: dispatch.dispatchId,
        });
        cloudCancellations += 1;
      }
    }

    const payloads = await ctx.db
      .query("execution_dispatch_payloads")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(50);
    for (const payload of payloads) {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        payload.ownerId,
        payload.ownerGeneration,
      );
      await ctx.db.delete(payload._id);
      const dispatch = await loadDispatch(ctx, payload.dispatchId);
      if (
        dispatch &&
        (dispatch.state === "queued" ||
          dispatch.state === "offering" ||
          dispatch.state === "computer_claimed" ||
          dispatch.state === "cloud_committed")
      ) {
        if (dispatch.state === "computer_claimed") {
          await releaseReservedSlot(ctx, dispatch, now);
        }
        await ctx.db.patch(dispatch._id, {
          state: "failed",
          errorCode: "EXECUTION_PAYLOAD_EXPIRED",
          errorMessage:
            "Execution expired before an executor durably accepted it.",
          terminalAt: now,
          revision: dispatch.revision + 1,
          updatedAt: now,
        });
      }
      expiredPayloads += 1;
    }
    return {
      expiredOffers,
      computerReconciliation,
      cloudRetries,
      cloudTerminals,
      cloudCancellations,
      expiredPayloads,
    };
  },
});
