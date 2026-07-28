import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "transient connector cleanup",
  { minutes: 5 },
  internal.channels.transient_data.purgeExpired,
  { maxBatches: 10 },
);
crons.interval(
  "transient connector turn payload cleanup",
  { minutes: 5 },
  internal.channels.connector_turn_payloads.purgeExpired,
  { maxBatches: 10 },
);
crons.interval(
  "transient connector stream cleanup",
  { minutes: 5 },
  internal.channels.connector_delivery.purgeExpiredConnectorStreamStates,
  { maxBatches: 10 },
);
crons.interval(
  "stella relay resume cleanup",
  { minutes: 1 },
  internal.stella_provider.relay_resume_store.drainExpiredRelayResumeStreams,
  {},
);
crons.interval(
  "transient cleanup failure retention sweep",
  { hours: 12 },
  internal.channels.transient_data.purgeExpiredCleanupFailures,
  { maxBatches: 10 },
);
crons.interval(
  "thread lifecycle sweep",
  { hours: 24 },
  internal.data.threads.sweepThreadLifecycle,
  {},
);

crons.interval(
  "rescue orphaned remote turns",
  { seconds: 60 },
  // Cheap gating mutation: runs the bounded orphan read and only schedules the
  // (expensive) rescue action when there is actually something to rescue.
  internal.channels.connector_delivery.sweepOrphanedTurns,
  {},
);

crons.interval(
  "fail stale media jobs",
  { minutes: 3 },
  internal.media_jobs.markStaleJobsFailed,
  { staleMs: 3 * 60 * 60_000 + 15 * 60_000, limit: 200 },
);

crons.interval(
  "reconcile image submissions",
  { minutes: 1 },
  internal.media_jobs.reconcilePendingImageSubmissions,
  {
    pendingStaleMs: 2 * 60_000,
    dispatchStaleMs: 2 * 60_000,
    unknownStaleMs: 3 * 60 * 60_000 + 15 * 60_000,
    pendingRetentionMs: 24 * 60 * 60_000,
    limit: 200,
  },
);

crons.interval(
  "retry legacy encrypted media blob deletion",
  { minutes: 1 },
  internal.media_image_submission.drainPrivateBlobCleanup,
  { limit: 100 },
);

crons.interval(
  "retry encrypted media manifest deletion",
  { minutes: 1 },
  internal.media_image_submission.drainPrivatePayloadManifests,
  { limit: 100 },
);

crons.interval(
  "retry purged media provider cancellation",
  { minutes: 1 },
  internal.media_image_submission.drainProviderCancellations,
  { limit: 100 },
);

crons.interval(
  "retry terminal image connector delivery",
  { minutes: 5 },
  internal.media_jobs.retryStuckImageConnectorDeliveries,
  { staleMs: 5 * 60_000, limit: 100, maxAttempts: 5 },
);

crons.interval(
  "secret encryption key rotation sweep",
  { hours: 6 },
  internal.data.secrets_rotation.rotateEncryptedMaterial,
  {
    batchSize: 100,
    maxBatches: 5,
  },
);

crons.interval(
  "managed model price sync",
  { hours: 24 },
  internal.billing.syncManagedModelPricesFromModelsDev,
  {},
);

crons.interval(
  "purge stale anonymous data",
  { hours: 24 },
  internal.anon_cleanup.purgeStaleAnonymousData,
  {},
);

crons.interval(
  "purge stale anon device usage",
  { hours: 24 },
  internal.ai_proxy_data.purgeStaleDeviceUsage,
  { batchSize: 1000 },
);

crons.interval(
  "purge expired slack oauth states",
  { hours: 1 },
  internal.data.integrations.purgeExpiredSlackOAuthStates,
  { batchSize: 200 },
);

crons.interval(
  "purge expired x oauth states",
  { hours: 1 },
  internal.data.integrations.purgeExpiredXOAuthStates,
  { batchSize: 200 },
);

crons.interval(
  "purge expired link codes",
  { hours: 1 },
  internal.channels.link_codes.purgeExpiredLinkCodes,
  { batchSize: 200 },
);

crons.interval(
  "purge expired canvas shares",
  { hours: 1 },
  internal.data.canvas_shares_actions.purgeExpiredShares,
  { batchSize: 200, maxBatches: 10 },
);

crons.interval(
  "cloud app failure spike detection",
  { minutes: 5 },
  internal.cloud_apps.scanFailureSpikes,
  {},
);

crons.interval(
  "purge expired cloud turn tokens",
  { minutes: 30 },
  internal.cloud_apps.purgeExpiredTurnTokensInternal,
  {},
);

// Retries the storage half of a conversation delete. Convex tombstones
// synchronously, but the transcript and its R2 segments live in the DO, and a
// DO that was unreachable when the user pressed delete must not be the reason
// their data survives.
crons.interval(
  "purge tombstoned cloud conversations",
  { minutes: 5 },
  internal.cloud_apps.sweepDeletedConversationsInternal,
  { limit: 10 },
);

// Retires the resurrection fences left by finished purges. They are a random
// conversation id and a timestamp — no owner, no content — and they only have
// to outlive an index flush that was in flight when the purge ran.
crons.interval(
  "retire purged cloud conversation tombstones",
  { hours: 6 },
  internal.cloud_apps.sweepConversationTombstonesInternal,
  { limit: 500 },
);

// Index rows whose DO never flushed anything — a dispatch that failed before
// the builder saw it. Left alone they are permanent empty sidebar entries.
crons.interval(
  "sweep orphaned cloud conversations",
  { hours: 6 },
  internal.cloud_apps.sweepOrphanConversationsInternal,
  { limit: 25 },
);

// One-shot in practice: drains the pre-DO transcript table. Remove this cron,
// `drainLegacyCloudMessagesInternal`, and the `cloud_messages` table once every
// deployment reports zero remaining rows.
crons.interval(
  "drain legacy cloud transcript rows",
  { hours: 1 },
  internal.cloud_apps.drainLegacyCloudMessagesInternal,
  { limit: 200 },
);

crons.interval(
  "dispatch due cloud schedules",
  { minutes: 1 },
  internal.cloud_schedule.dispatchDueSchedulesInternal,
  {},
);

crons.interval(
  "reclaim abandoned drive uploads",
  { hours: 1 },
  internal.cloud_drive.sweepStaleDriveUploadsInternal,
  { limit: 100 },
);

export default crons;
