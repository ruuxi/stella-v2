import type {
  CloudMemoryWipeJob,
  CloudMemoryWipeStatus,
  StartCloudMemoryWipeArgs,
} from "./cloud-home-api";

const MAX_TOKEN_CHARS = 1_024;
const MAX_ERROR_CODE_CHARS = 120;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|?-]{0,1023}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STATUS_KEYS = new Set([
  "subject",
  "ownerGeneration",
  "state",
  "memoryEpoch",
  "importDisposition",
  "job",
]);
const STATUS_OPTIONAL_KEYS = new Set(["lastWipedEpoch"]);
const JOB_REQUIRED_KEYS = new Set([
  "operationId",
  "stage",
  "attempts",
  "nextRetryAt",
  "objectsDeleted",
  "rowsDeleted",
  "updatedAt",
]);
const JOB_OPTIONAL_KEYS = new Set(["lastErrorCode", "completedAt"]);
const ACTIVE_STAGES = new Set(["sweeping", "metadata", "releasing"]);

export type CloudMemoryWipeIdentity = Readonly<{
  accountScope: string;
  identityRevision: number;
  ownerSubject: string;
}>;

export type CloudMemoryWipeRequestFence = Readonly<
  CloudMemoryWipeIdentity & { requestId: string }
>;

export type CloudMemoryWipeAttempt = Readonly<
  CloudMemoryWipeRequestFence &
    StartCloudMemoryWipeArgs & {
      previousOperationId: string | null;
    }
>;

export type CloudMemoryWipeIssueCode =
  | "active"
  | "stale_epoch"
  | "owner_generation_changed"
  | "idempotency_conflict"
  | "account_unavailable"
  | "unauthorized"
  | "invalid_response"
  | "unavailable";

export class CloudMemoryWipeError extends Error {
  readonly code: CloudMemoryWipeIssueCode;
  readonly retryable: boolean;

  constructor(code: CloudMemoryWipeIssueCode, retryable = false) {
    super("Cloud Memory wipe status is unavailable.");
    this.name = "CloudMemoryWipeError";
    this.code = code;
    this.retryable = retryable;
  }
}

const invalidResponse = (): never => {
  throw new CloudMemoryWipeError("invalid_response");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean => {
  const keys = Object.keys(value);
  return (
    [...required].every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.has(key) || optional.has(key))
  );
};

const nonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const timestamp = (value: unknown): value is number =>
  nonNegativeSafeInteger(value) && value <= MAX_TIMESTAMP_MS;

const normalizedToken = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_TOKEN_CHARS ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    !TOKEN_PATTERN.test(value)
  ) {
    return invalidResponse();
  }
  return value;
};

const normalizedIdentityValue = (value: string, label: string): string => {
  try {
    return normalizedToken(value);
  } catch {
    throw new TypeError(`A normalized ${label} is required.`);
  }
};

const decodeJob = (value: unknown): CloudMemoryWipeJob => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, JOB_REQUIRED_KEYS, JOB_OPTIONAL_KEYS)
  ) {
    return invalidResponse();
  }
  const operationId = normalizedToken(value.operationId);
  const stage = value.stage;
  if (
    (stage !== "sweeping" &&
      stage !== "metadata" &&
      stage !== "releasing" &&
      stage !== "completed") ||
    !nonNegativeSafeInteger(value.attempts) ||
    !timestamp(value.nextRetryAt) ||
    !nonNegativeSafeInteger(value.objectsDeleted) ||
    !nonNegativeSafeInteger(value.rowsDeleted) ||
    !timestamp(value.updatedAt)
  ) {
    return invalidResponse();
  }
  if (
    value.lastErrorCode !== undefined &&
    (typeof value.lastErrorCode !== "string" ||
      !value.lastErrorCode ||
      value.lastErrorCode.length > MAX_ERROR_CODE_CHARS ||
      value.lastErrorCode.normalize("NFC") !== value.lastErrorCode ||
      value.lastErrorCode.trim() !== value.lastErrorCode ||
      hasControlCharacter(value.lastErrorCode))
  ) {
    return invalidResponse();
  }
  if (value.completedAt !== undefined && !timestamp(value.completedAt)) {
    return invalidResponse();
  }
  if (
    (stage === "completed" && value.completedAt === undefined) ||
    (stage !== "completed" && value.completedAt !== undefined)
  ) {
    return invalidResponse();
  }
  return {
    operationId,
    stage,
    attempts: value.attempts,
    nextRetryAt: value.nextRetryAt,
    ...(value.lastErrorCode !== undefined
      ? { lastErrorCode: value.lastErrorCode }
      : {}),
    objectsDeleted: value.objectsDeleted,
    rowsDeleted: value.rowsDeleted,
    ...(value.completedAt !== undefined
      ? { completedAt: value.completedAt }
      : {}),
    updatedAt: value.updatedAt,
  };
};

export const decodeCloudMemoryWipeStatus = (
  value: unknown,
  expectedOwnerSubject: string,
): CloudMemoryWipeStatus => {
  const subject = normalizedIdentityValue(
    expectedOwnerSubject,
    "owner subject",
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, STATUS_KEYS, STATUS_OPTIONAL_KEYS)
  ) {
    return invalidResponse();
  }
  if (value.subject !== subject) return invalidResponse();
  const ownerGeneration = normalizedToken(value.ownerGeneration);
  const memoryEpoch = normalizedToken(value.memoryEpoch);
  if (value.state !== "open" && value.state !== "wiping") {
    return invalidResponse();
  }
  if (
    value.importDisposition !== "automatic_allowed" &&
    value.importDisposition !== "explicit_required" &&
    value.importDisposition !== "explicit_allowed"
  ) {
    return invalidResponse();
  }
  const lastWipedEpoch =
    value.lastWipedEpoch === undefined
      ? undefined
      : normalizedToken(value.lastWipedEpoch);
  const job = value.job === null ? null : decodeJob(value.job);
  if (
    (value.state === "wiping" && (!job || !ACTIVE_STAGES.has(job.stage))) ||
    (value.state === "open" && job !== null && job.stage !== "completed")
  ) {
    return invalidResponse();
  }
  return {
    subject,
    ownerGeneration,
    state: value.state,
    memoryEpoch,
    importDisposition: value.importDisposition,
    ...(lastWipedEpoch === undefined ? {} : { lastWipedEpoch }),
    job,
  };
};

export const isCloudMemoryWipeActive = (
  status: CloudMemoryWipeStatus,
): boolean => status.state === "wiping";

export const isCloudMemoryWipeComplete = (
  status: CloudMemoryWipeStatus,
): boolean =>
  status.state === "open" &&
  status.job?.stage === "completed" &&
  status.job.completedAt !== undefined;

let fallbackRequestSequence = 0;

const defaultRequestEntropy = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  fallbackRequestSequence = (fallbackRequestSequence + 1) % 0x7fffffff;
  return `${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}`;
};

export const createCloudMemoryWipeRequestId = (
  createEntropy: () => string = defaultRequestEntropy,
): string => {
  const requestId = `desktop-memory-wipe:${createEntropy()}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError("A valid cloud Memory wipe request id is required.");
  }
  return requestId;
};

export const createCloudMemoryWipeRequestFence = (args: {
  accountScope: string;
  identityRevision: number;
  ownerSubject: string;
  createEntropy?: () => string;
}): CloudMemoryWipeRequestFence => {
  if (!nonNegativeSafeInteger(args.identityRevision)) {
    throw new TypeError("A valid identity revision is required.");
  }
  return Object.freeze({
    accountScope: normalizedIdentityValue(args.accountScope, "account scope"),
    identityRevision: args.identityRevision,
    ownerSubject: normalizedIdentityValue(args.ownerSubject, "owner subject"),
    requestId: createCloudMemoryWipeRequestId(args.createEntropy),
  });
};

export const beginCloudMemoryWipe = (args: {
  identity: CloudMemoryWipeIdentity;
  status: CloudMemoryWipeStatus;
  createEntropy?: () => string;
}): CloudMemoryWipeAttempt => {
  const status = decodeCloudMemoryWipeStatus(
    args.status,
    args.identity.ownerSubject,
  );
  if (status.state !== "open") {
    throw new CloudMemoryWipeError("active");
  }
  const fence = createCloudMemoryWipeRequestFence({
    ...args.identity,
    createEntropy: args.createEntropy,
  });
  return Object.freeze({
    ...fence,
    expectedSubject: fence.ownerSubject,
    expectedOwnerGeneration: status.ownerGeneration,
    expectedMemoryEpoch: status.memoryEpoch,
    previousOperationId: status.job?.operationId ?? null,
  });
};

export const cloudMemoryWipeMutationInput = (
  attempt: CloudMemoryWipeAttempt,
): StartCloudMemoryWipeArgs => ({
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
  expectedMemoryEpoch: attempt.expectedMemoryEpoch,
  expectedSubject: attempt.expectedSubject,
  requestId: attempt.requestId,
});

export const isCloudMemoryWipeRequestCurrent = (
  originating: CloudMemoryWipeRequestFence,
  current: {
    accountScope: string | null | undefined;
    identityRevision: number | null | undefined;
    ownerSubject: string | null | undefined;
    requestId: string | null | undefined;
  },
): boolean =>
  originating.accountScope === current.accountScope &&
  originating.identityRevision === current.identityRevision &&
  originating.ownerSubject === current.ownerSubject &&
  originating.requestId === current.requestId;

const readSerializedPayload = (
  message: string,
): Record<string, unknown> | null => {
  const first = message.indexOf("{");
  const last = message.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    const value: unknown = JSON.parse(message.slice(first, last + 1));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const readErrorPayload = (error: unknown): Record<string, unknown> | null => {
  if (isRecord(error) && isRecord(error.data)) return error.data;
  return error instanceof Error ? readSerializedPayload(error.message) : null;
};

export const normalizeCloudMemoryWipeError = (
  error: unknown,
): CloudMemoryWipeError => {
  if (error instanceof CloudMemoryWipeError) return error;
  const payload = readErrorPayload(error);
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code === "CLOUD_MEMORY_WIPE_ACTIVE") {
    return new CloudMemoryWipeError("active");
  }
  if (code === "CLOUD_MEMORY_EPOCH_STALE") {
    return new CloudMemoryWipeError("stale_epoch");
  }
  if (
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNER_EXTERNAL_FENCE_MISMATCH" ||
    code === "OWNERSHIP_MIGRATED" ||
    code === "ANONYMOUS_IDENTITY_MIGRATED"
  ) {
    return new CloudMemoryWipeError("owner_generation_changed");
  }
  if (code === "CLOUD_HOME_IDEMPOTENCY_CONFLICT") {
    return new CloudMemoryWipeError("idempotency_conflict");
  }
  if (code === "OWNER_DATA_PURGE_ACTIVE") {
    return new CloudMemoryWipeError("account_unavailable");
  }
  if (
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "SESSION_IDENTITY_MISMATCH"
  ) {
    return new CloudMemoryWipeError("unauthorized");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /unauthenticated|authentication required|sign in|unauthorized/iu.test(
      message,
    )
  ) {
    return new CloudMemoryWipeError("unauthorized");
  }
  return new CloudMemoryWipeError("unavailable", true);
};

export type CloudMemoryWipePort = {
  read: (args: { expectedSubject: string }) => Promise<unknown>;
  start: (args: StartCloudMemoryWipeArgs) => Promise<unknown>;
};

const validateStartResult = (
  status: CloudMemoryWipeStatus,
  attempt: CloudMemoryWipeAttempt,
): CloudMemoryWipeStatus => {
  if (
    status.ownerGeneration !== attempt.expectedOwnerGeneration ||
    !status.job ||
    status.job.operationId === attempt.previousOperationId
  ) {
    return invalidResponse();
  }
  if (
    status.state === "wiping" &&
    status.memoryEpoch === attempt.expectedMemoryEpoch
  ) {
    return status;
  }
  if (
    isCloudMemoryWipeComplete(status) &&
    status.memoryEpoch !== attempt.expectedMemoryEpoch
  ) {
    return status;
  }
  return invalidResponse();
};

export const createCloudMemoryWipeClient = (port: CloudMemoryWipePort) => ({
  read: async (fence: CloudMemoryWipeRequestFence) => {
    try {
      return {
        fence,
        status: decodeCloudMemoryWipeStatus(
          await port.read({ expectedSubject: fence.ownerSubject }),
          fence.ownerSubject,
        ),
      };
    } catch (error) {
      throw normalizeCloudMemoryWipeError(error);
    }
  },
  start: async (attempt: CloudMemoryWipeAttempt) => {
    try {
      const status = decodeCloudMemoryWipeStatus(
        await port.start(cloudMemoryWipeMutationInput(attempt)),
        attempt.ownerSubject,
      );
      return { attempt, status: validateStartResult(status, attempt) };
    } catch (error) {
      throw normalizeCloudMemoryWipeError(error);
    }
  },
});
