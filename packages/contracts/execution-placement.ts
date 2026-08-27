/**
 * Provider-neutral execution placement protocol.
 *
 * `workspace` describes the subject of the work. It is deliberately not an
 * executor selector: placement is derived from trusted ingress plus current
 * device eligibility and is then durably committed by the backend.
 */

export const EXECUTION_PLACEMENT_PROTOCOL_VERSION = 1 as const;
export const EXECUTION_PLACEMENT_POLICY_VERSION = 1 as const;

export type ExecutionIngress =
  | "desktop"
  | "mobile"
  | "browser"
  | "cloud"
  | "schedule";

export type ExecutionRequestKind = "chat" | "agent";
export type ExecutionPlacement = "computer" | "cloud";
export type ExecutionSubject = "portable" | "computer" | "cloud";

export type ExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps";

export type ExecutionDispatchState =
  | "queued"
  | "offering"
  | "computer_claimed"
  | "computer_accepted"
  | "computer_running"
  | "cloud_committed"
  | "cloud_running"
  | "cancel_pending"
  | "reconciliation_required"
  | "completed"
  | "failed"
  | "canceled";

export type ExecutionTerminalState = "completed" | "failed" | "canceled";

export type ExecutionPlacementDecision =
  | {
      kind: "commit";
      placement: ExecutionPlacement;
      reason: string;
    }
  | {
      kind: "offer-computer";
      onNoEligibleComputer: "cloud" | "blocked";
      reason: string;
    }
  | {
      kind: "blocked";
      reason: string;
    };

export type ExecutionRoutingInput = {
  ingress: ExecutionIngress;
  requestKind: ExecutionRequestKind;
  subject: ExecutionSubject;
};

/**
 * Classifies legacy spawn `workspace` values as work subjects. Any explicit
 * non-computer workspace is hosted state and therefore cloud-only. Omitted
 * workspace remains portable and may follow ingress availability.
 */
export const executionSubjectForWorkspace = (
  workspace: string | null | undefined,
): ExecutionSubject => {
  const normalized = workspace?.trim().toLowerCase();
  if (!normalized) return "portable";
  if (normalized === "computer") return "computer";
  return "cloud";
};

/**
 * Derives the work subject from trusted ingress plus a server-authorized
 * workspace. Browser/cloud/schedule callers cannot select a local subject;
 * desktop and mobile retain the semantic workspace subject, which the policy
 * resolves independently from the executor.
 */
export const deriveExecutionSubject = (args: {
  ingress: ExecutionIngress;
  workspace?: string | null;
}): ExecutionSubject => {
  if (
    args.ingress === "browser" ||
    args.ingress === "cloud" ||
    args.ingress === "schedule"
  ) {
    return "cloud";
  }
  return executionSubjectForWorkspace(args.workspace);
};

/**
 * Pure policy only. Reachability never enters this function: an
 * `offer-computer` decision is resolved later by a fenced durable claim.
 */
export const decideExecutionPlacement = (
  input: ExecutionRoutingInput,
): ExecutionPlacementDecision => {
  if (input.subject === "cloud") {
    return {
      kind: "commit",
      placement: "cloud",
      reason: "hosted-subject",
    };
  }

  if (input.ingress === "desktop") {
    return {
      kind: "commit",
      placement: "computer",
      reason: "desktop-ingress",
    };
  }

  if (input.ingress === "mobile") {
    return {
      kind: "offer-computer",
      onNoEligibleComputer: "cloud",
      reason:
        input.subject === "computer"
          ? "paired-computer-preferred-for-computer-work"
          : "paired-computer-preferred",
    };
  }

  if (input.subject === "computer") {
    return {
      kind: "blocked",
      reason: "computer-unavailable-for-ingress",
    };
  }

  return {
    kind: "commit",
    placement: "cloud",
    reason: `${input.ingress}-ingress`,
  };
};

export const isExecutionTerminalState = (
  state: ExecutionDispatchState,
): state is ExecutionTerminalState =>
  state === "completed" || state === "failed" || state === "canceled";

/** Placement may only change while local execution is provably unaccepted. */
export const mayFallbackToCloud = (state: ExecutionDispatchState): boolean =>
  state === "queued" ||
  state === "offering" ||
  state === "computer_claimed";

export type ExecutionDeviceProofOperation =
  | "presence-register"
  | "presence-heartbeat"
  | "presence-drain"
  | "presence-clear"
  | "claim"
  | "claim-release"
  | "claim-ack"
  | "running"
  | "renew"
  | "complete";

export type ExecutionDeviceProofInput = {
  operation: ExecutionDeviceProofOperation;
  ownerGeneration: string;
  deviceId: string;
  presenceSessionId: string;
  sequence: number;
  bodyHash: string;
};

/**
 * Canonical signed envelope. A tuple avoids object-key ordering differences
 * across Node, React Native, and Convex runtimes.
 */
export const executionDeviceProofMessage = (
  input: ExecutionDeviceProofInput,
): string =>
  JSON.stringify([
    "stella-execution-placement",
    EXECUTION_PLACEMENT_PROTOCOL_VERSION,
    input.operation,
    input.ownerGeneration,
    input.deviceId,
    input.presenceSessionId,
    input.sequence,
    input.bodyHash,
  ]);

export type ExecutionDispatchSummary = {
  dispatchId: string;
  idempotencyKey: string;
  kind: ExecutionRequestKind;
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  workspace?: string;
  conversationId: string;
  threadId?: string;
  state: ExecutionDispatchState;
  placement?: ExecutionPlacement;
  executorDeviceId?: string;
  revision: number;
  fallbackReason?: string;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: string;
  terminalAt?: number;
  createdAt: number;
  updatedAt: number;
};
