import { sha256Hex } from "../hash.js";
import { OWNER_FENCE_LEASE_TTL_MS } from "../owner-fence-do.js";
import type { BuildSessionInternals } from "./host.js";
import { OwnerPurgeFenceError } from "./shared/errors.js";
import {
  BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
  BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX,
  OWNER_FENCE_LEASE_RETRY_MS,
  buildOwnerFenceLeaseReceiptKey,
  errorMessage,
  log,
} from "./shared/keys.js";
import type {
  BuildOwnerFenceLeaseReceipt,
  BuildOwnerFenceLeaseSlot,
  TurnRequest,
} from "./shared/types.js";

export type OwnerFenceLeaseHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "armOwnerFenceLeaseReconciliationAlarm"
  | "callOwnerFence"
  | "hasOwnerFenceLeaseRetirementDebt"
  | "ownerFenceReceiptMatches"
  | "retireBuildOwnerFenceLease"
>;

export const ownerFenceReceiptMatches = (
  host: OwnerFenceLeaseHost,
  receipt: BuildOwnerFenceLeaseReceipt,
  target: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "turnId">,
  leaseId: string,
): boolean => {
  return (
    receipt.schemaVersion === 1 &&
    receipt.ownerId === target.ownerId &&
    receipt.ownerGeneration === target.ownerGeneration &&
    receipt.turnId === target.turnId &&
    receipt.leaseId === leaseId
  );
};

export const ownerFenceLeaseSlotKey = async (
  host: OwnerFenceLeaseHost,
  turn: TurnRequest,
  kind: BuildOwnerFenceLeaseReceipt["kind"],
): Promise<string> => {
  const identity = await sha256Hex(
    JSON.stringify({
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration ?? 1,
      kind,
    }),
  );
  return `${BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX}${identity}`;
};

export const armOwnerFenceLeaseReconciliationAlarm = async (
  host: OwnerFenceLeaseHost,
): Promise<void> => {
  const retryAt = Date.now() + OWNER_FENCE_LEASE_RETRY_MS;
  await host.ctx.storage.transaction(async (txn) => {
    const current = await txn.getAlarm();
    if (current === null || current > retryAt) await txn.setAlarm(retryAt);
  });
};

export const hasOwnerFenceLeaseRetirementDebt = async (
  host: OwnerFenceLeaseHost,
): Promise<boolean> => {
  const receipts = await host.ctx.storage.list<BuildOwnerFenceLeaseReceipt>({
    prefix: BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
    limit: 512,
  });
  return [...receipts.values()].some(
    (receipt) => receipt.phase === "unregister_pending",
  );
};

export const retryOwnerFenceLeaseRetirements = async (
  host: OwnerFenceLeaseHost,
): Promise<void> => {
  const receipts = await host.ctx.storage.list<BuildOwnerFenceLeaseReceipt>({
    prefix: BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
    limit: 512,
  });
  for (const receipt of receipts.values()) {
    if (receipt.phase !== "unregister_pending") continue;
    await host.retireBuildOwnerFenceLease(receipt);
  }
  if (await host.hasOwnerFenceLeaseRetirementDebt()) {
    await host.armOwnerFenceLeaseReconciliationAlarm();
  }
};

export const registerBuildOwnerFenceLease = async (
  host: OwnerFenceLeaseHost,
  args: {
    turn: TurnRequest;
    kind: BuildOwnerFenceLeaseReceipt["kind"];
    role: "run" | "aux";
    slotKey?: string;
    leaseId?: string;
    mutateTurn?: boolean;
  },
): Promise<{ generation: string; expiresAt: number; leaseId: string }> => {
  let receipt!: BuildOwnerFenceLeaseReceipt;
  await host.ctx.storage.transaction(async (txn) => {
    const slot = args.slotKey
      ? await txn.get<BuildOwnerFenceLeaseSlot>(args.slotKey)
      : undefined;
    if (
      slot &&
      (slot.schemaVersion !== 1 ||
        slot.ownerId !== args.turn.ownerId ||
        slot.ownerGeneration !== args.turn.ownerGeneration ||
        slot.turnId !== args.turn.turnId ||
        slot.kind !== args.kind)
    ) {
      throw new OwnerPurgeFenceError();
    }
    const leaseId =
      args.leaseId ??
      (args.mutateTurn ? args.turn.ownerPurgeLeaseId : undefined) ??
      slot?.leaseId ??
      crypto.randomUUID();
    if (slot && slot.leaseId !== leaseId) throw new OwnerPurgeFenceError();
    const key = buildOwnerFenceLeaseReceiptKey(leaseId);
    const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
    if (
      current &&
      (!host.ownerFenceReceiptMatches(current, args.turn, leaseId) ||
        current.kind !== args.kind)
    ) {
      throw new OwnerPurgeFenceError();
    }
    const now = Date.now();
    receipt = current ?? {
      schemaVersion: 1,
      ownerId: args.turn.ownerId,
      ownerGeneration: args.turn.ownerGeneration,
      turnId: args.turn.turnId,
      leaseId,
      kind: args.kind,
      phase: "registering",
      ...(args.slotKey ? { slotKey: args.slotKey } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (receipt.phase === "unregister_pending") {
      throw new OwnerPurgeFenceError();
    }
    const writes: Record<string, unknown> = { [key]: receipt };
    if (args.slotKey) {
      writes[args.slotKey] = {
        schemaVersion: 1,
        ownerId: args.turn.ownerId,
        ownerGeneration: args.turn.ownerGeneration,
        turnId: args.turn.turnId,
        leaseId,
        kind: args.kind,
      } satisfies BuildOwnerFenceLeaseSlot;
    }
    await txn.put(writes);
    if (args.mutateTurn) args.turn.ownerPurgeLeaseId = leaseId;
  });

  let response: Response;
  const expiresAt = Date.now() + OWNER_FENCE_LEASE_TTL_MS;
  try {
    response = await host.callOwnerFence(args.turn.ownerId, "register", {
      leaseId: receipt.leaseId,
      sessionId: host.ctx.id.toString(),
      turnId: args.turn.turnId,
      ownerGeneration: args.turn.ownerGeneration,
      role: args.role,
      expiresAt,
      ...(receipt.registrationGeneration
        ? { generation: receipt.registrationGeneration }
        : {}),
    });
  } catch (error) {
    log("error", "owner_fence_register_response_lost", {
      turnId: receipt.turnId,
      leaseId: receipt.leaseId,
      kind: receipt.kind,
      message: errorMessage(error),
    });
    throw new OwnerPurgeFenceError();
  }
  const body = (await response.json().catch(() => null)) as {
    generation?: string;
    expiresAt?: number;
    code?: unknown;
  } | null;
  if (!response.ok || !body?.generation) {
    const rawCode = typeof body?.code === "string" ? body.code : "";
    log("info", "agent_turn_owner_fence_registration_rejected", {
      turnId: args.turn.turnId,
      threadId: args.turn.threadId,
      attemptGeneration: args.turn.attemptGeneration,
      status: response.status,
      code: rawCode || "unknown",
      kind: args.kind,
    });
    throw new OwnerPurgeFenceError();
  }
  let committed = false;
  await host.ctx.storage.transaction(async (txn) => {
    const key = buildOwnerFenceLeaseReceiptKey(receipt.leaseId);
    const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
    if (
      !current ||
      current.phase === "unregister_pending" ||
      !host.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
    ) {
      return;
    }
    receipt = {
      ...current,
      phase: "registered",
      registrationGeneration: body.generation,
      updatedAt: Date.now(),
    };
    await txn.put(key, receipt);
    committed = true;
  });
  if (!committed) {
    await host.callOwnerFence(receipt.ownerId, "unregister", {
      leaseId: receipt.leaseId,
      sessionId: host.ctx.id.toString(),
      turnId: receipt.turnId,
      ownerGeneration: receipt.ownerGeneration,
    }).catch(() => undefined);
    throw new OwnerPurgeFenceError();
  }
  if (args.mutateTurn) {
    args.turn.ownerPurgeLeaseId = receipt.leaseId;
    args.turn.ownerPurgeGeneration = body.generation;
  }
  return {
    generation: body.generation,
    expiresAt:
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : expiresAt,
    leaseId: receipt.leaseId,
  };
};

export const retireBuildOwnerFenceLease = async (
  host: OwnerFenceLeaseHost,
  receipt: BuildOwnerFenceLeaseReceipt,
  generation = receipt.registrationGeneration,
): Promise<boolean> => {
  const key = buildOwnerFenceLeaseReceiptKey(receipt.leaseId);
  let pending = receipt;
  await host.ctx.storage.transaction(async (txn) => {
    const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
    if (
      current &&
      !host.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
    ) {
      throw new OwnerPurgeFenceError();
    }
    pending = {
      ...(current ?? receipt),
      phase: "unregister_pending",
      updatedAt: Date.now(),
    };
    await txn.put(key, pending);
  });
  let response: Response;
  try {
    response = await host.callOwnerFence(pending.ownerId, "unregister", {
      leaseId: pending.leaseId,
      sessionId: host.ctx.id.toString(),
      turnId: pending.turnId,
      ownerGeneration: pending.ownerGeneration,
      ...(generation ? { generation } : {}),
    });
  } catch (error) {
    log("error", "owner_fence_unregister_deferred", {
      turnId: pending.turnId,
      leaseId: pending.leaseId,
      kind: pending.kind,
      message: errorMessage(error),
    });
    await host.armOwnerFenceLeaseReconciliationAlarm();
    return false;
  }
  if (!response.ok) {
    log("error", "owner_fence_unregister_deferred", {
      turnId: pending.turnId,
      leaseId: pending.leaseId,
      kind: pending.kind,
      status: response.status,
    });
    await host.armOwnerFenceLeaseReconciliationAlarm();
    return false;
  }
  await host.ctx.storage.transaction(async (txn) => {
    const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
    if (
      current &&
      host.ownerFenceReceiptMatches(current, pending, pending.leaseId)
    ) {
      await txn.delete(key);
    }
    if (pending.slotKey) {
      const slot = await txn.get<BuildOwnerFenceLeaseSlot>(pending.slotKey);
      if (slot?.leaseId === pending.leaseId) {
        await txn.delete(pending.slotKey);
      }
    }
  });
  return true;
};