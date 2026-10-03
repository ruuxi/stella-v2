import { cronJobs, makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();


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
