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
const HEADER_OWNER_FENCE_ID = "x-stella-owner-fence-id";

type CoordinatorEnv = {
  BUILD_SESSIONS: DurableObjectNamespace;
};

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

  private async ownerFence(ownerHash: string) {
    return this.env.BUILD_SESSIONS.getByName(`owner-purge-${ownerHash}`);
  }

  private async callFence(
    ownerId: string,
    ownerHash: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<FenceResponse> {
    const response = await (
      await this.ownerFence(ownerHash)
    ).fetch(`https://build-session/owner-fence/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER_FENCE_ID]: ownerId,
      },
      body: JSON.stringify({ ...body, ownerId }),
    });
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
  ): Promise<void> {
    await Promise.all(
      [
        [
          state.fromOwnerId,
          state.fromOwnerHash,
          state.fromOwnerGeneration,
          state.sourceReservation,
        ] as const,
        [
          state.toOwnerId,
          state.toOwnerHash,
          state.toOwnerGeneration,
          state.destinationReservation,
        ] as const,
      ].map(async ([ownerId, ownerHash, ownerGeneration, reservation]) => {
        await this.callFence(ownerId, ownerHash, "unregister", {
          leaseId: reservation.leaseId,
          sessionId: this.ctx.id.toString(),
          turnId: `owner-transfer:${state.operationId}`,
          ...(reservation.generation
            ? { generation: reservation.generation }
            : {}),
          ownerGeneration,
        }).catch(() => undefined);
      }),
    );
    delete state.reservationsExpireAt;
    delete state.sourceReservation.generation;
    delete state.destinationReservation.generation;
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
      this.callFence(
        state.fromOwnerId,
        state.fromOwnerHash,
        "assert-transfer",
        {
          leaseId: state.sourceReservation.leaseId,
          sessionId,
          turnId,
          ownerGeneration: state.fromOwnerGeneration,
        },
      ),
      this.callFence(state.toOwnerId, state.toOwnerHash, "assert-transfer", {
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
        renewalBlocked?: { retryable: boolean; code: string };
      }
    | { ok: false; retryable: boolean; code: string }
  > {
    const existing = await this.assertReservations(state);
    const expiresAt = now + RESERVATION_MS;
    const source = await this.callFence(
      state.fromOwnerId,
      state.fromOwnerHash,
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
        await this.ctx.storage.setAlarm(
          Math.min(now + 30_000, state.reservationsExpireAt!),
        );
        return { ok: true, renewalBlocked: classified };
      }
      await this.releaseReservations(state);
      return { ok: false, ...classified };
    }
    state.sourceReservation.generation = source.generation;

    const destination = await this.callFence(
      state.toOwnerId,
      state.toOwnerHash,
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
        await this.ctx.storage.setAlarm(
          Math.min(now + 30_000, state.reservationsExpireAt!),
        );
        return { ok: true, renewalBlocked: classified };
      }
      await this.releaseReservations(state);
      return { ok: false, ...classified };
    }
    state.destinationReservation.generation = destination.generation;
    state.reservationsExpireAt = expiresAt;
    state.phase =
      state.phase === "copy_complete" ? "copy_complete" : "reserved";
    await this.ctx.storage.setAlarm(now + RESERVATION_RENEW_MS);
    return { ok: true };
  }

  private async loadAndBind(
    attempt: OwnerTransferCoordinatorAttempt,
    now: number,
  ): Promise<OwnerTransferCoordinatorState> {
    let state =
      await this.ctx.storage.get<OwnerTransferCoordinatorState>(STATE_KEY);
    if (!state) {
      state = createCoordinatorState(attempt, now, {
        source: crypto.randomUUID(),
        destination: crypto.randomUUID(),
      });
    } else {
      bindCoordinatorAttempt(state, attempt, now);
    }
    return state;
  }

  private conflictResponse(error: unknown): Response {
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
    return await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      let state: OwnerTransferCoordinatorState;
      try {
        state = await this.loadAndBind(attempt, now);
        if (state.phase === "acknowledged") {
          return json({ status: "acknowledged", result: state.result });
        }
        if (state.phase === "permanent_blocked") {
          return json(
            {
              code: "owner_purge_permanent",
              message:
                "An account in this transfer is being permanently deleted.",
            },
            409,
          );
        }
        if (state.phase === "copy_complete") {
          const asserted = await this.assertReservations(state);
          if (asserted.ok) {
            return json({ status: "copy_complete", result: state.result });
          }
          state.phase = asserted.retryable
            ? "retryable_blocked"
            : "permanent_blocked";
          await this.releaseReservations(state);
          await this.ctx.storage.put(STATE_KEY, state);
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
        acquireCoordinatorPass(state, passIdHash, now, now + PASS_MS);
        await this.ctx.storage.put(STATE_KEY, state);
      } catch (error) {
        return this.conflictResponse(error);
      }

      try {
        if (state.phase === "retryable_blocked") state.phase = "reserving";
        const reservation = await this.ensureReservations(state, now);
        if (!reservation.ok) {
          state.phase = reservation.retryable
            ? "retryable_blocked"
            : "permanent_blocked";
          releaseCoordinatorPass(state, passIdHash, Date.now());
          await this.ctx.storage.put(STATE_KEY, state);
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
          await this.ctx.storage.put(STATE_KEY, state);
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
        await this.ctx.storage.put(STATE_KEY, state);
        return json({
          status: "reserved",
          reservation: this.reservationEnvelope(state),
        });
      } catch {
        // A transport failure does not prove a durable reservation vanished.
        // Keep its bounded expiry/alarm, but release the per-pass mutex so a
        // control-plane retry can reconcile the same stable lease promptly.
        releaseCoordinatorPass(state, passIdHash, Date.now());
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
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
    });
  }

  private async withPassState(
    body: Record<string, unknown>,
    update: (
      state: OwnerTransferCoordinatorState,
      attempt: OwnerTransferCoordinatorAttempt,
    ) => Response | Promise<Response>,
  ): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const state = await this.loadAndBind(attempt, Date.now());
        const activePass = state.activePass;
        if (
          activePass?.passIdHash !== attempt.passIdHash ||
          !activePass ||
          activePass.expiresAt <= Date.now()
        ) {
          throw new OwnerTransferCoordinatorConflictError(
            "transfer_busy",
            "This bounded ownership-transfer pass no longer owns the coordinator.",
          );
        }
        return await update(state, attempt);
      } catch (error) {
        return this.conflictResponse(error);
      }
    });
  }

  private async workspacePlan(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const observation = parseObservation(body.observation);
    if (!observation) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, async (state) => {
      const plan = claimWorkspacePlan(state, observation);
      state.updatedAt = Date.now();
      await this.ctx.storage.put(STATE_KEY, state);
      return json({ plan });
    });
  }

  private async workspaceGet(body: Record<string, unknown>): Promise<Response> {
    const workspacePlanId =
      typeof body.workspacePlanId === "string" ? body.workspacePlanId : "";
    if (!HASH_PATTERN.test(workspacePlanId)) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.withPassState(body, async (state) =>
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
    return await this.withPassState(body, async (state) => {
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
      const worldHash = await sha256Hex(WORLD_REGISTRY_SEGMENT);
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
        if (JSON.stringify(plan.turnState.manifest) !== JSON.stringify(manifest)) {
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
      await this.ctx.storage.put(STATE_KEY, state);
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
    return await this.withPassState(body, async (state) => {
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
      await this.ctx.storage.put(STATE_KEY, state);
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
    return await this.withPassState(body, async (state) => {
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
      await this.ctx.storage.put(STATE_KEY, state);
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
    return await this.withPassState(body, async (state) => {
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
      await this.ctx.storage.put(STATE_KEY, state);
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
    return await this.withPassState(body, async (state) => {
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
      await this.ctx.storage.put(STATE_KEY, state);
      return json({ plan });
    });
  }

  private async copied(body: Record<string, unknown>): Promise<Response> {
    return await this.withPassState(body, async (state, attempt) => {
      const asserted = await this.assertReservations(state);
      if (!asserted.ok) {
        state.phase = asserted.retryable
          ? "retryable_blocked"
          : "permanent_blocked";
        releaseCoordinatorPass(state, attempt.passIdHash!, Date.now());
        await this.releaseReservations(state);
        await this.ctx.storage.put(STATE_KEY, state);
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
      await this.ctx.storage.put(STATE_KEY, state);
      await this.ctx.storage.setAlarm(Date.now() + RESERVATION_RENEW_MS);
      return json({ status: "copy_complete", result: state.result });
    });
  }

  private async yieldPass(body: Record<string, unknown>): Promise<Response> {
    return await this.withPassState(body, async (state, attempt) => {
      releaseCoordinatorPass(state, attempt.passIdHash!, Date.now());
      await this.ctx.storage.put(STATE_KEY, state);
      return json({ yielded: true });
    });
  }

  private async abort(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    const permanent = body.permanent === true;
    if (!attempt?.passIdHash) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const now = Date.now();
        const state = await this.loadAndBind(attempt, now);
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
        await this.ctx.storage.put(STATE_KEY, state);
        await this.releaseReservations(state);
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.deleteAlarm();
        return json({ aborted: true, permanent });
      } catch (error) {
        return this.conflictResponse(error);
      }
    });
  }

  private async acknowledge(body: Record<string, unknown>): Promise<Response> {
    const attempt = await parseAttempt(body.attempt);
    if (!attempt) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const state =
          await this.ctx.storage.get<OwnerTransferCoordinatorState>(STATE_KEY);
        if (!state) {
          return json(
            {
              code: "owner_transfer_missing",
              message: "The ownership-transfer operation was not found.",
            },
            404,
          );
        }
        bindCoordinatorAttempt(state, attempt, Date.now());
        const replayed = state.phase === "acknowledged";
        if (state.phase !== "copy_complete" && state.phase !== "acknowledged") {
          return json(
            {
              code: "owner_transfer_incomplete",
              message: "The ownership-transfer copy is not complete.",
            },
            409,
          );
        }
        if (state.phase === "copy_complete") {
          const asserted = await this.assertReservations(state);
          if (!asserted.ok) {
            state.phase = asserted.retryable
              ? "retryable_blocked"
              : "permanent_blocked";
            await this.releaseReservations(state);
            await this.ctx.storage.put(STATE_KEY, state);
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
        }
        state.phase = "acknowledged";
        state.acknowledgedAt ??= Date.now();
        delete state.activePass;
        // Commit the acknowledgement before releasing either reservation. A
        // crash after this write is recovered by alarm/replayed acknowledge.
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
        await this.releaseReservations(state);
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.deleteAlarm();
        return json({ acknowledged: true, replayed });
      } catch (error) {
        return this.conflictResponse(error);
      }
    });
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
    await this.ctx.blockConcurrencyWhile(async () => {
      const state =
        await this.ctx.storage.get<OwnerTransferCoordinatorState>(STATE_KEY);
      if (!state) return;
      if (
        state.phase === "acknowledged" ||
        state.phase === "permanent_blocked" ||
        state.phase === "retryable_blocked"
      ) {
        await this.releaseReservations(state);
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      try {
        const result = await this.ensureReservations(state, Date.now());
        if (!result.ok) {
          state.phase = result.retryable
            ? "retryable_blocked"
            : "permanent_blocked";
          delete state.activePass;
          await this.ctx.storage.put(STATE_KEY, state);
          await this.ctx.storage.deleteAlarm();
          return;
        }
        await this.ctx.storage.put(STATE_KEY, state);
      } catch {
        if ((state.reservationsExpireAt ?? 0) > Date.now()) {
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        } else {
          state.phase = "retryable_blocked";
          delete state.activePass;
          await this.ctx.storage.put(STATE_KEY, state);
          await this.ctx.storage.deleteAlarm();
        }
      }
    });
  }
}
