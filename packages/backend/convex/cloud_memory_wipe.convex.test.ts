/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  vi.stubEnv("CLOUD_BUILDER_URL", "https://builder.test");
  vi.stubEnv("BUILDER_SERVICE_SECRET", "memory-policy-test-secret");
  // Exercise the real service callback and private mutations. The owner gate's
  // serialization, durable recovery and acknowledgement are tested in its suite.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://builder.test/internal/owners/memory-policy/change") {
      throw new Error(`Unexpected test fetch: ${request.url}`);
    }
    const applied = await t.fetch("/api/cloud/home/memory/policy/apply", {
      method: "POST", headers: request.headers, body: await request.text(),
    });
    if (applied.ok) return Response.json({ ok: true });
    const body = await applied.json();
    return Response.json({ error: body.code ?? "MEMORY_POLICY_CHANGE_REFUSED" }, { status: applied.status });
  });
  return t;
};

const startWipe = makeFunctionReference<"action", any, any>(
  "cloud_memory_lifecycle:startMyMemoryWipe",
);
const wipeStatus = makeFunctionReference<"query", any, any>(
  "cloud_memory_lifecycle:getMyMemoryWipeStatus",
);
const claimWipe = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:claimMemoryWipeJobInternal",
);
const recordExternalGeneration = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:recordMemoryWipeExternalGenerationInternal",
);
const advanceSweep = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:advanceMemoryWipeSweepInternal",
);
const deleteMetadata = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:deleteMemoryWipeMetadataBatchInternal",
);
const completeWipe = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:completeMemoryWipeInternal",
);
const retryWipe = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:retryMemoryWipeInternal",
);
const authorizeReimport = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:authorizeMyMemoryReimport",
);
const beginWrite = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:beginWriteInternal",
);
const commitWrite = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:commitWriteInternal",
);
const listDocuments = makeFunctionReference<"query", any, any>(
  "cloud_memory:listMyMemoryDocuments",
);
const setPreference = makeFunctionReference<"action", any, any>(
  "cloud_memory:setMyMemoryEnabled",
);
const OWNER_ID = "https://issuer.test|memory-wipe-owner";
const GENERATION = "memory-wipe-owner-generation";

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "memory-wipe-owner",
    tokenIdentifier: OWNER_ID,
  });

const openOwner = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const prepare = async (
  t: ReturnType<typeof createTest>,
  name: string,
  idempotencyKey: string,
  writer:
    | "system_seed"
    | "remember"
    | "desktop_sync"
    | "mobile_sync" = "system_seed",
  expectedMemoryEpoch?: string,
) =>
  await t.mutation(beginWrite, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    name,
    kind: name === "MEMORY.md" ? "memory" : "profile",
    source: "memory-wipe-test",
    expectedRevision: 0,
    sha256: "a".repeat(64),
    sizeBytes: 12,
    writer,
    idempotencyKey,
    ...(expectedMemoryEpoch ? { expectedMemoryEpoch } : {}),
    now: 10,
  });

const commit = async (
  t: ReturnType<typeof createTest>,
  receipt: Record<string, unknown>,
) =>
  await t.mutation(commitWrite, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    memoryEpoch: receipt.memoryEpoch,
    intentId: receipt.intentId,
    versionId: receipt.versionId,
    r2Key: receipt.r2Key,
    sha256: receipt.sha256,
    sizeBytes: receipt.sizeBytes,
    now: 20,
  });

describe("dedicated cloud memory wipe lifecycle", () => {
  it("is idempotent, crash-resumable, epoch fenced, preference preserving, and zero-residue", async () => {
    const t = createTest();
    await openOwner(t);
    const stored = await prepare(t, "memories/profile.md", "wipe-stored");
    await commit(t, stored);
    const stale = await prepare(t, "MEMORY.md", "wipe-stale-intent");
    await asOwner(t).action(setPreference, {
      expectedSubject: OWNER_ID,
      memoryEnabled: false,
      expectedOwnerGeneration: GENERATION,
      expectedRevision: 0,
      requestId: "wipe-disable-memory",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_skills", {
        skillId: "wipe-imported-skill",
        ownerId: OWNER_ID,
        slug: "wipe-imported-calendar",
        name: "Imported Calendar",
        description: "Skill metadata must survive a Memory-only wipe",
        source: "owner_migration",
        availability: "both",
        activeVersionId: "wipe-imported-skill-version",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_skill_versions", {
        versionId: "wipe-imported-skill-version",
        skillId: "wipe-imported-skill",
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        revision: 1,
        manifestR2Key:
          "agent-home/owner/__stella_imported__/source/skills/wipe-imported-skill/wipe-imported-skill-version/manifest.json",
        manifestSha256: "e".repeat(64),
        treeSha256: "f".repeat(64),
        fileCount: 1,
        totalSizeBytes: 10,
        source: "owner_migration",
        idempotencyKey: "wipe-imported-skill-version",
        createdAt: 1,
      });
      await ctx.db.insert("cloud_skill_files", {
        ownerId: OWNER_ID,
        skillId: "wipe-imported-skill",
        versionId: "wipe-imported-skill-version",
        path: "SKILL.md",
        r2Key:
          "agent-home/owner/__stella_imported__/source/skills/wipe-imported-skill/wipe-imported-skill-version/files/SKILL.md",
        sha256: "d".repeat(64),
        sizeBytes: 10,
        contentType: "text/markdown",
        createdAt: 1,
      });
    });

    const started = await asOwner(t).action(startWipe, {
      expectedSubject: OWNER_ID,
      expectedOwnerGeneration: GENERATION,
      expectedMemoryEpoch: "legacy",
      requestId: "wipe-request-1",
    });
    expect(started).toMatchObject({
      subject: OWNER_ID,
      ownerGeneration: GENERATION,
      state: "wiping",
      memoryEpoch: "legacy",
      job: { stage: "sweeping", attempts: 0 },
    });
    expect(
      await asOwner(t).action(startWipe, {
        expectedSubject: OWNER_ID,
        expectedOwnerGeneration: GENERATION,
        expectedMemoryEpoch: "legacy",
        requestId: "wipe-request-1",
      }),
    ).toEqual(started);
    await expect(asOwner(t).query(listDocuments, {})).rejects.toThrow(
      "being permanently erased",
    );
    await expect(commit(t, stale)).rejects.toThrow("being permanently erased");
    await expect(
      prepare(t, "memories/other.md", "wipe-blocked-remember", "remember"),
    ).rejects.toThrow("being permanently erased");

    const operationId = started.job.operationId as string;
    const firstClaim = await t.mutation(claimWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-job-lease-1",
      now: 100,
    });
    expect(firstClaim).toMatchObject({ stage: "sweeping" });
    expect(
      await t.mutation(claimWipe, {
        ownerId: OWNER_ID,
        operationId,
        leaseId: "wipe-job-lease-restart",
        now: 101,
      }),
    ).toBeNull();
    await t.mutation(retryWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-job-lease-1",
      errorCode: "MEMORY_WIPE_EXTERNAL_UNAVAILABLE",
      now: 110,
    });
    const afterFailure = await asOwner(t).query(wipeStatus, {
      expectedSubject: OWNER_ID,
    });
    expect(afterFailure).toMatchObject({
      state: "wiping",
      job: {
        stage: "sweeping",
        lastErrorCode: "MEMORY_WIPE_EXTERNAL_UNAVAILABLE",
      },
    });
    expect(afterFailure.job.attempts).toBeGreaterThanOrEqual(1);
    const restarted = await t.mutation(claimWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-job-lease-restart",
      now: afterFailure.job.nextRetryAt,
    });
    expect(restarted).toMatchObject({ stage: "sweeping" });
    await t.mutation(recordExternalGeneration, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-job-lease-restart",
      externalGeneration: "worker-wipe-generation",
      now: 120,
    });
    let sweepLeaseId = "wipe-job-lease-restart";
    for (let expectedCursor = 0; expectedCursor < 9; expectedCursor += 1) {
      await t.mutation(advanceSweep, {
        ownerId: OWNER_ID,
        operationId,
        leaseId: sweepLeaseId,
        protocolVersion: 2,
        targetCount: 9,
        expectedCursor,
        nextCursor: expectedCursor + 1,
        deleted: expectedCursor === 0 ? 7 : 0,
        complete: expectedCursor === 8,
        now: 130 + expectedCursor * 2,
      });
      if (expectedCursor < 8) {
        sweepLeaseId = `wipe-sweep-${expectedCursor + 1}`;
        expect(
          await t.mutation(claimWipe, {
            ownerId: OWNER_ID,
            operationId,
            leaseId: sweepLeaseId,
            now: 131 + expectedCursor * 2,
          }),
        ).toMatchObject({
          stage: "sweeping",
          externalCursor: expectedCursor + 1,
        });
      }
    }

    for (let storeIndex = 0; storeIndex < 3; storeIndex += 1) {
      const leaseId = `wipe-metadata-${storeIndex}`;
      await t.mutation(claimWipe, {
        ownerId: OWNER_ID,
        operationId,
        leaseId,
        now: 200 + storeIndex,
      });
      await t.mutation(deleteMetadata, {
        ownerId: OWNER_ID,
        operationId,
        leaseId,
        storeIndex,
        now: 300 + storeIndex,
      });
    }
    const releaseClaim = await t.mutation(claimWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-release",
      now: 400,
    });
    expect(releaseClaim).toMatchObject({ stage: "releasing" });
    await t.mutation(completeWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "wipe-release",
      releasedExternalGeneration: "worker-wipe-generation",
      now: 500,
    });

    const completed = await asOwner(t).query(wipeStatus, {
      expectedSubject: OWNER_ID,
    });
    expect(completed).toMatchObject({
      state: "open",
      importDisposition: "explicit_required",
      lastWipedEpoch: "legacy",
      job: { operationId, stage: "completed", objectsDeleted: 7 },
    });
    expect(completed.memoryEpoch).not.toBe("legacy");
    expect(
      await asOwner(t).action(startWipe, {
        expectedSubject: OWNER_ID,
        expectedOwnerGeneration: GENERATION,
        expectedMemoryEpoch: "legacy",
        requestId: "wipe-request-1",
      }),
    ).toEqual(completed);
    const residue = await t.run(async (ctx) => ({
      docs: await ctx.db.query("cloud_agent_home_docs").collect(),
      versions: await ctx.db.query("cloud_agent_home_doc_versions").collect(),
      intents: await ctx.db.query("cloud_agent_home_write_intents").collect(),
      preference: await ctx.db.query("cloud_agent_home_preferences").unique(),
      skills: await ctx.db.query("cloud_skills").collect(),
      skillVersions: await ctx.db.query("cloud_skill_versions").collect(),
      skillFiles: await ctx.db.query("cloud_skill_files").collect(),
    }));
    expect(residue).toMatchObject({
      docs: [],
      versions: [],
      intents: [],
      preference: { memoryEnabled: false, revision: 1 },
      skills: [
        {
          skillId: "wipe-imported-skill",
          source: "owner_migration",
          activeVersionId: "wipe-imported-skill-version",
        },
      ],
      skillVersions: [
        {
          versionId: "wipe-imported-skill-version",
          source: "owner_migration",
        },
      ],
      skillFiles: [
        {
          skillId: "wipe-imported-skill",
          path: "SKILL.md",
        },
      ],
    });

    await expect(
      prepare(
        t,
        "MEMORY.md",
        "wipe-passive-reimport-blocked",
        "desktop_sync",
        completed.memoryEpoch,
      ),
    ).rejects.toThrow("requires explicit confirmation");
    await expect(
      prepare(
        t,
        "MEMORY.md",
        "wipe-passive-mobile-reimport-blocked",
        "mobile_sync",
        completed.memoryEpoch,
      ),
    ).rejects.toThrow("requires explicit confirmation");
    const authorized = await asOwner(t).mutation(authorizeReimport, {
      expectedSubject: OWNER_ID,
      expectedOwnerGeneration: GENERATION,
      expectedMemoryEpoch: completed.memoryEpoch,
      requestId: "wipe-explicit-reimport",
    });
    expect(authorized).toMatchObject({
      memoryEpoch: completed.memoryEpoch,
      importDisposition: "explicit_allowed",
      lastWipedEpoch: "legacy",
    });

    await asOwner(t).action(setPreference, {
      expectedSubject: OWNER_ID,
      memoryEnabled: true,
      expectedOwnerGeneration: GENERATION,
      expectedRevision: 1,
      requestId: "wipe-reenable-memory",
    });
    const fresh = await prepare(
      t,
      "MEMORY.md",
      "wipe-fresh-memory",
      "desktop_sync",
      completed.memoryEpoch,
    );
    expect(fresh.memoryEpoch).toBe(completed.memoryEpoch);
    expect(await commit(t, fresh)).toMatchObject({ status: "committed" });
  });

  it("CAS-fences filtered scan progress and rejects incomplete terminal receipts", async () => {
    vi.useFakeTimers();
    const t = createTest();
    await openOwner(t);
    const started = await asOwner(t).action(startWipe, {
      expectedSubject: OWNER_ID,
      expectedOwnerGeneration: GENERATION,
      expectedMemoryEpoch: "legacy",
      requestId: "wipe-filtered-protocol",
    });
    const operationId = started.job.operationId as string;
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query("cloud_memory_wipe_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      await ctx.db.patch(job!._id, { externalCursor: 5 });
    });
    await t.mutation(claimWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "filtered-lease-1",
      now: 100,
    });

    const base = {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "filtered-lease-1",
      protocolVersion: 2,
      targetCount: 9,
      expectedCursor: 5,
      deleted: 0,
      now: 101,
    };
    await expect(
      t.mutation(advanceSweep, {
        ...base,
        nextCursor: 5,
        complete: true,
      }),
    ).rejects.toThrow("Invalid memory wipe sweep receipt");
    await expect(
      t.mutation(advanceSweep, {
        ...base,
        nextCursor: 9,
        complete: true,
      }),
    ).rejects.toThrow("Invalid memory wipe sweep receipt");

    const scanMarker =
      "agent-home/owner/__stella_imported__/source/skills/last-object";
    await expect(
      t.mutation(advanceSweep, {
        ...base,
        nextCursor: 5,
        nextStartAfter: scanMarker,
        complete: false,
      }),
    ).resolves.toBe(false);
    await t.mutation(claimWipe, {
      ownerId: OWNER_ID,
      operationId,
      leaseId: "filtered-lease-2",
      now: 102,
    });
    await expect(
      t.mutation(advanceSweep, {
        ...base,
        leaseId: "filtered-lease-2",
        nextCursor: 6,
        complete: false,
        now: 103,
      }),
    ).rejects.toThrow(
      "memory operation started before cloud memory was erased",
    );
    await expect(
      t.mutation(advanceSweep, {
        ...base,
        leaseId: "filtered-lease-2",
        expectedStartAfter: scanMarker,
        nextCursor: 6,
        complete: false,
        now: 103,
      }),
    ).resolves.toBe(false);
    const advancedJob = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_memory_wipe_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    );
    expect(advancedJob).toMatchObject({ externalCursor: 6 });
    expect(advancedJob?.externalStartAfter).toBeUndefined();
  });

  it.each(["source", "destination"] as const)(
    "rejects wipe start while an auth migration fences the %s owner",
    async (role) => {
      const t = createTest();
      await openOwner(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: role === "source" ? OWNER_ID : "migration-source",
          toOwnerId:
            role === "destination" ? OWNER_ID : "migration-destination",
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        });
      });
      await expect(
        asOwner(t).action(startWipe, {
          expectedSubject: OWNER_ID,
          expectedOwnerGeneration: GENERATION,
          expectedMemoryEpoch: "legacy",
          requestId: `wipe-migration-${role}`,
        }),
      ).rejects.toThrow("OWNERSHIP_MIGRATED");
      expect(
        await t.run(
          async (ctx) => await ctx.db.query("cloud_memory_wipe_jobs").collect(),
        ),
      ).toEqual([]);
    },
  );
});
