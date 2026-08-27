export const EXACT_TURN_CANCELLATIONS_KEY =
  "executionPlacementExactTurnCancellations:v1";

const MAX_PENDING_EXACT_TURN_CANCELLATIONS = 128;
const MAX_ACKNOWLEDGED_EXACT_TURN_CANCELLATIONS = 128;

export type ExactTurnCancellationRequest = {
  turnId: string;
  cancelRequestId: string;
  ownerId: string;
  ownerGeneration: string;
  attemptGeneration?: number;
};

export type ExactTurnCancellation = ExactTurnCancellationRequest & {
  state: "pending" | "acknowledged";
  persistedAt: number;
  acknowledgedAt?: number;
};

type ExactTurnCancellationStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type StageExactTurnCancellationResult =
  | { status: "staged" | "replayed"; cancellation: ExactTurnCancellation }
  | { status: "conflict" | "saturated" };

const boundedIdentity = (
  value: unknown,
  maxLength: number,
): string | undefined => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

export const parseExactTurnCancellationRequest = (
  value: unknown,
): ExactTurnCancellationRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const turnId = boundedIdentity(input.turnId, 128);
  const cancelRequestId = boundedIdentity(input.cancelRequestId, 128);
  const ownerId = boundedIdentity(input.ownerId, 512);
  const ownerGeneration = boundedIdentity(input.ownerGeneration, 512);
  const attemptGeneration = input.attemptGeneration;
  if (
    attemptGeneration !== undefined &&
    (typeof attemptGeneration !== "number" ||
      !Number.isSafeInteger(attemptGeneration) ||
      attemptGeneration < 1)
  ) {
    return null;
  }
  if (!turnId || !cancelRequestId || !ownerId || !ownerGeneration) return null;
  return {
    turnId,
    cancelRequestId,
    ownerId,
    ownerGeneration,
    ...(typeof attemptGeneration === "number" ? { attemptGeneration } : {}),
  };
};

const sameCancellation = (
  left: ExactTurnCancellationRequest,
  right: ExactTurnCancellationRequest,
): boolean =>
  left.turnId === right.turnId &&
  left.cancelRequestId === right.cancelRequestId &&
  left.ownerId === right.ownerId &&
  left.ownerGeneration === right.ownerGeneration &&
  left.attemptGeneration === right.attemptGeneration;

const normalizeLedger = (value: unknown): ExactTurnCancellation[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ExactTurnCancellation => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    return (
      parseExactTurnCancellationRequest(row) !== null &&
      (row.state === "pending" || row.state === "acknowledged") &&
      typeof row.persistedAt === "number" &&
      Number.isFinite(row.persistedAt) &&
      (row.acknowledgedAt === undefined ||
        (typeof row.acknowledgedAt === "number" &&
          Number.isFinite(row.acknowledgedAt)))
    );
  });
};

const boundedLedger = (
  entries: readonly ExactTurnCancellation[],
): ExactTurnCancellation[] => {
  const pending = entries.filter((entry) => entry.state === "pending");
  const acknowledged = entries
    .filter((entry) => entry.state === "acknowledged")
    .sort(
      (left, right) =>
        (right.acknowledgedAt ?? right.persistedAt) -
        (left.acknowledgedAt ?? left.persistedAt),
    )
    .slice(0, MAX_ACKNOWLEDGED_EXACT_TURN_CANCELLATIONS);
  return [...pending, ...acknowledged];
};

/**
 * Durable, bounded, fail-closed cancellation ledger for chat turns that may not
 * have reached the conversation Durable Object yet. Pending entries are never
 * aged out or evicted: once the bound is reached, new cancellations are refused
 * instead of silently allowing a delayed turn to resurrect.
 */
export class ExactTurnCancellationLedger {
  constructor(private readonly storage: ExactTurnCancellationStorage) {}

  private async read(): Promise<ExactTurnCancellation[]> {
    return normalizeLedger(
      await this.storage.get<unknown>(EXACT_TURN_CANCELLATIONS_KEY),
    );
  }

  async stage(
    request: ExactTurnCancellationRequest,
    now = Date.now(),
  ): Promise<StageExactTurnCancellationResult> {
    const entries = await this.read();
    const existing = entries.find((entry) => entry.turnId === request.turnId);
    if (existing) {
      return sameCancellation(existing, request)
        ? { status: "replayed", cancellation: existing }
        : { status: "conflict" };
    }
    const reusedOperation = entries.find(
      (entry) => entry.cancelRequestId === request.cancelRequestId,
    );
    if (reusedOperation) return { status: "conflict" };
    if (
      entries.filter((entry) => entry.state === "pending").length >=
      MAX_PENDING_EXACT_TURN_CANCELLATIONS
    ) {
      return { status: "saturated" };
    }
    const cancellation: ExactTurnCancellation = {
      ...request,
      state: "pending",
      persistedAt: now,
    };
    await this.storage.put(
      EXACT_TURN_CANCELLATIONS_KEY,
      boundedLedger([...entries, cancellation]),
    );
    return { status: "staged", cancellation };
  }

  async matching(args: {
    turnId: string;
    ownerId: string;
    ownerGeneration: string;
    attemptGeneration?: number;
  }): Promise<ExactTurnCancellation | null> {
    const entry = (await this.read()).find(
      (candidate) => candidate.turnId === args.turnId,
    );
    return entry &&
      entry.ownerId === args.ownerId &&
      entry.ownerGeneration === args.ownerGeneration &&
      (args.attemptGeneration === undefined ||
        entry.attemptGeneration === args.attemptGeneration)
      ? entry
      : null;
  }

  async acknowledge(
    request: ExactTurnCancellationRequest,
    now = Date.now(),
  ): Promise<boolean> {
    const entries = await this.read();
    const index = entries.findIndex((entry) => entry.turnId === request.turnId);
    if (index < 0 || !sameCancellation(entries[index]!, request)) return false;
    entries[index] = {
      ...entries[index]!,
      state: "acknowledged",
      acknowledgedAt: now,
    };
    await this.storage.put(EXACT_TURN_CANCELLATIONS_KEY, boundedLedger(entries));
    return true;
  }

  async entriesForTest(): Promise<ExactTurnCancellation[]> {
    return await this.read();
  }
}
