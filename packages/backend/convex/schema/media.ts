import { defineTable } from "convex/server";
import { v, type VLiteral } from "convex/values";
import {
  MEDIA_BILLING_UNITS,
  MEDIA_METERED_FROM_VALUES,
  type MediaBillingUnit,
  type MediaMeteredFrom,
  jsonObjectValidator,
  jsonValueValidator,
  optionalJsonValueValidator,
} from "../shared_validators";

export const mediaJobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("unknown"),
);

/** Every physical provider request that can spend media budget or return data. */
export const mediaProviderDispatchKindValidator = v.union(
  v.literal("fal_submit"),
  v.literal("fal_poll"),
  v.literal("fal_download"),
  v.literal("google_lyria"),
  v.literal("openrouter"),
);

export const mediaBillingDispositionStateValidator = v.union(
  v.literal("pending"),
  v.literal("billed"),
  v.literal("not_chargeable"),
  v.literal("unknown"),
);

export const mediaJobErrorValidator = v.object({
  message: v.string(),
  code: v.optional(v.string()),
  details: optionalJsonValueValidator,
});

export const mediaRequestSourceSummaryValidator = v.object({
  kind: v.union(
    v.literal("url"),
    v.literal("data_uri"),
    v.literal("base64_object"),
  ),
  mimeType: v.optional(v.string()),
  url: v.optional(v.string()),
});

export const mediaRequestSummaryValidator = v.object({
  prompt: v.optional(v.string()),
  aspectRatio: v.optional(v.string()),
  source: v.optional(mediaRequestSourceSummaryValidator),
  sources: v.optional(v.record(v.string(), mediaRequestSourceSummaryValidator)),
  input: v.optional(jsonObjectValidator),
});

export const mediaJobSubscriptionValidator = v.object({
  query: v.string(),
  args: jsonObjectValidator,
});

const billingUnitValidator = v.union(
  ...(MEDIA_BILLING_UNITS.map((u) => v.literal(u)) as [
    VLiteral<MediaBillingUnit>,
    VLiteral<MediaBillingUnit>,
    ...VLiteral<MediaBillingUnit>[],
  ]),
);

const meteredFromValidator = v.union(
  ...(MEDIA_METERED_FROM_VALUES.map((u) => v.literal(u)) as [
    VLiteral<MediaMeteredFrom>,
    VLiteral<MediaMeteredFrom>,
    ...VLiteral<MediaMeteredFrom>[],
  ]),
);

export const mediaJobBillingValidator = v.object({
  endpointId: v.string(),
  billingUnit: billingUnitValidator,
  unitPriceUsd: v.number(),
  quantity: v.number(),
  costMicroCents: v.number(),
  meteredFrom: meteredFromValidator,
  note: v.optional(v.string()),
});

export const mediaJobResponseValidator = v.object({
  jobId: v.string(),
  capability: v.string(),
  request: mediaRequestSummaryValidator,
  status: mediaJobStatusValidator,
  upstreamStatus: v.string(),
  queuePosition: v.union(v.number(), v.null()),
  logs: v.optional(v.array(jsonValueValidator)),
  output: optionalJsonValueValidator,
  error: v.optional(mediaJobErrorValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

export const mediaSchema = {
  media_jobs: defineTable({
    ownerId: v.string(),
    /** Captured at reservation and carried through provider completion. */
    ownerGeneration: v.optional(v.string()),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(
      v.literal("fal"),
      v.literal("google_lyria"),
      v.literal("openrouter"),
    ),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    /**
     * Opt-in owner-scoped identity supplied through Idempotency-Key. Only
     * clients that need durable retry/reattachment (currently image_gen) set
     * this; existing Media Studio/video/audio/3D behavior is unchanged.
     */
    clientRequestKey: v.optional(v.string()),
    /** Hash of the exact request body. Reusing a key with another payload is
     * rejected instead of silently attaching to the wrong generation. */
    clientRequestHash: v.optional(v.string()),
    /**
     * Durable image_gen submission outbox. New encrypted payloads live in the
     * owner-scoped manifest/chunk tables below; submissionPayloadStorageId is
     * retained only to read and clean legacy Convex file-storage rows.
     */
    submissionState: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("dispatching"),
        v.literal("submitted"),
        v.literal("unknown"),
        v.literal("failed"),
        v.literal("canceled"),
      ),
    ),
    submissionPayloadStorageId: v.optional(v.id("_storage")),
    /** Transactionally tracked replacement for new managed image payloads. */
    submissionPayloadManifestId: v.optional(v.string()),
    submissionAttemptId: v.optional(v.string()),
    submissionClaimedAt: v.optional(v.number()),
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
    /** Durable accounting authority/disposition for paid provider work. */
    billingDispositionState: v.optional(mediaBillingDispositionStateValidator),
    billingDispositionPolicy: v.optional(v.string()),
    billingDispositionReason: v.optional(v.string()),
    billingDispositionUpdatedAt: v.optional(v.number()),
    /** First exact attempt that changed the job from exempt to paid-pending. */
    billingDispositionAttemptId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerGatewayRequestId: v.optional(v.string()),
    providerResponseUrl: v.optional(v.string()),
    providerStatusUrl: v.optional(v.string()),
    status: mediaJobStatusValidator,
    upstreamStatus: v.string(),
    queuePosition: v.union(v.number(), v.null()),
    output: optionalJsonValueValidator,
    error: v.optional(mediaJobErrorValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    /**
     * Set when the connector-media delivery has been scheduled (in the
     * same mutation that calls `ctx.scheduler.runAfter(deliverMediaJobToConnector)`).
     * Acts as the dedup gate against duplicate `markGenerated` / `applyFalWebhook`
     * invocations for the same job — once set, subsequent terminal-success
     * patches skip re-scheduling.
     */
    connectorMediaDeliveryScheduledAt: v.optional(v.number()),
    /**
     * Set by `deliverMediaJobToConnector` *after* the connector POST
     * succeeded. A `scheduledAt && !deliveredAt && error` triple is the
     * signal that a delivery attempt was made but failed; recovery is
     * via manual re-trigger or a future watchdog.
     */
    connectorMediaDeliveredAt: v.optional(v.number()),
    /** Last delivery error message, if the most recent attempt failed. */
    connectorMediaDeliveryError: v.optional(v.string()),
    connectorMediaDeliveryAttempts: v.optional(v.number()),
    connectorMediaDeliveryAbandonedAt: v.optional(v.number()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"])
    .index("by_ownerId_and_clientRequestKey", ["ownerId", "clientRequestKey"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    // The desktop materializer subscribes via `listSucceededSince`, which
    // wants succeeded jobs in completion order. Adding `(status, completedAt)`
    // as a compound index lets that query return only succeeded rows
    // directly, rather than over-fetching `(ownerId, createdAt)` and JS
    // filtering by `status === "succeeded"`.
    .index("by_ownerId_and_status_and_completedAt", [
      "ownerId",
      "status",
      "completedAt",
    ])
    .index("by_status_and_capability_and_updatedAt", [
      "status",
      "capability",
      "updatedAt",
    ])
    .index("by_status_and_connectorMediaDeliveryScheduledAt", [
      "status",
      "connectorMediaDeliveryScheduledAt",
    ])
    .index("by_submissionState_and_updatedAt", ["submissionState", "updatedAt"])
    .index("by_ownerId_and_submissionState_and_updatedAt", [
      "ownerId",
      "submissionState",
      "updatedAt",
    ])
    .index("by_ownerId_and_billingDispositionState_and_updatedAt", [
      "ownerId",
      "billingDispositionState",
      "updatedAt",
    ])
    .index("by_provider_and_providerRequestId", [
      "provider",
      "providerRequestId",
    ]),

  /**
   * Exact physical-attempt authority for media provider I/O. A lifecycle
   * fence first converts active rows to cancellation debt. Reset, account
   * deletion, and either side of an owner migration then wait for an exact
   * response acknowledgement or the provider-specific hard safety bound.
   *
   * Fal POSTs deliberately keep a much longer bound than ordinary HTTP: a
   * lost submission response can still have allocated an asynchronous Fal
   * job. Once its request id is durable, the media job plus provider-
   * cancellation outbox take over that authority and this transport row can
   * settle immediately.
   */
  media_provider_dispatch_leases: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.optional(v.string()),
    dispatchId: v.string(),
    attemptId: v.string(),
    kind: mediaProviderDispatchKindValidator,
    state: v.union(v.literal("active"), v.literal("cancel_requested")),
    providerDeadlineAt: v.number(),
    leaseExpiresAt: v.number(),
    quiescentAfterAt: v.number(),
    cleanupJobId: v.id("_scheduled_functions"),
    cancelOperationId: v.optional(v.string()),
    cancelGeneration: v.optional(v.string()),
    cancelRequestedAt: v.optional(v.number()),
    ambiguousAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_dispatchId_and_attemptId", ["dispatchId", "attemptId"])
    .index("by_jobId_and_attemptId", ["jobId", "attemptId"])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_ownerId_and_state_and_quiescentAfterAt", [
      "ownerId",
      "state",
      "quiescentAfterAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_quiescentAfterAt", ["quiescentAfterAt"]),

  /**
   * Per-job webhook log entries split out from `media_jobs.logs`. Each fal
   * webhook delivery appends one row per log entry, so a long-running media
   * generation can accumulate many entries without rewriting the job
   * document or hitting the 1MB document size limit.
   */
  media_job_logs: defineTable({
    ownerId: v.string(),
    /** Generation of the media job whose callback emitted this log. */
    ownerGeneration: v.optional(v.string()),
    jobId: v.string(),
    ordinal: v.number(),
    receivedAt: v.number(),
    entry: jsonValueValidator,
  })
    .index("by_jobId_and_ordinal", ["jobId", "ordinal"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"]),

  /**
   * A user abort may reach the gateway before its matching POST reserves a
   * media_jobs row. This tombstone makes cancellation win that race durably,
   * so an automatic retry cannot allocate upstream work after cancellation.
   */
  media_request_cancellations: defineTable({
    ownerId: v.string(),
    /** Cancellation is scoped to the owner namespace that admitted it. */
    ownerGeneration: v.optional(v.string()),
    clientRequestKey: v.string(),
    createdAt: v.number(),
  }).index("by_ownerId_and_clientRequestKey", ["ownerId", "clientRequestKey"]),

  /** Durable account-deletion gate. Media reservation and dispatch both fail closed. */
  media_owner_purges: defineTable({
    ownerId: v.string(),
    startedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  /**
   * Durable deletion outbox for encrypted submission payloads. A row is
   * inserted immediately after storage.store and is retained until
   * storage.delete succeeds, including scheduler/action failures.
   */
  media_private_blob_cleanup: defineTable({
    ownerId: v.string(),
    storageId: v.id("_storage"),
    jobId: v.optional(v.string()),
    state: v.union(v.literal("held"), v.literal("pending")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_storageId", ["storageId"])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),

  /**
   * Owner/operation manifest created before the first encrypted payload chunk.
   * Every new managed image payload is discoverable from this table even if
   * its HTTP action crashes between any two chunk writes.
   */
  media_private_payload_manifests: defineTable({
    ownerId: v.string(),
    /** Prevents a pre-reset upload from attaching to the reopened owner. */
    ownerGeneration: v.optional(v.string()),
    manifestId: v.string(),
    jobId: v.string(),
    clientRequestKey: v.string(),
    state: v.union(
      v.literal("uploading"),
      v.literal("held"),
      v.literal("pending"),
    ),
    expectedChunks: v.number(),
    writtenChunks: v.number(),
    totalChars: v.number(),
    writtenChars: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_manifestId", ["manifestId"])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),

  /** Encrypted bounded chunks; owner and operation identity live on every row. */
  media_private_payload_chunks: defineTable({
    ownerId: v.string(),
    /** Must equal the generation captured on the parent manifest. */
    ownerGeneration: v.optional(v.string()),
    manifestId: v.string(),
    jobId: v.string(),
    index: v.number(),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_manifestId_and_index", ["manifestId", "index"])
    .index("by_ownerId_and_manifestId", ["ownerId", "manifestId"]),

  /** Durable Fal cancellation outbox used by account deletion races. */
  media_provider_cancellations: defineTable({
    ownerId: v.string(),
    /** Audit-only: cleanup remains allowed after the owner fence closes. */
    ownerGeneration: v.optional(v.string()),
    jobId: v.string(),
    endpointId: v.string(),
    providerRequestId: v.string(),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    /** Exact physical cancellation PUT currently holding this outbox row. */
    activeAttemptId: v.optional(v.string()),
    attemptStartedAt: v.optional(v.number()),
    attemptDeadlineAt: v.optional(v.number()),
    attemptQuiescentAfterAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_nextAttemptAt", ["nextAttemptAt"]),

  /** Fal webhook receipt and transition are written in one transaction. */
  media_webhook_events: defineTable({
    ownerId: v.optional(v.string()),
    /** Generation explicitly carried by the provider callback URL. */
    ownerGeneration: v.optional(v.string()),
    scope: v.string(),
    dedupKey: v.string(),
    jobId: v.string(),
    receivedAt: v.number(),
    applied: v.boolean(),
  })
    .index("by_scope_and_dedupKey", ["scope", "dedupKey"])
    .index("by_ownerId_and_receivedAt", ["ownerId", "receivedAt"])
    .index("by_jobId_and_receivedAt", ["jobId", "receivedAt"]),
};
