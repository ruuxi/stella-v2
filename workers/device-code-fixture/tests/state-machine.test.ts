import { describe, expect, test } from "bun:test";
import {
  applyPublicDecision,
  consumeGrant,
  readGrantStatus,
  type AuthorizationState,
} from "../src/state-machine.js";

const consumerA = "00000000-0000-4000-8000-000000000001";
const consumerB = "00000000-0000-4000-8000-000000000002";

const state = (
  overrides: Partial<AuthorizationState> = {},
): AuthorizationState => ({
  schemaVersion: 1,
  userCode: "BCDF2345",
  deviceCodeDigest: "a".repeat(64),
  status: "pending",
  createdAt: 1_000,
  expiresAt: 301_000,
  ...overrides,
});

describe("device authorization state machine", () => {
  test("requires human approval and consumes an approval once", () => {
    const pending = readGrantStatus(state(), "a".repeat(64), 2_000);
    expect(pending.response.status).toBe("authorization_pending");

    const approved = applyPublicDecision(state(), "approve", 2_000).state;
    expect(
      readGrantStatus(approved, "a".repeat(64), 2_001).response.status,
    ).toBe("approved");
    const first = consumeGrant(
      approved,
      "a".repeat(64),
      2_002,
      consumerA,
    );
    expect(first.response.outcome).toBe("approved");
    expect(first.state?.cleanupAt).toBe(601_000);
    const exactReplay = consumeGrant(
      first.state,
      "a".repeat(64),
      2_003,
      consumerA,
    );
    expect(exactReplay.response.outcome).toBe("approved");
    const differentConsumer = consumeGrant(
      first.state,
      "a".repeat(64),
      2_004,
      consumerB,
    );
    expect(differentConsumer.response.outcome).toBe("already_consumed");
    expect(
      consumeGrant(first.state, "a".repeat(64), 301_001, consumerA).response
        .outcome,
    ).toBe("approved");
  });

  test("denial, expiry, and an incorrect private code fail closed", () => {
    const denied = applyPublicDecision(state(), "deny", 2_000).state;
    expect(
      consumeGrant(denied, "a".repeat(64), 2_001, consumerA).response
        .outcome,
    ).toBe("access_denied");
    expect(
      consumeGrant(state(), "b".repeat(64), 2_001, consumerA).response
        .outcome,
    ).toBe("invalid_grant");
    expect(
      consumeGrant(state(), "a".repeat(64), 301_000, consumerA).response
        .outcome,
    ).toBe("expired_token");
  });
});
