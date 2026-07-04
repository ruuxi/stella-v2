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
  { staleMs: 4 * 60_000, limit: 200 },
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

export default crons;
