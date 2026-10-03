import { cronJobs, makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

const maintainAgentEventOwnershipRef = makeFunctionReference<
  "action",
  { maxBatches?: number },
  unknown
>("agent_event_ownership:maintainAgentEventOwnershipInternal");

const sweepComposioSessionCleanupRef = makeFunctionReference<
  "mutation",
  { now?: number; limitPerState?: number },
  { scheduled: number }
>(
  "composio_session_dispatch:sweepDueComposioSessionProvisioningCleanupInternal",
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
  "secret encryption key rotation sweep",
  { hours: 6 },
  internal.data.secrets_rotation.rotateEncryptedMaterial,
  {
    batchSize: 100,
    maxBatches: 5,
  },
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
  "recompute owner risk scores",
  { minutes: 15 },
  recomputeRiskScoresRef,
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
  "purge old usage logs",
  { hours: 24 },
  internal.telemetry_retention.purgeOldUsageLogs,
  { batchSize: 500 },
);

crons.interval(
  "cloud turn failure spike detection",
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

// Destructive owner resets/deletions cross Convex, R2, Durable Objects, and
// the cloud worker. A killed action must therefore resume from its durable
// stage/lease instead of silently leaving a blocked, half-purged account.
crons.interval(
  "resume owner data purges",
  { minutes: 1 },
  internal.owner_lifecycle.sweepDueOwnerPurgeJobsInternal,
  { limit: 10 },
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
