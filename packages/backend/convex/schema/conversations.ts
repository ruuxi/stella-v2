import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  channelAttachmentValidator,
  jsonValueValidator,
  optionalChannelEnvelopeValidator,
} from "../shared_validators";
import { connectorMediaRefValidator } from "../channels/connector_media_types";

/** All event `type` values written by the app (appendEvent + internal inserters).
 *
 * Subagent lifecycle events use kebab-case to match the IPC wire format
 * (`AGENT_STREAM_EVENT_TYPES`). Other events keep snake_case for historical
 * consistency with the rest of the events table. */
export const eventTypeValidator = v.union(
  v.literal("user_message"),
  v.literal("assistant_message"),
  v.literal("agent-started"),
  v.literal("agent-completed"),
  v.literal("agent-failed"),
  v.literal("agent-canceled"),
  v.literal("agent-progress"),
  v.literal("tool_request"),
  v.literal("tool_result"),
  v.literal("microcompact_boundary"),
  v.literal("remote_turn_request"),
  v.literal("screen_event"),
);

/**
 * Lifecycle marker for `remote_turn_request` events. The previous design
 * inserted separate `remote_turn_claimed` / `remote_turn_fulfilled` event
 * rows under `requestId` prefixes (`claimed:...`, `fulfilled:...`) which
 * forced the device subscription query to do two extra index lookups per
 * candidate event. Now we patch this field on the original request row so
 * readers can decide everything from a single read.
 */
export const remoteTurnRequestStateValidator = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("fulfilled"),
  /**
   * Set when the originating client (typically the mobile app) requests
   * cancellation via `cancelRemoteTurn`. The local device's remote-turn
   * bridge subscribes to a dedicated cancel query and aborts the active
   * orchestrator run; cancelled rows never flip to `claimed`/`fulfilled`.
   */
  v.literal("cancelled"),
);

export const remoteTurnOwnerBindingStateValidator = v.union(
  v.literal("bound"),
  v.literal("legacy_unbound"),
);

export const remoteTurnAttemptSourceValidator = v.union(
  v.literal("desktop"),
  v.literal("fast_rescue"),
  v.literal("orphan_watchdog"),
  v.literal("cron_watchdog"),
);

export const remoteTurnAttemptStateValidator = v.union(
  v.literal("active"),
  v.literal("cancel_requested"),
);

export const remoteTurnAttemptPhaseValidator = v.union(
  v.literal("running"),
  v.literal("completion_accepted"),
  v.literal("delivering"),
);

export const remoteTurnDispatchOutcomeValidator = v.union(
  v.literal("in_flight"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("aborted"),
  v.literal("timed_out"),
  v.literal("outcome_unknown"),
);

export const remoteTurnTerminalReasonValidator = v.union(
  v.literal("ownership_migrated"),
  v.literal("owner_data_changed"),
  v.literal("legacy_unbound"),
  v.literal("user_cancelled"),
);

export const threadStatusValidator = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("archived"),
);

export const pendingDeviceOptionValidator = v.object({
  deviceId: v.string(),
  deviceName: v.string(),
  platform: v.optional(v.string()),
});

export const pendingDeviceSelectionValidator = v.object({
  createdAt: v.number(),
  provider: v.string(),
  promptText: v.optional(v.string()),
  payloadRequestId: v.optional(v.string()),
  userMessageId: v.optional(v.id("events")),
  mediaRefs: v.optional(v.array(connectorMediaRefValidator)),
  attachments: v.optional(v.array(channelAttachmentValidator)),
  channelEnvelope: optionalChannelEnvelopeValidator,
  deliveryMeta: jsonValueValidator,
  deviceOptions: v.array(pendingDeviceOptionValidator),
});

export const conversationsSchema = {
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    activeThreadId: v.optional(v.id("threads")),
    activeTargetDeviceId: v.optional(v.string()),
    /**
     * Pointer to the conversation's pending device-selection prompt, if any.
     * The selection blob (which can carry sizable arrays of device options
     * and attachments) lives on the child `pending_device_selections` table
     * so writing/clearing the prompt doesn't rewrite — or contend with — the
     * conversation document.
     */
    pendingSelectionId: v.optional(v.id("pending_device_selections")),
    /**
     * Denormalized count of `events` rows for this conversation. Maintained by
     * `appendEventCore` so callers can read counts in O(1) without
     * paginating the events table.
     */
    eventCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_isDefault", ["ownerId", "isDefault"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  /**
   * Pending device-selection prompts split out from the `conversations`
   * document. One row per conversation that's currently waiting on a
   * device-selection reply; the row is inserted by
   * `setPendingDeviceSelection` and deleted by
   * `clearPendingDeviceSelection`. The conversation doc carries a
   * `pendingSelectionId` pointer for O(1) hydration.
   */
  pending_device_selections: defineTable({
    conversationId: v.id("conversations"),
    selection: pendingDeviceSelectionValidator,
    updatedAt: v.number(),
  }).index("by_conversationId", ["conversationId"]),

  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: eventTypeValidator,
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    /** Immutable source-owner binding for remote execution. Never recaptured. */
    ownerId: v.optional(v.string()),
    ownerGeneration: v.optional(v.string()),
    ownerBindingState: v.optional(remoteTurnOwnerBindingStateValidator),
    /**
     * Set only on `remote_turn_request` events. Initialised to `"pending"`
     * at insert time, patched to `"claimed"` when a desktop device picks
     * the request up, and patched to `"fulfilled"` once delivery succeeds.
     */
    requestState: v.optional(remoteTurnRequestStateValidator),
    /** Set only on `remote_turn_request` events once a device claims them. */
    claimedByDeviceId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    fulfilledAt: v.optional(v.number()),
    /** Set only on `remote_turn_request` events when the caller cancels. */
    cancelledAt: v.optional(v.number()),
    requestTerminalReason: v.optional(remoteTurnTerminalReasonValidator),
    /** Stable execution-attempt authority retained through cancellation debt. */
    activeAttemptId: v.optional(v.string()),
    activeAttemptSource: v.optional(remoteTurnAttemptSourceValidator),
    activeAttemptDeviceId: v.optional(v.string()),
    activeAttemptState: v.optional(remoteTurnAttemptStateValidator),
    activeAttemptPhase: v.optional(remoteTurnAttemptPhaseValidator),
    attemptStartedAt: v.optional(v.number()),
    attemptLastHeartbeatAt: v.optional(v.number()),
    attemptLeaseExpiresAt: v.optional(v.number()),
    attemptHardExpiresAt: v.optional(v.number()),
    attemptQuiescentAfterAt: v.optional(v.number()),
    attemptCleanupJobId: v.optional(v.id("_scheduled_functions")),
    attemptCancelRequestedAt: v.optional(v.number()),
    completionAttemptId: v.optional(v.string()),
    completionText: v.optional(v.string()),
    completionAcceptedAt: v.optional(v.number()),
    lastAttemptOutcome: v.optional(remoteTurnDispatchOutcomeValidator),
    lastAttemptId: v.optional(v.string()),
    lastAttemptFinishedAt: v.optional(v.number()),
    providerDispatchCount: v.optional(v.number()),
    providerDispatchOrdinal: v.optional(v.number()),
    lastProviderDispatchId: v.optional(v.string()),
    lastProviderDispatchOutcome: v.optional(remoteTurnDispatchOutcomeValidator),
    lastProviderDispatchAt: v.optional(v.number()),
    payload: jsonValueValidator,
    channelEnvelope: optionalChannelEnvelopeValidator,
  })
    .index("by_conversationId_and_timestamp", ["conversationId", "timestamp"])
    .index("by_conversationId_and_type_and_timestamp", [
      "conversationId",
      "type",
      "timestamp",
    ])
    .index("by_targetDeviceId_and_timestamp", ["targetDeviceId", "timestamp"])
    // Type-scoped device subscription queries (`subscribeRemoteTurnRequestsForDevice`
    // and friends) read by `(targetDeviceId, type, timestamp)` so adding the
    // `type` column to the index lets them stream the exact rows they need
    // instead of over-fetching by 3x and JS-filtering.
    .index("by_targetDeviceId_and_type_and_timestamp", [
      "targetDeviceId",
      "type",
      "timestamp",
    ])
    .index("by_targetDeviceId_and_type_and_requestState_and_timestamp", [
      "targetDeviceId",
      "type",
      "requestState",
      "timestamp",
    ])
    // Lets the orphan watchdog enumerate unfulfilled remote turns directly by
    // lifecycle state + age, instead of fanning a per-device index scan across
    // every registered device every minute. Rows without `requestState` (all
    // non-`remote_turn_request` events) sort under `undefined` and are never
    // matched by the `.eq("requestState", …)` lookups.
    .index("by_requestState_and_timestamp", ["requestState", "timestamp"])
    .index("by_requestState_and_attemptLeaseExpiresAt", [
      "requestState",
      "attemptLeaseExpiresAt",
    ])
    .index("by_ownerId_ownerGeneration_activeAttemptState", [
      "ownerId",
      "ownerGeneration",
      "activeAttemptState",
    ])
    .index("by_ownerId_ownerGeneration_requestState", [
      "ownerId",
      "ownerGeneration",
      "requestState",
    ])
    // Reset/account deletion rotate the owner generation at the fence, so
    // their bounded remote-turn inventory must start from the immutable owner
    // id and enumerate every pre-fence generation.
    .index("by_ownerId_requestState", ["ownerId", "requestState"])
    .index("by_ownerId_activeAttemptState", ["ownerId", "activeAttemptState"])
    // Legacy remote attempts may predate immutable owner stamping. Destructive
    // purge therefore needs a conversation-local active-attempt backstop that
    // cannot be bypassed by a missing or corrupt event ownerId.
    .index("by_conversationId_activeAttemptState", [
      "conversationId",
      "activeAttemptState",
    ])
    .index("by_conversationId_ownerBindingState_requestState", [
      "conversationId",
      "ownerBindingState",
      "requestState",
    ])
    .index("by_ownerBindingState_and_requestState", [
      "ownerBindingState",
      "requestState",
    ])
    .index("by_attemptQuiescentAfterAt", ["attemptQuiescentAfterAt"])
    .index("by_type_and_requestId", ["type", "requestId"])
    .index("by_requestId", ["requestId"]),

  attachments: defineTable({
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.id("_storage"),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_deviceId", ["deviceId"]),

  threads: defineTable({
    conversationId: v.id("conversations"),
    name: v.string(),
    status: threadStatusValidator,
    summary: v.optional(v.string()),
    messageCount: v.number(),
    totalTokenEstimate: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    resurfacedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_conversationId_and_status_and_lastUsedAt", [
      "conversationId",
      "status",
      "lastUsedAt",
    ])
    .index("by_conversationId_and_name", ["conversationId", "name"])
    .index("by_conversationId_and_lastUsedAt", ["conversationId", "lastUsedAt"])
    .index("by_status_and_lastUsedAt", ["status", "lastUsedAt"]),

  thread_messages: defineTable({
    threadId: v.id("threads"),
    ordinal: v.number(),
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
    tokenEstimate: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_threadId_and_ordinal", ["threadId", "ordinal"]),
};
