import {
  createCloudMemoryPreferenceRequestId,
  decodeCloudMemoryPolicy,
  isNonNegativeSafeInteger,
  normalizedCloudMemoryIdentity,
  writeCloudMemoryPreference,
  type SetCloudMemoryEnabledArgs,
} from "@stella/contracts/cloud-memory-preference";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";

export type CloudMemoryPreferenceRequestFence = Readonly<{
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
  requestId: string;
}>;

export type CloudMemoryPreferenceWriteAttempt = Readonly<
  CloudMemoryPreferenceRequestFence & SetCloudMemoryEnabledArgs
>;

export const createCloudMemoryPreferenceRequestFence = (args: {
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
  createEntropy?: () => string;
}): CloudMemoryPreferenceRequestFence => {
  if (!isNonNegativeSafeInteger(args.identityRevision)) {
    throw new TypeError("A valid identity revision is required.");
  }
  return Object.freeze({
    accountScope: normalizedCloudMemoryIdentity(
      args.accountScope,
      "account scope",
    ),
    identityRevision: args.identityRevision,
    expectedSubject: normalizedCloudMemoryIdentity(
      args.expectedSubject,
      "account subject",
    ),
    requestId: createCloudMemoryPreferenceRequestId(
      "desktop",
      args.createEntropy,
    ),
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

export type CloudMemoryPreferencePort = {
  write: (input: SetCloudMemoryEnabledArgs) => Promise<unknown>;
};

export const createCloudMemoryPreferenceClient = (
  port: CloudMemoryPreferencePort,
) => ({
  write: (attempt: CloudMemoryPreferenceWriteAttempt) =>
    writeCloudMemoryPreference(attempt, (input) => port.write(input)),
});
