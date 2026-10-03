import { BackendRequestError } from "@stella/contracts/backend/client";
import type { HomeCalls } from "@stella/contracts/backend/home";
import { OWNER_GENERATION_STALE } from "@stella/contracts/backend/protocol";

const MAX_OWNER_GENERATION_CHARS = 512;
const MAX_ACCOUNT_SCOPE_CHARS = 1_024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|?-]{0,1023}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PREFERENCE_KEYS = new Set([
  "ownerGeneration",
  "memoryEnabled",
  "revision",
  "updatedAt",
]);
const SESSION_PREFERENCE_KEYS = new Set([
  "subject",
  "memoryEpoch",
  "state",
  "importDisposition",
  ...PREFERENCE_KEYS,
]);
const SESSION_PREFERENCE_OPTIONAL_KEYS = new Set(["lastWipedEpoch"]);

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

export type MobileCloudMemoryPreferenceMutationInput =
  HomeCalls["memory.setEnabled"]["args"];

export type MobileCloudMemoryPreferenceIssue =
  | { code: "revision_conflict"; retryable: false }
  | {
      code:
        | "owner_generation_changed"
        | "idempotency_conflict"
        | "unauthorized"
        | "invalid_response";
      retryable: false;
    }
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
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean =>
  [...required].every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.has(key) || optional.has(key));

const isEpoch = (value: unknown): value is string =>
  typeof value === "string" &&
  value.normalize("NFC") === value &&
  value.trim() === value &&
  !CONTROL_CHARACTER_PATTERN.test(value) &&
  EPOCH_PATTERN.test(value);

/** `""` until the owner's first cloud-home write. */
const readOwnerGeneration = (value: unknown): string => {
  if (typeof value !== "string") return invalidResponse();
  if (value === "") return value;
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

/**
 * Whether an observed owner generation can follow a request made against
 * `expected`. Views report `""` before the owner's first cloud-home write;
 * a call made against `""` comes back stamped with a real generation.
 */
export const followsMobileOwnerGeneration = (
  expected: string,
  observed: string,
): boolean => (expected === "" ? observed !== "" : observed === expected);

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

/** Strictly decodes the preference projection the switch works from. */
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
 * Strictly decodes a `memory.preference` view value or `memory.setEnabled`
 * result. The backend echoes the caller's owner id so a renderer can never
 * relabel an account-A result as account B after an auth transition.
 */
export const decodeMobileCloudMemoryPreferenceForSubject = (
  value: unknown,
  expectedSubject: string,
): MobileCloudMemoryPreference => {
  const expected = readNormalizedIdentity(expectedSubject, "owner subject");
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      SESSION_PREFERENCE_KEYS,
      SESSION_PREFERENCE_OPTIONAL_KEYS,
    )
  ) {
    return invalidResponse();
  }
  if (
    value.subject !== expected ||
    !isEpoch(value.memoryEpoch) ||
    (value.state !== "open" && value.state !== "wiping") ||
    (value.importDisposition !== "automatic_allowed" &&
      value.importDisposition !== "explicit_required" &&
      value.importDisposition !== "explicit_allowed") ||
    (value.lastWipedEpoch !== undefined && !isEpoch(value.lastWipedEpoch))
  ) {
    return invalidResponse();
  }
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
  requestId: attempt.requestId,
  memoryEnabled: attempt.memoryEnabled,
  expectedRevision: attempt.expectedRevision,
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
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

/** Converts backend refusals into a small, UI-safe and exhaustive issue set. */
export const normalizeMobileCloudMemoryPreferenceIssue = (
  error: unknown,
): MobileCloudMemoryPreferenceIssue => {
  if (error instanceof MobileCloudMemoryPreferenceError) {
    return { code: error.code, retryable: error.retryable } as Exclude<
      MobileCloudMemoryPreferenceIssue,
      { code: "revision_conflict" }
    >;
  }
  // Anything that is not a backend refusal is a transport failure, and the
  // exact attempt (same request id) is safe to replay.
  if (!(error instanceof BackendRequestError)) {
    return { code: "unavailable", retryable: true };
  }
  if (error.reason === "CLOUD_HOME_REVISION_CONFLICT") {
    return { code: "revision_conflict", retryable: false };
  }
  if (error.reason === OWNER_GENERATION_STALE) {
    // A reset rotates the owner generation. A UI may offer a reload, but it
    // must never replay the same frozen write attempt.
    return { code: "owner_generation_changed", retryable: false };
  }
  if (error.reason === "CLOUD_HOME_IDEMPOTENCY_CONFLICT") {
    return { code: "idempotency_conflict", retryable: false };
  }
  if (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN") {
    return { code: "unauthorized", retryable: false };
  }
  // Includes MEMORY_POLICY_CHANGING: the change is still being applied and
  // the same request id settles it.
  return { code: "unavailable", retryable: true };
};

export type MobileCloudMemoryPreferencePort = {
  setMemoryEnabled: (
    input: MobileCloudMemoryPreferenceMutationInput,
  ) => Promise<unknown>;
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
    };

export type MobileCloudMemoryPreferenceClient = {
  write: (
    attempt: MobileCloudMemoryPreferenceWriteAttempt,
  ) => Promise<MobileCloudMemoryPreferenceWriteResult>;
};

/** Dependency-injected adapter used by React hooks and deterministic tests. */
export const createMobileCloudMemoryPreferenceClient = (
  port: MobileCloudMemoryPreferencePort,
): MobileCloudMemoryPreferenceClient => ({
  write: async (attempt) => {
    try {
      const preference = decodeMobileCloudMemoryPreferenceForSubject(
        await port.setMemoryEnabled(
          mobileCloudMemoryPreferenceMutationInput(attempt),
        ),
        attempt.expectedSubject,
      );
      if (
        !followsMobileOwnerGeneration(
          attempt.expectedOwnerGeneration,
          preference.ownerGeneration,
        )
      ) {
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
        return { status: "conflict", fence: attempt };
      }
      throw new MobileCloudMemoryPreferenceError(issue);
    }
  },
});
