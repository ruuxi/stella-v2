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
  profile: v.string(),
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

    clientRequestKey: v.optional(v.string()),

    clientRequestHash: v.optional(v.string()),

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

    submissionPayloadManifestId: v.optional(v.string()),
    submissionAttemptId: v.optional(v.string()),
    submissionClaimedAt: v.optional(v.number()),
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
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

    connectorMediaDeliveryScheduledAt: v.optional(v.number()),

    connectorMediaDeliveredAt: v.optional(v.number()),

    connectorMediaDeliveryError: v.optional(v.string()),
    connectorMediaDeliveryAttempts: v.optional(v.number()),
    connectorMediaDeliveryAbandonedAt: v.optional(v.number()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"])
    .index("by_ownerId_and_clientRequestKey", ["ownerId", "clientRequestKey"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])

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
    .index("by_provider_and_providerRequestId", [
      "provider",
      "providerRequestId",
    ]),

  media_job_logs: defineTable({
    ownerId: v.string(),
    jobId: v.string(),
    ordinal: v.number(),
    receivedAt: v.number(),
    entry: jsonValueValidator,
  })
    .index("by_jobId_and_ordinal", ["jobId", "ordinal"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"]),

  media_request_cancellations: defineTable({
    ownerId: v.string(),
    clientRequestKey: v.string(),
    createdAt: v.number(),
  }).index("by_ownerId_and_clientRequestKey", ["ownerId", "clientRequestKey"]),

  media_owner_purges: defineTable({
    ownerId: v.string(),
    startedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

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

  media_private_payload_manifests: defineTable({
    ownerId: v.string(),
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

  media_private_payload_chunks: defineTable({
    ownerId: v.string(),
    manifestId: v.string(),
    jobId: v.string(),
    index: v.number(),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_manifestId_and_index", ["manifestId", "index"])
    .index("by_ownerId_and_manifestId", ["ownerId", "manifestId"]),

  media_provider_cancellations: defineTable({
    ownerId: v.string(),
    jobId: v.string(),
    endpointId: v.string(),
    providerRequestId: v.string(),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_nextAttemptAt", ["nextAttemptAt"]),

  media_webhook_events: defineTable({
    ownerId: v.optional(v.string()),
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
