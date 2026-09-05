/** Memory permission metadata; document contents are a separate prompt snapshot. */
export type MemoryPolicy = {
  ownerGeneration: string;
  memoryEpoch: string;
  memoryEnabled: boolean;
  revision: number;
  updatedAt: number;
};

type MemoryChangeIdentity = {
  ownerId: string;
  expectedOwnerGeneration: string;
  requestId: string;
};

export type MemoryPolicyChange = MemoryChangeIdentity &
  (
    | { kind: "preference"; expectedRevision: number; memoryEnabled: boolean }
    | { kind: "wipe"; expectedMemoryEpoch: string }
  );

export const MEMORY_POLICY_CHANGE_PATH =
  "/internal/owners/memory-policy/change";
export const MEMORY_POLICY_APPLY_PATH = "/api/cloud/home/memory/policy/apply";

const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export const parseMemoryPolicy = (value: unknown): MemoryPolicy | null => {
  if (
    !value ||
    typeof value !== "object" ||
    !("ownerGeneration" in value) ||
    !text(value.ownerGeneration) ||
    !("memoryEpoch" in value) ||
    !text(value.memoryEpoch) ||
    !("memoryEnabled" in value) ||
    typeof value.memoryEnabled !== "boolean" ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  )
    return null;
  return {
    ownerGeneration: value.ownerGeneration,
    memoryEpoch: value.memoryEpoch,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
};

export const parseMemoryPolicyChange = (
  value: unknown,
): MemoryPolicyChange | null => {
  if (
    !value ||
    typeof value !== "object" ||
    !("ownerId" in value) ||
    !text(value.ownerId) ||
    !("expectedOwnerGeneration" in value) ||
    !text(value.expectedOwnerGeneration) ||
    !("requestId" in value) ||
    !text(value.requestId) ||
    !("kind" in value)
  )
    return null;
  const identity = {
    ownerId: value.ownerId,
    expectedOwnerGeneration: value.expectedOwnerGeneration,
    requestId: value.requestId,
  };
  if (
    value.kind === "preference" &&
    "expectedRevision" in value &&
    typeof value.expectedRevision === "number" &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    "memoryEnabled" in value &&
    typeof value.memoryEnabled === "boolean"
  ) {
    return {
      ...identity,
      kind: "preference",
      expectedRevision: value.expectedRevision,
      memoryEnabled: value.memoryEnabled,
    };
  }
  if (
    value.kind === "wipe" &&
    "expectedMemoryEpoch" in value &&
    text(value.expectedMemoryEpoch)
  ) {
    return {
      ...identity,
      kind: "wipe",
      expectedMemoryEpoch: value.expectedMemoryEpoch,
    };
  }
  return null;
};

export const memoryPoliciesMatch = (
  left: MemoryPolicy,
  right: MemoryPolicy,
): boolean =>
  left.ownerGeneration === right.ownerGeneration &&
  left.memoryEpoch === right.memoryEpoch &&
  left.memoryEnabled === right.memoryEnabled &&
  left.revision === right.revision;
