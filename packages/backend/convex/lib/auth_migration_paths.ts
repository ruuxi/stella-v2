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
    sourceId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-16) || "source";
  const folder = `anonymous-${identity}`;
  const rawSegments = name
    .normalize("NFC")
    .split(/[\\/]+/u)
    .filter(Boolean);
  const segments = rawSegments.map((segment) => {
    const safe = segment
      .replace(/[\u0000-\u001f\u007f]/gu, "-")
      .replace(/[^a-zA-Z0-9._ -]/gu, "-")
      .replace(/^\.+/u, "")
      .slice(0, 96);
    return safe || "memory";
  });
  if (segments.length === 0) segments.push("memory.md");
  const last = segments[segments.length - 1]!;
  if (!last.toLocaleLowerCase().endsWith(".md")) {
    segments[segments.length - 1] = `${last.slice(0, 93)}.md`;
  }
  const prefix = `imports/${folder}/`;
  let nested = segments.join("/");
  if (prefix.length + nested.length > 240) {
    const suffix = segments[segments.length - 1]!;
    const available = Math.max(3, 240 - prefix.length);
    nested = suffix.slice(0, available - 3).replace(/\.+$/u, "") + ".md";
  }
  return `${prefix}${nested}`;
};

export const importedSkillSlug = (
  slug: string,
  sourceId: string,
  attempt = 0,
): string => {
  const identity =
    sourceId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-12) || "source";
  const suffix = `-imported-${identity}${attempt > 0 ? `-${attempt + 1}` : ""}`;
  const safeBase =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || "skill";
  const base = safeBase
    .slice(0, Math.max(1, 63 - suffix.length))
    .replace(/-+$/u, "");
  return `${base || "skill"}${suffix}`;
};

export const importedAgentHomePrefix = (
  fromOwnerHash: string,
  toOwnerHash: string,
): string => `agent-home/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`;

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
