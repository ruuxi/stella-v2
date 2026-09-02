/**
 * Durable sandbox retirement primitives.
 *
 * This module deliberately knows nothing about a particular Durable Object or
 * container binding.  The caller supplies storage and performs destruction;
 * the durable value only records the exact resource that is still owed.  That
 * keeps teardown retryable after isolate loss without letting a later attempt
 * accidentally reinterpret an older sandbox at a different size or workload.
 */

import type { InstanceSize } from "./instance-size.js";

export const SANDBOX_WORKLOADS = [
  "app-build",
  "agent",
  "resident-attachment",
] as const;

export type SandboxWorkload = (typeof SANDBOX_WORKLOADS)[number];

export type SandboxTarget = Readonly<{
  sandboxId: string;
  size: InstanceSize;
  workload: SandboxWorkload;
}>;

export type SandboxLifecycleIdentity = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  attemptGeneration: number;
}>;

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Stable for exact replay, distinct for every owner/turn attempt successor.
 * Only a SHA-256 fingerprint enters the SDK-visible id; authority material
 * and user-controlled prefixes never do.
 */
export const sandboxLifecycleId = async (
  workloadPrefix: "app" | "agent" | "agent-lg" | "echo",
  identity: SandboxLifecycleIdentity,
): Promise<string> => {
  if (
    !identity.ownerId ||
    !identity.ownerGeneration ||
    !identity.turnId ||
    !Number.isSafeInteger(identity.attemptGeneration) ||
    identity.attemptGeneration < 1
  ) {
    throw new TypeError("Sandbox lifecycle identity must be exact.");
  }
  const canonical = [
    "stella-sandbox-lifecycle-v1",
    workloadPrefix,
    identity.ownerId,
    identity.ownerGeneration,
    identity.turnId,
    String(identity.attemptGeneration),
  ].join("\u0000");
  const digest = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    ),
  );
  return `${workloadPrefix}-${digest.slice(0, 40)}`;
};

export type SandboxLifecycleFailureFields = Readonly<{
  failureCode:
    | "aborted"
    | "deadline_exceeded"
    | "out_of_memory"
    | "sandbox_rpc_failed";
  detailBytes: number;
  detailBytesCapped: boolean;
}>;

export class SandboxLifecycleDeferredError extends Error {
  constructor() {
    super("Sandbox retirement is pending and will be retried.");
    this.name = "SandboxLifecycleDeferredError";
  }
}

const FAILURE_DETAIL_BYTE_CAP = 4_096;

/** Allowlisted lifecycle diagnostics only; provider bodies and URLs stay out. */
export const sandboxLifecycleFailureFields = (
  error: unknown,
): SandboxLifecycleFailureFields => {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const detail =
    error instanceof Error
      ? `${error.name}:${error.message}`
      : typeof error === "string"
        ? error
        : "unknown";
  const bytes = new TextEncoder().encode(detail).byteLength;
  const failureCode = name.includes("abort")
    ? "aborted"
    : name.includes("timeout") || name.includes("deadline")
      ? "deadline_exceeded"
      : name.includes("outofmemory") || name.includes("out_of_memory")
        ? "out_of_memory"
        : "sandbox_rpc_failed";
  return {
    failureCode,
    detailBytes: Math.min(bytes, FAILURE_DETAIL_BYTE_CAP),
    detailBytesCapped: bytes > FAILURE_DETAIL_BYTE_CAP,
  };
};

export type SandboxDestroyDebt = Readonly<{
  schemaVersion: 1;
  kind: "destroy-pending";
  target: SandboxTarget;
  createdAt: number;
  /** Number of failed destroy calls. There is intentionally no retry limit. */
  attemptCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
}>;

export const SANDBOX_DESTROY_DEBT_PREFIX =
  "sandbox-lifecycle:v1:destroy-pending:";

export const SANDBOX_DESTROY_RETRY_BASE_MS = 1_000;
export const SANDBOX_DESTROY_RETRY_MAX_MS = 15 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isInstanceSize = (value: unknown): value is InstanceSize =>
  value === "small" || value === "large";

export const isSandboxWorkload = (value: unknown): value is SandboxWorkload =>
  typeof value === "string" &&
  (SANDBOX_WORKLOADS as readonly string[]).includes(value);

export const parseSandboxTarget = (value: unknown): SandboxTarget | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.sandboxId !== "string" ||
    value.sandboxId.length === 0 ||
    !isInstanceSize(value.size) ||
    !isSandboxWorkload(value.workload)
  ) {
    return null;
  }
  return {
    sandboxId: value.sandboxId,
    size: value.size,
    workload: value.workload,
  };
};

export const sameSandboxTarget = (
  left: SandboxTarget,
  right: SandboxTarget,
): boolean =>
  left.sandboxId === right.sandboxId &&
  left.size === right.size &&
  left.workload === right.workload;

/**
 * The encoded component is lossless, including `:` and non-ASCII ids.  A debt
 * for the same sandbox id at another size/workload gets a different key, so it
 * cannot silently overwrite or clear the wrong container's tombstone.
 */
export const sandboxDestroyDebtKey = (target: SandboxTarget): string =>
  `${SANDBOX_DESTROY_DEBT_PREFIX}${encodeURIComponent(target.workload)}:${encodeURIComponent(
    target.size,
  )}:${encodeURIComponent(target.sandboxId)}`;

export const isSandboxDestroyDebtKey = (key: string): boolean =>
  key.startsWith(SANDBOX_DESTROY_DEBT_PREFIX);

export const parseSandboxDestroyDebt = (
  value: unknown,
): SandboxDestroyDebt | null => {
  if (!isRecord(value)) return null;
  const target = parseSandboxTarget(value.target);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "destroy-pending" ||
    !target ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !Number.isSafeInteger(value.nextAttemptAt) ||
    (value.nextAttemptAt as number) < (value.createdAt as number) ||
    (value.lastAttemptAt !== undefined &&
      (!Number.isSafeInteger(value.lastAttemptAt) ||
        (value.lastAttemptAt as number) < (value.createdAt as number) ||
        (value.lastAttemptAt as number) > (value.nextAttemptAt as number)))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: "destroy-pending",
    target,
    createdAt: value.createdAt as number,
    attemptCount: value.attemptCount as number,
    nextAttemptAt: value.nextAttemptAt as number,
    ...(value.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: value.lastAttemptAt as number }),
  };
};

const checkedTimestamp = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
};

/** Delay after `attemptCount` failures; the first failure waits one second. */
export const sandboxDestroyRetryDelayMs = (attemptCount: number): number => {
  checkedTimestamp(attemptCount, "attemptCount");
  if (attemptCount === 0) return 0;
  // Capping the exponent before exponentiation keeps even MAX_SAFE_INTEGER
  // attempts finite. The attempt counter is never used to terminate retry.
  const capExponent = Math.ceil(
    Math.log2(SANDBOX_DESTROY_RETRY_MAX_MS / SANDBOX_DESTROY_RETRY_BASE_MS),
  );
  const exponent = Math.min(attemptCount - 1, capExponent);
  return Math.min(
    SANDBOX_DESTROY_RETRY_MAX_MS,
    SANDBOX_DESTROY_RETRY_BASE_MS * 2 ** exponent,
  );
};

export const createSandboxDestroyDebt = (
  target: SandboxTarget,
  createdAt: number,
): SandboxDestroyDebt => ({
  schemaVersion: 1,
  kind: "destroy-pending",
  target: { ...target },
  createdAt: checkedTimestamp(createdAt, "createdAt"),
  attemptCount: 0,
  nextAttemptAt: createdAt,
});

/**
 * Advance after one failed destroy call.  The counter saturates solely to stay
 * representable; the record and capped schedule continue forever.
 */
export const advanceSandboxDestroyDebt = (
  debt: SandboxDestroyDebt,
  failedAt: number,
): SandboxDestroyDebt => {
  const timestamp = checkedTimestamp(failedAt, "failedAt");
  if (timestamp < debt.createdAt) {
    throw new RangeError("failedAt cannot be earlier than debt creation.");
  }
  const attemptCount = Math.min(Number.MAX_SAFE_INTEGER, debt.attemptCount + 1);
  const delay = sandboxDestroyRetryDelayMs(attemptCount);
  return {
    ...debt,
    target: { ...debt.target },
    attemptCount,
    lastAttemptAt: timestamp,
    nextAttemptAt: Math.min(Number.MAX_SAFE_INTEGER, timestamp + delay),
  };
};

export const isSandboxDestroyDue = (
  debt: SandboxDestroyDebt,
  now: number,
): boolean => checkedTimestamp(now, "now") >= debt.nextAttemptAt;

/** Structural subset implemented by DurableObjectStorage and tiny test fakes. */
export type SandboxLifecycleStorage = Readonly<{
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  transaction<T>(
    closure: (transaction: SandboxLifecycleTransaction) => Promise<T>,
  ): Promise<T>;
}>;

export type SandboxLifecycleTransaction = Readonly<{
  put<T>(key: string, value: T): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}>;

export type SandboxLifecycleListStorage = Readonly<{
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}>;

export const readSandboxDestroyDebt = async (
  storage: Pick<SandboxLifecycleStorage, "get">,
  target: SandboxTarget,
): Promise<SandboxDestroyDebt | null> => {
  const debt = parseSandboxDestroyDebt(
    await storage.get<unknown>(sandboxDestroyDebtKey(target)),
  );
  return debt && sameSandboxTarget(debt.target, target) ? debt : null;
};

/**
 * Persist first, then arm the earliest alarm. Durable Objects have one alarm,
 * so a destroy retry must never postpone an earlier watchdog or terminal wake.
 * Callers must complete this before destroy I/O.
 */
export const persistSandboxDestroyDebt = async (
  storage: Pick<SandboxLifecycleStorage, "transaction">,
  debt: SandboxDestroyDebt,
): Promise<void> => {
  await storage.transaction(async (transaction) => {
    await transaction.put(sandboxDestroyDebtKey(debt.target), debt);
    const existingAlarm = await transaction.getAlarm();
    await transaction.setAlarm(
      existingAlarm === null
        ? debt.nextAttemptAt
        : Math.min(existingAlarm, debt.nextAttemptAt),
    );
  });
};

export const clearSandboxDestroyDebt = async (
  storage: Pick<SandboxLifecycleStorage, "delete">,
  debt: SandboxDestroyDebt,
): Promise<boolean> => await storage.delete(sandboxDestroyDebtKey(debt.target));

/**
 * Parse a prefix listing without trusting either the key or value alone. A
 * malformed row, or a valid debt stored under a different tuple's key, is
 * ignored instead of becoming authority to destroy a container.
 */
export const parseSandboxDestroyDebtEntries = (
  entries: Iterable<readonly [string, unknown]>,
): readonly SandboxDestroyDebt[] => {
  const debts: SandboxDestroyDebt[] = [];
  for (const [key, value] of entries) {
    if (!isSandboxDestroyDebtKey(key)) continue;
    const debt = parseSandboxDestroyDebt(value);
    if (!debt || key !== sandboxDestroyDebtKey(debt.target)) continue;
    debts.push(debt);
  }
  return debts;
};

export const listSandboxDestroyDebts = async (
  storage: SandboxLifecycleListStorage,
): Promise<readonly SandboxDestroyDebt[]> =>
  parseSandboxDestroyDebtEntries(
    await storage.list<unknown>({ prefix: SANDBOX_DESTROY_DEBT_PREFIX }),
  );

export type DurableSandboxTarget = Readonly<{
  target: SandboxTarget;
  lifecycle: "owned" | "retiring";
}>;

export type SandboxInventoryReconciliation = Readonly<{
  /** Every non-retiring durable target. */
  owned: readonly SandboxTarget[];
  /** Active durable targets whose exact tuple appears in live inventory. */
  live: readonly SandboxTarget[];
  /** Live exact tuples with no active or retiring durable target. */
  orphan: readonly SandboxTarget[];
  /** Active durable targets whose exact tuple is not live. */
  missing: readonly SandboxTarget[];
  /** Every durable destroy-pending target, whether still live or already gone. */
  retiring: readonly SandboxTarget[];
}>;

const tupleKey = (target: SandboxTarget): string =>
  JSON.stringify([target.sandboxId, target.size, target.workload]);

/**
 * Compare snapshots only. This function does not destroy, persist, schedule or
 * mutate either input. A size/workload disagreement becomes missing + orphan,
 * rather than claiming ownership of a different container by id alone.
 */
export const reconcileSandboxInventory = (
  durableTargets: readonly DurableSandboxTarget[],
  liveInventory: readonly SandboxTarget[],
): SandboxInventoryReconciliation => {
  const owned = durableTargets
    .filter((entry) => entry.lifecycle === "owned")
    .map((entry) => ({ ...entry.target }));
  const retiring = durableTargets
    .filter((entry) => entry.lifecycle === "retiring")
    .map((entry) => ({ ...entry.target }));
  const durableKeys = new Set(
    durableTargets.map((entry) => tupleKey(entry.target)),
  );
  const ownedKeys = new Set(owned.map(tupleKey));
  const inventoryKeys = new Set(liveInventory.map(tupleKey));

  return {
    owned,
    live: owned.filter((target) => inventoryKeys.has(tupleKey(target))),
    orphan: liveInventory
      .filter((target) => !durableKeys.has(tupleKey(target)))
      .map((target) => ({ ...target })),
    missing: owned.filter((target) => !inventoryKeys.has(tupleKey(target))),
    retiring,
  };
};

/** Count-only telemetry: no sandbox, owner or user identifiers leave the DO. */
export const summarizeSandboxInventory = (
  reconciliation: SandboxInventoryReconciliation,
): Readonly<
  Record<"owned" | "live" | "orphan" | "missing" | "retiring", number>
> => ({
  owned: reconciliation.owned.length,
  live: reconciliation.live.length,
  orphan: reconciliation.orphan.length,
  missing: reconciliation.missing.length,
  retiring: reconciliation.retiring.length,
});
