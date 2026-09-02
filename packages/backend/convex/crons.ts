import { cronJobs, makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

const maintainAgentEventOwnershipRef = makeFunctionReference<
  "action",
  { maxBatches?: number },
  unknown
>("agent_event_ownership:maintainAgentEventOwnershipInternal");

const sweepMemoryWipesRef = makeFunctionReference<
  "action",
  { limit?: number },
  { attempted: number }
>("cloud_memory_lifecycle:sweepDueMemoryWipesInternal");

const sweepComposioSessionCleanupRef = makeFunctionReference<
  "mutation",
  { now?: number; limitPerState?: number },
  { scheduled: number }
>(
  "composio_session_dispatch:sweepDueComposioSessionProvisioningCleanupInternal",
);

const drainLateStripeCleanupRef = makeFunctionReference<"action", {}, null>(
  "stripe_operation_dispatch:drainLateStripeCleanupInternal",
);

const recomputeRiskScoresRef = makeFunctionReference<
  "mutation",
  { now?: number },
  unknown
>("risk:recomputeRiskScoresInternal");

const purgeExpiredAppIntegrityNoncesRef = makeFunctionReference<
  "mutation",
  { now?: number; limit?: number },
  { deleted: number; hasMore: boolean }
>("app_integrity:purgeExpiredNoncesInternal");

const purgeIdleTunnelsRef = makeFunctionReference<
  "action",
  { now?: number; limit?: number },
  unknown
>("cloudflare_tunnels:purgeIdleTunnelsInternal");

crons.interval(
  "transient connector turn payload cleanup",
  { minutes: 5 },
  internal.channels.connector_turn_payloads.purgeExpired,
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
  "media cleanup retry sweep",
  { minutes: 5 },
  // Cheap gating mutation replacing the three former per-minute drain-action
  // crons (blob deletion, manifest deletion, provider cancellation). It only
  // schedules a drain action when its retry queue has due rows. These queues
  // are retries of already-failed cleanup with exponential backoff, so the
  // relaxed cadence never delays first-attempt cleanup.
  internal.media_jobs.sweepMediaCleanupQueues,
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
  "managed provider dispatch lease cleanup",
  { minutes: 1 },
  internal.billing.sweepManagedProviderDispatchesInternal,
  {},
);

crons.interval(
  "recover Composio session cleanup dispatches",
  { minutes: 1 },
  sweepComposioSessionCleanupRef,
  { limitPerState: 8 },
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
  "release expired gateway capability grants",
  { minutes: 10 },
  internal.gateway_capabilities.releaseExpiredGatewayCapabilityGrantsInternal,
  {},
);
crons.interval(
  "recompute owner risk scores",
  { minutes: 15 },
  recomputeRiskScoresRef,
  {},
);
crons.interval(
  "purge idle cloudflare tunnels",
  { hours: 24 },
  purgeIdleTunnelsRef,
  {},
);
crons.interval(
  "purge expired x oauth states",
  { hours: 1 },
  internal.data.integrations.purgeExpiredXOAuthStates,
  { batchSize: 200 },
);
crons.interval(
  "purge expired app integrity nonces",
  { hours: 1 },
  purgeExpiredAppIntegrityNoncesRef,
  {},
);
crons.interval(
  "purge expired canvas shares",
  { hours: 1 },
  internal.data.canvas_shares_actions.purgeExpiredShares,
  { batchSize: 200, maxBatches: 10 },
);

crons.interval(
  "purge old usage logs",
  { hours: 24 },
  internal.telemetry_retention.purgeOldUsageLogs,
  { batchSize: 500 },
);

crons.interval(
  "purge old media job logs",
  { hours: 24 },
  internal.telemetry_retention.purgeOldMediaJobLogs,
  { batchSize: 500 },
);

crons.interval(
  "purge expired tts stream tickets",
  { minutes: 5 },
  internal.tts_stream.purgeExpired,
  { maxBatches: 10 },
);

crons.interval(
  "cloud app failure spike detection",
  { minutes: 5 },
  internal.cloud_apps.scanFailureSpikes,
  {},
);

crons.interval(
  "repair legacy agent event ownership",
  { hours: 6 },
  maintainAgentEventOwnershipRef,
  { maxBatches: 8 },
);

// Memory-only erasure is object-first and cursor-driven. This sweep recovers
// killed actions while the memory epoch remains closed, so restart can never
// turn a partial deletion into an apparently successful empty home.
crons.interval(
  "resume cloud memory wipes",
  { minutes: 1 },
  sweepMemoryWipesRef,
  { limit: 10 },
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
// conversation id and a timestamp -- no owner, no content -- and only have to
// outlive an index flush that was in flight when the purge ran.
crons.interval(
  "retire purged cloud conversation tombstones",
  { hours: 6 },
  internal.cloud_apps.sweepConversationTombstonesInternal,
  { limit: 500 },
);

// Index rows whose DO never flushed anything -- a dispatch that failed before
// the builder saw it. Left alone they are permanent empty sidebar entries.
crons.interval(
  "sweep orphaned cloud conversations",
  { hours: 6 },
  internal.cloud_apps.sweepOrphanConversationsInternal,
  { limit: 25 },
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

// Destructive owner resets/deletions cross Convex, R2, Durable Objects, and
// the cloud worker. A killed action must therefore resume from its durable
// stage/lease instead of silently leaving a blocked, half-purged account.
crons.interval(
  "resume owner data purges",
  { minutes: 1 },
  internal.owner_lifecycle.sweepDueOwnerPurgeJobsInternal,
  { limit: 10 },
);

// A platform-suspended Stripe action can report a provider success only after
// permanent account deletion removed its owner-scoped operation row. The mark
// retained a hash-only physical receipt; this sweep drains any short-lived raw
// cleanup locator even if its transaction-scheduled first wake was lost.
crons.interval(
  "drain late Stripe deletion locators",
  { minutes: 1 },
  drainLateStripeCleanupRef,
  {},
);

// Better Auth's delete-user route can time out after publishing the durable
// whole-stack purge. Once that exact delete job completes, this sweep removes
// any remaining component auth rows from the retained user locator.
crons.interval(
  "finalize completed auth account deletions",
  { minutes: 1 },
  internal.auth_account_deletion.sweepAuthAccountDeletionFinalizersInternal,
  { limit: 10 },
);

// Successful anonymous -> connected migrations permanently retire the source
// Better Auth principal. The completion mutation schedules this handoff
// atomically; this sweep covers lost action responses and manual repairs.
crons.interval(
  "retire migrated anonymous auth principals",
  { minutes: 1 },
  internal.auth_migration.sweepMigratedSourceIdentityDeletionsInternal,
  { limit: 10 },
);

crons.interval(
  "purge expired revoked-session tombstones",
  { hours: 1 },
  internal.auth.purgeExpiredRevokedSessions,
  { batchSize: 500 },
);

export default crons;
