import { describe, expect, it } from "vitest";
import {
  resolveAuthSessionObservation,
  resolveMissingCredentialSnapshot,
  type AuthSessionError,
} from "@stella/contracts/auth-session";

const connectedSession = {
  user: { id: "connected-user" },
};

const unknownErrors: AuthSessionError[] = [
  { kind: "network", message: "offline" },
  { kind: "http", message: "upstream failed", status: 500 },
  { kind: "http", message: "route missing", status: 404 },
  { kind: "malformed", message: "invalid json" },
  { kind: "ipc", message: "main unavailable" },
];

describe("auth session snapshot contract", () => {
  it.each(unknownErrors)(
    "never turns a non-verdict $kind failure into signed-out or rejected state",
    (error) => {
      const snapshot = resolveAuthSessionObservation({
        observation: { kind: "unknown", error },
        identityIntent: "connected",
        staleSession: connectedSession,
      });

      expect(snapshot.status).toBe("unknown");
      expect(snapshot).toMatchObject({ staleSession: connectedSession });
    },
  );

  it("requires reauthentication when a connected credential is affirmatively rejected", () => {
    const snapshot = resolveAuthSessionObservation({
      observation: { kind: "rejected" },
      identityIntent: "connected",
      staleSession: connectedSession,
    });

    expect(snapshot.status).toBe("reauth_required");
  });

  it("is signed out on first install and for a legacy anonymous session", () => {
    expect(
      resolveMissingCredentialSnapshot({
        identityIntent: null,
        staleSession: null,
      }),
    ).toMatchObject({ status: "signed_out", reason: "first_install" });
    expect(
      resolveAuthSessionObservation({
        observation: {
          kind: "authenticated",
          session: { user: { id: "legacy-user", isAnonymous: true } },
        },
        identityIntent: null,
        staleSession: null,
      }),
    ).toMatchObject({ status: "signed_out" });
    expect(
      resolveMissingCredentialSnapshot({
        identityIntent: "connected",
        staleSession: connectedSession,
      }).status,
    ).toBe("reauth_required");
  });
});
