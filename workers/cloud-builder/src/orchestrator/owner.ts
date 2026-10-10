import type { OwnerHomeContext } from "../owner-home-context.js";
import {
  OWNER_EVENT_VERSION,
  type OwnerEvent,
} from "@stella/contracts/turn-plane/owner-events";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  type OwnerGateAdmission,
  type OwnerGateAdmitInput,
  OwnerGateSnapshotError,
} from "../owner-gate.js";
import { deliverOwnerEvents } from "../owner-events.js";
import { AgentHome } from "../agent-home.js";
import { ownerMemoryWorld } from "../world-memory.js";
import { sha256Hex } from "../hash.js";
import type { ConversationOwnerRecord } from "../conversation-types.js";
import type {
  ChatTurnRequest,
  OwnerFencedTurn,
  OwnerFenceLeaseReceipt,
  OwnerFenceRunSlot,
  OwnerFenceRegisterRequest,
  OwnerFenceRegisterTransport,
} from "./types.js";
import {
  ORCHESTRATOR_FENCE_LEASE_RECEIPT_PREFIX,
  OWNER_FENCE_RUN_SLOT_PREFIX,
  OWNER_FENCE_ID_HEADER,
  OWNER_EVENT_BATCH_PREFIX,
  OWNER_EVENT_DEBT_RETRY_MS,
  ownerPurgeImportedLeaseKey,
  orchestratorFenceLeaseReceiptKey,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  OwnerFenceLeaseConflictError,
  OwnerFenceRegistrationUncertainError,
  measureInto,
  errorMessage,
  log,
  requireCloudContext,
} from "./support.js";
import { OrchestratorSessionCore } from "./session-core.js";

/**
 * Owner fence leases, the owner gate, owner events, and the owner's home
 * context.
 */
export abstract class OrchestratorOwner extends OrchestratorSessionCore {
  protected async callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.env.OWNER_GATES.getByName(ownerId).fetch(
      `https://owner-gate/owner-fence/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [OWNER_FENCE_ID_HEADER]: ownerId,
        },
        body: JSON.stringify({ ...body, ownerId }),
      },
    );
  }

  protected ownerFenceReceiptMatches(
    receipt: OwnerFenceLeaseReceipt,
    target: Pick<OwnerFencedTurn, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
  ): boolean {
    return (
      receipt.schemaVersion === 1 &&
      receipt.ownerId === target.ownerId &&
      receipt.ownerGeneration === target.ownerGeneration &&
      receipt.turnId === target.turnId &&
      receipt.leaseId === leaseId
    );
  }

  protected async ownerFenceRunSlotKey(turn: OwnerFencedTurn): Promise<string> {
    const identityHash = await sha256Hex(
      JSON.stringify({
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
      }),
    );
    return `${OWNER_FENCE_RUN_SLOT_PREFIX}${identityHash}`;
  }

  protected async armOwnerFenceLeaseReconciliationAlarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const retryAt = Date.now() + 30_000;
      await this.armAlarmNoLaterThan(retryAt);
    });
  }

  protected async hasOwnerFenceLeaseRetirementDebt(): Promise<boolean> {
    const receipts = await this.ctx.storage.list<OwnerFenceLeaseReceipt>({
      prefix: ORCHESTRATOR_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 100,
    });
    return [...receipts.values()].some(
      (receipt) => receipt.phase === "unregister_pending",
    );
  }

  /** Retirements or projections the alarm still owes. */
  protected async hasMaintenanceDebt(): Promise<boolean> {
    return (
      (await this.hasOwnerFenceLeaseRetirementDebt()) ||
      (await this.hasOwnerEventDebt())
    );
  }

  protected async retryOwnerFenceLeaseRetirements(): Promise<void> {
    const receipts = await this.ctx.storage.list<OwnerFenceLeaseReceipt>({
      prefix: ORCHESTRATOR_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 100,
    });
    for (const receipt of receipts.values()) {
      if (receipt.phase !== "unregister_pending") continue;
      await this.retireOwnerFenceLeaseReceipt(receipt);
    }
    if (await this.hasMaintenanceDebt()) {
      await this.armOwnerFenceLeaseReconciliationAlarm();
    }
  }

  /**
   * Retire one exact durable lease receipt. The pending state is written before
   * the cross-DO request, so a lost response is replayable after isolate loss.
   */
  protected async retireOwnerFenceLeaseReceipt(
    receipt: OwnerFenceLeaseReceipt,
    generation = receipt.registrationGeneration,
  ): Promise<boolean> {
    const receiptKey = orchestratorFenceLeaseReceiptKey(receipt.leaseId);
    let pending = receipt;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        current &&
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        throw new OwnerPurgeFenceError();
      }
      pending = {
        ...(current ?? receipt),
        phase: "unregister_pending",
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(receiptKey, pending);
    });

    let response: Response;
    try {
      response = await this.callOwnerFence(pending.ownerId, "unregister", {
        ownerGeneration: pending.ownerGeneration,
        leaseId: pending.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: pending.turnId,
        ...(generation ? { generation } : {}),
      });
    } catch (error) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        message: errorMessage(error),
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }
    if (!response.ok) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        status: response.status,
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        current &&
        this.ownerFenceReceiptMatches(current, pending, pending.leaseId)
      ) {
        await this.ctx.storage.delete(receiptKey);
      }
      if (pending.runSlotKey) {
        const slot = await this.ctx.storage.get<OwnerFenceRunSlot>(
          pending.runSlotKey,
        );
        if (slot?.leaseId === pending.leaseId) {
          await this.ctx.storage.delete(pending.runSlotKey);
        }
      }
    });
    return true;
  }

  protected async registerOwnerTurn(
    turn: OwnerFencedTurn,
    freshLease = false,
    operationFingerprint?: string,
    transport: OwnerFenceRegisterTransport = (ownerId, body) =>
      this.registerOwnerFenceLease(ownerId, body),
  ): Promise<string> {
    const runSlotKey = freshLease
      ? undefined
      : await this.ownerFenceRunSlotKey(turn);
    let receipt!: OwnerFenceLeaseReceipt;
    await this.ctx.blockConcurrencyWhile(async () => {
      const slot = runSlotKey
        ? await this.getTurnState<OwnerFenceRunSlot>(runSlotKey)
        : undefined;
      if (
        slot &&
        (slot.schemaVersion !== 1 ||
          slot.ownerId !== turn.ownerId ||
          slot.ownerGeneration !== turn.ownerGeneration ||
          slot.turnId !== turn.turnId)
      ) {
        throw new OwnerPurgeFenceError();
      }
      const leaseId = freshLease
        ? crypto.randomUUID()
        : (turn.ownerPurgeLeaseId ?? slot?.leaseId ?? crypto.randomUUID());
      const receiptKey = orchestratorFenceLeaseReceiptKey(leaseId);
      const current =
        await this.getTurnState<OwnerFenceLeaseReceipt>(receiptKey);
      if (await this.getTurnState(ownerPurgeImportedLeaseKey(leaseId)))
        throw new OwnerPurgeFenceError();
      if (current && !this.ownerFenceReceiptMatches(current, turn, leaseId)) {
        throw new OwnerPurgeFenceError();
      }
      if (
        current?.operationFingerprint &&
        operationFingerprint &&
        current.operationFingerprint !== operationFingerprint
      ) {
        throw new OwnerFenceLeaseConflictError();
      }
      // Reusing a registered lease is a read. Rewriting its unchanged receipt
      // and run slot adds a durable write barrier to every admitted turn.
      if (
        current?.phase === "registered" &&
        current.registrationGeneration &&
        (!operationFingerprint ||
          current.operationFingerprint === operationFingerprint) &&
        (!runSlotKey || slot?.leaseId === current.leaseId)
      ) {
        receipt = current;
        return;
      }
      const now = Date.now();
      receipt = current
        ? {
            ...current,
            ...(operationFingerprint && !current.operationFingerprint
              ? { operationFingerprint }
              : {}),
          }
        : {
            schemaVersion: 1,
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            turnId: turn.turnId,
            leaseId,
            kind: freshLease ? "aux" : "run",
            phase: "registering",
            ...(turn.ownerPurgeGeneration
              ? { registrationGeneration: turn.ownerPurgeGeneration }
              : {}),
            ...(runSlotKey ? { runSlotKey } : {}),
            ...(operationFingerprint ? { operationFingerprint } : {}),
            createdAt: now,
            updatedAt: now,
          };
      turn.ownerPurgeLeaseId = leaseId;
      if (receipt.registrationGeneration) {
        turn.ownerPurgeGeneration = receipt.registrationGeneration;
      }
      const writes: Record<string, unknown> = { [receiptKey]: receipt };
      if (runSlotKey) {
        writes[runSlotKey] = {
          schemaVersion: 1,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          turnId: turn.turnId,
          leaseId,
        } satisfies OwnerFenceRunSlot;
      }
      // The exact lease id is durable before owner-fence/register can commit.
      await this.putTurnState(writes);
    });

    if (receipt.phase === "unregister_pending") {
      if (!(await this.retireOwnerFenceLeaseReceipt(receipt))) {
        throw new OwnerPurgeFenceError();
      }
      delete turn.ownerPurgeLeaseId;
      delete turn.ownerPurgeGeneration;
      return await this.registerOwnerTurn(
        turn,
        freshLease,
        operationFingerprint,
        transport,
      );
    }
    if (receipt.phase === "registered" && receipt.registrationGeneration) {
      turn.ownerPurgeLeaseId = receipt.leaseId;
      turn.ownerPurgeGeneration = receipt.registrationGeneration;
      return receipt.registrationGeneration;
    }

    let body: { generation: string } | null;
    try {
      body = await transport(turn.ownerId, {
        ownerGeneration: receipt.ownerGeneration,
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: receipt.turnId,
        namespace: "orchestrator",
        role: "orchestrator",
        ...(receipt.registrationGeneration
          ? { generation: receipt.registrationGeneration }
          : {}),
      });
    } catch {
      // The remote Durable Object may have committed before the response was
      // lost. Preserve the exact intent so replay uses the same lease id.
      throw new OwnerFenceRegistrationUncertainError();
    }
    if (!body) throw new OwnerPurgeFenceError();

    let committed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const receiptKey = orchestratorFenceLeaseReceiptKey(receipt.leaseId);
      const current =
        await this.getTurnState<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        !current ||
        current.phase === "unregister_pending" ||
        (await this.getTurnState(
          ownerPurgeImportedLeaseKey(receipt.leaseId),
        )) ||
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        return;
      }
      receipt = {
        ...current,
        phase: "registered",
        registrationGeneration: body.generation,
        updatedAt: Date.now(),
      };
      await this.putTurnState({ [receiptKey]: receipt });
      committed = true;
    });
    if (!committed) {
      // A concurrent purge retired the local intent while register was in
      // flight. Best-effort exact rollback; the purge still owns retry.
      await this.callOwnerFence(receipt.ownerId, "unregister", {
        ownerGeneration: receipt.ownerGeneration,
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: receipt.turnId,
        generation: body.generation,
      }).catch(() => undefined);
      throw new OwnerPurgeFenceError();
    }
    turn.ownerPurgeLeaseId = receipt.leaseId;
    turn.ownerPurgeGeneration = body.generation;
    return body.generation;
  }

  /** The default register transport: one `POST /owner-fence/register`. */
  protected async registerOwnerFenceLease(
    ownerId: string,
    body: OwnerFenceRegisterRequest,
  ): Promise<{ generation: string } | null> {
    const response = await this.callOwnerFence(ownerId, "register", body);
    const parsed = (await response.json().catch(() => null)) as {
      generation?: string;
    } | null;
    return response.ok && parsed?.generation
      ? { generation: parsed.generation }
      : null;
  }

  /**
   * A new local turn's owner lookup and fence registration in one gate round
   * trip. The gate registers the lease only while its snapshot still says
   * the owner is writable at `turn.ownerGeneration`, so a stale caller never
   * leaves a lease behind. The durable receipt protocol is registerOwnerTurn's,
   * unchanged; only the transport differs. A replayed registration (receipt
   * already `registered`) makes no register call and reads the snapshot on
   * its own.
   */
  protected async registerOwnerTurnWithSnapshot(
    turn: OwnerFencedTurn,
    operationFingerprint: string,
  ): Promise<
    | { registered: true; generation: string; snapshot: OwnerSnapshot }
    | {
        registered: false;
        reason: "not_writable" | "generation_stale";
        snapshot: OwnerSnapshot;
      }
  > {
    const observed: {
      snapshot?: OwnerSnapshot;
      skipped?: "not_writable" | "generation_stale";
      snapshotError?: OwnerGateSnapshotError;
    } = {};
    let generation: string;
    try {
      generation = await this.registerOwnerTurn(
        turn,
        false,
        operationFingerprint,
        async (ownerId, body) => {
          const outcome = await this.ownerGate(ownerId).snapshotWithFenceLease({
            lease: body,
          });
          if (!outcome.snapshot) {
            observed.snapshotError = new OwnerGateSnapshotError(
              outcome.snapshotError.code,
              outcome.snapshotError.message,
              outcome.snapshotError.retryable,
            );
            return null;
          }
          observed.snapshot = outcome.snapshot;
          if (outcome.lease.status === "registered") {
            return { generation: outcome.lease.generation };
          }
          if (outcome.lease.status === "skipped") {
            observed.skipped = outcome.lease.reason;
          }
          return null;
        },
      );
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        // A snapshot the gate could not obtain fails the way the separate
        // snapshot read used to: nothing was registered.
        if (observed.snapshotError) throw observed.snapshotError;
        if (observed.skipped && observed.snapshot) {
          return {
            registered: false,
            reason: observed.skipped,
            snapshot: observed.snapshot,
          };
        }
      }
      throw error;
    }
    const snapshot =
      observed.snapshot ?? (await this.ownerGateSnapshot(turn.ownerId));
    return { registered: true, generation, snapshot };
  }

  protected async assertOwnerTurn(turn: OwnerFencedTurn): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const response = await this.callOwnerFence(turn.ownerId, "assert", {
      ownerGeneration: turn.ownerGeneration,
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
  }

  protected async assertOwnerFenceLeaseReceiptActive(
    turn: OwnerFencedTurn,
  ): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const receipt = await this.ctx.storage.get<OwnerFenceLeaseReceipt>(
      orchestratorFenceLeaseReceiptKey(turn.ownerPurgeLeaseId),
    );
    if (
      !receipt ||
      receipt.phase !== "registered" ||
      receipt.registrationGeneration !== turn.ownerPurgeGeneration ||
      !this.ownerFenceReceiptMatches(receipt, turn, turn.ownerPurgeLeaseId)
    ) {
      throw new OwnerPurgeFenceError();
    }
  }

  protected async retireOwnerFenceLeaseByIdentity(
    turn: Pick<OwnerFencedTurn, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
    generation?: string,
  ): Promise<boolean> {
    const receiptKey = orchestratorFenceLeaseReceiptKey(leaseId);
    let receipt =
      await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
    if (receipt && !this.ownerFenceReceiptMatches(receipt, turn, leaseId)) {
      log("error", "owner_fence_unregister_identity_conflict", {
        turnId: turn.turnId,
        leaseId,
      });
      return false;
    }
    if (!receipt) {
      // Rolling-deploy repair for a lease admitted before the durable receipt.
      const now = Date.now();
      const possibleRunSlotKey = await this.ownerFenceRunSlotKey(turn);
      const possibleRunSlot =
        await this.ctx.storage.get<OwnerFenceRunSlot>(possibleRunSlotKey);
      const runSlotKey =
        possibleRunSlot?.leaseId === leaseId ? possibleRunSlotKey : undefined;
      receipt = {
        schemaVersion: 1,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        leaseId,
        kind: runSlotKey ? "run" : "aux",
        phase: "unregister_pending",
        ...(generation ? { registrationGeneration: generation } : {}),
        ...(runSlotKey ? { runSlotKey } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(receiptKey, receipt);
    }
    return await this.retireOwnerFenceLeaseReceipt(receipt, generation);
  }

  protected async unregisterOwnerTurn(turn: OwnerFencedTurn): Promise<boolean> {
    const leaseId = turn.ownerPurgeLeaseId;
    if (!leaseId) return true;
    return await this.retireOwnerFenceLeaseByIdentity(
      turn,
      leaseId,
      turn.ownerPurgeGeneration,
    );
  }

  protected async ownerGateSnapshot(ownerId: string): Promise<OwnerSnapshot> {
    return await this.ownerGate(ownerId).snapshot();
  }

  /** A refusal, never a throw: the caller maps it to the start contract. */
  protected async ownerGateAdmit(
    ownerId: string,
    input: OwnerGateAdmitInput,
  ): Promise<OwnerGateAdmission> {
    try {
      return await this.ownerGate(ownerId).admit(input);
    } catch (error) {
      log("error", "owner_gate_admit_failed", {
        turnId: input.turnId,
        lane: input.lane,
        message: errorMessage(error),
      });
      return {
        ok: false,
        code: "internal",
        message: "Stella can't check your plan right now. Try again shortly.",
        retryable: true,
      };
    }
  }

  /**
   * Best-effort and idempotent. A release the gate never receives is bounded
   * by its own `TURN_TIMEOUT_MS` grace, so a lost call costs a slot for
   * minutes, never forever.
   */
  protected async releaseOwnerGate(
    turn: Pick<ChatTurnRequest, "ownerId" | "turnId">,
  ): Promise<void> {
    try {
      await this.ownerGate(turn.ownerId).release({ turnId: turn.turnId });
    } catch (error) {
      log("error", "owner_gate_release_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
    }
  }

  /**
   * Persist the events locally, then deliver; the owner round trip must not
   * delay a reply. For the events a turn owes (`conversation.created`,
   * `turn.started`, `thread.spawned`, `conversation.deleted`) an unreachable
   * owner must never turn into a lost row: the owner cannot index a
   * conversation it never heard of, so the alarm retries every batch still
   * on disk.
   */
  protected async deferOwnerEvents(events: OwnerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const key = `${OWNER_EVENT_BATCH_PREFIX}${crypto.randomUUID()}`;
    await this.ctx.blockConcurrencyWhile(async () => {
      const retryAt = Date.now() + OWNER_EVENT_DEBT_RETRY_MS;
      await this.armAlarmNoLaterThan(retryAt);
      await this.putTurnState({ [key]: events });
    });
    void this.deliverDeferredOwnerEvents(key, events).catch(
      (error: unknown) => {
        log("error", "owner_events_delivery_failed", {
          message: errorMessage(error),
        });
      },
    );
  }

  protected async deliverDeferredOwnerEvents(
    key: string,
    events: OwnerEvent[],
  ): Promise<void> {
    try {
      await deliverOwnerEvents(this.env, events);
      // Each batch owns its key. A concurrent append or retry cannot be erased
      // by an earlier send completing; duplicate sends remain idempotent.
      if (this.ctx.storage.kv) this.ctx.storage.kv.delete(key);
      else await this.ctx.storage.delete(key);
    } catch (error) {
      log("error", "owner_events_deferred", {
        events: events.map((event) => `${event.kind}:${event.key}`),
        message: errorMessage(error),
      });
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!(await this.ctx.storage.get(key))) return;
        const retryAt = Date.now() + OWNER_EVENT_DEBT_RETRY_MS;
        await this.armAlarmNoLaterThan(retryAt);
      });
    }
  }

  protected async hasOwnerEventDebt(): Promise<boolean> {
    const batches = await this.ctx.storage.list({
      prefix: OWNER_EVENT_BATCH_PREFIX,
      limit: 1,
    });
    return batches.size > 0;
  }

  protected async retryOwnerEventDebt(): Promise<void> {
    const batches = await this.ctx.storage.list<OwnerEvent[]>({
      prefix: OWNER_EVENT_BATCH_PREFIX,
    });
    await Promise.all(
      [...batches].map(([key, events]) =>
        this.deliverDeferredOwnerEvents(key, events),
      ),
    );
  }

  protected ownerEventBase(
    turn: Pick<ChatTurnRequest, "ownerId" | "ownerGeneration">,
    key: string,
  ) {
    return {
      v: OWNER_EVENT_VERSION,
      key,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      emittedAt: Date.now(),
    } as const;
  }

  /**
   * The owner of this conversation for a verified caller — the session is
   * the authority. Bound: the caller must be the owner (null otherwise, so the
   * route answers 404 and confirms nothing). Unbound: adopt the caller. This
   * is what lets a client subscribe to a conversation it has just minted
   * before its first turn: the socket binds the prospective owner, and the
   * first turn projects `conversation.created` to the owner. The generation
   * comes from the owner gate's snapshot; a write path passes
   * `refreshGeneration` because a new write capability must be fenced on the
   * generation that is current now, not the one cached with the last turn.
   */
  protected async resolveOwnerForCaller(
    caller: { ownerId: string },
    options: { refreshGeneration?: boolean } = {},
  ): Promise<ConversationOwnerRecord | null> {
    const callerId = caller.ownerId.trim();
    if (!callerId || this.purged()) return null;
    const meta = this.journal.meta();
    if (meta.owner_id && meta.owner_id !== callerId) return null;
    if (meta.owner_id && this.ownerGeneration && !options.refreshGeneration) {
      return {
        ownerId: meta.owner_id,
        ownerGeneration: this.ownerGeneration,
        createdAt: meta.created_at,
        title: meta.title,
      };
    }
    const snapshot = await this.ownerGateSnapshot(callerId);
    return await this.adoptOwnerSnapshot(callerId, snapshot);
  }

  /**
   * The half of resolveOwnerForCaller that runs once a snapshot is in hand:
   * the write fence, adoption of an unbound conversation, and the persisted
   * owner generation. Shared with the local-turn begin path, whose snapshot
   * arrives together with its fence registration.
   */
  protected async adoptOwnerSnapshot(
    callerId: string,
    snapshot: OwnerSnapshot,
  ): Promise<ConversationOwnerRecord | null> {
    if (!snapshot.writable) return null;
    if (this.purged()) return null;
    if (!this.journal.meta().owner_id) {
      const conversationId = this.conversationId();
      this.journal.bindOwner({
        ownerId: callerId,
        ownerGeneration: snapshot.ownerGeneration,
        createdAt: Date.now(),
        title: "",
        conversationId,
      });
      log("info", "conversation_adopted", { conversationId, via: "connect" });
    }
    if (this.ownerGeneration !== snapshot.ownerGeneration) {
      this.ownerGeneration = snapshot.ownerGeneration;
      await this.ctx.storage.put(
        "ownerDataGeneration",
        snapshot.ownerGeneration,
      );
    }
    const bound = this.journal.meta();
    return {
      ownerId: bound.owner_id,
      ownerGeneration: snapshot.ownerGeneration,
      createdAt: bound.created_at,
      title: bound.title,
    };
  }

  protected async prepareCloudHomeContext(
    turn: ChatTurnRequest,
    admittedContext?: OwnerHomeContext,
  ) {
    const timings: Record<string, number> = {};
    const measure = measureInto(timings);
    const home = this.cloudAgentHome(turn);
    const metadata =
      admittedContext ??
      (await measure("homeMetadataMs", async () => {
        if (!turn.ownerPurgeGeneration) {
          // Initial separate registration has not finished yet. This bootstrap
          // uses the original authoritative reads; warm admission carries metadata.
          const [memory, skills] = await Promise.all([
            home.cloudStore().getMemoryContext(),
            home.loadSkillCatalog("orchestrator"),
          ]);
          return { revision: 0, memory, skills };
        }
        return await this.ownerGate(turn.ownerId).homeContext(
          turn.ownerGeneration,
          turn.ownerPurgeGeneration,
        );
      }));
    timings.homeMetadataRevision = metadata.revision;
    if (this.purged()) throw new Error("Conversation was purged.");
    const memoryPreference = metadata.memory.preference;
    // Memory is plain world files that change without a home revision, so
    // the resident documents and the personality are read fresh every turn.
    const [memoryDocuments, personalityOverride] =
      memoryPreference.memoryEnabled
        ? await Promise.all([
            measure("memoryDocumentsMs", () =>
              requireCloudContext("agent_home_memory", home.readDocuments()),
            ),
            measure("personalityMs", () =>
              requireCloudContext(
                "agent_home_personality",
                home.readPersonality(),
              ),
            ),
          ])
        : [[], null];
    return {
      memoryPreference,
      memoryDocuments,
      personalityOverride,
      skillCatalog: metadata.skills,
      timings,
    };
  }

  /**
   * The owner's agent home for one turn: skills from the cloud home, memory
   * from the owner's world.
   */
  protected cloudAgentHome(turn: ChatTurnRequest): AgentHome {
    const worlds = this.env.WORLDS as typeof this.env.WORLDS | undefined;
    return new AgentHome(
      this.env.AGENT_HOME,
      turn.ownerId,
      {
        control: (op, body) =>
          this.ownerGate(turn.ownerId).homeControl({ op, body }),
        ownerGeneration: turn.ownerGeneration,
      },
      worlds ? () => ownerMemoryWorld(worlds, turn.ownerId) : undefined,
    );
  }
}
