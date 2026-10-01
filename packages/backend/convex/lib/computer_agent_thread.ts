import type { ExecutionPlacement } from "../schema/execution_placement";

/**
 * Cloud-agent watchdogs normally terminalize a sandbox turn within 15 minutes.
 * Keep the existing one-hour grace so a failed terminal callback cannot lock
 * the account forever, while still leaving ample time for watchdog retries.
 */
const CLOUD_SANDBOX_LEASE_MS = 60 * 60_000;
const COMPUTER_AGENT_SANDBOX_LEASE_MARKER = 0;

const countsTowardCloudSandboxConcurrency = (
  placement: ExecutionPlacement,
) => placement === "cloud";

export const cloudAgentSandboxLeaseExpiresAt = (
  placement: ExecutionPlacement,
  now: number,
): number =>
  countsTowardCloudSandboxConcurrency(placement)
    ? now + CLOUD_SANDBOX_LEASE_MS
    : COMPUTER_AGENT_SANDBOX_LEASE_MARKER;
