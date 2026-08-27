import type {
  CloudMemoryPreference,
  SetCloudMemoryEnabledArgs,
} from "./cloud-home-api";

const MAX_OWNER_GENERATION_CHARS = 512;
const MAX_ACCOUNT_SCOPE_CHARS = 1_024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PREFERENCE_KEYS = new Set([
  "ownerGeneration",
  "memoryEnabled",
  "revision",
  "updatedAt",
]);
const SESSION_PREFERENCE_KEYS = new Set(["subject", ...PREFERENCE_KEYS]);

export type CloudMemoryPreferenceRequestFence = Readonly<{
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
  requestId: string;
}>;

export type CloudMemoryPreferenceWriteAttempt = Readonly<
  CloudMemoryPreferenceRequestFence & SetCloudMemoryEnabledArgs
>;

export type CloudMemoryPreferenceConflictHead = {
  revision: number;
  memoryEnabled: boolean;
};

export type CloudMemoryPreferenceIssue =
  | {
      code: "revision_conflict";
      retryable: false;
      current: CloudMemoryPreferenceConflictHead | null;
    }
  | {
      code:
        | "owner_generation_changed"
        | "idempotency_conflict"
        | "account_unavailable"
        | "unauthorized"
        | "invalid_response";
      retryable: false;
    }
  | { code: "unavailable"; retryable: true };

export class CloudMemoryPreferenceError extends Error {
  readonly code: Exclude<
    CloudMemoryPreferenceIssue["code"],
    "revision_conflict"
  >;
  readonly retryable: boolean;

  constructor(
    issue: Exclude<CloudMemoryPreferenceIssue, { code: "revision_conflict" }>,
  ) {
    super("Cloud memory preference is unavailable.");
    this.name = "CloudMemoryPreferenceError";
    this.code = issue.code;
    this.retryable = issue.retryable;
  }
}

const invalidResponse = (): never => {
  throw new CloudMemoryPreferenceError({
    code: "invalid_response",
    retryable: false,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean =>
  Object.keys(value).length === keys.size &&
  Object.keys(value).every((key) => keys.has(key));

const nonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

export const decodeCloudMemoryPreference = (
  value: unknown,
): CloudMemoryPreference => {
  if (!isRecord(value) || !hasExactKeys(value, PREFERENCE_KEYS)) {
    return invalidResponse();
  }
  if (
    typeof value.ownerGeneration !== "string" ||
    !OWNER_GENERATION_PATTERN.test(value.ownerGeneration) ||
    value.ownerGeneration.length > MAX_OWNER_GENERATION_CHARS ||
    value.ownerGeneration.normalize("NFC") !== value.ownerGeneration ||
    value.ownerGeneration.trim() !== value.ownerGeneration ||
    typeof value.memoryEnabled !== "boolean" ||
    !nonNegativeSafeInteger(value.revision) ||
    !nonNegativeSafeInteger(value.updatedAt) ||
    value.updatedAt > MAX_TIMESTAMP_MS
  ) {
    return invalidResponse();
  }
  return {
    ownerGeneration: value.ownerGeneration,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
};

export const decodeCloudMemoryPreferenceForSubject = (
  value: unknown,
  expectedSubject: string,
): CloudMemoryPreference => {
  const expected = normalizedSubject(expectedSubject);
  if (!isRecord(value) || !hasExactKeys(value, SESSION_PREFERENCE_KEYS)) {
    return invalidResponse();
  }
  if (value.subject !== expected) return invalidResponse();
  return decodeCloudMemoryPreference({
    ownerGeneration: value.ownerGeneration,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  });
};

const normalizedAccountScope = (value: string): string => {
  if (
    !value ||
    value.length > MAX_ACCOUNT_SCOPE_CHARS ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("A normalized account scope is required.");
  }
  return value;
};

const normalizedSubject = (value: string): string => {
  const subject = value.trim();
  if (
    !subject ||
    subject !== value ||
    subject.length > MAX_ACCOUNT_SCOPE_CHARS ||
    subject.normalize("NFC") !== subject ||
    hasControlCharacter(subject)
  ) {
    throw new TypeError("A normalized account subject is required.");
  }
  return subject;
};

let fallbackRequestSequence = 0;

const defaultRequestEntropy = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  fallbackRequestSequence = (fallbackRequestSequence + 1) % 0x7fffffff;
  return [
    Date.now().toString(36),
    fallbackRequestSequence.toString(36),
    Math.random().toString(36).slice(2, 14),
  ].join("-");
};

export const createCloudMemoryPreferenceRequestId = (
  createEntropy: () => string = defaultRequestEntropy,
): string => {
  const requestId = `desktop-memory:${createEntropy()}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError("A valid cloud memory request id is required.");
  }
  return requestId;
};

export const createCloudMemoryPreferenceRequestFence = (args: {
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
  createEntropy?: () => string;
}): CloudMemoryPreferenceRequestFence => {
  if (!nonNegativeSafeInteger(args.identityRevision)) {
    throw new TypeError("A valid identity revision is required.");
  }
  return Object.freeze({
    accountScope: normalizedAccountScope(args.accountScope),
    identityRevision: args.identityRevision,
    expectedSubject: normalizedSubject(args.expectedSubject),
    requestId: createCloudMemoryPreferenceRequestId(args.createEntropy),
  });
};

export const beginCloudMemoryPreferenceWrite = (args: {
  accountScope: string;
  expectedSubject: string;
  identityRevision: number;
  preference: CloudMemoryPreference;
  memoryEnabled: boolean;
  createEntropy?: () => string;
}): CloudMemoryPreferenceWriteAttempt => {
  const preference = decodeCloudMemoryPreference(args.preference);
  if (typeof args.memoryEnabled !== "boolean") {
    throw new TypeError("Cloud memory preference must be a boolean.");
  }
  const fence = createCloudMemoryPreferenceRequestFence(args);
  return Object.freeze({
    ...fence,
    memoryEnabled: args.memoryEnabled,
    expectedOwnerGeneration: preference.ownerGeneration,
    expectedRevision: preference.revision,
  });
};

export const cloudMemoryPreferenceMutationInput = (
  attempt: CloudMemoryPreferenceWriteAttempt,
): SetCloudMemoryEnabledArgs => ({
  expectedSubject: attempt.expectedSubject,
  memoryEnabled: attempt.memoryEnabled,
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
  expectedRevision: attempt.expectedRevision,
  requestId: attempt.requestId,
});

export const isCloudMemoryPreferenceRequestCurrent = (
  originating: CloudMemoryPreferenceRequestFence,
  current: {
    accountScope: string | null | undefined;
    identityRevision: number | null | undefined;
    expectedSubject: string | null | undefined;
    requestId: string | null | undefined;
  },
): boolean =>
  originating.accountScope === current.accountScope &&
  originating.identityRevision === current.identityRevision &&
  originating.expectedSubject === current.expectedSubject &&
  originating.requestId === current.requestId;

const readSerializedPayload = (
  message: string,
): Record<string, unknown> | null => {
  const first = message.indexOf("{");
  const last = message.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(first, last + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readErrorPayload = (error: unknown): Record<string, unknown> | null => {
  if (isRecord(error) && isRecord(error.data)) return error.data;
  return error instanceof Error ? readSerializedPayload(error.message) : null;
};

export const normalizeCloudMemoryPreferenceIssue = (
  error: unknown,
): CloudMemoryPreferenceIssue => {
  if (error instanceof CloudMemoryPreferenceError) {
    return { code: error.code, retryable: error.retryable } as Exclude<
      CloudMemoryPreferenceIssue,
      { code: "revision_conflict" }
    >;
  }
  const payload = readErrorPayload(error);
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code === "CLOUD_HOME_REVISION_CONFLICT") {
    const current =
      nonNegativeSafeInteger(payload?.currentRevision) &&
      typeof payload?.currentMemoryEnabled === "boolean"
        ? {
            revision: payload.currentRevision,
            memoryEnabled: payload.currentMemoryEnabled,
          }
        : null;
    return { code: "revision_conflict", retryable: false, current };
  }
  if (
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNER_EXTERNAL_FENCE_MISMATCH" ||
    code === "OWNERSHIP_MIGRATED" ||
    code === "ANONYMOUS_IDENTITY_MIGRATED"
  ) {
    return { code: "owner_generation_changed", retryable: false };
  }
  if (code === "OWNER_DATA_PURGE_ACTIVE") {
    return { code: "account_unavailable", retryable: false };
  }
  if (code === "CLOUD_HOME_IDEMPOTENCY_CONFLICT") {
    return { code: "idempotency_conflict", retryable: false };
  }
  if (
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "SESSION_IDENTITY_MISMATCH"
  ) {
    return { code: "unauthorized", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /unauthenticated|authentication required|sign in|unauthorized/iu.test(
      message,
    )
  ) {
    return { code: "unauthorized", retryable: false };
  }
  return { code: "unavailable", retryable: true };
};

export type CloudMemoryPreferencePort = {
  read: (args: { expectedSubject: string }) => Promise<unknown>;
  write: (input: SetCloudMemoryEnabledArgs) => Promise<unknown>;
};

export type CloudMemoryPreferenceReadResult = {
  fence: CloudMemoryPreferenceRequestFence;
  preference: CloudMemoryPreference;
};

export type CloudMemoryPreferenceWriteResult =
  | {
      status: "committed";
      fence: CloudMemoryPreferenceWriteAttempt;
      preference: CloudMemoryPreference;
    }
  | {
      status: "conflict";
      fence: CloudMemoryPreferenceWriteAttempt;
      current: CloudMemoryPreferenceConflictHead | null;
    };

export const createCloudMemoryPreferenceClient = (
  port: CloudMemoryPreferencePort,
) => ({
  read: async (
    fence: CloudMemoryPreferenceRequestFence,
  ): Promise<CloudMemoryPreferenceReadResult> => {
    try {
      const preference = decodeCloudMemoryPreferenceForSubject(
        await port.read({
          expectedSubject: fence.expectedSubject,
        }),
        fence.expectedSubject,
      );
      return { fence, preference };
    } catch (error) {
      const issue = normalizeCloudMemoryPreferenceIssue(error);
      if (issue.code === "revision_conflict") {
        throw new CloudMemoryPreferenceError({
          code: "unavailable",
          retryable: true,
        });
      }
      throw new CloudMemoryPreferenceError(issue);
    }
  },
  write: async (
    attempt: CloudMemoryPreferenceWriteAttempt,
  ): Promise<CloudMemoryPreferenceWriteResult> => {
    try {
      const preference = decodeCloudMemoryPreferenceForSubject(
        await port.write(cloudMemoryPreferenceMutationInput(attempt)),
        attempt.expectedSubject,
      );
      if (
        preference.ownerGeneration !== attempt.expectedOwnerGeneration ||
        preference.memoryEnabled !== attempt.memoryEnabled ||
        preference.revision !== attempt.expectedRevision + 1
      ) {
        return invalidResponse();
      }
      return { status: "committed", fence: attempt, preference };
    } catch (error) {
      const issue = normalizeCloudMemoryPreferenceIssue(error);
      if (issue.code === "revision_conflict") {
        return {
          status: "conflict",
          fence: attempt,
          current: issue.current,
        };
      }
      throw new CloudMemoryPreferenceError(issue);
    }
  },
});
