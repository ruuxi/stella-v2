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

export const memoryPoliciesMatch = (
  left: MemoryPolicy,
  right: MemoryPolicy,
): boolean =>
  left.ownerGeneration === right.ownerGeneration &&
  left.memoryEpoch === right.memoryEpoch &&
  left.memoryEnabled === right.memoryEnabled &&
  left.revision === right.revision;
