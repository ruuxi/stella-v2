import { sha256Hex } from "./hash.js";

const CONTROL_ID_MAX_CHARS = 256;
const OWNER_ID_MAX_CHARS = 512;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const STAGE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export const OWNER_TRANSFER_OPERATION_ID_PATTERN = /^[0-9a-f]{64}$/;

export type OwnerTransferControl = {
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  stage: string;
  planRevision: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
};

export type OwnerTransferCoordinatorAttempt = {
  operationId: string;
  planFingerprint: string;
  fromOwnerId: string;
  toOwnerId: string;
  fromOwnerHash: string;
  toOwnerHash: string;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  migrationIdHash: string;
  leaseIdHash: string;
  leaseGeneration: number;
  stageHash: string;
  planRevision: number;
  passIdHash?: string;
};

export type DurableTurnStateTransferManifest = {
  schemaVersion: 1;
  transferOperationId: string;
  sourceOwnerHash: string;
  sourceOwnerGeneration: string;
  sourceWorkspaceHash: string;
  destinationOwnerHash: string;
  destinationOwnerGeneration: string;
  destinationWorkspaceHash: string;
  count: number;
  fingerprint: string;
};

export type DurableTurnStateWorkspaceTransfer = {
  manifest: DurableTurnStateTransferManifest;
  cursor: number;
  phase: "staging" | "activated" | "retired";
  activationReceipt?: string;
  emptyReceipt?: string;
};

export type WorkspacePlanObservation = {
  workspacePlanId: string;
  sourceHasState: boolean;
  sourceStateMarker: string;
  destinationMarker: string;
  expectedDestinationMarker: string;
};

export type DurableWorkspaceTransferPlan = {
  workspacePlanId: string;
  sourceStateMarker: string;
  initialResolvedDestinationMarker: string;
  expectedResolvedDestinationMarker: string;
  state: "planned" | "copied" | "retired";
  turnState?: DurableTurnStateWorkspaceTransfer;
};

export type OwnerTransferReservation = {
  leaseId: string;
  generation?: string;
};

export type OwnerTransferReservationEnvelope = {
  sessionId: string;
  turnId: string;
  expiresAt: number;
  source: { leaseId: string; generation: string };
  destination: { leaseId: string; generation: string };
};

export type OwnerTransferCoordinatorState = {
  schemaVersion: 1;
  operationId: string;
  planFingerprint: string;
  fromOwnerId: string;
  toOwnerId: string;
  fromOwnerHash: string;
  toOwnerHash: string;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  migrationIdHash: string;
  leaseIdHash: string;
  leaseGeneration: number;
  stageHash: string;
  planRevision: number;
  phase:
    | "reserving"
    | "reserved"
    | "copy_complete"
    | "retryable_blocked"
    | "permanent_blocked"
    | "acknowledged";
  sourceReservation: OwnerTransferReservation;
  destinationReservation: OwnerTransferReservation;
  reservationsExpireAt?: number;
  activePass?: { passIdHash: string; expiresAt: number };
  workspacePlans: Record<string, DurableWorkspaceTransferPlan>;
  result?: unknown;
  updatedAt: number;
  acknowledgedAt?: number;
};

export class OwnerTransferCoordinatorConflictError extends Error {
  constructor(
    readonly code:
      | "owner_transfer_conflict"
      | "stale_transfer_lease"
      | "transfer_busy"
      | "destination_checkpoint_changed",
    message: string,
  ) {
    super(message);
    this.name = "OwnerTransferCoordinatorConflictError";
  }
}

const nonEmptyTrimmed = (value: unknown, max: number): string =>
  typeof value === "string" && value.trim().length <= max ? value.trim() : "";

export const normalizeOwnerTransferOwnerId = (value: unknown): string => {
  if (typeof value !== "string") return "";
  if (
    value.length === 0 ||
    value.length > OWNER_ID_MAX_CHARS ||
    value !== value.trim() ||
    CONTROL_CHAR_PATTERN.test(value)
  ) {
    return "";
  }
  return value;
};

export const parseOwnerTransferControl = (
  value: Record<string, unknown>,
): OwnerTransferControl | null => {
  const migrationId = nonEmptyTrimmed(value.migrationId, CONTROL_ID_MAX_CHARS);
  const leaseId = nonEmptyTrimmed(value.leaseId, CONTROL_ID_MAX_CHARS);
  const stage = nonEmptyTrimmed(value.stage, 128);
  const fromOwnerGeneration = nonEmptyTrimmed(
    value.fromOwnerGeneration,
    CONTROL_ID_MAX_CHARS,
  );
  const toOwnerGeneration = nonEmptyTrimmed(
    value.toOwnerGeneration,
    CONTROL_ID_MAX_CHARS,
  );
  const leaseGeneration = value.leaseGeneration;
  const planRevision = value.planRevision;
  if (
    !migrationId ||
    !leaseId ||
    !fromOwnerGeneration ||
    !toOwnerGeneration ||
    !STAGE_PATTERN.test(stage) ||
    !Number.isSafeInteger(leaseGeneration) ||
    (leaseGeneration as number) < 0 ||
    !Number.isSafeInteger(planRevision) ||
    (planRevision as number) < 1
  ) {
    return null;
  }
  return {
    migrationId,
    leaseId,
    leaseGeneration: leaseGeneration as number,
    stage,
    planRevision: planRevision as number,
    fromOwnerGeneration,
    toOwnerGeneration,
  };
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonicalize(source[key])]),
  );
};

export const stableValueMarker = async (value: unknown): Promise<string> =>
  `sha256:${await sha256Hex(JSON.stringify(canonicalize(value)))}`;

export const ownerTransferOperationId = async (
  control: OwnerTransferControl,
  operationScope: string,
): Promise<string> =>
  await sha256Hex(
    `stella-owner-transfer-v1\0${control.migrationId}\0${control.stage}\0${control.planRevision}\0${operationScope}`,
  );

export const createCoordinatorAttempt = async (args: {
  control: OwnerTransferControl;
  operationId: string;
  planFingerprint: string;
  fromOwnerId: string;
  toOwnerId: string;
  passId?: string;
}): Promise<OwnerTransferCoordinatorAttempt> => {
  const fromOwnerId = normalizeOwnerTransferOwnerId(args.fromOwnerId);
  const toOwnerId = normalizeOwnerTransferOwnerId(args.toOwnerId);
  if (!fromOwnerId || !toOwnerId || fromOwnerId === toOwnerId) {
    throw new TypeError("Ownership-transfer owner identities are invalid.");
  }
  const [fromOwnerHash, toOwnerHash, migrationIdHash, leaseIdHash, stageHash] =
    await Promise.all([
      sha256Hex(fromOwnerId),
      sha256Hex(toOwnerId),
      sha256Hex(args.control.migrationId),
      sha256Hex(args.control.leaseId),
      sha256Hex(args.control.stage),
    ]);
  if (fromOwnerHash === toOwnerHash) {
    throw new TypeError("Ownership-transfer owner identities collide.");
  }
  return {
    operationId: args.operationId,
    planFingerprint: args.planFingerprint,
    fromOwnerId,
    toOwnerId,
    fromOwnerHash,
    toOwnerHash,
    fromOwnerGeneration: args.control.fromOwnerGeneration,
    toOwnerGeneration: args.control.toOwnerGeneration,
    migrationIdHash,
    leaseIdHash,
    leaseGeneration: args.control.leaseGeneration,
    stageHash,
    planRevision: args.control.planRevision,
    ...(args.passId ? { passIdHash: await sha256Hex(args.passId) } : {}),
  };
};

export const createCoordinatorState = (
  attempt: OwnerTransferCoordinatorAttempt,
  now: number,
  reservationIds: { source: string; destination: string },
): OwnerTransferCoordinatorState => ({
  schemaVersion: 1,
  operationId: attempt.operationId,
  planFingerprint: attempt.planFingerprint,
  fromOwnerId: attempt.fromOwnerId,
  toOwnerId: attempt.toOwnerId,
  fromOwnerHash: attempt.fromOwnerHash,
  toOwnerHash: attempt.toOwnerHash,
  fromOwnerGeneration: attempt.fromOwnerGeneration,
  toOwnerGeneration: attempt.toOwnerGeneration,
  migrationIdHash: attempt.migrationIdHash,
  leaseIdHash: attempt.leaseIdHash,
  leaseGeneration: attempt.leaseGeneration,
  stageHash: attempt.stageHash,
  planRevision: attempt.planRevision,
  phase: "reserving",
  sourceReservation: { leaseId: reservationIds.source },
  destinationReservation: { leaseId: reservationIds.destination },
  workspacePlans: {},
  updatedAt: now,
});

/**
 * Bind a request to the durable operation. A watchdog takeover may advance the
 * lease generation, but an old generation can never resume or acknowledge it.
 */
export const bindCoordinatorAttempt = (
  state: OwnerTransferCoordinatorState,
  attempt: OwnerTransferCoordinatorAttempt,
  now: number,
): OwnerTransferCoordinatorState => {
  if (
    state.operationId !== attempt.operationId ||
    state.planFingerprint !== attempt.planFingerprint ||
    state.fromOwnerId !== attempt.fromOwnerId ||
    state.toOwnerId !== attempt.toOwnerId ||
    state.fromOwnerHash !== attempt.fromOwnerHash ||
    state.toOwnerHash !== attempt.toOwnerHash ||
    state.fromOwnerGeneration !== attempt.fromOwnerGeneration ||
    state.toOwnerGeneration !== attempt.toOwnerGeneration ||
    state.migrationIdHash !== attempt.migrationIdHash ||
    state.stageHash !== attempt.stageHash ||
    state.planRevision !== attempt.planRevision
  ) {
    throw new OwnerTransferCoordinatorConflictError(
      "owner_transfer_conflict",
      "The durable ownership-transfer operation is bound to a different plan.",
    );
  }
  if (attempt.leaseGeneration < state.leaseGeneration) {
    throw new OwnerTransferCoordinatorConflictError(
      "stale_transfer_lease",
      "This ownership-transfer lease generation is stale.",
    );
  }
  if (
    attempt.leaseGeneration === state.leaseGeneration &&
    attempt.leaseIdHash !== state.leaseIdHash
  ) {
    throw new OwnerTransferCoordinatorConflictError(
      "stale_transfer_lease",
      "This ownership-transfer lease does not own the current generation.",
    );
  }
  if (
    attempt.leaseGeneration > state.leaseGeneration &&
    state.phase !== "acknowledged" &&
    state.phase !== "permanent_blocked"
  ) {
    state.leaseGeneration = attempt.leaseGeneration;
    state.leaseIdHash = attempt.leaseIdHash;
  }
  state.updatedAt = now;
  return state;
};

export const acquireCoordinatorPass = (
  state: OwnerTransferCoordinatorState,
  passIdHash: string,
  now: number,
  expiresAt: number,
): void => {
  if (
    state.activePass &&
    state.activePass.expiresAt > now &&
    state.activePass.passIdHash !== passIdHash
  ) {
    throw new OwnerTransferCoordinatorConflictError(
      "transfer_busy",
      "Another bounded ownership-transfer pass is still active.",
    );
  }
  state.activePass = { passIdHash, expiresAt };
  state.updatedAt = now;
};

export const releaseCoordinatorPass = (
  state: OwnerTransferCoordinatorState,
  passIdHash: string,
  now: number,
): void => {
  if (state.activePass?.passIdHash === passIdHash) {
    delete state.activePass;
    state.updatedAt = now;
  }
};

/**
 * The destination's world is the only place a transferred world can land, so
 * a destination that already holds one is a conflict rather than something to
 * resolve. The decision lives in the strongly consistent coordinator, not KV:
 * re-observing a destination is allowed only when it is byte-for-byte the
 * initial object or the exact descriptor this operation was expected to write.
 */
export const claimWorkspacePlan = (
  state: OwnerTransferCoordinatorState,
  observation: WorkspacePlanObservation,
): DurableWorkspaceTransferPlan => {
  const existing = state.workspacePlans[observation.workspacePlanId];
  if (existing) {
    if (
      existing.sourceStateMarker !== observation.sourceStateMarker &&
      existing.state === "planned"
    ) {
      throw new OwnerTransferCoordinatorConflictError(
        "destination_checkpoint_changed",
        "The source checkpoint changed during ownership transfer.",
      );
    }
    if (
      observation.destinationMarker !==
        existing.initialResolvedDestinationMarker &&
      observation.destinationMarker !==
        existing.expectedResolvedDestinationMarker
    ) {
      throw new OwnerTransferCoordinatorConflictError(
        "destination_checkpoint_changed",
        "The destination checkpoint changed during ownership transfer.",
      );
    }
    return existing;
  }
  if (observation.sourceHasState && observation.destinationMarker !== "absent") {
    throw new OwnerTransferCoordinatorConflictError(
      "destination_checkpoint_changed",
      "The destination account already has a world of its own.",
    );
  }
  const plan: DurableWorkspaceTransferPlan = {
    workspacePlanId: observation.workspacePlanId,
    sourceStateMarker: observation.sourceStateMarker,
    initialResolvedDestinationMarker: observation.destinationMarker,
    expectedResolvedDestinationMarker: observation.expectedDestinationMarker,
    state: "planned",
  };
  state.workspacePlans[observation.workspacePlanId] = plan;
  return plan;
};

export const classifyOwnerFenceRejection = (
  code: string | undefined,
): { retryable: boolean; code: string } => {
  if (code === "owner_purge_permanent") {
    return { retryable: false, code };
  }
  if (code === "owner_purge_temporary") {
    return { retryable: true, code };
  }
  return {
    retryable: true,
    code: code === "transfer_busy" ? "transfer_busy" : "transfer_unavailable",
  };
};
