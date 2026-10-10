import {
  createCloudMemoryPreferenceRequestId,
  decodeCloudMemoryPreferenceForSubject,
  decodeCloudMemorySwitch,
  isNonNegativeSafeInteger,
  normalizedCloudMemoryIdentity as readNormalizedIdentity,
  writeCloudMemoryPreference,
  type CloudMemorySwitch,
  type SetCloudMemoryEnabledArgs,
} from "@stella/contracts/cloud-memory-preference";

/**
 * The mobile names for the shared cloud memory client
 * (`@stella/contracts/cloud-memory-preference`). Mobile adds an identity key
 * to its request fence and drops late results against it.
 */
export {
  CloudMemoryPreferenceError as MobileCloudMemoryPreferenceError,
  cloudMemoryPreferenceMutationInput as mobileCloudMemoryPreferenceMutationInput,
  decodeCloudMemorySwitch as decodeMobileCloudMemoryPreference,
  followsOwnerGeneration as followsMobileOwnerGeneration,
  normalizeCloudMemoryPreferenceIssue as normalizeMobileCloudMemoryPreferenceIssue,
  type CloudMemoryPreferenceIssue as MobileCloudMemoryPreferenceIssue,
} from "@stella/contracts/cloud-memory-preference";

export type MobileCloudMemoryPreference = CloudMemorySwitch;

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
  SetCloudMemoryEnabledArgs;

const readIdentityRevision = (value: unknown): number => {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TypeError("A non-negative identity revision is required.");
  }
  return value;
};

export const createMobileCloudMemoryOwnerSubject = (
  issuer: string,
  userSubject: string,
): string =>
  `${readNormalizedIdentity(issuer, "token issuer")}|${readNormalizedIdentity(
    userSubject,
    "user subject",
  )}`;

/**
 * Strictly decodes a `memory.preference` view value or `memory.setEnabled`
 * result. The backend echoes the caller's owner id so a renderer can never
 * relabel an account-A result as account B after an auth transition.
 */
export const decodeMobileCloudMemoryPreferenceForSubject = (
  value: unknown,
  expectedSubject: string,
): MobileCloudMemoryPreference => {
  const { memoryEpoch: _memoryEpoch, ...preference } =
    decodeCloudMemoryPreferenceForSubject(value, expectedSubject);
  return preference;
};

/** Creates one backend-valid id. Call once per logical toggle attempt. */
export const createMobileCloudMemoryPreferenceRequestId = (
  createEntropy?: () => string,
): string => createCloudMemoryPreferenceRequestId("mobile", createEntropy);

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
    accountScope: readNormalizedIdentity(
      identity.accountScope,
      "account scope",
    ),
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
  const preference = decodeCloudMemorySwitch(args.preference);
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
    const result = await writeCloudMemoryPreference(attempt, (input) =>
      port.setMemoryEnabled(input),
    );
    if (result.status === "conflict") return result;
    const { memoryEpoch: _memoryEpoch, ...preference } = result.preference;
    return { status: "committed", fence: attempt, preference };
  },
});
