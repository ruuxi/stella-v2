/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";
import schema from "./schema";
import { quiesceOwnerComposioSessionProvisioning } from "./composio_session_dispatch";
import { runComposioProviderCallBeforeDeadline } from "./http_routes/native_oauth";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

type ReserveResult =
  | {
      acquired: true;
      status: "reserved";
      providerDeadlineAt: number;
      quiescentAfterAt: number;
    }
  | { acquired: false; status: "busy" | "outcome_unknown" }
  | { acquired: false; status: "bound"; sessionId: string };

const reserve = makeFunctionReference<"mutation", any, ReserveResult>(
  "composio_session_dispatch:reserveComposioSessionProvisioningInternal",
);
const mark = makeFunctionReference<
  "mutation",
  any,
  | { started: false }
  | { started: true; providerDeadlineAt: number; quiescentAfterAt: number }
>(
  "composio_session_dispatch:markComposioSessionProvisioningMayHaveStartedInternal",
);
const markUnknown = makeFunctionReference<"mutation", any, boolean>(
  "composio_session_dispatch:markComposioSessionProvisioningOutcomeUnknownInternal",
);
const recordLocator = makeFunctionReference<"mutation", any, boolean>(
  "composio_session_dispatch:recordComposioSessionProvisioningLocatorInternal",
);
const bind = makeFunctionReference<"mutation", any, boolean>(
  "composio_session_dispatch:bindComposioSessionProvisioningInternal",
);
const requestCleanup = makeFunctionReference<"mutation", any, boolean>(
  "composio_session_dispatch:requestComposioSessionProvisioningCleanupInternal",
);
const claimCleanup = makeFunctionReference<"mutation", any, any>(
  "composio_session_dispatch:claimComposioSessionProvisioningCleanupInternal",
);
const remaining = makeFunctionReference<"query", any, string[]>(
  "composio_session_dispatch:remainingOwnerComposioSessionProvisioningInternal",
);
const resolveUnknown = makeFunctionReference<"mutation", any, any>(
  "composio_session_dispatch:resolveComposioSessionProvisioningOutcomeInternal",
);
const sweepCleanup = makeFunctionReference<"mutation", any, any>(
  "composio_session_dispatch:sweepDueComposioSessionProvisioningCleanupInternal",
);
const cleanupAction = makeFunctionReference<"action", any, null>(
  "composio_session_cleanup:cleanupComposioSessionProvisioningInternal",
);
const beginPurge = makeFunctionReference<"mutation", any, any>(
  "owner_lifecycle:beginOwnerDataPurgeInternal",
);
const claimPurge = makeFunctionReference<"mutation", any, any>(
  "owner_lifecycle:claimOwnerPurgeStageInternal",
);
const quiesceForPurge = makeFunctionReference<"mutation", any, any>(
  "composio_session_dispatch:quiesceOwnerComposioSessionProvisioningForPurgeInternal",
);
const prepareMigration = makeFunctionReference<"mutation", any, any>(
  "auth_migration:prepareOwnershipMigration",
);
const claimMigration = makeFunctionReference<"mutation", any, any>(
  "auth_migration:claimOwnershipMigration",
);
const quiesceForMigration = makeFunctionReference<"mutation", any, any>(
  "auth_migration:quiesceComposioProvisioningForOwnershipMigration",
);
const migrateResolutionAudits = makeFunctionReference<"mutation", any, any>(
  "auth_migration:migrateComposioSessionProvisioningResolutionsBatch",
);
const resetOwnerData = makeFunctionReference<"action", any, null>(
  "reset:resetOwnerDataInternal",
);
const deleteOwnerData = makeFunctionReference<"action", any, null>(
  "account_deletion:purgeOwnerCloudData",
);

const ownerId = "https://issuer.test|composio-provisioning";
const ownerGeneration = "legacy";

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "composio-provisioning",
    tokenIdentifier: ownerId,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.COMPOSIO_API_KEY;
});

const attemptArgs = (
  attemptId: string,
  now: number,
  overrides: Partial<{
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    composioUserId: string;
    leaseId: string;
  }> = {},
) => ({
  ownerId: overrides.ownerId ?? ownerId,
  ownerGeneration: overrides.ownerGeneration ?? ownerGeneration,
  integrationId: overrides.integrationId ?? "outlook",
  toolkit: overrides.toolkit ?? "outlook",
  composioUserId: overrides.composioUserId ?? "stella_test_user",
  attemptId,
  leaseId: overrides.leaseId ?? `lease-${attemptId}`,
  now,
});

const exactAttemptArgs = (args: ReturnType<typeof attemptArgs>) => ({
  ownerId: args.ownerId,
  ownerGeneration: args.ownerGeneration,
  attemptId: args.attemptId,
  leaseId: args.leaseId,
});

const withEmptyCloudBuilder = async <T>(run: () => Promise<T>): Promise<T> => {
  const previousUrl = process.env.CLOUD_BUILDER_URL;
  const previousSecret = process.env.BUILDER_SERVICE_SECRET;
  const previousEmojiBucket = process.env.R2_EMOJI_BUCKET;
  const previousEmojiPublicBase = process.env.R2_EMOJI_PUBLIC_BASE_URL;
  process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
  process.env.BUILDER_SERVICE_SECRET = "test-secret";
  process.env.R2_EMOJI_BUCKET = "stella-emoji-dev";
  process.env.R2_EMOJI_PUBLIC_BASE_URL = "https://emoji.test";
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/owners/purge/begin")) {
        const body = JSON.parse(String(init?.body)) as {
          expectedGeneration?: string;
        };
        return new Response(
          JSON.stringify({
            generation: body.expectedGeneration ?? "builder-generation",
            rejoined: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/owners/purge")) {
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }
      if (url.endsWith("/owners/purge/release")) {
        return new Response(JSON.stringify({ released: true }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected external request: ${url}`);
    });
  try {
    return await run();
  } finally {
    fetchMock.mockRestore();
    if (previousUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
    else process.env.CLOUD_BUILDER_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
    else process.env.BUILDER_SERVICE_SECRET = previousSecret;
    if (previousEmojiBucket === undefined) delete process.env.R2_EMOJI_BUCKET;
    else process.env.R2_EMOJI_BUCKET = previousEmojiBucket;
    if (previousEmojiPublicBase === undefined)
      delete process.env.R2_EMOJI_PUBLIC_BASE_URL;
    else process.env.R2_EMOJI_PUBLIC_BASE_URL = previousEmojiPublicBase;
  }
};

const seedResolutionAudit = async (
  t: ReturnType<typeof createTest>,
  auditOwnerId: string,
  suffix: string,
) =>
  await t.run(async (ctx) =>
    ctx.db.insert("composio_session_provisioning_resolutions", {
      ownerId: auditOwnerId,
      ownerGeneration: "legacy",
      integrationId: "gmail",
      toolkit: "gmail",
      composioUserIdHash: "a".repeat(64),
      attemptId: `attempt-${suffix}`,
      leaseId: `lease-${suffix}`,
      resolution: "provider_confirmed_not_created",
      resolvedByHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      resolvedAt: 1,
    }),
  );

describe("durable Composio session provisioning", () => {
  it("does not redispatch after a create response is lost", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "test-composio-key";
    const publish = makeFunctionReference<"mutation", any, any>(
      "data/integrations:upsertPublicIntegration",
    );
    await t.mutation(publish, {
      id: "outlook",
      name: "Outlook",
      provider: "composio",
      category: "email",
      auth: ["OAUTH2"],
      catalogToolCount: 1,
      actions: [
        {
          name: "OUTLOOK_QUERY_EMAILS",
          inputSchemaJson: JSON.stringify({
            type: "object",
            additionalProperties: false,
          }),
        },
      ],
      connector: {
        type: "composio",
        toolkit: "outlook",
        provider: "composio",
      },
      enabled: true,
      usagePolicy: "ready",
    });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("provider response lost"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = () =>
      asOwner(t).fetch("/api/native-integrations/connect-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "outlook" }),
      });
    expect((await request()).status).toBe(502);
    expect((await request()).status).toBe(502);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(await t.query(remaining, { ownerId })).toEqual([
      "composio_session_outcome_unknown:outlook",
    ]);
  });

  it("serializes concurrent creates for one owner and integration", async () => {
    const t = createTest();
    const now = Date.now();
    const results = await Promise.all([
      t.mutation(reserve, attemptArgs("attempt-concurrent-a", now)),
      t.mutation(reserve, attemptArgs("attempt-concurrent-b", now)),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(
      results.filter((result) => !result.acquired && result.status === "busy"),
    ).toHaveLength(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("composio_session_provisioning_attempts").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("starts the full provider timeout and abort grace at the final dispatch marker", async () => {
    const t = createTest();
    const reservedAt = Date.now();
    const args = attemptArgs("attempt-delayed-mark", reservedAt);
    const receipt = await t.mutation(reserve, args);
    expect(receipt.acquired).toBe(true);
    const markedAt = reservedAt + 29_000;
    expect(
      await t.mutation(mark, { ...exactAttemptArgs(args), now: markedAt }),
    ).toEqual({
      started: true,
      providerDeadlineAt: markedAt + 30_000,
      quiescentAfterAt: markedAt + 45_000,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique(),
    );
    expect(row?.state).toBe("dispatching");
    expect(row?.providerDeadlineAt).toBe(markedAt + 30_000);
    expect(row?.quiescentAfterAt).toBe(markedAt + 45_000);
    expect(row?.nextCleanupAt).toBe(markedAt + 45_000);
  });

  it("performs zero provider IO when a suspended creator resumes after its durable deadline and terminal resolution", async () => {
    const t = createTest();
    const reservedAt = 10_000;
    const args = attemptArgs("attempt-resumed-after-deadline", reservedAt);
    await t.mutation(reserve, args);
    const marked = await t.mutation(mark, {
      ...exactAttemptArgs(args),
      now: reservedAt + 1,
    });
    expect(marked).toMatchObject({ started: true });
    if (typeof marked !== "object" || !marked.started) {
      throw new Error("expected Composio dispatch marker");
    }
    await t.mutation(markUnknown, {
      ...exactAttemptArgs(args),
      now: marked.quiescentAfterAt,
      reason: "creator suspended before provider fetch",
    });
    await t.mutation(resolveUnknown, {
      ...args,
      resolution: { kind: "provider_confirmed_not_created" },
      resolvedBy: "operator@example.test",
      evidence: "The stale creator was suspended before its provider POST.",
      now: marked.quiescentAfterAt + 1,
    });

    const providerPost = vi.fn(async (_signal: AbortSignal) => ({ ok: true }));
    await expect(
      runComposioProviderCallBeforeDeadline({
        providerDeadlineAt: marked.providerDeadlineAt,
        now: () => marked.quiescentAfterAt + 2,
        run: providerPost,
      }),
    ).resolves.toEqual({ started: false });
    expect(providerPost).not.toHaveBeenCalled();
    const attempts = await t.run(async (ctx) =>
      ctx.db.query("composio_session_provisioning_attempts").collect(),
    );
    expect(attempts).toEqual([]);
    expect(await t.query(remaining, { ownerId })).toEqual([
      "composio_session_resolution_audit:outlook",
    ]);
  });

  it("does not let an unrelated bound session erase a marked unknown outcome", async () => {
    const t = createTest();
    const now = Date.now();
    const args = attemptArgs("attempt-unknown-with-bound", now);
    await t.mutation(reserve, args);
    await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
    await t.mutation(markUnknown, {
      ...exactAttemptArgs(args),
      now: now + 2,
      reason: "response lost",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId,
        provider: "outlook",
        mode: "composio",
        externalId: "session-from-another-create",
        config: { composioUserId: "stella_test_user" },
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.run(async (ctx) =>
      quiesceOwnerComposioSessionProvisioning(ctx, {
        ownerId,
        now: now + 60_000,
      }),
    );
    expect(result).toEqual({
      ready: false,
      pending: ["composio_session_outcome_unknown:outlook"],
      retryAt: null,
    });
    expect(await t.query(remaining, { ownerId })).toEqual([
      "composio_session_outcome_unknown:outlook",
    ]);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("composio_session_provisioning_attempts").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("accepts a late exact locator after outcome_unknown and can bind it once", async () => {
    const t = createTest();
    const now = Date.now();
    const args = attemptArgs("attempt-late-locator", now);
    await t.mutation(reserve, args);
    await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
    await t.mutation(markUnknown, {
      ...exactAttemptArgs(args),
      now: now + 2,
      reason: "response lost",
    });
    expect(
      await t.mutation(recordLocator, {
        ...exactAttemptArgs(args),
        sessionId: "session_late_exact",
        now: now + 50_000,
      }),
    ).toBe(true);
    expect(
      await t.mutation(bind, {
        ...args,
        sessionId: "session_late_exact",
        now: now + 50_001,
      }),
    ).toBe(true);

    expect(await t.query(remaining, { ownerId })).toEqual([]);
    const integration = await t.run(async (ctx) =>
      ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", ownerId).eq("provider", "outlook"),
        )
        .unique(),
    );
    expect(integration).toMatchObject({
      mode: "composio",
      externalId: "session_late_exact",
      config: { composioUserId: "stella_test_user" },
    });
  });

  it("records only hash-minimized operator evidence and makes exact unknown-create resolution replayable", async () => {
    const t = createTest();
    const now = Date.now();
    const args = attemptArgs("attempt-operator-resolution", now);
    await t.mutation(reserve, args);
    await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
    await t.mutation(markUnknown, {
      ...exactAttemptArgs(args),
      now: now + 2,
      reason: "provider response lost",
    });
    const resolutionArgs = {
      ...args,
      resolution: { kind: "provider_confirmed_not_created" as const },
      resolvedBy: "operator@example.test",
      evidence: "Provider ticket COM-123 confirmed no session was created.",
      now: now + 3,
    };
    await expect(t.mutation(resolveUnknown, resolutionArgs)).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: false,
    });
    await expect(
      t.mutation(resolveUnknown, { ...resolutionArgs, now: now + 4 }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: true,
    });
    await expect(
      t.mutation(resolveUnknown, {
        ...resolutionArgs,
        evidence: "different evidence",
        now: now + 5,
      }),
    ).rejects.toThrow(/does not match its audit/u);

    const [audit] = await t.run(async (ctx) =>
      ctx.db.query("composio_session_provisioning_resolutions").collect(),
    );
    expect(audit).toMatchObject({
      ownerId,
      ownerGeneration,
      integrationId: "outlook",
      resolution: "provider_confirmed_not_created",
      composioUserIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resolvedByHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(audit).not.toHaveProperty("composioUserId");
    expect(audit).not.toHaveProperty("sessionId");
    expect(audit).not.toHaveProperty("resolvedBy");
    expect(audit).not.toHaveProperty("evidence");
    expect(await t.query(remaining, { ownerId })).toEqual([
      "composio_session_resolution_audit:outlook",
    ]);
  });

  it("keeps an operator-recovered session cleanup-only against a late exact creator", async () => {
    const t = createTest();
    const now = Date.now();
    const args = attemptArgs("attempt-recovered-cleanup-only", now);
    await t.mutation(reserve, args);
    await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
    await t.mutation(markUnknown, {
      ...exactAttemptArgs(args),
      now: now + 2,
      reason: "provider response lost",
    });
    await expect(
      t.mutation(resolveUnknown, {
        ...args,
        resolution: {
          kind: "recovered_session",
          sessionId: "session_recovered_cleanup_only",
        },
        resolvedBy: "operator@example.test",
        evidence: "Provider support recovered the orphan session locator.",
        now: now + 3,
      }),
    ).resolves.toEqual({ resolution: "recovered_session", replayed: false });

    await expect(
      t.mutation(bind, {
        ...args,
        sessionId: "session_recovered_cleanup_only",
        now: now + 4,
      }),
    ).rejects.toThrow(/bind receipt changed/u);
    const snapshot = await t.run(async (ctx) => ({
      attempt: await ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique(),
      integration: await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", ownerId).eq("provider", "outlook"),
        )
        .unique(),
    }));
    expect(snapshot.attempt).toMatchObject({
      state: "locator_recorded",
      sessionId: "session_recovered_cleanup_only",
    });
    expect(snapshot.integration).toBeNull();
  });

  it("replaces a due cleanup whose recorded scheduler job already completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const t = createTest();
    const completedJobId = await t.run(async (ctx) =>
      ctx.scheduler.runAfter(0, cleanupAction, {
        attemptId: "already-absent-attempt",
        leaseId: "already-absent-lease",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
    await t.run(async (ctx) => {
      await ctx.db.insert("composio_session_provisioning_attempts", {
        ownerId,
        ownerGeneration,
        integrationId: "outlook",
        toolkit: "outlook",
        composioUserId: "stella_test_user",
        attemptId: "attempt-completed-cleanup-job",
        leaseId: "lease-completed-cleanup-job",
        state: "cleanup_pending",
        sessionId: "session_completed_cleanup_job",
        providerDeadlineAt: 50_000,
        quiescentAfterAt: 60_000,
        cleanupJobId: completedJobId,
        cleanupAttempts: 1,
        nextCleanupAt: 99_999,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await expect(
      t.mutation(sweepCleanup, { now: 100_001, limitPerState: 1 }),
    ).resolves.toEqual({ scheduled: 1 });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) =>
          q.eq("attemptId", "attempt-completed-cleanup-job"),
        )
        .unique(),
    );
    expect(row?.cleanupJobId).not.toBe(completedJobId);
    expect(row?.nextCleanupAt).toBe(100_001 + 5 * 60_000);
  });

  it.each(["reset", "delete"] as const)(
    "purges hash-only operator audits under the exact %s lifecycle lease",
    async (mode) => {
      const t = createTest();
      const now = Date.now();
      const args = attemptArgs(`attempt-${mode}-audit`, now);
      await t.mutation(reserve, args);
      await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
      await t.mutation(markUnknown, {
        ...exactAttemptArgs(args),
        now: now + 2,
        reason: "provider response lost",
      });
      await t.mutation(resolveUnknown, {
        ...args,
        resolution: { kind: "provider_confirmed_not_created" },
        resolvedBy: "operator@example.test",
        evidence: "Provider confirmed no session.",
        now: now + 3,
      });
      const operationId = `${mode}-composio-audit`;
      const lifecycle = (await t.mutation(beginPurge, {
        ownerId,
        operationId,
        mode,
        now: now + 4,
      })) as { generation: string };
      const leaseId = `${mode}-composio-audit-lease`;
      await t.mutation(claimPurge, {
        ownerId,
        operationId,
        generation: lifecycle.generation,
        stage: "core",
        leaseId,
        now: now + 5,
      });
      await expect(
        t.mutation(quiesceForPurge, {
          ownerId,
          operationId,
          generation: lifecycle.generation,
          leaseId,
          mode,
          now: now + 6,
        }),
      ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
      expect(await t.query(remaining, { ownerId })).toEqual([]);
      expect(
        await t.run(async (ctx) =>
          ctx.db.query("composio_session_provisioning_resolutions").collect(),
        ),
      ).toEqual([]);
    },
  );

  it("purges and reads back resolution audits through the full owner reset", async () => {
    const t = createTest();
    const auditOwnerId = "composio-audit-full-reset";
    await seedResolutionAudit(t, auditOwnerId, "full-reset");
    const operationId = "composio-audit-full-reset-operation";
    const lifecycle = (await t.mutation(beginPurge, {
      ownerId: auditOwnerId,
      operationId,
      mode: "reset",
      now: 1,
    })) as { generation: string };
    await t.run(async (ctx) =>
      seedReadyPurgeBackupSweep(ctx, {
        ownerId: auditOwnerId,
        operationId,
        generation: lifecycle.generation,
      }),
    );

    await withEmptyCloudBuilder(async () => {
      await expect(
        t.action(resetOwnerData, { ownerId: auditOwnerId }),
      ).resolves.toBeNull();
    });

    expect(await t.query(remaining, { ownerId: auditOwnerId })).toEqual([]);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("composio_session_provisioning_resolutions")
          .withIndex("by_ownerId_and_resolvedAt", (q) =>
            q.eq("ownerId", auditOwnerId),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  it("purges and reads back resolution audits through full account deletion", async () => {
    const t = createTest();
    const auditOwnerId = "composio-audit-full-delete";
    await seedResolutionAudit(t, auditOwnerId, "full-delete");
    const operationId = "composio-audit-full-delete-operation";
    const lifecycle = (await t.mutation(beginPurge, {
      ownerId: auditOwnerId,
      operationId,
      mode: "delete",
      now: 1,
    })) as { generation: string };
    await t.run(async (ctx) =>
      seedReadyPurgeBackupSweep(ctx, {
        ownerId: auditOwnerId,
        operationId,
        generation: lifecycle.generation,
      }),
    );

    await withEmptyCloudBuilder(async () => {
      const args = {
        ownerId: auditOwnerId,
        operationId,
        generation: lifecycle.generation,
      };
      let completed = false;
      for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
        try {
          await t.action(deleteOwnerData, args);
          completed = true;
        } catch (error) {
          if (!String(error).includes("billing_locator_capture")) throw error;
        }
      }
      expect(completed).toBe(true);
    });

    expect(await t.query(remaining, { ownerId: auditOwnerId })).toEqual([]);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("composio_session_provisioning_resolutions")
          .withIndex("by_ownerId_and_resolvedAt", (q) =>
            q.eq("ownerId", auditOwnerId),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  it("moves source resolution audits to the destination generation while preserving destination audits", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "composio-audit-migration-source",
      toOwnerId: "composio-audit-migration-destination",
    };
    await t.mutation(prepareMigration, owners);
    const claim = (await t.mutation(claimMigration, {
      ...owners,
      leaseId: "composio-audit-migration-lease",
      now: 1_000,
    })) as {
      leaseGeneration: number;
      fromOwnerGeneration: string;
      toOwnerGeneration: string;
    };
    const auditRow = (
      ownerId: string,
      ownerGeneration: string,
      suffix: string,
    ) => ({
      ownerId,
      ownerGeneration,
      integrationId: "gmail",
      toolkit: "gmail",
      composioUserIdHash: suffix.repeat(64).slice(0, 64),
      attemptId: `attempt-${suffix}`,
      leaseId: `lease-${suffix}`,
      resolution: "provider_confirmed_not_created" as const,
      resolvedByHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      resolvedAt: 1_001,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "composio_session_provisioning_resolutions",
        auditRow(owners.fromOwnerId, claim.fromOwnerGeneration, "a"),
      );
      await ctx.db.insert(
        "composio_session_provisioning_resolutions",
        auditRow(owners.toOwnerId, claim.toOwnerGeneration, "d"),
      );
    });
    const lease = {
      ...owners,
      leaseId: "composio-audit-migration-lease",
      leaseGeneration: claim.leaseGeneration,
      leaseNow: 1_002,
    };
    await expect(t.mutation(quiesceForMigration, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    await expect(t.mutation(migrateResolutionAudits, lease)).resolves.toEqual({
      hasMore: false,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", owners.toOwnerId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attemptId).sort()).toEqual([
      "attempt-a",
      "attempt-d",
    ]);
    expect(
      rows.every((row) => row.ownerGeneration === claim.toOwnerGeneration),
    ).toBe(true);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("composio_session_provisioning_resolutions")
          .withIndex("by_ownerId_and_resolvedAt", (q) =>
            q.eq("ownerId", owners.fromOwnerId),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  it("drops only definitively pre-dispatch reservations during quiescence", async () => {
    const t = createTest();
    const now = Date.now();
    await t.mutation(reserve, attemptArgs("attempt-never-dispatched", now));
    const result = await t.run(async (ctx) =>
      quiesceOwnerComposioSessionProvisioning(ctx, { ownerId, now: now + 1 }),
    );
    expect(result).toEqual({ ready: true, pending: [], retryAt: null });
    expect(await t.query(remaining, { ownerId })).toEqual([]);
  });

  it("publishes a cleanup watchdog before provider delete and restarts a stale claim", async () => {
    const t = createTest();
    const now = Date.now();
    const args = attemptArgs("attempt-cleanup-crash", now);
    await t.mutation(reserve, args);
    await t.mutation(mark, { ...exactAttemptArgs(args), now: now + 1 });
    await t.mutation(recordLocator, {
      ...exactAttemptArgs(args),
      sessionId: "session_cleanup_crash",
      now: now + 2,
    });
    await t.mutation(requestCleanup, {
      ...exactAttemptArgs(args),
      sessionId: "session_cleanup_crash",
      now: now + 3,
      reason: "bind failed",
    });
    const claim = await t.mutation(claimCleanup, {
      attemptId: args.attemptId,
      leaseId: args.leaseId,
      now: now + 4,
    });
    expect(claim).toMatchObject({
      kind: "cleanup",
      sessionId: "session_cleanup_crash",
    });
    const claimed = await t.run(async (ctx) =>
      ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique(),
    );
    expect(claimed?.state).toBe("cleanup_pending");
    expect(claimed?.nextCleanupAt).toBe(now + 4 + 5 * 60_000);

    const restartAt = claimed!.nextCleanupAt! + 1;
    const quiesced = await t.run(async (ctx) =>
      quiesceOwnerComposioSessionProvisioning(ctx, {
        ownerId,
        now: restartAt,
      }),
    );
    expect(quiesced.ready).toBe(false);
    expect(quiesced.pending).toEqual([
      "composio_session_cleanup_pending:outlook",
    ]);
    const restarted = await t.run(async (ctx) =>
      ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique(),
    );
    expect(restarted?.nextCleanupAt).toBe(restartAt);
  });
});
