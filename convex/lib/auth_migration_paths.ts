export const importedProjectSlug = (
  slug: string,
  projectId: string,
  attempt = 0,
): string => {
  const identity = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const suffix = `-imported-${identity}${attempt > 0 ? `-${attempt + 1}` : ""}`;
  const base =
    slug.slice(0, Math.max(1, 64 - suffix.length)).replace(/[._-]+$/g, "") ||
    "project";
  return `${base}${suffix}`;
};

export const importedDrivePath = (
  path: string,
  rowId: string,
  attempt = 0,
): string => {
  const prefix = "Imported from anonymous/";
  const suffix = `-${rowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}${
    attempt > 0 ? `-${attempt + 1}` : ""
  }`;
  const available = Math.max(1, 400 - prefix.length - suffix.length);
  return `${prefix}${path.slice(0, available)}${suffix}`;
};

export const importedAgentHomeDocumentName = (
  name: string,
  sourceId: string,
): string => {
  const identity =
    sourceId.replace(/[^a-zA-Z0-9]/g, "").slice(-16) || "anonymous";
  const dot = name.lastIndexOf(".");
  const suffix = `.imported-${identity}`;
  return dot > 0
    ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
    : `${name}${suffix}`;
};

export const importedAgentHomePrefix = (
  fromOwnerHash: string,
  toOwnerHash: string,
): string => `agent-home/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`;

export const importedInteriorPrefix = (
  fromOwnerHash: string,
  toOwnerHash: string,
): string => `interiors/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`;

export type OwnershipMigrationTransientState =
  | "cloud_drive_upload"
  | "cloud_engine_connect"
  | "cloud_github_install_state";
export type OwnershipMigrationTransientDisposition = "discard" | "block";

/**
 * These rows describe incomplete handshakes, not durable user content. Once
 * the anonymous source is fenced it cannot finish them, so migration cancels
 * them instead of exposing a Retry button that can never succeed.
 */
export const ownershipMigrationTransientStateDisposition = (
  _state: OwnershipMigrationTransientState,
): OwnershipMigrationTransientDisposition => "discard";

/**
 * Clean an abandoned presigned upload once immediately and once after its URL
 * has expired. The late pass catches a PUT that raced after the first cleanup;
 * both passes independently prove no Drive row references the object key.
 */
export const canceledPendingUploadCleanupDelays = (
  now: number,
  expiresAt: number,
): [number, number] => [
  0,
  Math.max(0, Math.floor(expiresAt) - Math.floor(now)) + 60_000,
];

type WorkspaceTransferRequest = {
  from: string;
  to: string;
  importedTo?: string;
};

type WorkspaceTransferResolution = {
  from: string;
  requestedTo: string;
  resolvedTo: string;
  imported: boolean;
};

/**
 * The worker may choose only the requested canonical workspace or its exact
 * precomputed imported project. Enforcing a one-to-one map makes the returned
 * project metadata and the checkpoint destination one idempotent decision.
 */
export const workspaceTransferResolutionsMatch = (
  requests: readonly WorkspaceTransferRequest[],
  resolutions: readonly WorkspaceTransferResolution[],
): boolean => {
  if (requests.length !== resolutions.length) return false;
  const remaining = [...resolutions];
  for (const request of requests) {
    const matches = remaining
      .map((resolution, index) => ({ resolution, index }))
      .filter(
        ({ resolution }) =>
          resolution.from === request.from &&
          resolution.requestedTo === request.to,
      );
    if (matches.length !== 1) return false;
    const { resolution, index } = matches[0]!;
    if (
      resolution.imported
        ? !request.importedTo || resolution.resolvedTo !== request.importedTo
        : resolution.resolvedTo !== request.to
    ) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
};

/**
 * Drive bytes live in the @convex-dev/r2 component, not the cloud-builder
 * worker's R2 bindings. Owner migration therefore re-owns metadata in place
 * and deliberately leaves the existing component object key untouched.
 */
export const driveFileOwnershipPatch = (
  toOwnerId: string,
): { ownerId: string } => ({ ownerId: toOwnerId });

export const shouldAdvanceOwnerNamespaceStage = (
  remainingSourceDocuments: number,
): boolean => remainingSourceDocuments === 0;

export const ownerMigrationSourceFenceActive = (
  ownerId: string,
  migrations: readonly { fromOwnerId: string; status: string }[],
): boolean => migrations.some((migration) => migration.fromOwnerId === ownerId);

export const importedOwnerScopedKey = (
  key: string,
  sourceId: string,
  attempt = 0,
  maxLength = 240,
): string => {
  const identity =
    sourceId.replace(/[^a-zA-Z0-9]/g, "").slice(-10) || "anonymous";
  const suffix = `.imported-${identity}${attempt > 0 ? `-${attempt + 1}` : ""}`;
  return `${key.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
};

export const isOwnershipMigrationBlockedMessage = (message: string): boolean =>
  message.startsWith("ownership_migration_blocked:");

export const scheduleOwnershipClaimAllowed = (
  rowOwnerId: string,
  expectedOwnerId: string,
  migrationStatuses: readonly string[],
): boolean =>
  rowOwnerId === expectedOwnerId &&
  migrationStatuses.every((status) => status === "complete");

type BillingUsageWindowSnapshot = {
  rollingUsageMicroCents: number;
  rollingWindowStartedAt: number;
  weeklyUsageMicroCents: number;
  weeklyWindowStartedAt: number;
  monthlyUsageMicroCents: number;
  monthlyWindowStartedAt: number;
  totalUsageMicroCents: number;
  createdAt: number;
  updatedAt: number;
};

const addUsageWithoutOverflow = (left: number, right: number): number =>
  Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.floor(left)) + Math.max(0, Math.floor(right)),
  );

/**
 * Conservatively combine pre-link and connected-account metering.
 *
 * The later window start keeps the combined usage active for at least as long
 * as either input row. Choosing the earlier start would let account linking
 * immediately expire a nearly-finished anonymous window and reset quota.
 */
export const mergeBillingUsageWindows = (
  source: BillingUsageWindowSnapshot,
  destination: BillingUsageWindowSnapshot,
): BillingUsageWindowSnapshot => ({
  rollingUsageMicroCents: addUsageWithoutOverflow(
    source.rollingUsageMicroCents,
    destination.rollingUsageMicroCents,
  ),
  rollingWindowStartedAt: Math.max(
    source.rollingWindowStartedAt,
    destination.rollingWindowStartedAt,
  ),
  weeklyUsageMicroCents: addUsageWithoutOverflow(
    source.weeklyUsageMicroCents,
    destination.weeklyUsageMicroCents,
  ),
  weeklyWindowStartedAt: Math.max(
    source.weeklyWindowStartedAt,
    destination.weeklyWindowStartedAt,
  ),
  monthlyUsageMicroCents: addUsageWithoutOverflow(
    source.monthlyUsageMicroCents,
    destination.monthlyUsageMicroCents,
  ),
  monthlyWindowStartedAt: Math.max(
    source.monthlyWindowStartedAt,
    destination.monthlyWindowStartedAt,
  ),
  totalUsageMicroCents: addUsageWithoutOverflow(
    source.totalUsageMicroCents,
    destination.totalUsageMicroCents,
  ),
  createdAt: Math.min(source.createdAt, destination.createdAt),
  updatedAt: Math.max(source.updatedAt, destination.updatedAt),
});
