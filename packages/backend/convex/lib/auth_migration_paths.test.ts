import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canceledPendingUploadCleanupDelays,
  driveFileOwnershipPatch,
  importedAgentHomeDocumentName,
  importedAgentHomePrefix,
  importedDrivePath,
  importedInteriorPrefix,
  importedOwnerScopedKey,
  importedProjectSlug,
  importedSkillSlug,
  isOwnershipMigrationBlockedMessage,
  linkedSourcePurgeOperationId,
  mergeBillingUsageWindows,
  ownerMigrationSourceFenceActive,
  ownershipMigrationSourceDigest,
  ownershipMigrationTransientStateDisposition,
  scheduleOwnershipClaimAllowed,
  shouldAdvanceOwnerNamespaceStage,
} from "./auth_migration_paths";

describe("anonymous owner collision paths", () => {
  test("uses a stable bounded project slug without replacing the destination", () => {
    assert.equal(
      importedProjectSlug("notes", "Project_ABCDEF12"),
      "notes-imported-projectabcde",
    );
    assert.notEqual(
      importedProjectSlug("notes", "Project_ABCDEF12", 1),
      importedProjectSlug("notes", "Project_ABCDEF12", 0),
    );
    assert.ok(
      importedProjectSlug("x".repeat(64), "abcdef12-3456").length <= 64,
    );
  });

  test("keeps colliding drive files under a stable imported path", () => {
    const path = importedDrivePath(
      "reports/q3.xlsx",
      "cloud_drive_files_12345678",
    );
    assert.equal(path, "Imported from anonymous/reports/q3.xlsx-12345678");
    assert.ok(importedDrivePath("x".repeat(400), "row-12345678").length <= 400);
    assert.notEqual(
      importedDrivePath("reports/q3.xlsx", "row-12345678", 1),
      importedDrivePath("reports/q3.xlsx", "row-12345678", 0),
    );
  });

  test("re-owns Drive metadata without inventing a new R2 object key", () => {
    const patch = driveFileOwnershipPatch("issuer|connected");
    assert.deepEqual(patch, { ownerId: "issuer|connected" });
    assert.equal("r2Key" in patch, false);
  });

  test("gives imported agent-home and interior bytes stable owner-scoped namespaces", () => {
    assert.equal(
      importedAgentHomeDocumentName(
        "MEMORY.md",
        "cloud_agent_home_docs_12345678",
      ),
      "imports/anonymous-homedocs12345678/MEMORY.md",
    );
    assert.equal(
      importedAgentHomePrefix("anonymoushash", "connectedhash"),
      "agent-home/connectedhash/__stella_imported__/anonymoushash/",
    );
    assert.equal(
      importedInteriorPrefix("anonymoushash", "connectedhash"),
      "interiors/connectedhash/__stella_imported__/anonymoushash/",
    );
  });

  test("uses valid collision-safe identities for migrated skills", () => {
    assert.equal(
      importedSkillSlug("calendar", "skill-source-ABC123"),
      "calendar-imported-sourceabc123",
    );
    assert.match(
      importedSkillSlug("Bad / Skill", "source", 1),
      /^[a-z0-9][a-z0-9-]{0,62}$/,
    );
  });

  test("does not advance the owner namespace stage while a later page remains", () => {
    assert.equal(shouldAdvanceOwnerNamespaceStage(1), false);
    assert.equal(shouldAdvanceOwnerNamespaceStage(500), false);
    assert.equal(shouldAdvanceOwnerNamespaceStage(0), true);
  });

  test("never reopens a source owner across migration status transitions", () => {
    for (const status of ["pending", "running", "failed", "complete"]) {
      assert.equal(
        ownerMigrationSourceFenceActive("issuer|anonymous", [
          { fromOwnerId: "issuer|anonymous", status },
        ]),
        true,
      );
    }
    assert.equal(
      ownerMigrationSourceFenceActive("issuer|connected", [
        { fromOwnerId: "issuer|anonymous", status: "complete" },
      ]),
      false,
    );
  });

  test("derives a stable opaque source tombstone digest", async () => {
    const first = await ownershipMigrationSourceDigest("issuer|anonymous");
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(
      first,
      await ownershipMigrationSourceDigest("issuer|anonymous"),
    );
    assert.notEqual(
      first,
      await ownershipMigrationSourceDigest("issuer|connected"),
    );
    assert.equal(first.includes("anonymous"), false);
  });

  test("derives a stable opaque linked-source purge operation", async () => {
    const first = await linkedSourcePurgeOperationId(
      "parent-operation",
      "issuer|anonymous",
    );
    assert.match(first, /^linked-source-purge:[a-f0-9]{64}$/);
    assert.equal(
      first,
      await linkedSourcePurgeOperationId(
        "parent-operation",
        "issuer|anonymous",
      ),
    );
    assert.notEqual(
      first,
      await linkedSourcePurgeOperationId(
        "different-parent",
        "issuer|anonymous",
      ),
    );
    assert.equal(first.includes("anonymous"), false);
  });

  test("preflight and core discard source-fenced transient handshakes", () => {
    assert.equal(
      ownershipMigrationTransientStateDisposition("cloud_drive_upload"),
      "discard",
    );
    assert.equal(
      ownershipMigrationTransientStateDisposition("cloud_engine_connect"),
      "discard",
    );
    assert.equal(
      ownershipMigrationTransientStateDisposition("cloud_github_install_state"),
      "discard",
    );
  });

  test("cleans a canceled upload immediately and again after its URL expires", () => {
    assert.deepEqual(
      canceledPendingUploadCleanupDelays(1_000, 5_000),
      [0, 64_000],
    );
    assert.deepEqual(
      canceledPendingUploadCleanupDelays(5_000, 1_000),
      [0, 60_000],
    );
  });

  test("merges billing windows without resetting anonymous quota", () => {
    const merged = mergeBillingUsageWindows(
      {
        rollingUsageMicroCents: 200,
        rollingWindowStartedAt: 20,
        weeklyUsageMicroCents: 300,
        weeklyWindowStartedAt: 10,
        monthlyUsageMicroCents: 400,
        monthlyWindowStartedAt: 5,
        totalUsageMicroCents: 900,
        totalRequestCount: 9,
        createdAt: 1,
        updatedAt: 30,
      },
      {
        rollingUsageMicroCents: 20,
        rollingWindowStartedAt: 25,
        weeklyUsageMicroCents: 30,
        weeklyWindowStartedAt: 10,
        monthlyUsageMicroCents: 40,
        monthlyWindowStartedAt: 15,
        totalUsageMicroCents: 90,
        totalRequestCount: 3,
        createdAt: 2,
        updatedAt: 35,
      },
    );

    assert.deepEqual(merged, {
      activeReservedMicroCents: 0,
      rollingUsageMicroCents: 220,
      rollingWindowStartedAt: 25,
      weeklyUsageMicroCents: 330,
      weeklyWindowStartedAt: 10,
      monthlyUsageMicroCents: 440,
      monthlyWindowStartedAt: 15,
      totalUsageMicroCents: 990,
      totalRequestCount: 12,
      createdAt: 1,
      updatedAt: 35,
    });
  });

  test("refuses to merge an active provider-spend reservation", () => {
    const row = {
      activeReservedMicroCents: 0,
      rollingUsageMicroCents: 1,
      rollingWindowStartedAt: 1,
      weeklyUsageMicroCents: 1,
      weeklyWindowStartedAt: 1,
      monthlyUsageMicroCents: 1,
      monthlyWindowStartedAt: 1,
      totalUsageMicroCents: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    assert.throws(
      () =>
        mergeBillingUsageWindows({ ...row, activeReservedMicroCents: 1 }, row),
      /provider spend is reserved/u,
    );
    assert.throws(
      () =>
        mergeBillingUsageWindows(row, { ...row, activeReservedMicroCents: 1 }),
      /provider spend is reserved/u,
    );
  });

  test("caps corrupted usage sums at the safe integer boundary", () => {
    const row = {
      rollingUsageMicroCents: Number.MAX_SAFE_INTEGER,
      rollingWindowStartedAt: 1,
      weeklyUsageMicroCents: Number.MAX_SAFE_INTEGER,
      weeklyWindowStartedAt: 1,
      monthlyUsageMicroCents: Number.MAX_SAFE_INTEGER,
      monthlyWindowStartedAt: 1,
      totalUsageMicroCents: Number.MAX_SAFE_INTEGER,
      createdAt: 1,
      updatedAt: 1,
    };
    const merged = mergeBillingUsageWindows(row, row);
    assert.equal(merged.rollingUsageMicroCents, Number.MAX_SAFE_INTEGER);
    assert.equal(merged.totalUsageMicroCents, Number.MAX_SAFE_INTEGER);
  });

  test("keeps colliding owner-scoped values under a deterministic bounded key", () => {
    assert.equal(
      importedOwnerScopedKey("theme", "preferences-row-abc123"),
      "theme.imported-srowabc123",
    );
    assert.notEqual(
      importedOwnerScopedKey("theme", "preferences-row-abc123", 1),
      importedOwnerScopedKey("theme", "preferences-row-abc123"),
    );
    assert.ok(
      importedOwnerScopedKey("x".repeat(300), "row-abc123").length <= 240,
    );
    assert.ok(
      importedOwnerScopedKey("x".repeat(300), "row-abc123", 0, 128).length <=
        128,
    );
  });

  test("distinguishes hard ownership blockers from retryable failures", () => {
    assert.equal(
      isOwnershipMigrationBlockedMessage(
        "ownership_migration_blocked: pending upload",
      ),
      true,
    );
    assert.equal(isOwnershipMigrationBlockedMessage("network timeout"), false);
  });

  test("rejects stale schedule claims across an owner transfer", () => {
    assert.equal(scheduleOwnershipClaimAllowed("anon", "account", []), false);
    assert.equal(
      scheduleOwnershipClaimAllowed("anon", "anon", ["running"]),
      false,
    );
    assert.equal(
      scheduleOwnershipClaimAllowed("account", "account", ["complete"]),
      true,
    );
  });
});
