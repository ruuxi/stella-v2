import { describe, expect, test } from "bun:test";
import {
  resolveCloudConversationSession,

} from "../src/global/auth/lib/cloud-conversation-session";

describe("resolveCloudConversationSession", () => {
  test("keeps conversation routing loading before anonymous auth exists", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: true });
  });

  test("marks cloud conversations ready for any Better Auth session accepted by Convex", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: true, isLoading: false });
  });

  test("does not fall back locally while Convex token exchange is pending", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: true });
  });

  test("surfaces a terminal auth bootstrap failure instead of loading forever", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: false });
  });

  test("blocks cloud data until Convex proves it serves the current subject", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: true });

    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: true });
  });

  test("never activates a confirmed stale identity when bootstrap failed", () => {
    expect(
      resolveCloudConversationSession({
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
    ).toEqual({ isCloudConversationReady: false, isLoading: false });
  });
});
