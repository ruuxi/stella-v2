import { hashSha256Hex } from "./crypto_utils";

/**
 * One-way identity used by the permanent post-purge source fence. Domain
 * separation prevents this digest from being correlated with owner hashes
 * used for R2/DO namespaces elsewhere in the product.
 */
export const ownershipMigrationSourceDigest = async (
  ownerId: string,
): Promise<string> =>
  await hashSha256Hex(`stella:ownership-migration-source:v1\0${ownerId}`);

/**
 * Stable child operation for purging an anonymous source that is still linked
 * to a destination being reset or deleted. Neither raw owner id is embedded in
 * the durable operation id or in worker-visible logs.
 */
export const linkedSourcePurgeOperationId = async (
  parentOperationId: string,
  sourceOwnerId: string,
): Promise<string> => {
  const digest = await hashSha256Hex(
    `stella:ownership-migration-linked-source-purge:v1\0${parentOperationId}\0${sourceOwnerId}`,
  );
  return `linked-source-purge:${digest}`;
};

/**
 * Stable permanent-delete operation started after a successful anonymous to
 * connected ownership transfer. The raw principals never appear in the
 * operation id, while an exact retry always rejoins the same source fence.
 */
export const migratedSourceAuthDeletionOperationId = async (
  fromOwnerId: string,
  toOwnerId: string,
): Promise<string> => {
  const digest = await hashSha256Hex(
    `stella:ownership-migration-source-auth-delete:v1\0${fromOwnerId}\0${toOwnerId}`,
  );
  return `migrated-source-auth-delete:${digest}`;
};

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

export type OwnershipMigrationTransientState =
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

type BillingUsageWindowSnapshot = {
  activeReservedMicroCents?: number;
  rollingUsageMicroCents: number;
  rollingWindowStartedAt: number;
  weeklyUsageMicroCents: number;
  weeklyWindowStartedAt: number;
  monthlyUsageMicroCents: number;
  monthlyWindowStartedAt: number;
  totalUsageMicroCents: number;
  totalRequestCount?: number;
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
): BillingUsageWindowSnapshot => {
  if (
    (source.activeReservedMicroCents ?? 0) !== 0 ||
    (destination.activeReservedMicroCents ?? 0) !== 0
  ) {
    throw new Error(
      "Billing usage windows cannot merge while provider spend is reserved.",
    );
  }
  return {
    activeReservedMicroCents: 0,
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
    ...(source.totalRequestCount !== undefined ||
    destination.totalRequestCount !== undefined
      ? {
          totalRequestCount: addUsageWithoutOverflow(
            source.totalRequestCount ?? 0,
            destination.totalRequestCount ?? 0,
          ),
        }
      : {}),
    createdAt: Math.min(source.createdAt, destination.createdAt),
    updatedAt: Math.max(source.updatedAt, destination.updatedAt),
  };
};
