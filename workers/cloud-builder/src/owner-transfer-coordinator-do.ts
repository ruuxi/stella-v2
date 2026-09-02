import { DurableObject } from "cloudflare:workers";
import {
  OWNER_TRANSFER_OPERATION_ID_PATTERN,
  OwnerTransferCoordinatorConflictError,
  acquireCoordinatorPass,
  bindCoordinatorAttempt,
  claimWorkspacePlan,
  classifyOwnerFenceRejection,
  createCoordinatorState,
  normalizeOwnerTransferOwnerId,
  releaseCoordinatorPass,
  type DurableTurnStateTransferManifest,
  type OwnerTransferCoordinatorAttempt,
  type OwnerTransferCoordinatorState,
  type OwnerTransferReservationEnvelope,
  type WorkspacePlanObservation,
} from "./owner-transfer-coordinator.js";
import { sha256Hex } from "./hash.js";
import { WORLD_REGISTRY_SEGMENT } from "./turn-state-registry.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TURN_STATE_TRANSFER_ENTRIES = 512;
const MAX_TURN_STATE_TRANSFER_PAGE_ENTRIES = 16;
const RESERVATION_MS = 9 * 60_000;
const RESERVATION_RENEW_MS = 4 * 60_000;
const PASS_MS = 3 * 60_000;
const STATE_KEY = "ownerTransferCoordinator";
const STATE_REVISION_KEY = "ownerTransferCoordinatorRevision";
const REMOTE_CLAIM_KEY = "ownerTransferCoordinatorRemoteClaim";
const DEFAULT_FENCE_TIMEOUT_MS = 8_000;
const MIN_FENCE_TIMEOUT_MS = 250;
const MAX_FENCE_TIMEOUT_MS = 15_000;
const REMOTE_CLAIM_MIN_MS = 60_000;
const HEADER_OWNER_FENCE_ID = "x-stella-owner-fence-id";

type CoordinatorEnv = {
  OWNER_GATES: DurableObjectNamespace;
  /** Test-only override also permits a future deploy-time tightening. */
  OWNER_TRANSFER_FENCE_TIMEOUT_MS?: string;
};

type RemoteClaimKind =
  | "reserve"
  | "reserve-copy-complete"
  | "copied"
  | "abort"
  | "acknowledge"
  | "alarm";

type RemoteClaim = {
  schemaVersion: 1;
  claimId: string;
  kind: RemoteClaimKind;
  operationId: string;
  expectedRevision: number;
  claimedAt: number;
  expiresAt: number;
  passIdHash?: string;
};

type ClaimedRemoteOperation = {
  claim: RemoteClaim;
  state: OwnerTransferCoordinatorState;
};

type CoordinatorReleaseDebt = {
  source: boolean;
  destination: boolean;
};

type CoordinatorStateWithReleaseDebt = OwnerTransferCoordinatorState & {
  releaseDebt?: CoordinatorReleaseDebt;
};

class ImmediateCoordinatorResponse extends Error {
  constructor(readonly response: Response) {
    super("Immediate coordinator response");
    this.name = "ImmediateCoordinatorResponse";
  }
}

type FenceResponse = {
  ok: boolean;
  generation?: string;
  code?: string;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const parseAttempt = async (
  value: unknown,
): Promise<OwnerTransferCoordinatorAttempt | null> => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const string = (key: string): string =>
    typeof row[key] === "string" ? (row[key] as string) : "";
  const attempt: OwnerTransferCoordinatorAttempt = {
    operationId: string("operationId"),
    planFingerprint: string("planFingerprint"),
    fromOwnerId: normalizeOwnerTransferOwnerId(row.fromOwnerId),
    toOwnerId: normalizeOwnerTransferOwnerId(row.toOwnerId),
    fromOwnerHash: string("fromOwnerHash"),
    toOwnerHash: string("toOwnerHash"),
    fromOwnerGeneration: string("fromOwnerGeneration"),
    toOwnerGeneration: string("toOwnerGeneration"),
    migrationIdHash: string("migrationIdHash"),
    leaseIdHash: string("leaseIdHash"),
    leaseGeneration: row.leaseGeneration as number,
    stageHash: string("stageHash"),
    planRevision: row.planRevision as number,
    ...(typeof row.passIdHash === "string"
      ? { passIdHash: row.passIdHash }
      : {}),
  };
  if (
    !OWNER_TRANSFER_OPERATION_ID_PATTERN.test(attempt.operationId) ||
    !HASH_PATTERN.test(attempt.planFingerprint) ||
    !attempt.fromOwnerId ||
    !attempt.toOwnerId ||
    attempt.fromOwnerId === attempt.toOwnerId ||
    !HASH_PATTERN.test(attempt.fromOwnerHash) ||
    !HASH_PATTERN.test(attempt.toOwnerHash) ||
    attempt.fromOwnerHash === attempt.toOwnerHash ||
    !attempt.fromOwnerGeneration ||
    attempt.fromOwnerGeneration.length > 256 ||
    !attempt.toOwnerGeneration ||
    attempt.toOwnerGeneration.length > 256 ||
    !HASH_PATTERN.test(attempt.migrationIdHash) ||
    !HASH_PATTERN.test(attempt.leaseIdHash) ||
    !HASH_PATTERN.test(attempt.stageHash) ||
    !Number.isSafeInteger(attempt.leaseGeneration) ||
    attempt.leaseGeneration < 0 ||
    !Number.isSafeInteger(attempt.planRevision) ||
    attempt.planRevision < 1 ||
    (attempt.passIdHash !== undefined && !HASH_PATTERN.test(attempt.passIdHash))
  ) {
    return null;
  }
  const [fromOwnerHash, toOwnerHash] = await Promise.all([
    sha256Hex(attempt.fromOwnerId),
    sha256Hex(attempt.toOwnerId),
  ]);
  if (
    fromOwnerHash !== attempt.fromOwnerHash ||
    toOwnerHash !== attempt.toOwnerHash
  ) {
    return null;
  }
  return attempt;
};

const parseObservation = (value: unknown): WorkspacePlanObservation | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    !HASH_PATTERN.test(String(row.workspacePlanId ?? "")) ||
    typeof row.sourceHasState !== "boolean" ||
    typeof row.sourceStateMarker !== "string" ||
    typeof row.destinationMarker !== "string" ||
    typeof row.expectedDestinationMarker !== "string"
  ) {
    return null;
  }
  return {
    workspacePlanId: row.workspacePlanId as string,
    sourceHasState: row.sourceHasState,
    sourceStateMarker: row.sourceStateMarker,
    destinationMarker: row.destinationMarker,
    expectedDestinationMarker: row.expectedDestinationMarker,
  };
};

const parseTurnStateManifest = (
  value: unknown,
): DurableTurnStateTransferManifest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = [
    "count",
    "destinationOwnerGeneration",
    "destinationOwnerHash",
    "destinationWorkspaceHash",
    "fingerprint",
    "schemaVersion",
    "sourceOwnerGeneration",
    "sourceOwnerHash",
    "sourceWorkspaceHash",
    "transferOperationId",
  ];
  if (
    Object.keys(row).sort().join(",") !== expected.sort().join(",") ||
    row.schemaVersion !== 1 ||
    !HASH_PATTERN.test(String(row.transferOperationId ?? "")) ||
    !HASH_PATTERN.test(String(row.sourceOwnerHash ?? "")) ||
    typeof row.sourceOwnerGeneration !== "string" ||
    !row.sourceOwnerGeneration ||
    row.sourceOwnerGeneration.length > 256 ||
    !HASH_PATTERN.test(String(row.sourceWorkspaceHash ?? "")) ||
    !HASH_PATTERN.test(String(row.destinationOwnerHash ?? "")) ||
    typeof row.destinationOwnerGeneration !== "string" ||
    !row.destinationOwnerGeneration ||
    row.destinationOwnerGeneration.length > 256 ||
    !HASH_PATTERN.test(String(row.destinationWorkspaceHash ?? "")) ||
    !Number.isSafeInteger(row.count) ||
    (row.count as number) < 1 ||
    (row.count as number) > MAX_TURN_STATE_TRANSFER_ENTRIES ||
    !HASH_PATTERN.test(String(row.fingerprint ?? ""))
  ) {
    return null;
  }
  return row as DurableTurnStateTransferManifest;
};

export class OwnerTransferCoordinator extends DurableObject<CoordinatorEnv> {
  private markReleaseDebt(state: OwnerTransferCoordinatorState): void {
    const extended = state as CoordinatorStateWithReleaseDebt;
    extended.releaseDebt ??= { source: true, destination: true };
  }

  private hasReleaseDebt(state: OwnerTransferCoordinatorState): boolean {
    const debt = (state as CoordinatorStateWithReleaseDebt).releaseDebt;
    return Boolean(debt?.source || debt?.destination);
  }

  private applyReservationSnapshot(
    target: OwnerTransferCoordinatorState,
    snapshot: OwnerTransferCoordinatorState,
  ): void {
    target.sourceReservation = { ...snapshot.sourceReservation };
    target.destinationReservation = { ...snapshot.destinationReservation };
    if (snapshot.reservationsExpireAt === undefined) {
      delete target.reservationsExpireAt;
    } else {
      target.reservationsExpireAt = snapshot.reservationsExpireAt;
    }
    const snapshotDebt = (snapshot as CoordinatorStateWithReleaseDebt)
      .releaseDebt;
    if (snapshotDebt) {
      (target as CoordinatorStateWithReleaseDebt).releaseDebt = {
        ...snapshotDebt,
      };
    } else {
      delete (target as CoordinatorStateWithReleaseDebt).releaseDebt;
    }
  }

  private fenceTimeoutMs(): number {
    const configured = Number(this.env.OWNER_TRANSFER_FENCE_TIMEOUT_MS ?? "");
    return Number.isSafeInteger(configured) &&
      configured >= MIN_FENCE_TIMEOUT_MS &&
      configured <= MAX_FENCE_TIMEOUT_MS
      ? configured
      : DEFAULT_FENCE_TIMEOUT_MS;
  }

  private remoteClaimMs(): number {
    // ensureReservations can make four sequential fence-call rounds in its
    // failure path. Keep the persisted claim comfortably beyond that bounded
    // work so a live request can never be mistaken for an abandoned claim.
    return Math.max(REMOTE_CLAIM_MIN_MS, this.fenceTimeoutMs() * 6);
  }

  private async currentRevision(
    storage: Pick<DurableObjectTransaction, "get"> = this.ctx.storage,
  ): Promise<number> {
    const value = await storage.get<number>(STATE_REVISION_KEY);
    return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
  }

  private isLiveClaim(claim: RemoteClaim | undefined, now: number): boolean {
    return Boolean(
      claim &&
        claim.schemaVersion === 1 &&
        claim.claimId &&
        claim.operationId &&
        Number.isSafeInteger(claim.expectedRevision) &&
        claim.expectedRevision >= 1 &&
        Number.isSafeInteger(claim.expiresAt) &&
        claim.expiresAt > now,
    );
  }

  private claimConflict(): OwnerTransferCoordinatorConflictError {
    return new OwnerTransferCoordinatorConflictError(
      "transfer_busy",
      "Ownership-transfer reservation reconciliation is still in progress.",
    );
  }

  private async commitClaim(
    claimed: ClaimedRemoteOperation,
    update: (
      state: OwnerTransferCoordinatorState,
      txn: DurableObjectTransaction,
      nextRevision: number,
    ) => void | Promise<void>,
    options: { retainClaim?: boolean } = {},
  ): Promise<RemoteClaim | null> {
    return await this.ctx.storage.transaction(async (txn) => {
      const [claim, revision, state] = await Promise.all([
        txn.get<RemoteClaim>(REMOTE_CLAIM_KEY),
        this.currentRevision(txn),
        txn.get<OwnerTransferCoordinatorState>(STATE_KEY),
      ]);
      if (
        !claim ||
        claim.claimId !== claimed.claim.claimId ||
        claim.expectedRevision !== claimed.claim.expectedRevision ||
        revision !== claimed.claim.expectedRevision ||
        !state ||
        state.operationId !== claimed.claim.operationId
      ) {
        throw this.claimConflict();
      }
      const nextRevision = revision + 1;
      await update(state, txn, nextRevision);
      state.updatedAt = Date.now();
      await txn.put(STATE_KEY, state);
      await txn.put(STATE_REVISION_KEY, nextRevision);
      if (!options.retainClaim) {
        await txn.delete(REMOTE_CLAIM_KEY);
        return null;
      }
      const nextClaim = { ...claim, expectedRevision: nextRevision };
      await txn.put(REMOTE_CLAIM_KEY, nextClaim);
      return nextClaim;
    });
  }

  private async claimRemote(
    kind: RemoteClaimKind,
    attempt: OwnerTransferCoordinatorAttempt | null,
    prepare: (
      state: OwnerTransferCoordinatorState | undefined,
      now: number,
      txn: DurableObjectTransaction,
    ) => OwnerTransferCoordinatorState,
  ): Promise<ClaimedRemoteOperation> {
    return await this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const existingClaim = await txn.get<RemoteClaim>(REMOTE_CLAIM_KEY);
      if (this.isLiveClaim(existingClaim, now)) throw this.claimConflict();
      if (existingClaim) await txn.delete(REMOTE_CLAIM_KEY);
      const existingState =
        await txn.get<OwnerTransferCoordinatorState>(STATE_KEY);
      const state = prepare(existingState, now, txn);
      const revision = (await this.currentRevision(txn)) + 1;
      const claim: RemoteClaim = {
        schemaVersion: 1,
        claimId: crypto.randomUUID(),
        kind,
        operationId: state.operationId,
        expectedRevision: revision,
        claimedAt: now,
        expiresAt: now + this.remoteClaimMs(),
        ...(attempt?.passIdHash ? { passIdHash: attempt.passIdHash } : {}),
      };
      await txn.put(STATE_KEY, state);
      await txn.put(STATE_REVISION_KEY, revision);
      await txn.put(REMOTE_CLAIM_KEY, claim);
      // A crashed request leaves a durable recovery signal. A live request has
      // a much shorter explicit deadline and will replace this alarm on commit.
      const alarmAt = await txn.getAlarm();
      if (alarmAt === null || alarmAt > claim.expiresAt) {
        await txn.setAlarm(claim.expiresAt);
      }
      return { claim, state };
    });
  }

  private reservationEnvelope(
    state: OwnerTransferCoordinatorState,
  ): OwnerTransferReservationEnvelope {
    const sourceGeneration = state.sourceReservation.generation;
    const destinationGeneration = state.destinationReservation.generation;
    const expiresAt = state.reservationsExpireAt;
    if (
      !sourceGeneration ||
      !destinationGeneration ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt! <= Date.now()
    ) {
      throw new Error("Ownership-transfer reservation is incomplete.");
    }
    return {
      sessionId: this.ctx.id.toString(),
      turnId: `owner-transfer:${state.operationId}`,
      expiresAt: expiresAt!,
      source: {
        leaseId: state.sourceReservation.leaseId,
        generation: sourceGeneration,
      },
      destination: {
        leaseId: state.destinationReservation.leaseId,
        generation: destinationGeneration,
      },
    };
  }

  private ownerFence(ownerId: string) {
    return this.env.OWNER_GATES.getByName(ownerId);
  }

  private async callFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<FenceResponse> {
    const signal = AbortSignal.timeout(this.fenceTimeoutMs());
    const response = await this.ownerFence(ownerId).fetch(
      `https://owner-gate/owner-fence/${path}`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          [HEADER_OWNER_FENCE_ID]: ownerId,
        },
        body: JSON.stringify({ ...body, ownerId }),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      generation?: unknown;
      code?: unknown;
    } | null;
    return {
      ok: response.ok,
      ...(typeof result?.generation === "string"
        ? { generation: result.generation }
        : {}),
      ...(typeof result?.code === "string" ? { code: result.code } : {}),
    };
  }

  private reservationBody(
    state: OwnerTransferCoordinatorState,
    leaseId: string,
    ownerGeneration: string,
    expiresAt: number,
  ): Record<string, unknown> {
    return {
      leaseId,
      sessionId: this.ctx.id.toString(),
      turnId: `owner-transfer:${state.operationId}`,
      ownerGeneration,
      namespace: "activity",
      role: "transfer",
      expiresAt,
    };
  }

  private async releaseReservations(
    state: OwnerTransferCoordinatorState,
  ): Promise<boolean> {
    this.markReleaseDebt(state);
    const extended = state as CoordinatorStateWithReleaseDebt;
    const debt = extended.releaseDebt!;
    const targets = [
      {
        side: "source" as const,
        ownerId: state.fromOwnerId,
        ownerGeneration: state.fromOwnerGeneration,
        reservation: state.sourceReservation,
      },
      {
        side: "destination" as const,
        ownerId: state.toOwnerId,
        ownerGeneration: state.toOwnerGeneration,
        reservation: state.destinationReservation,
      },
    ];
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        if (!debt[target.side]) return { side: target.side, released: true };
        const result = await this.callFence(target.ownerId, "unregister", {
          leaseId: target.reservation.leaseId,
          sessionId: this.ctx.id.toString(),
          turnId: `owner-transfer:${state.operationId}`,
          ...(target.reservation.generation
            ? { generation: target.reservation.generation }
            : {}),
          ownerGeneration: target.ownerGeneration,
        }).catch(() => null);
        return { side: target.side, released: result?.ok === true };
      }),
    );
    for (const outcome of outcomes) {
      if (!outcome.released) continue;
      debt[outcome.side] = false;
      delete (
        outcome.side === "source"
          ? state.sourceReservation
          : state.destinationReservation
      ).generation;
    }
    if (debt.source || debt.destination) return false;
    delete extended.releaseDebt;
    delete state.reservationsExpireAt;
    return true;
  }

  private async assertReservations(
    state: OwnerTransferCoordinatorState,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; code: string }> {
    if (
      !state.sourceReservation.generation ||
      !state.destinationReservation.generation
    ) {
      return { ok: false, retryable: true, code: "transfer_unavailable" };
    }
    const turnId = `owner-transfer:${state.operationId}`;
    const sessionId = this.ctx.id.toString();
    const [source, destination] = await Promise.all([
      this.callFence(state.fromOwnerId, "assert-transfer", {
        leaseId: state.sourceReservation.leaseId,
        sessionId,
        turnId,
        ownerGeneration: state.fromOwnerGeneration,
      }),
      this.callFence(state.toOwnerId, "assert-transfer", {
        leaseId: state.destinationReservation.leaseId,
        sessionId,
        turnId,
        ownerGeneration: state.toOwnerGeneration,
      }),
    ]);
    if (source.ok && destination.ok) return { ok: true };
    const codes = [source.code, destination.code];
    return {
      ok: false,
      ...classifyOwnerFenceRejection(
        codes.includes("owner_purge_permanent")
          ? "owner_purge_permanent"
          : codes.includes("owner_purge_temporary")
            ? "owner_purge_temporary"
            : codes.includes("transfer_busy")
              ? "transfer_busy"
              : undefined,
      ),
    };
  }

  private async ensureReservations(
    state: OwnerTransferCoordinatorState,
    now: number,
  ): Promise<
    | {
        ok: true;
        alarmAt: number;
        renewalBlocked?: { retryable: boolean; code: string };
      }
    | { ok: false; retryable: boolean; code: string }
  > {
    const existing = await this.assertReservations(state);
    if (existing.ok) {
      delete (state as CoordinatorStateWithReleaseDebt).releaseDebt;
    }
    const expiresAt = now + RESERVATION_MS;
    const source = await this.callFence(
      state.fromOwnerId,
      "register",
      this.reservationBody(
        state,
        state.sourceReservation.leaseId,
        state.fromOwnerGeneration,
        expiresAt,
      ),
    );
    if (!source.ok || !source.generation) {
      const classified = classifyOwnerFenceRejection(source.code);
      if (existing.ok && (state.reservationsExpireAt ?? 0) > now) {
        return {
          ok: true,
          alarmAt: Math.min(now + 30_000, state.reservationsExpireAt!),
          renewalBlocked: classified,
        };
      }
      await this.releaseReservations(state);
      return { ok: false, ...classified };
    }
    state.sourceReservation.generation = source.generation;

    const destination = await this.callFence(
      state.toOwnerId,
      "register",
      this.reservationBody(
        state,
        state.destinationReservation.leaseId,
        state.toOwnerGeneration,
        expiresAt,
      ),
    );
    if (!destination.ok || !destination.generation) {
      const classified = classifyOwnerFenceRejection(destination.code);
      if (existing.ok && (state.reservationsExpireAt ?? 0) > now) {
        return {
          ok: true,
          alarmAt: Math.min(now + 30_000, state.reservationsExpireAt!),
          renewalBlocked: classified,
        };
      }
      await this.releaseReservations(state);
      return { ok: false, ...classified };
    }
    state.destinationReservation.generation = destination.generation;
    state.reservationsExpireAt = expiresAt;
    delete (state as CoordinatorStateWithReleaseDebt).releaseDebt;
    state.phase =
      state.phase === "copy_complete" ? "copy_complete" : "reserved";
    return { ok: true, alarmAt: now + RESERVATION_RENEW_MS };
  }

  private loadAndBindState(
    existing: OwnerTransferCoordinatorState | undefined,
    attempt: OwnerTransferCoordinatorAttempt,
    now: number,
  ): OwnerTransferCoordinatorState {
    if (!existing) {
      return createCoordinatorState(attempt, now, {
        source: crypto.randomUUID(),
        destination: crypto.randomUUID(),
      });
    }
    return bindCoordinatorAttempt(existing, attempt, now);
  }

  private conflictResponse(error: unknown): Response {
    if (error instanceof ImmediateCoordinatorResponse) return error.response;
    if (error instanceof OwnerTransferCoordinatorConflictError) {
      return json({ code: error.code, message: error.message }, 409);
    }
    return json(
      {
        code: "transfer_unavailable",
        retryable: true,
        retryAfterMs: 5_000,
        message: "Ownership-transfer coordination is temporarily unavailable.",
      },
      503,
    );
  }

  private async reserve(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const passIdHash = attempt.passIdHash;
    let claimed: ClaimedRemoteOperation;
    try {
      claimed = await this.claimRemote("reserve", attempt, (existing, now) => {
        const state = this.loadAndBindState(existing, attempt, now);
        if (state.phase === "acknowledged") {
          throw new ImmediateCoordinatorResponse(
            json({ status: "acknowledged", result: state.result }),
          );
        }
        if (state.phase === "permanent_blocked") {
          throw new ImmediateCoordinatorResponse(
            json(
              {
                code: "owner_purge_permanent",
                message:
                  "An account in this transfer is being permanently deleted.",
              },
              409,
            ),
          );
        }
        if (state.phase !== "copy_complete") {
          acquireCoordinatorPass(state, passIdHash, now, now + PASS_MS);
          if (state.phase === "retryable_blocked") state.phase = "reserving";
        }
        return state;
      });
    } catch (error) {
      return this.conflictResponse(error);
    }

    const state = claimed.state;
    if (state.phase === "copy_complete") {
      try {
        const asserted = await this.assertReservations(state);
        if (asserted.ok) {
          await this.commitClaim(claimed, async (_current, txn) => {
            await txn.setAlarm(Date.now() + RESERVATION_RENEW_MS);
          });
          return json({ status: "copy_complete", result: state.result });
        }
        state.phase = asserted.retryable
          ? "retryable_blocked"
          : "permanent_blocked";
        const released = await this.releaseReservations(state);
        await this.commitClaim(claimed, async (current, txn) => {
          current.phase = state.phase;
          delete current.activePass;
          this.applyReservationSnapshot(current, state);
          if (released) await txn.deleteAlarm();
          else await txn.setAlarm(Date.now() + 30_000);
        });
        return json(
          {
            code: asserted.code,
            retryable: asserted.retryable,
            message: "Ownership-transfer acknowledgement lost its reservation.",
          },
          409,
        );
      } catch (error) {
        try {
          await this.commitClaim(claimed, async (_current, txn) => {
            await txn.setAlarm(Date.now() + 30_000);
          });
        } catch (commitError) {
          return this.conflictResponse(commitError);
        }
        return this.conflictResponse(error);
      }
    }

    const now = Date.now();
    try {
      const reservation = await this.ensureReservations(state, now);
      if (!reservation.ok) {
        state.phase = reservation.retryable
          ? "retryable_blocked"
          : "permanent_blocked";
        releaseCoordinatorPass(state, passIdHash, Date.now());
        await this.commitClaim(claimed, async (current, txn) => {
          current.phase = state.phase;
          current.activePass = state.activePass;
          this.applyReservationSnapshot(current, state);
          if (this.hasReleaseDebt(state)) {
            await txn.setAlarm(Date.now() + 30_000);
          } else {
            await txn.deleteAlarm();
          }
        });
        return json(
          {
            code: reservation.code,
            retryable: reservation.retryable,
            message: reservation.retryable
              ? "Ownership transfer is temporarily blocked."
              : "Ownership transfer conflicts with permanent account deletion.",
            ...(reservation.retryable ? { retryAfterMs: 5_000 } : {}),
          },
          409,
        );
      }
      if (
        reservation.renewalBlocked &&
        (state.reservationsExpireAt ?? 0) < now + PASS_MS
      ) {
        releaseCoordinatorPass(state, passIdHash, Date.now());
        await this.commitClaim(claimed, async (current, txn) => {
          current.activePass = state.activePass;
          current.phase = state.phase;
          current.reservationsExpireAt = state.reservationsExpireAt;
          current.sourceReservation = { ...state.sourceReservation };
          current.destinationReservation = { ...state.destinationReservation };
          await txn.setAlarm(reservation.alarmAt);
        });
        return json(
          {
            code: reservation.renewalBlocked.code,
            retryable: reservation.renewalBlocked.retryable,
            retryAfterMs: 5_000,
            message: "Ownership-transfer reservation is too close to expiry.",
          },
          409,
        );
      }
      await this.commitClaim(claimed, async (current, txn) => {
        current.phase = state.phase;
        current.activePass = state.activePass;
        current.reservationsExpireAt = state.reservationsExpireAt;
        current.sourceReservation = { ...state.sourceReservation };
        current.destinationReservation = { ...state.destinationReservation };
        await txn.setAlarm(reservation.alarmAt);
      });
      return json({
        status: "reserved",
        reservation: this.reservationEnvelope(state),
      });
    } catch (error) {
      // A transport failure does not prove a durable reservation vanished.
      // Keep its bounded expiry/alarm, but release the per-pass mutex so a
      // control-plane retry can reconcile the same stable lease promptly.
      releaseCoordinatorPass(state, passIdHash, Date.now());
      try {
        await this.commitClaim(claimed, async (current, txn) => {
          current.activePass = state.activePass;
          current.phase = state.phase;
          current.reservationsExpireAt = state.reservationsExpireAt;
          current.sourceReservation = { ...state.sourceReservation };
          current.destinationReservation = { ...state.destinationReservation };
          await txn.setAlarm(Date.now() + 30_000);
        });
      } catch (commitError) {
        return this.conflictResponse(commitError);
      }
      return json(
        {
          code: "transfer_unavailable",
          retryable: true,
          retryAfterMs: 5_000,
          message: "Ownership-transfer reservations could not be verified.",
        },
        503,
      );
    }
  }

  private async withPassState(
    body: Record<string, unknown>,
    update: (
      state: OwnerTransferCoordinatorState,
      attempt: OwnerTransferCoordinatorAttempt,
    ) => Response,
  ): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    try {
      return await this.ctx.storage.transaction(async (txn) => {
        const now = Date.now();
        const remoteClaim = await txn.get<RemoteClaim>(REMOTE_CLAIM_KEY);
        if (this.isLiveClaim(remoteClaim, now)) throw this.claimConflict();
        if (remoteClaim) await txn.delete(REMOTE_CLAIM_KEY);
        const state = this.loadAndBindState(
          await txn.get<OwnerTransferCoordinatorState>(STATE_KEY),
          attempt,
          now,
        );
        const activePass = state.activePass;
        if (
          activePass?.passIdHash !== attempt.passIdHash ||
          !activePass ||
          activePass.expiresAt <= now
        ) {
          throw new OwnerTransferCoordinatorConflictError(
            "transfer_busy",
            "This bounded ownership-transfer pass no longer owns the coordinator.",
          );
        }
        const response = update(state, attempt);
        state.updatedAt = Date.now();
        await txn.put(STATE_KEY, state);
        await txn.put(
          STATE_REVISION_KEY,
          (await this.currentRevision(txn)) + 1,
        );
        return response;
      });
    } catch (error) {
      return this.conflictResponse(error);
    }
  }

  private async workspacePlan(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const observation = parseObservation(body.observation);
    if (!observation) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) => {
      const plan = claimWorkspacePlan(state, observation);
      state.updatedAt = Date.now();
      return json({ plan });
    });
  }

  private async workspaceGet(body: Record<string, unknown>): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    if (!HASH_PATTERN.test(workspacePlanId)) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) =>
      json({ plan: state.workspacePlans[workspacePlanId] ?? null }),
    );
  }

  private async workspaceTurnStateExported(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    const manifest = parseTurnStateManifest(body.manifest);
    if (!HASH_PATTERN.test(workspacePlanId) || !manifest) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const worldHash = await sha256Hex(WORLD_REGISTRY_SEGMENT);
    return await this.withPassState(body, (state) => {
      const plan = state.workspacePlans[workspacePlanId];
      if (!plan || plan.state !== "planned") {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable workspace transfer plan is unavailable.",
          },
          409,
        );
      }
      if (
        manifest.transferOperationId !== state.operationId ||
        manifest.sourceOwnerHash !== state.fromOwnerHash ||
        manifest.sourceOwnerGeneration !== state.fromOwnerGeneration ||
        manifest.sourceWorkspaceHash !== worldHash ||
        manifest.destinationOwnerHash !== state.toOwnerHash ||
        manifest.destinationOwnerGeneration !== state.toOwnerGeneration ||
        manifest.destinationWorkspaceHash !== worldHash
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The turn-state manifest escaped its workspace plan.",
          },
          409,
        );
      }
      if (plan.turnState) {
        if (
          JSON.stringify(plan.turnState.manifest) !== JSON.stringify(manifest)
        ) {
          return json(
            {
              code: "destination_checkpoint_changed",
              message: "The durable turn-state manifest changed.",
            },
            409,
          );
        }
        return json({ turnState: plan.turnState, replayed: true });
      }
      plan.turnState = {
        manifest,
        cursor: 0,
        phase: "staging",
      };
      state.updatedAt = Date.now();
      return json({ turnState: plan.turnState, replayed: false });
    });
  }

  private async workspaceTurnStateStaged(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    const manifestFingerprint =
      typeof body.manifestFingerprint === "string"
        ? body.manifestFingerprint
        : "";
    const previousCursor = body.previousCursor;
    const nextCursor = body.nextCursor;
    if (
      !HASH_PATTERN.test(workspacePlanId) ||
      !HASH_PATTERN.test(manifestFingerprint) ||
      !Number.isSafeInteger(previousCursor) ||
      !Number.isSafeInteger(nextCursor) ||
      (previousCursor as number) < 0 ||
      (nextCursor as number) < 1 ||
      (nextCursor as number) - (previousCursor as number) >
        MAX_TURN_STATE_TRANSFER_PAGE_ENTRIES
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) => {
      const transfer = state.workspacePlans[workspacePlanId]?.turnState;
      if (
        !transfer ||
        transfer.manifest.fingerprint !== manifestFingerprint ||
        transfer.phase !== "staging" ||
        (nextCursor as number) > transfer.manifest.count
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable turn-state staging cursor changed.",
          },
          409,
        );
      }
      if (transfer.cursor === nextCursor) {
        return json({ turnState: transfer, replayed: true });
      }
      if (
        transfer.cursor !== previousCursor ||
        (nextCursor as number) <= (previousCursor as number)
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable turn-state staging cursor changed.",
          },
          409,
        );
      }
      transfer.cursor = nextCursor as number;
      state.updatedAt = Date.now();
      return json({ turnState: transfer, replayed: false });
    });
  }

  private async workspaceTurnStateActivated(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    const manifestFingerprint =
      typeof body.manifestFingerprint === "string"
        ? body.manifestFingerprint
        : "";
    const activationReceipt =
      typeof body.activationReceipt === "string" ? body.activationReceipt : "";
    if (
      !HASH_PATTERN.test(workspacePlanId) ||
      !HASH_PATTERN.test(manifestFingerprint) ||
      !HASH_PATTERN.test(activationReceipt)
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) => {
      const transfer = state.workspacePlans[workspacePlanId]?.turnState;
      if (
        !transfer ||
        transfer.manifest.fingerprint !== manifestFingerprint ||
        transfer.cursor !== transfer.manifest.count ||
        (transfer.activationReceipt !== undefined &&
          transfer.activationReceipt !== activationReceipt) ||
        transfer.phase === "retired"
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable turn-state activation changed.",
          },
          409,
        );
      }
      const replayed = transfer.phase === "activated";
      transfer.phase = "activated";
      transfer.activationReceipt = activationReceipt;
      state.updatedAt = Date.now();
      return json({ turnState: transfer, replayed });
    });
  }

  private async workspaceTurnStateRetired(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    const manifestFingerprint =
      typeof body.manifestFingerprint === "string"
        ? body.manifestFingerprint
        : "";
    const activationReceipt =
      typeof body.activationReceipt === "string" ? body.activationReceipt : "";
    const emptyReceipt =
      typeof body.emptyReceipt === "string" ? body.emptyReceipt : "";
    if (
      !HASH_PATTERN.test(workspacePlanId) ||
      !HASH_PATTERN.test(manifestFingerprint) ||
      !HASH_PATTERN.test(activationReceipt) ||
      !HASH_PATTERN.test(emptyReceipt)
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) => {
      const plan = state.workspacePlans[workspacePlanId];
      const transfer = plan?.turnState;
      if (
        !plan ||
        plan.state !== "copied" ||
        !transfer ||
        transfer.manifest.fingerprint !== manifestFingerprint ||
        transfer.activationReceipt !== activationReceipt ||
        (transfer.emptyReceipt !== undefined &&
          transfer.emptyReceipt !== emptyReceipt) ||
        (transfer.phase !== "activated" && transfer.phase !== "retired")
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable turn-state retirement changed.",
          },
          409,
        );
      }
      const replayed = transfer.phase === "retired";
      transfer.phase = "retired";
      transfer.emptyReceipt = emptyReceipt;
      state.updatedAt = Date.now();
      return json({ turnState: transfer, replayed });
    });
  }

  private async workspaceState(
    body: Record<string, unknown>,
    next: "copied" | "retired",
  ): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    if (!HASH_PATTERN.test(workspacePlanId)) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, (state) => {
      const plan = state.workspacePlans[workspacePlanId];
      if (!plan) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "The durable workspace transfer plan is missing.",
          },
          409,
        );
      }
      if (
        (next === "copied" &&
          plan.turnState &&
          plan.turnState.phase !== "activated") ||
        (next === "retired" &&
          plan.turnState &&
          plan.turnState.phase !== "retired")
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message:
              "The atomic turn-state transfer has not reached this workspace phase.",
          },
          409,
        );
      }
      if (next === "retired" || plan.state !== "retired") plan.state = next;
      state.updatedAt = Date.now();
      return json({ plan });
    });
  }

  private async copied(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    let claimed: ClaimedRemoteOperation;
    try {
      claimed = await this.claimRemote("copied", attempt, (existing, now) => {
        const state = this.loadAndBindState(existing, attempt, now);
        const activePass = state.activePass;
        if (
          !activePass ||
          activePass.passIdHash !== attempt.passIdHash ||
          activePass.expiresAt <= now
        ) {
          throw new OwnerTransferCoordinatorConflictError(
            "transfer_busy",
            "This bounded ownership-transfer pass no longer owns the coordinator.",
          );
        }
        return state;
      });
    } catch (error) {
      return this.conflictResponse(error);
    }
    const state = claimed.state;
    try {
      const asserted = await this.assertReservations(state);
      if (!asserted.ok) {
        state.phase = asserted.retryable
          ? "retryable_blocked"
          : "permanent_blocked";
        releaseCoordinatorPass(state, attempt.passIdHash!, Date.now());
        const released = await this.releaseReservations(state);
        await this.commitClaim(claimed, async (current, txn) => {
          current.phase = state.phase;
          current.activePass = state.activePass;
          this.applyReservationSnapshot(current, state);
          if (released) await txn.deleteAlarm();
          else await txn.setAlarm(Date.now() + 30_000);
        });
        return json(
          {
            code: asserted.code,
            retryable: asserted.retryable,
            message: "Ownership-transfer copy lost its reservation.",
          },
          409,
        );
      }
      state.phase = "copy_complete";
      state.result = body.result;
      releaseCoordinatorPass(state, attempt.passIdHash!, Date.now());
      await this.commitClaim(claimed, async (current, txn) => {
        current.phase = "copy_complete";
        current.result = state.result;
        current.activePass = state.activePass;
        await txn.setAlarm(Date.now() + RESERVATION_RENEW_MS);
      });
      return json({ status: "copy_complete", result: state.result });
    } catch (error) {
      try {
        await this.commitClaim(claimed, async (_current, txn) => {
          await txn.setAlarm(Date.now() + 30_000);
        });
      } catch (commitError) {
        return this.conflictResponse(commitError);
      }
      return this.conflictResponse(error);
    }
  }

  private async yieldPass(body: Record<string, unknown>): Promise<Response> {
    return await this.withPassState(body, (state, attempt) => {
      releaseCoordinatorPass(state, attempt.passIdHash!, Date.now());
      return json({ yielded: true });
    });
  }

  private async abort(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    const permanent = body.permanent === true;
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    let claimed: ClaimedRemoteOperation;
    try {
      claimed = await this.claimRemote("abort", attempt, (existing, now) => {
        const state = this.loadAndBindState(existing, attempt, now);
        if (
          state.phase === "copy_complete" ||
          state.phase === "acknowledged" ||
          state.phase === "permanent_blocked"
        ) {
          throw new OwnerTransferCoordinatorConflictError(
            "owner_transfer_conflict",
            "A terminal ownership-transfer state cannot be aborted.",
          );
        }
        const activePass = state.activePass;
        if (
          !activePass ||
          activePass.passIdHash !== attempt.passIdHash ||
          activePass.expiresAt <= now
        ) {
          throw new OwnerTransferCoordinatorConflictError(
            "transfer_busy",
            "This bounded ownership-transfer pass no longer owns the coordinator.",
          );
        }
        state.phase = permanent ? "permanent_blocked" : "retryable_blocked";
        delete state.activePass;
        this.markReleaseDebt(state);
        return state;
      });
    } catch (error) {
      return this.conflictResponse(error);
    }
    const released = await this.releaseReservations(claimed.state);
    try {
      await this.commitClaim(claimed, async (state, txn) => {
        this.applyReservationSnapshot(state, claimed.state);
        if (released) await txn.deleteAlarm();
        else await txn.setAlarm(Date.now() + 30_000);
      });
      return released
        ? json({ aborted: true, permanent })
        : json(
            {
              code: "transfer_unavailable",
              retryable: true,
              retryAfterMs: 5_000,
              message: "Ownership-transfer teardown is still pending.",
            },
            503,
          );
    } catch (error) {
      return this.conflictResponse(error);
    }
  }

  private async acknowledge(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    let claimed: ClaimedRemoteOperation;
    try {
      claimed = await this.claimRemote(
        "acknowledge",
        attempt,
        (existing, now) => {
          if (!existing) {
            throw new ImmediateCoordinatorResponse(
              json(
                {
                  code: "owner_transfer_missing",
                  message: "The ownership-transfer operation was not found.",
                },
                404,
              ),
            );
          }
          const state = bindCoordinatorAttempt(existing, attempt, now);
          if (
            state.phase !== "copy_complete" &&
            state.phase !== "acknowledged"
          ) {
            throw new ImmediateCoordinatorResponse(
              json(
                {
                  code: "owner_transfer_incomplete",
                  message: "The ownership-transfer copy is not complete.",
                },
                409,
              ),
            );
          }
          return state;
        },
      );
    } catch (error) {
      return this.conflictResponse(error);
    }

    const state = claimed.state;
    const replayed = state.phase === "acknowledged";
    if (state.phase === "copy_complete") {
      try {
        const asserted = await this.assertReservations(state);
        if (!asserted.ok) {
          state.phase = asserted.retryable
            ? "retryable_blocked"
            : "permanent_blocked";
          const released = await this.releaseReservations(state);
          await this.commitClaim(claimed, async (current, txn) => {
            current.phase = state.phase;
            delete current.activePass;
            this.applyReservationSnapshot(current, state);
            if (released) await txn.deleteAlarm();
            else await txn.setAlarm(Date.now() + 30_000);
          });
          return json(
            {
              code: asserted.code,
              retryable: asserted.retryable,
              message:
                "Ownership-transfer acknowledgement lost its reservation.",
            },
            409,
          );
        }
      } catch (error) {
        try {
          await this.commitClaim(claimed, async (_current, txn) => {
            await txn.setAlarm(Date.now() + 30_000);
          });
        } catch (commitError) {
          return this.conflictResponse(commitError);
        }
        return this.conflictResponse(error);
      }
    }

    try {
      const retainedClaim = await this.commitClaim(
        claimed,
        async (current, txn) => {
          current.phase = "acknowledged";
          current.acknowledgedAt ??= Date.now();
          delete current.activePass;
          this.markReleaseDebt(current);
          // The acknowledgement is committed before either reservation is
          // released. A crash after this transaction is recovered by alarm.
          await txn.setAlarm(Date.now() + 1_000);
        },
        { retainClaim: true },
      );
      claimed = { ...claimed, claim: retainedClaim! };
    } catch (error) {
      return this.conflictResponse(error);
    }

    const released = await this.releaseReservations(state);
    try {
      await this.commitClaim(claimed, async (current, txn) => {
        this.applyReservationSnapshot(current, state);
        if (released) await txn.deleteAlarm();
        else await txn.setAlarm(Date.now() + 30_000);
      });
      return released
        ? json({ acknowledged: true, replayed })
        : json(
            {
              code: "transfer_unavailable",
              retryable: true,
              retryAfterMs: 5_000,
              message:
                "Ownership-transfer acknowledgement teardown is pending.",
            },
            503,
          );
    } catch (error) {
      return this.conflictResponse(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    const path = new URL(request.url).pathname;
    if (path === "/reserve") return await this.reserve(body);
    if (path === "/workspace/get") return await this.workspaceGet(body);
    if (path === "/workspace/plan") return await this.workspacePlan(body);
    if (path === "/workspace/turn-state/exported")
      return await this.workspaceTurnStateExported(body);
    if (path === "/workspace/turn-state/staged")
      return await this.workspaceTurnStateStaged(body);
    if (path === "/workspace/turn-state/activated")
      return await this.workspaceTurnStateActivated(body);
    if (path === "/workspace/turn-state/retired")
      return await this.workspaceTurnStateRetired(body);
    if (path === "/workspace/copied")
      return await this.workspaceState(body, "copied");
    if (path === "/workspace/retired")
      return await this.workspaceState(body, "retired");
    if (path === "/copied") return await this.copied(body);
    if (path === "/yield") return await this.yieldPass(body);
    if (path === "/abort") return await this.abort(body);
    if (path === "/ack") return await this.acknowledge(body);
    return json({ error: "Not found." }, 404);
  }

  async alarm(): Promise<void> {
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const existingClaim = await txn.get<RemoteClaim>(REMOTE_CLAIM_KEY);
      if (this.isLiveClaim(existingClaim, now)) {
        await txn.setAlarm(existingClaim!.expiresAt + 1_000);
        return null;
      }
      if (existingClaim) await txn.delete(REMOTE_CLAIM_KEY);
      const state = await txn.get<OwnerTransferCoordinatorState>(STATE_KEY);
      if (!state) {
        await txn.deleteAlarm();
        return null;
      }
      const revision = (await this.currentRevision(txn)) + 1;
      const claim: RemoteClaim = {
        schemaVersion: 1,
        claimId: crypto.randomUUID(),
        kind: "alarm",
        operationId: state.operationId,
        expectedRevision: revision,
        claimedAt: now,
        expiresAt: now + this.remoteClaimMs(),
      };
      await txn.put(STATE_REVISION_KEY, revision);
      await txn.put(REMOTE_CLAIM_KEY, claim);
      await txn.setAlarm(claim.expiresAt);
      return { claim, state } satisfies ClaimedRemoteOperation;
    });
    if (!claimed) return;

    const state = claimed.state;
    if (
      state.phase === "acknowledged" ||
      state.phase === "permanent_blocked" ||
      state.phase === "retryable_blocked"
    ) {
      const released = await this.releaseReservations(state);
      await this.commitClaim(claimed, async (current, txn) => {
        this.applyReservationSnapshot(current, state);
        if (released) await txn.deleteAlarm();
        else await txn.setAlarm(Date.now() + 30_000);
      });
      return;
    }

    try {
      const result = await this.ensureReservations(state, Date.now());
      if (!result.ok) {
        state.phase = result.retryable
          ? "retryable_blocked"
          : "permanent_blocked";
        delete state.activePass;
        await this.commitClaim(claimed, async (current, txn) => {
          current.phase = state.phase;
          delete current.activePass;
          this.applyReservationSnapshot(current, state);
          if (this.hasReleaseDebt(state)) {
            await txn.setAlarm(Date.now() + 30_000);
          } else {
            await txn.deleteAlarm();
          }
        });
        return;
      }
      await this.commitClaim(claimed, async (current, txn) => {
        current.phase = state.phase;
        current.activePass = state.activePass;
        current.reservationsExpireAt = state.reservationsExpireAt;
        current.sourceReservation = { ...state.sourceReservation };
        current.destinationReservation = { ...state.destinationReservation };
        await txn.setAlarm(result.alarmAt);
      });
    } catch {
      await this.commitClaim(claimed, async (current, txn) => {
        current.reservationsExpireAt = state.reservationsExpireAt;
        current.sourceReservation = { ...state.sourceReservation };
        current.destinationReservation = { ...state.destinationReservation };
        if ((state.reservationsExpireAt ?? 0) > Date.now()) {
          await txn.setAlarm(Date.now() + 30_000);
        } else {
          current.phase = "retryable_blocked";
          delete current.activePass;
          this.markReleaseDebt(state);
          this.applyReservationSnapshot(current, state);
          await txn.setAlarm(Date.now() + 30_000);
        }
      });
    }
  }
}
