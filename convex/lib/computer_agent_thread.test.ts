import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CLOUD_SANDBOX_LEASE_MS,
  cloudAgentSandboxLeaseExpiresAt,
  cloudSandboxThreadIsActive,
  COMPUTER_AGENT_SANDBOX_LEASE_MARKER,
  countsTowardCloudSandboxConcurrency,
  shouldApplyComputerAgentTerminal,
} from "./computer_agent_thread";

describe("computer agent cloud-thread policy", () => {
  test("computer activity rows do not consume cloud sandbox concurrency", () => {
    assert.equal(countsTowardCloudSandboxConcurrency("computer"), false);
    assert.equal(countsTowardCloudSandboxConcurrency("cloud"), true);
    assert.equal(countsTowardCloudSandboxConcurrency("project:stella"), true);
  });

  test("mixed-rollout computer rows cannot shadow cloud sandbox admission", () => {
    const now = 10 * CLOUD_SANDBOX_LEASE_MS;
    const freshCloudLease = cloudAgentSandboxLeaseExpiresAt(
      "project:stella",
      now,
    );
    assert.equal(
      cloudAgentSandboxLeaseExpiresAt("computer", now),
      COMPUTER_AGENT_SANDBOX_LEASE_MARKER,
    );
    assert.equal(
      cloudSandboxThreadIsActive({
        workspace: "computer",
        status: "running",
        sandboxLeaseExpiresAt: COMPUTER_AGENT_SANDBOX_LEASE_MARKER,
        updatedAt: now,
        now,
      }),
      false,
    );
    assert.equal(
      cloudSandboxThreadIsActive({
        workspace: "computer",
        status: "running",
        updatedAt: now,
        now,
      }),
      false,
    );
    assert.equal(
      cloudSandboxThreadIsActive({
        workspace: "project:legacy",
        status: "running",
        updatedAt: now - CLOUD_SANDBOX_LEASE_MS + 1,
        now,
      }),
      true,
    );
    assert.equal(
      cloudSandboxThreadIsActive({
        workspace: "project:stale",
        status: "running",
        updatedAt: now - CLOUD_SANDBOX_LEASE_MS,
        now,
      }),
      false,
    );
    assert.equal(
      cloudSandboxThreadIsActive({
        workspace: "project:stella",
        status: "running",
        sandboxLeaseExpiresAt: freshCloudLease,
        updatedAt: now,
        now,
      }),
      true,
    );
  });

  test("only the running current attempt may terminalize a mirrored row", () => {
    assert.equal(
      shouldApplyComputerAgentTerminal({
        currentAttemptGeneration: 4,
        requestedAttemptGeneration: 4,
        currentStatus: "running",
      }),
      true,
    );
    assert.equal(
      shouldApplyComputerAgentTerminal({
        currentAttemptGeneration: 5,
        requestedAttemptGeneration: 4,
        currentStatus: "running",
      }),
      false,
    );
    assert.equal(
      shouldApplyComputerAgentTerminal({
        currentAttemptGeneration: 4,
        requestedAttemptGeneration: 4,
        currentStatus: "completed",
      }),
      false,
    );
  });
});
