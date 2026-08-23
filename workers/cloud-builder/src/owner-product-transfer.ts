import { sha256Hex } from "./hash.js";
import { resolveWorkspace } from "./workspace.js";

/** Longer than the 150s control-plane request, but never a permanent fence. */
export const OWNER_PRODUCT_TRANSFER_LEASE_MS = 9 * 60_000;
/** One HTTP request may retire at most this many source R2 objects. */
export const OWNER_TRANSFER_OBJECT_LIMIT = 200;

export type OwnerWorkspaceTransfer = {
  from: string;
  to: string;
  /**
   * Product-visible fallback when `to` already owns a checkpoint. It is
   * always a normal cloud-project workspace, so the preserved source can be
   * opened through the ordinary project restore path.
   */
  importedTo?: string;
};

export type OwnerProductTransferRequest = {
  fromOwnerId: string;
  toOwnerId: string;
  agentHome: boolean;
  interiors: boolean;
  workspaces: OwnerWorkspaceTransfer[];
  appSlugs: string[];
};

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
  if (
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
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.appSlugs) ||
    value.workspaces.length > 4 ||
    value.appSlugs.length > 4
  ) {
    return null;
  }
  const workspaces: OwnerWorkspaceTransfer[] = [];
  for (const raw of value.workspaces) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.from !== "string" ||
      typeof row.to !== "string" ||
      (row.importedTo !== undefined && typeof row.importedTo !== "string")
    ) {
      return null;
    }
    const from = resolveWorkspace(row.from);
    const to = resolveWorkspace(row.to);
    const importedTo =
      typeof row.importedTo === "string"
        ? resolveWorkspace(row.importedTo)
        : null;
    if (
      !from ||
      !to ||
      from.kind === "computer" ||
      to.kind === "computer" ||
      from.kind !== to.kind
    ) {
      return null;
    }
    if (
      row.importedTo !== undefined &&
      (!importedTo || importedTo.kind !== "project")
    ) {
      return null;
    }
    workspaces.push({
      from: from.canonical,
      to: to.canonical,
      ...(importedTo ? { importedTo: importedTo.canonical } : {}),
    });
  }
  const appSlugs: string[] = [];
  for (const raw of value.appSlugs) {
    if (typeof raw !== "string" || !APP_SLUG_PATTERN.test(raw)) return null;
    appSlugs.push(raw);
  }
  return {
    fromOwnerId,
    toOwnerId,
    agentHome: value.agentHome,
    interiors: value.interiors,
    workspaces,
    appSlugs,
  };
};

export type WorkspaceTransferResolution = {
  from: string;
  requestedTo: string;
  resolvedTo: string;
  imported: boolean;
};

/**
 * A checkpoint collision never shares the destination workspace. The source
 * moves to the caller-selected project fallback, which makes both checkpoints
 * independently restorable through normal product paths.
 */
export const resolveWorkspaceTransfer = (
  transfer: OwnerWorkspaceTransfer,
  destinationHasCheckpoint: boolean,
): WorkspaceTransferResolution | null => {
  if (!destinationHasCheckpoint) {
    return {
      from: transfer.from,
      requestedTo: transfer.to,
      resolvedTo: transfer.to,
      imported: false,
    };
  }
  if (!transfer.importedTo) return null;
  return {
    from: transfer.from,
    requestedTo: transfer.to,
    resolvedTo: transfer.importedTo,
    imported: true,
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
  key.startsWith(sourcePrefix)
    ? `${destinationPrefix}${key.slice(sourcePrefix.length)}`
    : null;

type TransferLeaseIdentity = {
  leaseId?: string;
  sessionId?: string;
  turnId?: string;
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
