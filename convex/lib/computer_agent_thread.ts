export const COMPUTER_AGENT_WORKSPACE = "computer";

/**
 * Cloud-agent watchdogs normally terminalize a sandbox turn within 15 minutes.
 * Keep the existing one-hour grace so a failed terminal callback cannot lock
 * the account forever, while still leaving ample time for watchdog retries.
 */
export const CLOUD_SANDBOX_LEASE_MS = 60 * 60_000;
export const COMPUTER_AGENT_SANDBOX_LEASE_MARKER = 0;

export const countsTowardCloudSandboxConcurrency = (workspace: string) =>
  workspace !== COMPUTER_AGENT_WORKSPACE;

export const cloudAgentSandboxLeaseExpiresAt = (
  workspace: string,
  now: number,
): number =>
  countsTowardCloudSandboxConcurrency(workspace)
    ? now + CLOUD_SANDBOX_LEASE_MS
    : COMPUTER_AGENT_SANDBOX_LEASE_MARKER;

/**
 * Rolling-deploy policy for the indexed admission query. Fresh rows carry an
 * explicit lease. Pre-field rows retain the previous updatedAt-based one-hour
 * grace; computer rows never consume cloud sandbox capacity in either form.
 */
export const cloudSandboxThreadIsActive = (args: {
  workspace: string;
  status: string;
  sandboxLeaseExpiresAt?: number;
  updatedAt: number;
  now: number;
}): boolean => {
  if (
    args.status !== "running" ||
    !countsTowardCloudSandboxConcurrency(args.workspace)
  ) {
    return false;
  }
  return args.sandboxLeaseExpiresAt === undefined
    ? args.updatedAt > args.now - CLOUD_SANDBOX_LEASE_MS
    : args.sandboxLeaseExpiresAt > args.now;
};

export const shouldApplyComputerAgentTerminal = (args: {
  currentAttemptGeneration: number | undefined;
  requestedAttemptGeneration: number;
  currentStatus: string;
}): boolean =>
  (args.currentAttemptGeneration ?? 0) === args.requestedAttemptGeneration &&
  args.currentStatus === "running";
