const MAX_OWNER_GENERATION_CHARS = 512;
const MAX_ACCOUNT_SCOPE_CHARS = 1_024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PREFERENCE_KEYS = new Set([
  "ownerGeneration",
  "memoryEnabled",
  "revision",
  "updatedAt",
]);
const SESSION_PREFERENCE_KEYS = new Set(["subject", ...PREFERENCE_KEYS]);

export type MobileCloudMemoryPreference = {
  ownerGeneration: string;
  memoryEnabled: boolean;
  revision: number;
  updatedAt: number;
};

export type MobileCloudMemoryPreferenceRequestFence = Readonly<{
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  expectedSubject: string;
  requestId: string;
}>;

export type MobileCloudMemoryPreferenceWriteAttempt = Readonly<{
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  expectedSubject: string;
  requestId: string;
  memoryEnabled: boolean;
  expectedOwnerGeneration: string;
  expectedRevision: number;
}>;

export type MobileCloudMemoryPreferenceMutationInput = {
  expectedSubject: string;
  memoryEnabled: boolean;
  expectedOwnerGeneration: string;
  expectedRevision: number;
  requestId: string;
};

export type MobileCloudMemoryPreferenceConflictHead = {
  revision: number;
  memoryEnabled: boolean;
};

export type MobileCloudMemoryPreferenceIssue =
  | {
      code: "revision_conflict";
      retryable: false;
      current: MobileCloudMemoryPreferenceConflictHead | null;
    }
  | {
      code:
        | "owner_generation_changed"
        | "idempotency_conflict"
        | "unauthorized"
        | "invalid_response";
      retryable: false;
    }
  | { code: "account_unavailable"; retryable: false }
  | { code: "unavailable"; retryable: true };

export class MobileCloudMemoryPreferenceError extends Error {
  readonly code: Exclude<
    MobileCloudMemoryPreferenceIssue["code"],
    "revision_conflict"
  >;
  readonly retryable: boolean;

  constructor(
    issue: Exclude<
      MobileCloudMemoryPreferenceIssue,
      { code: "revision_conflict" }
    >,
  ) {
    const message =
      issue.code === "owner_generation_changed"
        ? "Cloud memory changed account generations. Reload this setting."
        : issue.code === "account_unavailable"
          ? "Cloud memory is unavailable while this account is being reset."
          : issue.code === "idempotency_conflict"
            ? "This cloud memory update no longer identifies the same change."
            : issue.code === "unauthorized"
              ? "Sign in again to change cloud memory."
              : issue.code === "invalid_response"
                ? "Cloud memory returned an invalid response."
                : "Cloud memory could not be reached. Try again.";
    super(message);
    this.name = "MobileCloudMemoryPreferenceError";
    this.code = issue.code;
    this.retryable = issue.retryable;
  }
}

const invalidResponse = (): never => {
  throw new MobileCloudMemoryPreferenceError({
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

const readOwnerGeneration = (value: unknown): string => {
  if (typeof value !== "string") return invalidResponse();
  if (
    !value ||
    value.length > MAX_OWNER_GENERATION_CHARS ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    !OWNER_GENERATION_PATTERN.test(value)
  ) {
    return invalidResponse();
  }
  return value;
};

const readNormalizedIdentity = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_ACCOUNT_SCOPE_CHARS ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(`A normalized ${label} is required.`);
  }
  return value;
};

const readIdentityRevision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("A non-negative identity revision is required.");
  }
  return value as number;
};

export const createMobileCloudMemoryOwnerSubject = (
  issuer: string,
  userSubject: string,
): string =>
  `${readNormalizedIdentity(issuer, "token issuer")}|${readNormalizedIdentity(
    userSubject,
    "user subject",
  )}`;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Strictly decodes the public Convex preference projection. */
export const decodeMobileCloudMemoryPreference = (
  value: unknown,
): MobileCloudMemoryPreference => {
  if (!isRecord(value) || !hasExactKeys(value, PREFERENCE_KEYS)) {
    return invalidResponse();
  }
  const ownerGeneration = readOwnerGeneration(value.ownerGeneration);
  if (
    typeof value.memoryEnabled !== "boolean" ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isNonNegativeSafeInteger(value.updatedAt) ||
    value.updatedAt > MAX_TIMESTAMP_MS
  ) {
    return invalidResponse();
  }
  return {
    ownerGeneration,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
};

/**
 * Strictly decodes the session-attested public projection. The server echoes
 * the exact authenticated tokenIdentifier so a renderer can never relabel an
 * account-A result as account B after an auth transition.
 */
export const decodeMobileCloudMemoryPreferenceForSubject = (
  value: unknown,
  expectedSubject: string,
): MobileCloudMemoryPreference => {
  const expected = readNormalizedIdentity(expectedSubject, "owner subject");
  if (!isRecord(value) || !hasExactKeys(value, SESSION_PREFERENCE_KEYS)) {
    return invalidResponse();
  }
  if (value.subject !== expected) return invalidResponse();
  return decodeMobileCloudMemoryPreference({
    ownerGeneration: value.ownerGeneration,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  });
};

const readAccountScope = (value: string): string => {
  return readNormalizedIdentity(value, "account scope");
};

const readRequestId = (value: string): string => {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new TypeError("A valid cloud memory request id is required.");
  }
  return value;
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

/** Creates one backend-valid id. Call once per logical toggle attempt. */
export const createMobileCloudMemoryPreferenceRequestId = (
  createEntropy: () => string = defaultRequestEntropy,
): string => {
  const entropy = createEntropy();
  if (
    typeof entropy !== "string" ||
    !entropy ||
    entropy.normalize("NFC") !== entropy ||
    entropy.trim() !== entropy
  ) {
    throw new TypeError("Cloud memory request entropy is invalid.");
  }
  return readRequestId(`mobile-memory:${entropy}`);
};

export const createMobileCloudMemoryPreferenceRequestFence = (
  identity: {
    accountScope: string;
    identityKey: string;
    identityRevision: number;
    expectedSubject: string;
  },
  createEntropy?: () => string,
): MobileCloudMemoryPreferenceRequestFence =>
  Object.freeze({
    accountScope: readAccountScope(identity.accountScope),
    identityKey: readNormalizedIdentity(identity.identityKey, "identity key"),
    identityRevision: readIdentityRevision(identity.identityRevision),
    expectedSubject: readNormalizedIdentity(
      identity.expectedSubject,
      "owner subject",
    ),
    requestId: createMobileCloudMemoryPreferenceRequestId(createEntropy),
  });

/**
 * Captures the CAS base and idempotency id once. Retrying this exact object is
 * safe; a new target or newly loaded revision must create a new attempt.
 */
export const beginMobileCloudMemoryPreferenceWrite = (args: {
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  expectedSubject: string;
  preference: MobileCloudMemoryPreference;
  memoryEnabled: boolean;
  createEntropy?: () => string;
}): MobileCloudMemoryPreferenceWriteAttempt => {
  const preference = decodeMobileCloudMemoryPreference(args.preference);
  if (typeof args.memoryEnabled !== "boolean") {
    throw new TypeError("Cloud memory preference must be a boolean.");
  }
  const fence = createMobileCloudMemoryPreferenceRequestFence(
    args,
    args.createEntropy,
  );
  return Object.freeze({
    ...fence,
    memoryEnabled: args.memoryEnabled,
    expectedOwnerGeneration: preference.ownerGeneration,
    expectedRevision: preference.revision,
  });
};

export const mobileCloudMemoryPreferenceMutationInput = (
  attempt: MobileCloudMemoryPreferenceWriteAttempt,
): MobileCloudMemoryPreferenceMutationInput => ({
  expectedSubject: attempt.expectedSubject,
  memoryEnabled: attempt.memoryEnabled,
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
  expectedRevision: attempt.expectedRevision,
  requestId: attempt.requestId,
});

export const isMobileCloudMemoryPreferenceRequestCurrent = (
  originating: MobileCloudMemoryPreferenceRequestFence,
  current: {
    accountScope: string | null | undefined;
    identityKey: string | null | undefined;
    identityRevision: number | null | undefined;
    expectedSubject?: string | null | undefined;
    requestId: string | null | undefined;
  },
): boolean =>
  originating.accountScope === current.accountScope &&
  originating.identityKey === current.identityKey &&
  originating.identityRevision === current.identityRevision &&
  (current.expectedSubject === undefined ||
    originating.expectedSubject === current.expectedSubject) &&
  originating.requestId === current.requestId;

export type MobileCloudMemoryPreferenceFencedResult = {
  fence: MobileCloudMemoryPreferenceRequestFence;
  preference?: MobileCloudMemoryPreference;
};

/** Drops late results after account replacement or a newer request. */
export const acceptCurrentMobileCloudMemoryPreferenceResult = <
  T extends MobileCloudMemoryPreferenceFencedResult,
>(
  result: T,
  current: {
    accountScope: string | null | undefined;
    identityKey: string | null | undefined;
    identityRevision: number | null | undefined;
    expectedSubject?: string | null | undefined;
    requestId: string | null | undefined;
    ownerGeneration?: string | null | undefined;
  },
): T | null =>
  isMobileCloudMemoryPreferenceRequestCurrent(result.fence, current) &&
  (!current.ownerGeneration ||
    (result.preference
      ? result.preference.ownerGeneration === current.ownerGeneration
      : "expectedOwnerGeneration" in result.fence &&
        result.fence.expectedOwnerGeneration === current.ownerGeneration))
    ? result
    : null;

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

/** Converts Convex details into a small, UI-safe and exhaustive issue set. */
export const normalizeMobileCloudMemoryPreferenceIssue = (
  error: unknown,
): MobileCloudMemoryPreferenceIssue => {
  if (error instanceof MobileCloudMemoryPreferenceError) {
    return { code: error.code, retryable: error.retryable } as Exclude<
      MobileCloudMemoryPreferenceIssue,
      { code: "revision_conflict" }
    >;
  }
  const payload = readErrorPayload(error);
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code === "CLOUD_HOME_REVISION_CONFLICT") {
    const current =
      isNonNegativeSafeInteger(payload?.currentRevision) &&
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
    // Even a temporary reset rotates the owner generation. A UI may offer a
    // reload, but it must never replay the same frozen write attempt.
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

export type MobileCloudMemoryPreferencePort = {
  getMyMemoryPreference: (input: {
    expectedSubject: string;
  }) => Promise<unknown>;
  setMyMemoryEnabled: (
    input: MobileCloudMemoryPreferenceMutationInput,
  ) => Promise<unknown>;
};

export type MobileCloudMemoryPreferenceReadResult = {
  fence: MobileCloudMemoryPreferenceRequestFence;
  preference: MobileCloudMemoryPreference;
};

export type MobileCloudMemoryPreferenceWriteResult =
  | {
      status: "committed";
      fence: MobileCloudMemoryPreferenceWriteAttempt;
      preference: MobileCloudMemoryPreference;
    }
  | {
      status: "conflict";
      fence: MobileCloudMemoryPreferenceWriteAttempt;
      /** Partial server hint only. Reload before publishing a new snapshot. */
      current: MobileCloudMemoryPreferenceConflictHead | null;
    };

export type MobileCloudMemoryPreferenceClient = {
  read: (
    fence: MobileCloudMemoryPreferenceRequestFence,
  ) => Promise<MobileCloudMemoryPreferenceReadResult>;
  write: (
    attempt: MobileCloudMemoryPreferenceWriteAttempt,
  ) => Promise<MobileCloudMemoryPreferenceWriteResult>;
};

const preferenceError = (error: unknown): MobileCloudMemoryPreferenceError => {
  const issue = normalizeMobileCloudMemoryPreferenceIssue(error);
  if (issue.code === "revision_conflict") {
    return new MobileCloudMemoryPreferenceError({
      code: "unavailable",
      retryable: true,
    });
  }
  return new MobileCloudMemoryPreferenceError(issue);
};

/** Dependency-injected adapter used by React hooks and deterministic tests. */
export const createMobileCloudMemoryPreferenceClient = (
  port: MobileCloudMemoryPreferencePort,
): MobileCloudMemoryPreferenceClient => ({
  read: async (fence) => {
    try {
      const preference = decodeMobileCloudMemoryPreferenceForSubject(
        await port.getMyMemoryPreference({
          expectedSubject: fence.expectedSubject,
        }),
        fence.expectedSubject,
      );
      return { fence, preference };
    } catch (error) {
      throw preferenceError(error);
    }
  },
  write: async (attempt) => {
    try {
      const preference = decodeMobileCloudMemoryPreferenceForSubject(
        await port.setMyMemoryEnabled(
          mobileCloudMemoryPreferenceMutationInput(attempt),
        ),
        attempt.expectedSubject,
      );
      if (preference.ownerGeneration !== attempt.expectedOwnerGeneration) {
        throw new MobileCloudMemoryPreferenceError({
          code: "owner_generation_changed",
          retryable: false,
        });
      }
      if (
        preference.memoryEnabled !== attempt.memoryEnabled ||
        preference.revision !== attempt.expectedRevision + 1
      ) {
        throw new MobileCloudMemoryPreferenceError({
          code: "invalid_response",
          retryable: false,
        });
      }
      return { status: "committed", fence: attempt, preference };
    } catch (error) {
      const issue = normalizeMobileCloudMemoryPreferenceIssue(error);
      if (issue.code === "revision_conflict") {
        return {
          status: "conflict",
          fence: attempt,
          current: issue.current,
        };
      }
      throw new MobileCloudMemoryPreferenceError(issue);
    }
  },
});
