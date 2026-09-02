import { describe, expect, test } from "vitest";
import { resolveOwnershipMigrationInProgress } from "@/global/auth/hooks/use-ownership-migration-in-progress";

const connected = {
  hasConnectedAccount: true,
  sessionIsLoading: false,
  isCloudConversationReady: true,
} as const;

describe("resolveOwnershipMigrationInProgress", () => {
  test("anonymous users never wait — they have nothing to migrate", () => {
    for (const status of [undefined, "pending", "running", null] as const) {
      expect(
        resolveOwnershipMigrationInProgress({
          ...connected,
          hasConnectedAccount: false,
          status,
        }),
      ).toBe(false);
    }
  });

  test("holds while the new identity is still being confirmed", () => {
    expect(
      resolveOwnershipMigrationInProgress({
        ...connected,
        sessionIsLoading: true,
        isCloudConversationReady: false,
        status: undefined,
      }),
    ).toBe(true);
  });

  test("does not hold when the session settled without cloud readiness (auth failed / re-auth)", () => {
    expect(
      resolveOwnershipMigrationInProgress({
        ...connected,
        isCloudConversationReady: false,
        status: undefined,
      }),
    ).toBe(false);
  });

  test("holds while the status query is in flight and while the transfer runs", () => {
    for (const status of [undefined, "pending", "running"] as const) {
      expect(
        resolveOwnershipMigrationInProgress({ ...connected, status }),
      ).toBe(true);
    }
  });

  test("releases on a verdict: complete, none, or failed (root shows retry)", () => {
    for (const status of ["complete", null, "failed"] as const) {
      expect(
        resolveOwnershipMigrationInProgress({ ...connected, status }),
      ).toBe(false);
    }
  });
});
