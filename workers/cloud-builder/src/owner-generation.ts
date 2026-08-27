export const normalizeOwnerGeneration = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
};

export const ownerGenerationMatches = (
  expected: string | undefined,
  incoming: unknown,
): boolean => {
  const normalized = normalizeOwnerGeneration(incoming);
  return Boolean(expected && normalized === expected);
};

/** A forced admission lookup must never share an older in-flight lookup. */
export const mayReusePendingOwnerLookup = (
  forceGenerationRefresh: boolean,
): boolean => !forceGenerationRefresh;

export type OwnerPurgeBeginDisposition =
  | {
      action: "start";
      mode: "temporary" | "permanent";
      rejoined: boolean;
    }
  | {
      action: "resume";
      upgradeToPermanent: boolean;
      rejoined: boolean;
    }
  | { action: "reject" };

/**
 * Decides whether a purge begin request creates, resumes, or rejoins a fence.
 *
 * `rejoinedFromGeneration` makes the rejoin acknowledgement itself replayable:
 * if the response carrying the replacement generation is lost, retrying with
 * the released generation returns the same blocked fence instead of opening a
 * second one or stranding the caller on a 409.
 */
export const ownerPurgeBeginDisposition = (args: {
  state: "open" | "blocked";
  mode?: "temporary" | "permanent";
  generation: string;
  beginRequestId?: string;
  lastReleasedGeneration?: string;
  rejoinedFromGeneration?: string;
  requestId: unknown;
  expectedGeneration: unknown;
  requestedMode: "temporary" | "permanent";
}): OwnerPurgeBeginDisposition => {
  const requestId = normalizeOwnerGeneration(args.requestId);
  const hasExpectedGeneration = args.expectedGeneration !== undefined;
  const expectedGeneration = normalizeOwnerGeneration(args.expectedGeneration);
  if (!requestId || (hasExpectedGeneration && !expectedGeneration)) {
    return { action: "reject" };
  }

  if (args.state === "open") {
    if (!hasExpectedGeneration) {
      return {
        action: "start",
        mode: args.requestedMode,
        rejoined: false,
      };
    }
    return expectedGeneration === args.lastReleasedGeneration
      ? { action: "start", mode: "temporary", rejoined: true }
      : { action: "reject" };
  }

  // Before Convex has received and durably recorded the first generation, an
  // initial begin response can be lost. The immutable lifecycle operation id
  // is the only authority available on that retry: exact replay returns the
  // same blocked fence, while another operation id cannot adopt it. A delete
  // upgrade is monotonic and therefore safe for the same operation.
  if (!expectedGeneration) {
    return requestId === args.beginRequestId
      ? {
          action: "resume",
          upgradeToPermanent: args.requestedMode === "permanent",
          rejoined: false,
        }
      : { action: "reject" };
  }
  if (expectedGeneration === args.generation) {
    return {
      action: "resume",
      upgradeToPermanent: args.requestedMode === "permanent",
      rejoined: false,
    };
  }
  if (expectedGeneration === args.rejoinedFromGeneration) {
    return {
      action: "resume",
      // The caller has not yet acknowledged the replacement generation, so a
      // replay may recover it but cannot upgrade the fence to permanent.
      upgradeToPermanent: false,
      rejoined: true,
    };
  }
  return { action: "reject" };
};

export const ownerPurgeReleaseDisposition = (args: {
  state: "open" | "blocked";
  mode?: "temporary" | "permanent";
  generation: string;
  lastReleasedGeneration?: string;
  requestedGeneration: unknown;
  activeLeaseCount: number;
}): "release" | "already-released" | "reject" => {
  const requestedGeneration = normalizeOwnerGeneration(
    args.requestedGeneration,
  );
  if (!requestedGeneration) return "reject";
  if (
    args.state === "open" &&
    args.lastReleasedGeneration === requestedGeneration
  ) {
    return "already-released";
  }
  return args.state === "blocked" &&
    args.mode === "temporary" &&
    requestedGeneration === args.generation &&
    args.activeLeaseCount === 0
    ? "release"
    : "reject";
};
