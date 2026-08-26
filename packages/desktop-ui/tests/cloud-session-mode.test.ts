import { describe, expect, test } from "bun:test";
import {
  resolveCloudSessionMode,
  resolveOwnershipMigrationGate,
} from "../src/global/auth/lib/cloud-session-mode";

describe("resolveCloudSessionMode", () => {
  test("keeps conversation routing loading before anonymous auth exists", () => {
    expect(
      resolveCloudSessionMode({
        hasSession: false,
        sessionIsLoading: false,
        convexIsAuthenticated: false,
        convexIsLoading: false,
        hasExpectedSubject: false,
        identityConfirmed: false,
        identityIsLoading: false,
        authBootstrapReady: false,
        authBootstrapFailed: false,
      }),
    ).toEqual({ cloudMode: false, isLoading: true });
  });

  test("uses cloud mode for any Better Auth session accepted by Convex", () => {
    expect(
      resolveCloudSessionMode({
        // This intentionally does not distinguish anonymous from connected:
        // both are durable owner identities for conversation routing.
        hasSession: true,
        sessionIsLoading: false,
        convexIsAuthenticated: true,
        convexIsLoading: false,
        hasExpectedSubject: true,
        identityConfirmed: true,
        identityIsLoading: false,
        authBootstrapReady: true,
        authBootstrapFailed: false,
      }),
    ).toEqual({ cloudMode: true, isLoading: false });
  });

  test("does not fall back locally while Convex token exchange is pending", () => {
    expect(
      resolveCloudSessionMode({
        hasSession: true,
        sessionIsLoading: false,
        convexIsAuthenticated: false,
        convexIsLoading: true,
        hasExpectedSubject: true,
        identityConfirmed: false,
        identityIsLoading: false,
        authBootstrapReady: false,
        authBootstrapFailed: false,
      }),
    ).toEqual({ cloudMode: false, isLoading: true });
  });

  test("surfaces a terminal auth bootstrap failure instead of loading forever", () => {
    expect(
      resolveCloudSessionMode({
        hasSession: false,
        sessionIsLoading: false,
        convexIsAuthenticated: false,
        convexIsLoading: false,
        hasExpectedSubject: false,
        identityConfirmed: false,
        identityIsLoading: false,
        authBootstrapReady: false,
        authBootstrapFailed: true,
      }),
    ).toEqual({ cloudMode: false, isLoading: false });
  });

  test("blocks cloud data until Convex proves it serves the current subject", () => {
    expect(
      resolveCloudSessionMode({
        hasSession: true,
        sessionIsLoading: false,
        convexIsAuthenticated: true,
        convexIsLoading: false,
        hasExpectedSubject: true,
        identityConfirmed: false,
        identityIsLoading: true,
        authBootstrapReady: true,
        authBootstrapFailed: false,
      }),
    ).toEqual({ cloudMode: false, isLoading: true });

    expect(
      resolveCloudSessionMode({
        hasSession: true,
        sessionIsLoading: false,
        convexIsAuthenticated: true,
        convexIsLoading: false,
        hasExpectedSubject: true,
        identityConfirmed: false,
        identityIsLoading: false,
        authBootstrapReady: true,
        authBootstrapFailed: false,
      }),
    ).toEqual({ cloudMode: false, isLoading: true });
  });

  test("never activates a confirmed stale identity when bootstrap failed", () => {
    expect(
      resolveCloudSessionMode({
        hasSession: true,
        sessionIsLoading: false,
        convexIsAuthenticated: true,
        convexIsLoading: false,
        hasExpectedSubject: true,
        identityConfirmed: true,
        identityIsLoading: false,
        authBootstrapReady: false,
        authBootstrapFailed: true,
      }),
    ).toEqual({ cloudMode: false, isLoading: false });
  });
});

describe("resolveOwnershipMigrationGate", () => {
  test("blocks selection until migration status has loaded", () => {
    expect(resolveOwnershipMigrationGate(undefined, true)).toEqual({
      isLoading: true,
      isPending: false,
      isFailed: false,
      canSelectConversation: false,
    });
  });

  test("blocks pending and failed handoffs, then allows a settled owner", () => {
    expect(
      resolveOwnershipMigrationGate("running", true).canSelectConversation,
    ).toBe(false);
    expect(
      resolveOwnershipMigrationGate("failed", true).canSelectConversation,
    ).toBe(false);
    expect(
      resolveOwnershipMigrationGate("complete", true).canSelectConversation,
    ).toBe(true);
    expect(
      resolveOwnershipMigrationGate(null, true).canSelectConversation,
    ).toBe(true);
  });
});
