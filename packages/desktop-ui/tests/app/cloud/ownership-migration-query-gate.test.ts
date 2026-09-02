import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveOwnershipMigrationGate } from "../../../src/global/auth/lib/cloud-conversation-session";

const ROOT_SOURCE = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../src/routes/__root.tsx",
  ),
  "utf8",
);

const sourceBetween = (start: string, end: string) => {
  const startIndex = ROOT_SOURCE.indexOf(start);
  const endIndex = ROOT_SOURCE.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return ROOT_SOURCE.slice(startIndex, endIndex);
};

describe("RootLayout ownership migration query gate", () => {
  test("blocks fenced queries for loading, pending, running, and failed migrations", () => {
    for (const status of [undefined, "pending", "running", "failed"] as const) {
      expect(
        resolveOwnershipMigrationGate(status, true).canSelectConversation,
      ).toBe(false);
    }
  });

  test("enables fenced queries only for complete or absent migrations", () => {
    for (const status of ["complete", null] as const) {
      expect(
        resolveOwnershipMigrationGate(status, true).canSelectConversation,
      ).toBe(true);
    }
  });

  test("queries migration authority before every ownership-fenced Root query", () => {
    const migrationQueryIndex = ROOT_SOURCE.indexOf(
      "cloudApi.getMyOwnershipMigrationStatus",
    );
    expect(migrationQueryIndex).toBeGreaterThanOrEqual(0);

    for (const queryName of [
      "cloudApi.listMyConversations",
      "cloudApi.getMyCloudConversationIdentity",
      "cloudApi.getMyConversation",
    ]) {
      expect(ROOT_SOURCE.indexOf(queryName)).toBeGreaterThan(
        migrationQueryIndex,
      );
    }

    expect(
      sourceBetween(
        "const cloudConversations = useQuery(",
        "const conversationIdentity = useQuery(",
      ),
    ).toContain('canQueryOwnershipFencedCloudData ? {} : "skip"');
    expect(
      sourceBetween(
        "const conversationIdentity = useQuery(",
        "const ownerGeneration =",
      ),
    ).toContain('canQueryOwnershipFencedCloudData ? {} : "skip"');
    expect(
      sourceBetween(
        "const exactCloudConversation = useQuery(",
        "const cachedConversationIsListed =",
      ),
    ).toContain("canQueryOwnershipFencedCloudData &&");
    expect(
      sourceBetween(
        "const exactCachedCloudConversation = useQuery(",
        "const routeOwnershipIsLoading =",
      ),
    ).toContain("canQueryOwnershipFencedCloudData &&");
  });

  test("never swaps the mounted shell for a placeholder while migration is loading or pending", () => {
    // The shell is already mounted (with a null conversation and fenced
    // queries skipped) before cloud auth is ready. Replacing it with a
    // placeholder for the status round-trip, or for a pending transfer,
    // produced a visible remount of the home surface. The sign-in dialog owns
    // the post-sign-in wait instead; only a *failed* migration takes over the
    // screen, because it needs the retry action.
    expect(ROOT_SOURCE).not.toContain("CloudStartupPending");
    const failedGuard = sourceBetween(
      "if (ownershipMigrationGate.isFailed)",
      "<RootChrome conversationId={conversationId} />",
    );
    expect(failedGuard).toContain("onRetry={retryOwnershipMigration}");
    expect(failedGuard).not.toMatch(
      /if \([^)]*ownershipMigrationGate\.(isLoading|isPending)[^)]*\) \{\s*return/,
    );
  });

  test("dismisses the launch splash only once the shell is live or a startup failure is shown", () => {
    const liveness = sourceBetween(
      "const shellIsLive =",
      "useEffect(() => {\n    if (shouldDismissLaunchSplash) dismissLaunchSplash();",
    );
    expect(liveness).toContain("conversationId !== null");
    expect(liveness).toContain("!isOnChatRoute && isCloudConversationReady");
    expect(liveness).toContain("authBootstrapError");
    expect(liveness).toContain("ownershipMigrationGate.isFailed");
    expect(liveness).toContain("showsCloudCreateFailure");
    expect(liveness).toContain('authBootstrapStatus === "reauth_required"');
  });
});
