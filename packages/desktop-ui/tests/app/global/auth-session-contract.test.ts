import { describe, expect, it } from "vitest";
import {
  canBootstrapAnonymous,
  resolveAuthSessionObservation,
  resolveMissingCredentialSnapshot,
  type AuthSessionError,
} from "@stella/contracts/auth-session";

const connectedSession = {
  user: { id: "connected-user", isAnonymous: false },
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
    "never turns a non-verdict $kind failure into anonymous or rejected state",
    (error) => {
      const snapshot = resolveAuthSessionObservation({
        observation: { kind: "unknown", error },
        identityIntent: "connected",
        staleSession: connectedSession,
      });

      expect(snapshot.status).toBe("unknown");
      expect(canBootstrapAnonymous(snapshot)).toBe(false);
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
    expect(canBootstrapAnonymous(snapshot)).toBe(false);
  });

  it("allows first-install and dead-anonymous bootstrap only", () => {
    expect(
      canBootstrapAnonymous(
        resolveMissingCredentialSnapshot({
          identityIntent: null,
          staleSession: null,
        }),
      ),
    ).toBe(true);
    expect(
      canBootstrapAnonymous(
        resolveAuthSessionObservation({
          observation: { kind: "rejected" },
          identityIntent: "anonymous",
          staleSession: null,
        }),
      ),
    ).toBe(true);
    expect(
      canBootstrapAnonymous(
        resolveMissingCredentialSnapshot({
          identityIntent: "connected",
          staleSession: connectedSession,
        }),
      ),
    ).toBe(false);
  });
});
