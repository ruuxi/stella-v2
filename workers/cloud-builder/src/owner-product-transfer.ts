import { sha256Hex } from "./hash.js";
import {
  parseOwnerTransferControl,
  type OwnerTransferControl,
} from "./owner-transfer-coordinator.js";

/** Longer than the 150s control-plane request, but never a permanent fence. */
export const OWNER_PRODUCT_TRANSFER_LEASE_MS = 9 * 60_000;
/** One HTTP request may retire at most this many source R2 objects. */
export const OWNER_TRANSFER_OBJECT_LIMIT = 200;

export type OwnerProductTransferRequest = OwnerTransferControl & {
  fromOwnerId: string;
  toOwnerId: string;
  agentHome: boolean;
  interiors: boolean;
  /** Move the source owner's world onto the destination owner. */
  world: boolean;
  appSlugs: string[];
};

export const missingOwnerProductTransferBinding = (
  request: Pick<OwnerProductTransferRequest, "agentHome">,
  available: { agentHome: boolean },
): "AGENT_HOME" | null =>
  request.agentHome && !available.agentHome ? "AGENT_HOME" : null;

const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const parseOwnerProductTransferRequest = (
  input: unknown,
): OwnerProductTransferRequest | null => {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const fromOwnerId =
    typeof value.fromOwnerId === "string" ? value.fromOwnerId.trim() : "";
  const toOwnerId =
    typeof value.toOwnerId === "string" ? value.toOwnerId.trim() : "";
  const control = parseOwnerTransferControl(value);
  if (
    !control ||
    !fromOwnerId ||
    !toOwnerId ||
    fromOwnerId === toOwnerId ||
    fromOwnerId.length > 512 ||
    toOwnerId.length > 512
  ) {
    return null;
  }
  if (
    typeof value.agentHome !== "boolean" ||
    typeof value.interiors !== "boolean" ||
    typeof value.world !== "boolean" ||
    !Array.isArray(value.appSlugs) ||
    value.appSlugs.length > 4
  ) {
    return null;
  }
  const appSlugs: string[] = [];
  for (const raw of value.appSlugs) {
    if (typeof raw !== "string" || !APP_SLUG_PATTERN.test(raw)) return null;
    appSlugs.push(raw);
  }
  return {
    ...control,
    fromOwnerId,
    toOwnerId,
    agentHome: value.agentHome,
    interiors: value.interiors,
    world: value.world,
    appSlugs,
  };
};

/**
 * Backup copies need a stable destination id so a retry never creates another
 * full copy. The sandbox SDK only requires the UUID shape for backup ids.
 */
export const transferredBackupId = async (
  fromWorkspaceKey: string,
  toWorkspaceKey: string,
  sourceBackupId: string,
): Promise<string> => {
  const hex = (
    await sha256Hex(
      `owner-product-transfer:${fromWorkspaceKey}:${toWorkspaceKey}:${sourceBackupId}`,
    )
  ).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const importedCheckpointDescriptor = <
  T extends { id: string; name?: string },
>(
  source: T | undefined,
  copiedBackupId: string | undefined,
  destinationName: string,
): T | undefined =>
  source && copiedBackupId
    ? {
        ...source,
        id: copiedBackupId,
        name: `${destinationName}-import-${copiedBackupId.slice(0, 8)}`,
      }
    : undefined;

export const collectCheckpointRecoveryReferences = (input: {
  descriptorId?: string;
  debtBackupIds?: readonly string[];
  historicalBackupName: string;
  imports?: readonly {
    descriptorId?: string;
    backupIds: readonly string[];
    historicalBackupName: string;
  }[];
}): { backupIds: string[]; historicalBackupNames: string[] } => {
  const backupIds = new Set<string>();
  if (input.descriptorId) backupIds.add(input.descriptorId);
  for (const backupId of input.debtBackupIds ?? []) backupIds.add(backupId);
  const historicalBackupNames = new Set([input.historicalBackupName]);
  for (const imported of input.imports ?? []) {
    if (imported.descriptorId) backupIds.add(imported.descriptorId);
    for (const backupId of imported.backupIds) backupIds.add(backupId);
    historicalBackupNames.add(imported.historicalBackupName);
  }
  return {
    backupIds: [...backupIds],
    historicalBackupNames: [...historicalBackupNames],
  };
};

export const replaceOwnerPrefix = (
  key: string,
  sourcePrefix: string,
  destinationPrefix: string,
): string | null =>
  sourcePrefix.endsWith("/") &&
  destinationPrefix.endsWith("/") &&
  key.startsWith(sourcePrefix)
    ? `${destinationPrefix}${key.slice(sourcePrefix.length)}`
    : null;

const OWNER_NAMESPACE_PREFIX =
  /^(agent-home|interiors)\/([0-9a-f]{64})\/(?:__stella_imported__\/([0-9a-f]{64})\/)?$/;
const OWNER_BUILD_PREFIX = /^builds\/([0-9a-f]{64})\/$/;
const BACKUP_PREFIX =
  /^backups\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/$/i;

/** Validate the complete source and destination namespaces before any list. */
export const isValidOwnerTransferPrefixPair = (
  sourcePrefix: string,
  destinationPrefix: string,
): boolean => {
  const sourceNamespace = sourcePrefix.match(OWNER_NAMESPACE_PREFIX);
  const destinationNamespace = destinationPrefix.match(OWNER_NAMESPACE_PREFIX);
  if (sourceNamespace || destinationNamespace) {
    return Boolean(
      sourceNamespace &&
        destinationNamespace &&
        sourceNamespace[1] === destinationNamespace[1] &&
        sourceNamespace[3] === undefined &&
        destinationNamespace[2] !== sourceNamespace[2] &&
        destinationNamespace[3] === sourceNamespace[2],
    );
  }
  const sourceBuild = sourcePrefix.match(OWNER_BUILD_PREFIX);
  const destinationBuild = destinationPrefix.match(OWNER_BUILD_PREFIX);
  if (sourceBuild || destinationBuild) {
    return Boolean(
      sourceBuild &&
        destinationBuild &&
        sourceBuild[1] !== destinationBuild[1],
    );
  }
  const sourceBackup = sourcePrefix.match(BACKUP_PREFIX);
  const destinationBackup = destinationPrefix.match(BACKUP_PREFIX);
  return Boolean(
    sourceBackup &&
      destinationBackup &&
      sourceBackup[1]!.toLowerCase() !== destinationBackup[1]!.toLowerCase(),
  );
};

type InteriorArtifactManifest = {
  schemaVersion: 1;
  buildId: string;
  version: string;
  artifactPrefix: string;
  files: Array<{ path: string; url: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * Rewrites the typed interior manifest fields only. A global string replace can
 * mutate unrelated user-controlled strings and does not prove the old prefix
 * was structurally where the manifest contract requires it.
 */
export const rewriteInteriorArtifactManifest = async (args: {
  manifestJson: string;
  sourcePrefix: string;
  destinationPrefix: string;
  appsHostOrigin: string;
}): Promise<{ manifestJson: string; manifestSha256: string }> => {
  if (!isValidOwnerTransferPrefixPair(args.sourcePrefix, args.destinationPrefix)) {
    throw new Error("Invalid interior ownership-transfer prefixes.");
  }
  const parsed = JSON.parse(args.manifestJson) as Partial<InteriorArtifactManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.buildId !== "string" ||
    parsed.version !== parsed.buildId ||
    typeof parsed.artifactPrefix !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Invalid interior artifact manifest.");
  }
  const artifactPrefix = replaceOwnerPrefix(
    `${parsed.artifactPrefix}/`,
    args.sourcePrefix,
    args.destinationPrefix,
  )?.replace(/\/$/, "");
  if (
    !artifactPrefix ||
    !parsed.artifactPrefix.endsWith(`/${parsed.buildId}`)
  ) {
    throw new Error("Interior artifact prefix does not match its build id.");
  }
  const sourcePath = `/interior-builds/${parsed.artifactPrefix.slice(
    "interiors/".length,
  )}/`;
  const destinationPath = `/interior-builds/${artifactPrefix.slice(
    "interiors/".length,
  )}/`;
  const files = parsed.files.map((file) => {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.url !== "string"
    ) {
      throw new Error("Invalid interior artifact file entry.");
    }
    const url = new URL(file.url);
    if (
      url.origin !== args.appsHostOrigin ||
      !url.pathname.startsWith(sourcePath) ||
      decodeURIComponent(url.pathname.slice(sourcePath.length)) !== file.path
    ) {
      throw new Error("Interior artifact URL does not match its file path.");
    }
    url.pathname = `${destinationPath}${file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return { ...file, url: url.toString() };
  });
  const manifestJson = JSON.stringify({
    ...parsed,
    artifactPrefix,
    files,
  });
  return {
    manifestJson,
    manifestSha256: `sha256:${await sha256Hex(manifestJson)}`,
  };
};

type TransferLeaseIdentity = {
  leaseId?: string;
  sessionId?: string;
  turnId?: string;
};

type TransferReservationIdentity = TransferLeaseIdentity & {
  ownerGeneration?: string;
  role?: string;
};

/**
 * A reset/delete that closes admission after a transfer registered must wait:
 * the exact pre-existing transfer reservation stays writable until ack/expiry.
 * A missing or mismatched reservation instead inherits the purge disposition.
 */
export const assertOwnerTransferReservation = (
  active: TransferReservationIdentity | undefined,
  incoming: TransferReservationIdentity,
  fence: {
    state: "open" | "blocked";
    mode?: "temporary" | "permanent";
  },
):
  | { ok: true }
  | {
      ok: false;
      code:
        | "owner_purge_permanent"
        | "owner_purge_temporary"
        | "transfer_unavailable";
    } => {
  if (
    active?.role === "transfer" &&
    active.leaseId === incoming.leaseId &&
    active.sessionId === incoming.sessionId &&
    active.turnId === incoming.turnId &&
    active.ownerGeneration === incoming.ownerGeneration
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    code:
      fence.state === "blocked"
        ? fence.mode === "permanent"
          ? "owner_purge_permanent"
          : "owner_purge_temporary"
        : "transfer_unavailable",
  };
};

/**
 * A transfer fences every other transfer. The sole compatible replay is the
 * exact same registration, which lets a lost register response be retried
 * without opening a second transfer critical section.
 */
export const ownerTransferLeaseConflicts = (
  active: TransferLeaseIdentity,
  incoming: TransferLeaseIdentity,
): boolean =>
  active.leaseId !== incoming.leaseId ||
  active.sessionId !== incoming.sessionId ||
  active.turnId !== incoming.turnId;

export type OwnerTransferBudget = { remaining: number };

export const createOwnerTransferBudget = (): OwnerTransferBudget => ({
  remaining: OWNER_TRANSFER_OBJECT_LIMIT,
});

/**
 * Pure batching seam used by the R2 mover. Deleting each returned source
 * object means the next request starts at the next object without a cursor or
 * a scan through already-copied keys.
 */
export const takeOwnerTransferBatch = <T>(
  objects: readonly T[],
  budget: OwnerTransferBudget,
): T[] => {
  if (budget.remaining <= 0) return [];
  const batch = objects.slice(0, budget.remaining);
  budget.remaining -= batch.length;
  return batch;
};
