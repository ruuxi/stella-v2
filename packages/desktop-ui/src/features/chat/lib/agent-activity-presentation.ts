import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";

export type AgentAttemptPresentation = {
  status?: TaskLifecycleStatus;
  attemptGeneration?: number;
  rootRunId?: string;
  startedAtMs?: number;
  observedAtMs?: number;
};

export type AuthoritativeAgentPresentation = {
  status: TaskLifecycleStatus;
  attemptGeneration?: number;
  rootRunId?: string;
  updatedAtMs: number;
  completedAtMs?: number;
};

const isTerminal = (status: TaskLifecycleStatus): boolean =>
  status !== "running";

/**
 * The durable row normally wins. A strictly newer observed attempt is the
 * narrow exception while the authoritative Activity refetch catches up.
 */
export const latestAttemptSupersedesAuthoritative = (
  authoritative: AuthoritativeAgentPresentation,
  latestAttempt?: AgentAttemptPresentation,
): boolean => {
  if (!latestAttempt) return false;
  const observedStatus = latestAttempt.status ?? "running";
  const authoritativeAttempt = authoritative.attemptGeneration;
  const observedAttempt = latestAttempt.attemptGeneration;

  if (authoritativeAttempt !== undefined && observedAttempt !== undefined) {
    if (observedAttempt > authoritativeAttempt) return true;
    if (observedAttempt < authoritativeAttempt) return false;
    if (authoritative.status === "running" && isTerminal(observedStatus)) {
      return true;
    }
    if (isTerminal(authoritative.status) && observedStatus === "running") {
      return false;
    }
    return false;
  }

  if (
    authoritative.rootRunId &&
    latestAttempt.rootRunId &&
    authoritative.rootRunId === latestAttempt.rootRunId &&
    authoritativeAttempt === observedAttempt
  ) {
    return authoritative.status === "running" && isTerminal(observedStatus);
  }

  const observedAt =
    latestAttempt.startedAtMs ?? latestAttempt.observedAtMs ?? 0;
  const authoritativeAt =
    authoritative.completedAtMs ?? authoritative.updatedAtMs;
  return observedAt > authoritativeAt;
};

export const deriveLatestAgentPresentationStatus = (
  authoritative: AuthoritativeAgentPresentation,
  latestAttempt?: AgentAttemptPresentation,
): TaskLifecycleStatus =>
  latestAttemptSupersedesAuthoritative(authoritative, latestAttempt)
    ? (latestAttempt?.status ?? "running")
    : authoritative.status;

/** A terminal owner completes only after its currently-owned work settles. */
export const deriveOwnedAgentPresentationStatus = (
  ownerStatus: TaskLifecycleStatus,
  ownedStatuses: readonly TaskLifecycleStatus[],
): TaskLifecycleStatus => {
  if (ownerStatus === "running") return "running";
  if (ownerStatus === "error" || ownerStatus === "canceled") {
    return ownerStatus;
  }
  if (ownedStatuses.includes("running")) return "running";
  if (ownedStatuses.includes("error")) return "error";
  return "completed";
};

const isRecordCurrentForCard = (
  record: ThreadActivityRecord,
  options: {
    attemptGeneration?: number;
    rootRunId?: string;
    startedAtMs?: number;
  },
): boolean => {
  if (
    options.attemptGeneration !== undefined &&
    record.attemptGeneration !== undefined
  ) {
    if (record.attemptGeneration !== options.attemptGeneration) return false;
    if (
      options.rootRunId &&
      record.rootRunId &&
      record.rootRunId !== options.rootRunId
    )
      return false;
    return true;
  }
  if (options.rootRunId && record.rootRunId === options.rootRunId) return true;
  const cardStartedAt = options.startedAtMs ?? 0;
  return record.startedAt >= cardStartedAt || record.updatedAt >= cardStartedAt;
};

/** Resolve one thread plus its transitive authoritative ownership tree. */
export const deriveThreadAndOwnedPresentationStatus = (
  records: readonly ThreadActivityRecord[],
  threadId: string,
  options: {
    attemptGeneration?: number;
    rootRunId?: string;
    startedAtMs?: number;
  } = {},
): TaskLifecycleStatus | undefined => {
  const recordById = new Map(
    records.map((record) => [record.threadId, record]),
  );
  const childrenByParent = new Map<string, ThreadActivityRecord[]>();
  for (const record of records) {
    if (!record.parentAgentId || record.parentAgentId === record.threadId) {
      continue;
    }
    const children = childrenByParent.get(record.parentAgentId);
    if (children) children.push(record);
    else childrenByParent.set(record.parentAgentId, [record]);
  }

  const derive = (
    id: string,
    ancestors: ReadonlySet<string>,
  ): TaskLifecycleStatus | undefined => {
    const record = recordById.get(id);
    if (!record || ancestors.has(id)) return undefined;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    const childStatuses = (childrenByParent.get(id) ?? [])
      .map((child) => derive(child.threadId, nextAncestors))
      .filter((status): status is TaskLifecycleStatus => status !== undefined);
    return deriveOwnedAgentPresentationStatus(record.status, childStatuses);
  };

  const owner = recordById.get(threadId);
  if (!owner || !isRecordCurrentForCard(owner, options)) return undefined;
  return derive(threadId, new Set());
};

/** Active-first precedence prevents a terminal glyph beside Working text. */
export const deriveAgentCardPresentationStatus = (input: {
  working: boolean;
  paused: boolean;
  failed: boolean;
}): TaskLifecycleStatus => {
  if (input.working) return "running";
  if (input.failed) return "error";
  if (input.paused) return "canceled";
  return "completed";
};

export const agentPresentationFallback = (
  status: TaskLifecycleStatus,
): "Working…" | "Paused" | "Failed" | "Completed" => {
  switch (status) {
    case "running":
      return "Working…";
    case "canceled":
      return "Paused";
    case "error":
      return "Failed";
    case "completed":
      return "Completed";
  }
};
