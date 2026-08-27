type DurableSettingStore = {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
};

export type PlacementLocalExecutionKind = "agent" | "chat";

const expectedPrefix = (kind: PlacementLocalExecutionKind) =>
  kind === "agent" ? "placement-agent:" : "placement-chat:";

export const normalizePlacementExecutionId = (
  kind: PlacementLocalExecutionKind,
  executionId: string,
): string => {
  const normalized = executionId.trim();
  if (
    !normalized.startsWith(expectedPrefix(kind)) ||
    normalized.length > 256
  ) {
    throw new Error(`Invalid ${kind} execution-placement owner id.`);
  }
  return normalized;
};

const cancellationSettingKey = (
  kind: PlacementLocalExecutionKind,
  executionId: string,
) =>
  `execution-placement.cancel.v1:${kind}:${normalizePlacementExecutionId(
    kind,
    executionId,
  )}`;

/**
 * Persist-before-ack half of the local run/cancel admission fence. SessionStore
 * writes settings synchronously in SQLite, so a worker restart after this call
 * cannot resurrect a delayed placement RPC.
 */
export const persistPlacementCancellation = (args: {
  store: DurableSettingStore;
  kind: PlacementLocalExecutionKind;
  executionId: string;
  reason?: string;
}): string => {
  const reason =
    args.reason?.trim().slice(0, 2_000) ||
    "Canceled before the local execution started.";
  args.store.setSetting(
    cancellationSettingKey(args.kind, args.executionId),
    reason,
  );
  return reason;
};

/** Fail-closed read half of the same fence. */
export const getPlacementCancellation = (args: {
  store: DurableSettingStore;
  kind: PlacementLocalExecutionKind;
  executionId: string;
}): string | null =>
  args.store.getSetting(cancellationSettingKey(args.kind, args.executionId));
