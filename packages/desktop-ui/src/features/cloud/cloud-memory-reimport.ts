import type {
  AuthorizeCloudMemoryReimportArgs,
  CloudMemoryWipeStatus,
} from "./cloud-home-api";
import {
  CloudMemoryWipeError,
  decodeCloudMemoryWipeStatus,
} from "./cloud-memory-wipe";

const MAX_IDENTITY_CHARS = 1_024;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|?-]{0,1023}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CloudMemoryReimportIdentity = Readonly<{
  accountScope: string;
  identityRevision: number;
  ownerSubject: string;
}>;

export type CloudMemoryReimportRequestFence = Readonly<
  CloudMemoryReimportIdentity & { requestId: string }
>;

export type CloudMemoryReimportAttempt = Readonly<
  CloudMemoryReimportRequestFence & AuthorizeCloudMemoryReimportArgs
>;

export type CloudMemoryReimportIssueCode =
  | "not_required"
  | "active"
  | "stale_epoch"
  | "owner_generation_changed"
  | "idempotency_conflict"
  | "account_unavailable"
  | "unauthorized"
  | "invalid_response"
  | "unavailable";

export class CloudMemoryReimportError extends Error {
  readonly code: CloudMemoryReimportIssueCode;
  readonly retryable: boolean;

  constructor(code: CloudMemoryReimportIssueCode, retryable = false) {
    super("Cloud Memory reimport authorization is unavailable.");
    this.name = "CloudMemoryReimportError";
    this.code = code;
    this.retryable = retryable;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const normalizedIdentityValue = (value: string, label: string): string => {
  if (
    !value ||
    value.length > MAX_IDENTITY_CHARS ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    !IDENTITY_PATTERN.test(value)
  ) {
    throw new TypeError(`A normalized ${label} is required.`);
  }
  return value;
};

const nonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

let fallbackRequestSequence = 0;

const defaultRequestEntropy = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  fallbackRequestSequence = (fallbackRequestSequence + 1) % 0x7fffffff;
  return `${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}`;
};

export const createCloudMemoryReimportRequestId = (
  createEntropy: () => string = defaultRequestEntropy,
): string => {
  const requestId = `desktop-memory-reimport:${createEntropy()}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError(
      "A valid cloud Memory reimport request id is required.",
    );
  }
  return requestId;
};

export const createCloudMemoryReimportRequestFence = (args: {
  accountScope: string;
  identityRevision: number;
  ownerSubject: string;
  createEntropy?: () => string;
}): CloudMemoryReimportRequestFence => {
  if (!nonNegativeSafeInteger(args.identityRevision)) {
    throw new TypeError("A valid identity revision is required.");
  }
  return Object.freeze({
    accountScope: normalizedIdentityValue(args.accountScope, "account scope"),
    identityRevision: args.identityRevision,
    ownerSubject: normalizedIdentityValue(args.ownerSubject, "owner subject"),
    requestId: createCloudMemoryReimportRequestId(args.createEntropy),
  });
};

export const beginCloudMemoryReimport = (args: {
  identity: CloudMemoryReimportIdentity;
  status: CloudMemoryWipeStatus;
  createEntropy?: () => string;
}): CloudMemoryReimportAttempt => {
  const status = decodeCloudMemoryWipeStatus(
    args.status,
    args.identity.ownerSubject,
  );
  if (status.state === "wiping") {
    throw new CloudMemoryReimportError("active");
  }
  if (status.importDisposition !== "explicit_required") {
    throw new CloudMemoryReimportError("not_required");
  }
  const fence = createCloudMemoryReimportRequestFence({
    ...args.identity,
    createEntropy: args.createEntropy,
  });
  return Object.freeze({
    ...fence,
    expectedSubject: fence.ownerSubject,
    expectedOwnerGeneration: status.ownerGeneration,
    expectedMemoryEpoch: status.memoryEpoch,
  });
};

export const cloudMemoryReimportMutationInput = (
  attempt: CloudMemoryReimportAttempt,
): AuthorizeCloudMemoryReimportArgs => ({
  expectedSubject: attempt.expectedSubject,
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
  expectedMemoryEpoch: attempt.expectedMemoryEpoch,
  requestId: attempt.requestId,
});

export const isCloudMemoryReimportRequestCurrent = (
  originating: CloudMemoryReimportRequestFence,
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

export const normalizeCloudMemoryReimportError = (
  error: unknown,
): CloudMemoryReimportError => {
  if (error instanceof CloudMemoryReimportError) return error;
  if (error instanceof CloudMemoryWipeError) {
    return new CloudMemoryReimportError("invalid_response");
  }
  const payload = readErrorPayload(error);
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code === "CLOUD_MEMORY_REIMPORT_NOT_REQUIRED") {
    return new CloudMemoryReimportError("not_required");
  }
  if (code === "CLOUD_MEMORY_WIPE_ACTIVE") {
    return new CloudMemoryReimportError("active");
  }
  if (code === "CLOUD_MEMORY_EPOCH_STALE") {
    return new CloudMemoryReimportError("stale_epoch");
  }
  if (
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNER_EXTERNAL_FENCE_MISMATCH" ||
    code === "OWNERSHIP_MIGRATED" ||
    code === "ANONYMOUS_IDENTITY_MIGRATED"
  ) {
    return new CloudMemoryReimportError("owner_generation_changed");
  }
  if (code === "CLOUD_HOME_IDEMPOTENCY_CONFLICT") {
    return new CloudMemoryReimportError("idempotency_conflict");
  }
  if (code === "OWNER_DATA_PURGE_ACTIVE") {
    return new CloudMemoryReimportError("account_unavailable");
  }
  if (
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "SESSION_IDENTITY_MISMATCH"
  ) {
    return new CloudMemoryReimportError("unauthorized");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /unauthenticated|authentication required|sign in|unauthorized/iu.test(
      message,
    )
  ) {
    return new CloudMemoryReimportError("unauthorized");
  }
  return new CloudMemoryReimportError("unavailable", true);
};

export type CloudMemoryReimportPort = {
  read: (args: { expectedSubject: string }) => Promise<unknown>;
  authorize: (args: AuthorizeCloudMemoryReimportArgs) => Promise<unknown>;
};

const validateAuthorizationResult = (
  status: CloudMemoryWipeStatus,
  attempt: CloudMemoryReimportAttempt,
): CloudMemoryWipeStatus => {
  if (status.ownerGeneration !== attempt.expectedOwnerGeneration) {
    throw new CloudMemoryReimportError("owner_generation_changed");
  }
  if (status.memoryEpoch !== attempt.expectedMemoryEpoch) {
    throw new CloudMemoryReimportError("stale_epoch");
  }
  if (status.state !== "open") {
    throw new CloudMemoryReimportError("active");
  }
  if (status.importDisposition !== "explicit_allowed") {
    throw new CloudMemoryReimportError("invalid_response");
  }
  return status;
};

export const createCloudMemoryReimportClient = (
  port: CloudMemoryReimportPort,
) => ({
  read: async (fence: CloudMemoryReimportRequestFence) => {
    try {
      return {
        fence,
        status: decodeCloudMemoryWipeStatus(
          await port.read({ expectedSubject: fence.ownerSubject }),
          fence.ownerSubject,
        ),
      };
    } catch (error) {
      throw normalizeCloudMemoryReimportError(error);
    }
  },
  authorize: async (attempt: CloudMemoryReimportAttempt) => {
    try {
      const status = decodeCloudMemoryWipeStatus(
        await port.authorize(cloudMemoryReimportMutationInput(attempt)),
        attempt.ownerSubject,
      );
      return {
        attempt,
        status: validateAuthorizationResult(status, attempt),
      };
    } catch (error) {
      throw normalizeCloudMemoryReimportError(error);
    }
  },
});
