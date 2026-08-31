import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

export const executionIngressValidator = v.union(
  v.literal("desktop"),
  v.literal("mobile"),
  v.literal("browser"),
  v.literal("cloud"),
  v.literal("schedule"),
);

export const executionRequestKindValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
);

export const executionSubjectValidator = v.union(
  v.literal("portable"),
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionPlacementValidator = v.union(
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionTargetModeValidator = v.union(
  v.literal("automatic"),
  v.literal("cloud"),
  v.literal("device"),
);

export type ExecutionPlacement = Infer<typeof executionPlacementValidator>;

export const executionCapabilityValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
  v.literal("computer-use"),
  v.literal("local-files"),
  v.literal("local-apps"),
  // A build that can resolve the dispatch payload's drive-path attachments.
  // Gating on a capability rather than a protocol bump keeps a desktop that
  // predates attachments eligible for every turn that has none.
  v.literal("attachments"),
);

export const executionPresenceStatusValidator = v.union(
  v.literal("ready"),
  v.literal("draining"),
);

export const executionPresenceTransportValidator = v.literal("socket");

export const executionDispatchStateValidator = v.union(
  v.literal("queued"),
  v.literal("offering"),
  v.literal("computer_claimed"),
  v.literal("computer_accepted"),
  v.literal("computer_running"),
  v.literal("cloud_committed"),
  v.literal("cloud_running"),
  v.literal("cancel_pending"),
  v.literal("reconciliation_required"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const noEligibleComputerActionValidator = v.union(
  v.literal("cloud"),
  v.literal("blocked"),
);

export const executionOfferStatusValidator = v.union(
  v.literal("open"),
  v.literal("claimed"),
  v.literal("closed"),
);

export const executionDeviceProofOperationValidator = v.union(
  v.literal("presence-register"),
  v.literal("presence-heartbeat"),
  v.literal("presence-socket-connect"),
  v.literal("presence-drain"),
  v.literal("presence-clear"),
  v.literal("execution-submit"),
  v.literal("claim"),
  v.literal("claim-release"),
  v.literal("claim-ack"),
  v.literal("running"),
  v.literal("renew"),
  v.literal("complete"),
);

export const executionPlacementSchema = {
  /**
   * Short-lived runtime readiness. Bridge registration and tunnel health are
   * discovery signals only and are never used as execution authority.
   */
  desktop_execution_presence: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.string(),
    devicePublicKey: v.string(),
    deviceKeyFingerprint: v.string(),
    presenceSessionId: v.string(),
    protocolVersion: v.number(),
    appVersion: v.string(),
    capabilities: v.array(executionCapabilityValidator),
    status: executionPresenceStatusValidator,
    heartbeatSeq: v.number(),
    proofSeq: v.number(),
    lastProofOperation: executionDeviceProofOperationValidator,
    lastProofBodyHash: v.string(),
    chatSlotCapacity: v.number(),
    agentSlotCapacity: v.number(),
    availableChatSlots: v.number(),
    availableAgentSlots: v.number(),
    /** Absent on pre-socket clients, which continue to use the bounded lease. */
    presenceTransport: v.optional(executionPresenceTransportValidator),
    /** Exact live Worker connection. Its absence means a socket client is offline. */
    socketConnectionId: v.optional(v.string()),
    socketConnectedAt: v.optional(v.number()),
    socketLeaseExpiresAt: v.optional(v.number()),
    leaseExpiresAt: v.number(),
    purgeOperationId: v.optional(v.string()),
    purgeGeneration: v.optional(v.string()),
    /** Account-link migration that drained this transient presence proof. */
    migrationId: v.optional(v.id("auth_owner_migrations")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"])
    .index("by_ownerId_and_presenceSessionId", ["ownerId", "presenceSessionId"])
    .index("by_ownerId_and_status_and_leaseExpiresAt", [
      "ownerId",
      "status",
      "leaseExpiresAt",
    ])
    .index("by_ownerId_and_purgeOperationId", ["ownerId", "purgeOperationId"])
    .index("by_ownerId_and_migrationId", ["ownerId", "migrationId"]),

  /** Single routing/lifecycle authority for one idempotent execution. */
  execution_dispatches: defineTable({
    dispatchId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    idempotencyKey: v.string(),
    payloadHash: v.string(),
    payloadSizeBytes: v.number(),
    kind: executionRequestKindValidator,
    ingress: executionIngressValidator,
    subject: executionSubjectValidator,
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    requestingDeviceId: v.optional(v.string()),
    pairGrantDeviceId: v.optional(v.string()),
    /** User destination. Executor identity stays in targetDeviceId. */
    requestedTargetMode: v.optional(executionTargetModeValidator),
    requestedExecutorDeviceId: v.optional(v.string()),
    requiredCapabilities: v.array(executionCapabilityValidator),
    routingPolicyVersion: v.number(),
    onNoEligibleComputer: noEligibleComputerActionValidator,
    state: executionDispatchStateValidator,
    revision: v.number(),
    attemptGeneration: v.number(),
    placement: v.optional(executionPlacementValidator),
    targetDeviceId: v.optional(v.string()),
    targetPresenceSessionId: v.optional(v.string()),
    offerDeadlineAt: v.optional(v.number()),
    claimRequestId: v.optional(v.string()),
    claimTokenHash: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    terminalAt: v.optional(v.number()),
    /** Set before the first upstream cloud mutation is invoked. */
    cloudAttemptedAt: v.optional(v.number()),
    cloudAttemptId: v.optional(v.string()),
    cloudAttemptLeaseExpiresAt: v.optional(v.number()),
    cloudTurnId: v.optional(v.string()),
    fallbackReason: v.optional(v.string()),
    cancelRequestId: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    /** Destructive owner lifecycle operation that fenced this dispatch. */
    purgeOperationId: v.optional(v.string()),
    /** Purge generation is distinct from the executor's signed generation. */
    purgeGeneration: v.optional(v.string()),
    /** Final bound after which a lost executor lease is terminally reconciled. */
    purgeCancelDeadlineAt: v.optional(v.number()),
    /** Account-link operation that owns this cancellation fence. */
    migrationId: v.optional(v.id("auth_owner_migrations")),
    /** Exact owner generation captured by the account-link operation. */
    migrationOwnerGeneration: v.optional(v.string()),
    /** Final bound after which the pre-migration executor lease is retired. */
    migrationCancelDeadlineAt: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    resultJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_ownerId_and_idempotencyKey", ["ownerId", "idempotencyKey"])
    .index("by_ownerId_and_conversationId_and_createdAt", [
      "ownerId",
      "conversationId",
      "createdAt",
    ])
    .index("by_target_session_state_updated", [
      "targetDeviceId",
      "targetPresenceSessionId",
      "state",
      "updatedAt",
    ])
    .index("by_state_and_claimExpiresAt", ["state", "claimExpiresAt"])
    .index("by_state_and_offerDeadlineAt", ["state", "offerDeadlineAt"])
    .index("by_threadId_and_attemptGeneration", [
      "threadId",
      "attemptGeneration",
    ])
    .index("by_ownerId_and_state_and_updatedAt", [
      "ownerId",
      "state",
      "updatedAt",
    ])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  /** Bounded fan-out: one offer row per eligible paired runtime session. */
  execution_offers: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    deviceId: v.string(),
    presenceSessionId: v.string(),
    status: executionOfferStatusValidator,
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_deviceId_and_presenceSessionId_and_status", [
      "ownerId",
      "deviceId",
      "presenceSessionId",
      "status",
    ])
    .index("by_dispatchId_and_status", ["dispatchId", "status"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_ownerId_and_status", ["ownerId", "status"])
    .index("by_ownerId", ["ownerId"]),

  /**
   * Private short-lived payload. List/activity APIs never return this table;
   * it is deleted after durable local-inbox ack or cloud-turn persistence.
   */
  execution_dispatch_payloads: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    payloadJson: v.string(),
    payloadHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_expiresAt", ["expiresAt"]),
};
