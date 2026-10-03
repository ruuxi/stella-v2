import { BackendRequestError } from "@stella/contracts/backend/client";
import type { HomeCalls } from "@stella/contracts/backend/home";
import { OWNER_GENERATION_STALE } from "@stella/contracts/backend/protocol";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";

const MAX_OWNER_GENERATION_CHARS = 512;
const MAX_ACCOUNT_SCOPE_CHARS = 1_024;
const MAX_TOKEN_CHARS = 1_024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|?-]{0,1023}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const POLICY_KEYS = new Set([
  "ownerGeneration",
  "memoryEpoch",
  "memoryEnabled",
  "revision",
  "updatedAt",
]);
const PREFERENCE_KEYS = new Set([
  "subject",
  "state",
  "importDisposition",
  ...POLICY_KEYS,
]);
const PREFERENCE_OPTIONAL_KEYS = new Set(["lastWipedEpoch"]);

export type SetCloudMemoryEnabledArgs = HomeCalls["memory.setEnabled"]["args"];

export type CloudMemoryPreferenceRequestFence = Readonly<{
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
  requestId: string;
}>;

export type CloudMemoryPreferenceWriteAttempt = Readonly<
  CloudMemoryPreferenceRequestFence & SetCloudMemoryEnabledArgs
>;

export type CloudMemoryPreferenceIssue =
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
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean =>
  [...required].every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.has(key) || optional.has(key));

const nonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

/**
 * Whether an observed owner generation can follow a request made against
 * `expected`. Views report `""` before the owner's first cloud-home write;
 * a call made against `""` comes back stamped with a real generation.
 */
export const followsOwnerGeneration = (
  expected: string,
  observed: string,
): boolean => (expected === "" ? observed !== "" : observed === expected);

const isToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_TOKEN_CHARS &&
  value.normalize("NFC") === value &&
  value.trim() === value &&
  !hasControlCharacter(value) &&
  TOKEN_PATTERN.test(value);

/**
 * Strictly decodes the memory switch the hook works from. `ownerGeneration`
 * is `""` until the owner's first cloud-home write.
 */
export const decodeCloudMemoryPolicy = (value: unknown): MemoryPolicy => {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) {
    return invalidResponse();
  }
  if (
    typeof value.ownerGeneration !== "string" ||
    (value.ownerGeneration !== "" &&
      !OWNER_GENERATION_PATTERN.test(value.ownerGeneration)) ||
    value.ownerGeneration.length > MAX_OWNER_GENERATION_CHARS ||
    value.ownerGeneration.normalize("NFC") !== value.ownerGeneration ||
    value.ownerGeneration.trim() !== value.ownerGeneration ||
    !isToken(value.memoryEpoch) ||
    typeof value.memoryEnabled !== "boolean" ||
    !nonNegativeSafeInteger(value.revision) ||
    !nonNegativeSafeInteger(value.updatedAt) ||
    value.updatedAt > MAX_TIMESTAMP_MS
  ) {
    return invalidResponse();
  }
  return {
    ownerGeneration: value.ownerGeneration,
    memoryEpoch: value.memoryEpoch,
    memoryEnabled: value.memoryEnabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
};

/**
 * Decodes a `memory.preference` view value or `memory.setEnabled` result.
 * The backend echoes the caller's owner id, so a result that belongs to
 * another account is refused rather than relabeled.
 */
export const decodeCloudMemoryPreferenceForSubject = (
  value: unknown,
  expectedSubject: string,
): MemoryPolicy => {
  const expected = normalizedSubject(expectedSubject);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PREFERENCE_KEYS, PREFERENCE_OPTIONAL_KEYS)
  ) {
    return invalidResponse();
  }
  if (
    value.subject !== expected ||
    (value.state !== "open" && value.state !== "wiping") ||
    (value.importDisposition !== "automatic_allowed" &&
      value.importDisposition !== "explicit_required" &&
      value.importDisposition !== "explicit_allowed") ||
    (value.lastWipedEpoch !== undefined && !isToken(value.lastWipedEpoch))
  ) {
    return invalidResponse();
  }
  return decodeCloudMemoryPolicy({
    ownerGeneration: value.ownerGeneration,
    memoryEpoch: value.memoryEpoch,
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
  preference: MemoryPolicy;
  memoryEnabled: boolean;
  createEntropy?: () => string;
}): CloudMemoryPreferenceWriteAttempt => {
  const preference = decodeCloudMemoryPolicy(args.preference);
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
  requestId: attempt.requestId,
  memoryEnabled: attempt.memoryEnabled,
  expectedRevision: attempt.expectedRevision,
  expectedOwnerGeneration: attempt.expectedOwnerGeneration,
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

export const normalizeCloudMemoryPreferenceIssue = (
  error: unknown,
): CloudMemoryPreferenceIssue => {
  if (error instanceof CloudMemoryPreferenceError) {
    return { code: error.code, retryable: error.retryable } as Exclude<
      CloudMemoryPreferenceIssue,
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

export type CloudMemoryPreferencePort = {
  write: (input: SetCloudMemoryEnabledArgs) => Promise<unknown>;
};

export type CloudMemoryPreferenceWriteResult =
  | {
      status: "committed";
      fence: CloudMemoryPreferenceWriteAttempt;
      preference: MemoryPolicy;
    }
  | {
      status: "conflict";
      fence: CloudMemoryPreferenceWriteAttempt;
    };

export const createCloudMemoryPreferenceClient = (
  port: CloudMemoryPreferencePort,
) => ({
  write: async (
    attempt: CloudMemoryPreferenceWriteAttempt,
  ): Promise<CloudMemoryPreferenceWriteResult> => {
    try {
      const preference = decodeCloudMemoryPreferenceForSubject(
        await port.write(cloudMemoryPreferenceMutationInput(attempt)),
        attempt.expectedSubject,
      );
      if (
        !followsOwnerGeneration(
          attempt.expectedOwnerGeneration,
          preference.ownerGeneration,
        ) ||
        preference.memoryEnabled !== attempt.memoryEnabled ||
        preference.revision !== attempt.expectedRevision + 1
      ) {
        return invalidResponse();
      }
      return { status: "committed", fence: attempt, preference };
    } catch (error) {
      const issue = normalizeCloudMemoryPreferenceIssue(error);
      if (issue.code === "revision_conflict") {
        return { status: "conflict", fence: attempt };
      }
      throw new CloudMemoryPreferenceError(issue);
    }
  },
});
