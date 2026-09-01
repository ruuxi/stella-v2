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

  test("keeps the child shell unmounted while migration is loading or pending", () => {
    const guardedStartup = sourceBetween(
      "if (ownershipMigrationGate.isFailed)",
      "return <CloudStartupPending />;",
    );
    expect(guardedStartup).toContain("onRetry={retryOwnershipMigration}");
    expect(guardedStartup).toContain("ownershipMigrationGate.isLoading");
    expect(guardedStartup).toContain("ownershipMigrationGate.isPending");
    expect(ROOT_SOURCE.indexOf("return <CloudStartupPending />;")).toBeLessThan(
      ROOT_SOURCE.indexOf("<RootChrome conversationId={conversationId} />"),
    );
  });
});
