/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  connectedAccountIdsFromPayload,
  connectedAccountRevokedFromPayload,
} from "./composio_purge";
import { composioUserIdForOwner } from "./lib/composio_identity";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const beginPurge = makeFunctionReference<"mutation">(
  "owner_lifecycle:beginOwnerDataPurgeInternal",
);
const claimPurge = makeFunctionReference<"mutation">(
  "owner_lifecycle:claimOwnerPurgeStageInternal",
);
const purge = makeFunctionReference<"action">(
  "composio_purge:purgeOwnerComposioSessionsInternal",
);
const remaining = makeFunctionReference<"action">(
  "composio_purge:remainingOwnerComposioSessionsInternal",
);
const getBatch = makeFunctionReference<"query">(
  "composio_purge_store:getOwnerComposioPurgeBatchInternal",
);
const acknowledge = makeFunctionReference<"mutation">(
  "composio_purge_store:acknowledgeOwnerComposioSessionDeletedInternal",
);
const drainNonComposio = makeFunctionReference<"mutation">(
  "account_deletion:_deleteOwnerNonComposioIntegrationsBatch",
);
const cleanupProvisioning = makeFunctionReference<"action">(
  "composio_session_cleanup:cleanupComposioSessionProvisioningInternal",
);
const resolvePrincipal = makeFunctionReference<"mutation", any, any>(
  "composio_purge_store:resolveOwnerComposioPrincipalInternal",
);

const beginDeleteLease = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) => {
  const now = Date.now();
  const operationId = `delete-${ownerId}`;
  const lifecycle = (await t.mutation(beginPurge, {
    ownerId,
    operationId,
    mode: "delete",
    now,
  })) as { generation: string };
  const leaseId = `lease-${ownerId}`;
  await t.mutation(claimPurge, {
    ownerId,
    operationId,
    generation: lifecycle.generation,
    stage: "core",
    leaseId,
    now,
  });
  return {
    ownerId,
    operationId,
    generation: lifecycle.generation,
    leaseId,
  };
};

const insertSession = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  overrides: Partial<{
    provider: string;
    externalId: string;
    composioUserId: string;
    updatedAt: number;
  }> = {},
) =>
  await t.run(async (ctx) =>
    ctx.db.insert("user_integrations", {
      ownerId,
      provider: overrides.provider ?? "gmail",
      mode: "composio",
      externalId: overrides.externalId ?? "trs_session_1",
      config: {
        composioUserId: overrides.composioUserId ?? "stella_user_1",
      },
      createdAt: 1,
      updatedAt: overrides.updatedAt ?? 1,
    }),
  );

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  process.env.COMPOSIO_TOOL_ROUTER_URL =
    "https://tool-router.test/api/v3.1/tool_router";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Composio external session purge", () => {
  it("rolls back only the orphan session when another bound session shares its principal and toolkit", async () => {
    const t = createTest();
    const ownerId = "owner-composio-shared-session-principal";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId,
        provider: "gmail-bound",
        mode: "composio",
        externalId: "session_still_bound",
        config: {
          composioUserId: "stella_shared_user",
          composioToolkit: "gmail",
        },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("composio_session_provisioning_attempts", {
        ownerId,
        ownerGeneration: "legacy",
        integrationId: "gmail-orphan",
        toolkit: "gmail",
        composioUserId: "stella_shared_user",
        attemptId: "attempt-shared-principal-orphan",
        leaseId: "lease-shared-principal-orphan",
        state: "cleanup_pending",
        sessionId: "session_orphan_only",
        providerDeadlineAt: now - 2,
        quiescentAfterAt: now - 1,
        cleanupAttempts: 0,
        nextCleanupAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    let sessionDeleted = false;
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/tool_router/session/session_orphan_only")) {
          if (method === "DELETE") {
            sessionDeleted = true;
            return json({ deleted: true });
          }
          return sessionDeleted
            ? json({}, 404)
            : json({ config: { user_id: "stella_shared_user" } });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(
      t.action(cleanupProvisioning, {
        attemptId: "attempt-shared-principal-orphan",
        leaseId: "lease-shared-principal-orphan",
      }),
    ).resolves.toBeNull();
    expect(calls.some((call) => call.url.includes("connected_accounts"))).toBe(
      false,
    );
    const snapshot = await t.run(async (ctx) => ({
      bound: await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", ownerId).eq("provider", "gmail-bound"),
        )
        .unique(),
      attempt: await ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_attemptId", (q) =>
          q.eq("attemptId", "attempt-shared-principal-orphan"),
        )
        .unique(),
    }));
    expect(snapshot.bound?.externalId).toBe("session_still_bound");
    expect(snapshot.attempt).toBeNull();
  });

  it("finishes an exact zero-row readback without provider configuration", async () => {
    const t = createTest();
    const ownerId = "owner-without-composio-debt";
    const fence = await beginDeleteLease(t, ownerId);
    delete process.env.COMPOSIO_API_KEY;

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: true,
      pending: [],
    });
    await expect(t.action(remaining, { ownerId })).resolves.toEqual([]);
  });

  it("rejects any connected-account row outside the exact user and toolkit", () => {
    expect(() =>
      connectedAccountIdsFromPayload(
        {
          items: [
            {
              id: "ca_other",
              user_id: "stella_someone_else",
              toolkit: { slug: "gmail" },
            },
          ],
        },
        { provider: "gmail", composioUserId: "stella_user_1" },
      ),
    ).toThrow(/identity did not match/u);
    expect(() =>
      connectedAccountIdsFromPayload(
        {
          items: [],
          next_cursor: "x".repeat(513),
        },
        { provider: "gmail", composioUserId: "stella_user_1" },
      ),
    ).toThrow(/cursor is invalid/u);
    expect(
      connectedAccountRevokedFromPayload(
        {
          id: "ca_exact",
          user_id: "stella_user_1",
          toolkit: { slug: "gmail" },
          status: "REVOKED",
        },
        {
          id: "ca_exact",
          provider: "gmail",
          composioUserId: "stella_user_1",
        },
      ),
    ).toBe(true);
    expect(() =>
      connectedAccountRevokedFromPayload(
        {
          id: "ca_exact",
          user_id: "another_user",
          toolkit: { slug: "gmail" },
          status: "REVOKED",
        },
        {
          id: "ca_exact",
          provider: "gmail",
          composioUserId: "stella_user_1",
        },
      ),
    ).toThrow(/identity changed/u);
  });

  it("deletes and confirms the session first, then revokes accounts, relists empty, and deletes the local locator", async () => {
    const t = createTest();
    const ownerId = "owner-composio-delete";
    await insertSession(t, ownerId);
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId,
        provider: "x",
        mode: "oauth",
        config: {},
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const fence = await beginDeleteLease(t, ownerId);
    const calls: Array<{ url: string; method: string }> = [];
    let sessionDeleted = false;
    let accountRevoked = false;
    let accountDeleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (
          url.endsWith("/tool_router/session/trs_session_1") &&
          method === "GET"
        ) {
          return sessionDeleted
            ? json({}, 404)
            : json({ config: { user_id: "stella_user_1" } });
        }
        if (url.includes("/connected_accounts?") && method === "GET") {
          return json({
            items: accountDeleted
              ? []
              : [
                  {
                    id: "ca_account_1",
                    user_id: "stella_user_1",
                    toolkit: { slug: "gmail" },
                  },
                ],
            next_cursor: null,
          });
        }
        if (
          url.endsWith("/connected_accounts/ca_account_1/revoke") &&
          method === "POST"
        ) {
          accountRevoked = true;
          return json({
            id: "ca_account_1",
            user_id: "stella_user_1",
            toolkit: { slug: "gmail" },
            status: "REVOKED",
          });
        }
        if (
          url.endsWith(
            "/connected_accounts/ca_account_1?revoke_on_delete=true",
          ) &&
          method === "DELETE"
        ) {
          accountDeleted = true;
          return json({ success: true });
        }
        if (
          url.endsWith("/connected_accounts/ca_account_1") &&
          method === "GET"
        ) {
          return accountDeleted
            ? json({}, 404)
            : json({
                id: "ca_account_1",
                user_id: "stella_user_1",
                toolkit: { slug: "gmail" },
                status: accountRevoked ? "REVOKED" : "ACTIVE",
              });
        }
        if (
          url.endsWith("/tool_router/session/trs_session_1") &&
          method === "DELETE"
        ) {
          sessionDeleted = true;
          return json({ session_id: "trs_session_1", deleted: true });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: true,
      pending: [],
    });
    await expect(t.action(remaining, { ownerId })).resolves.toEqual([]);
    await expect(t.mutation(drainNonComposio, fence)).resolves.toEqual({
      hasMore: false,
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
    ).resolves.toEqual([]);
    const accountDelete = calls.findIndex(
      (call) =>
        call.method === "DELETE" && call.url.includes("connected_accounts"),
    );
    const accountRevoke = calls.findIndex(
      (call) => call.method === "POST" && call.url.endsWith("/revoke"),
    );
    const revokeConfirm = calls.findIndex(
      (call, index) =>
        index > accountRevoke &&
        call.method === "GET" &&
        call.url.endsWith("/connected_accounts/ca_account_1"),
    );
    const sessionDelete = calls.findIndex(
      (call) =>
        call.method === "DELETE" && call.url.includes("tool_router/session"),
    );
    const sessionConfirm = calls.findIndex(
      (call, index) =>
        index > sessionDelete &&
        call.method === "GET" &&
        call.url.includes("tool_router/session"),
    );
    const accountLists = calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.method === "GET" && call.url.includes("connected_accounts?"),
      )
      .map(({ index }) => index);
    expect(accountDelete).toBeGreaterThanOrEqual(0);
    expect(accountRevoke).toBeGreaterThan(accountLists[0]!);
    expect(revokeConfirm).toBeGreaterThan(accountRevoke);
    expect(accountDelete).toBeGreaterThan(revokeConfirm);
    expect(sessionDelete).toBeGreaterThanOrEqual(0);
    expect(sessionConfirm).toBeGreaterThan(sessionDelete);
    expect(accountLists).toHaveLength(2);
    expect(accountLists[0]).toBeGreaterThan(sessionConfirm);
    expect(accountLists[1]).toBeGreaterThan(accountDelete);
  });

  it("does not treat an unrelated later migration as row-specific legacy-principal authority", async () => {
    const t = createTest();
    const originalSourceOwnerId = "legacy-composio-original-source-owner";
    const unrelatedSourceOwnerId = "legacy-composio-unrelated-source-owner";
    const ownerId = "legacy-composio-destination-owner";
    const originalPrincipal = await composioUserIdForOwner(
      originalSourceOwnerId,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId,
        provider: "gmail",
        mode: "composio",
        externalId: "session_migrated_legacy",
        config: {},
        createdAt: 1,
        updatedAt: 1,
      });
      // The row originally crossed A -> B before principal persistence. Only a
      // later, unrelated C -> B operational edge survives. That edge is not
      // authority to inspect or delete A's provider partition.
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: unrelatedSourceOwnerId,
        toOwnerId: ownerId,
        status: "complete",
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      });
    });
    const fence = await beginDeleteLease(t, ownerId);
    const listedPrincipals: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/session/session_migrated_legacy")) {
          return json({}, 404);
        }
        if (url.pathname.endsWith("/connected_accounts") && method === "GET") {
          const principal = url.searchParams.get("user_ids")!;
          listedPrincipals.push(principal);
          return json({
            items: [
              {
                id: "ca_migrated_legacy",
                user_id: originalPrincipal,
                toolkit: { slug: "gmail" },
              },
            ],
            next_cursor: null,
          });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: false,
      pending: [
        "composio:gmail:external_cleanup_pending",
        "composio_session:gmail",
      ],
    });
    expect(listedPrincipals).toEqual([]);
    await expect(t.action(remaining, { ownerId })).resolves.toEqual([
      "composio_session:gmail",
    ]);
  });

  it("fails closed after minimized migration provenance until an exact hash-audited principal resolution", async () => {
    const t = createTest();
    const sourceOwnerId = "minimized-composio-source-owner";
    const ownerId = "minimized-composio-destination-owner";
    const sourcePrincipal = await composioUserIdForOwner(sourceOwnerId);
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId,
        provider: "gmail",
        mode: "composio",
        externalId: "session_minimized_legacy",
        config: {},
        createdAt: 1,
        updatedAt: 1,
      });
      // The pre-fix operational migration was minimized to a one-way digest;
      // no raw source owner remains from which the provider principal can be
      // safely reconstructed.
      await ctx.db.insert("auth_owner_migration_tombstones", {
        sourceOwnerDigest: "d".repeat(64),
      });
    });
    const fence = await beginDeleteLease(t, ownerId);
    let accountDeleted = false;
    const connectedLists: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/session/session_minimized_legacy")) {
          return json({}, 404);
        }
        if (url.pathname.endsWith("/connected_accounts") && method === "GET") {
          const principal = url.searchParams.get("user_ids")!;
          connectedLists.push(principal);
          return json({
            items: accountDeleted
              ? []
              : [
                  {
                    id: "ca_minimized_legacy",
                    user_id: sourcePrincipal,
                    toolkit: { slug: "gmail" },
                  },
                ],
            next_cursor: null,
          });
        }
        if (
          url.pathname.endsWith(
            "/connected_accounts/ca_minimized_legacy/revoke",
          ) &&
          method === "POST"
        ) {
          return json({
            id: "ca_minimized_legacy",
            user_id: sourcePrincipal,
            toolkit: { slug: "gmail" },
            status: "REVOKED",
          });
        }
        if (
          url.pathname.endsWith("/connected_accounts/ca_minimized_legacy") &&
          method === "GET"
        ) {
          return accountDeleted
            ? json({}, 404)
            : json({
                id: "ca_minimized_legacy",
                user_id: sourcePrincipal,
                toolkit: { slug: "gmail" },
                status: "REVOKED",
              });
        }
        if (
          url.pathname.endsWith("/connected_accounts/ca_minimized_legacy") &&
          method === "DELETE"
        ) {
          accountDeleted = true;
          return json({ deleted: true });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: false,
      pending: [
        "composio:gmail:external_cleanup_pending",
        "composio_session:gmail",
      ],
    });
    expect(connectedLists).toEqual([]);
    const resolutionArgs = {
      ownerId,
      provider: "gmail",
      sessionId: "session_minimized_legacy",
      composioUserId: sourcePrincipal,
      resolutionId: "minimized-principal-resolution",
      resolvedBy: "operator@example.test",
      evidence: "Provider ticket COM-404 identifies the legacy principal.",
    };
    await expect(
      t.mutation(resolvePrincipal, { ...resolutionArgs, now: 10_010 }),
    ).resolves.toEqual({ replayed: false });
    await expect(
      t.mutation(resolvePrincipal, { ...resolutionArgs, now: 10_011 }),
    ).resolves.toEqual({ replayed: true });
    const resolved = await t.run(async (ctx) =>
      ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", ownerId).eq("provider", "gmail"),
        )
        .unique(),
    );
    expect(resolved?.config).toMatchObject({
      composioUserId: sourcePrincipal,
      composioPrincipalResolutionId: "minimized-principal-resolution",
      composioPrincipalSessionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      composioPrincipalResolvedByHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      composioPrincipalEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(resolved?.config).not.toHaveProperty("resolvedBy");
    expect(resolved?.config).not.toHaveProperty("evidence");

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: true,
      pending: [],
    });
    expect(new Set(connectedLists)).toEqual(new Set([sourcePrincipal]));
    expect(accountDeleted).toBe(true);
  });

  it("retains the durable locator after an ambiguous provider failure", async () => {
    const t = createTest();
    const ownerId = "owner-composio-ambiguous";
    const rowId = await insertSession(t, ownerId);
    const fence = await beginDeleteLease(t, ownerId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/tool_router/session/trs_session_1")) {
          return json({ config: { user_id: "stella_user_1" } });
        }
        if (url.includes("/connected_accounts?") && method === "GET") {
          return json({
            items: [
              {
                id: "ca_account_1",
                user_id: "stella_user_1",
                toolkit: { slug: "gmail" },
              },
            ],
          });
        }
        if (method === "DELETE") throw new TypeError("network reset");
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    const result = (await t.action(purge, fence)) as {
      ready: boolean;
      pending: string[];
    };
    expect(result.ready).toBe(false);
    expect(result.pending).toContain("composio:gmail:external_cleanup_pending");
    await expect(t.mutation(drainNonComposio, fence)).rejects.toThrow(
      /external deletion debt/u,
    );
    await expect(
      t.run(async (ctx) => ctx.db.get(rowId)),
    ).resolves.not.toBeNull();
  });

  it("restarts after session deletion from the persisted principal and finishes an exact account relist", async () => {
    const t = createTest();
    const ownerId = "owner-composio-session-deleted-restart";
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("user_integrations", {
        ownerId,
        provider: "gmail",
        mode: "composio",
        externalId: "trs_session_restart",
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const fence = await beginDeleteLease(t, ownerId);
    let sessionDeleted = false;
    let accountRevoked = false;
    let accountDeleted = false;
    let connectedAccountLists = 0;
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (
          url.endsWith("/tool_router/session/trs_session_restart") &&
          method === "GET"
        ) {
          return sessionDeleted
            ? json({}, 404)
            : json({ config: { user_id: "stella_restart_user" } });
        }
        if (
          url.endsWith("/tool_router/session/trs_session_restart") &&
          method === "DELETE"
        ) {
          if (sessionDeleted) return json({}, 404);
          sessionDeleted = true;
          return json({ deleted: true });
        }
        if (url.includes("/connected_accounts?") && method === "GET") {
          connectedAccountLists += 1;
          if (connectedAccountLists === 1) {
            throw new TypeError("worker stopped after session delete");
          }
          return json({
            items: accountDeleted
              ? []
              : [
                  {
                    id: "ca_restart_account",
                    user_id: "stella_restart_user",
                    toolkit: { slug: "gmail" },
                  },
                ],
            next_cursor: null,
          });
        }
        if (
          url.endsWith("/connected_accounts/ca_restart_account/revoke") &&
          method === "POST"
        ) {
          accountRevoked = true;
          return json({
            id: "ca_restart_account",
            user_id: "stella_restart_user",
            toolkit: { slug: "gmail" },
            status: "REVOKED",
          });
        }
        if (
          url.endsWith(
            "/connected_accounts/ca_restart_account?revoke_on_delete=true",
          ) &&
          method === "DELETE"
        ) {
          accountDeleted = true;
          return json({ success: true });
        }
        if (
          url.endsWith("/connected_accounts/ca_restart_account") &&
          method === "GET"
        ) {
          return accountDeleted
            ? json({}, 404)
            : json({
                id: "ca_restart_account",
                user_id: "stella_restart_user",
                toolkit: { slug: "gmail" },
                status: accountRevoked ? "REVOKED" : "ACTIVE",
              });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(t.action(purge, fence)).resolves.toMatchObject({
      ready: false,
    });
    const durableAfterCrash = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(durableAfterCrash).toMatchObject({
      externalId: "trs_session_restart",
      config: { composioUserId: "stella_restart_user" },
    });

    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: true,
      pending: [],
    });
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).toBeNull();
    const secondSessionGet = calls.findIndex(
      (call, index) =>
        index > 0 &&
        call.method === "GET" &&
        call.url.endsWith("/tool_router/session/trs_session_restart") &&
        calls
          .slice(0, index)
          .some(
            (prior) =>
              prior.method === "DELETE" &&
              prior.url.endsWith("/tool_router/session/trs_session_restart"),
          ),
    );
    expect(secondSessionGet).toBeGreaterThanOrEqual(0);
    expect(connectedAccountLists).toBe(3);
  });

  it("retries a lost synchronous revoke response without dropping cleanup debt", async () => {
    const t = createTest();
    const ownerId = "owner-composio-revoke-response-loss";
    const rowId = await insertSession(t, ownerId, {
      externalId: "trs_revoke_loss",
    });
    const fence = await beginDeleteLease(t, ownerId);
    let sessionDeleted = false;
    let accountRevoked = false;
    let accountDeleted = false;
    let revokeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (
          url.endsWith("/tool_router/session/trs_revoke_loss") &&
          method === "GET"
        ) {
          return sessionDeleted
            ? json({}, 404)
            : json({ config: { user_id: "stella_user_1" } });
        }
        if (
          url.endsWith("/tool_router/session/trs_revoke_loss") &&
          method === "DELETE"
        ) {
          if (sessionDeleted) return json({}, 404);
          sessionDeleted = true;
          return json({ deleted: true });
        }
        if (url.includes("/connected_accounts?") && method === "GET") {
          return json({
            items: accountDeleted
              ? []
              : [
                  {
                    id: "ca_revoke_loss",
                    user_id: "stella_user_1",
                    toolkit: { slug: "gmail" },
                  },
                ],
            next_cursor: null,
          });
        }
        if (
          url.endsWith("/connected_accounts/ca_revoke_loss/revoke") &&
          method === "POST"
        ) {
          revokeCalls += 1;
          accountRevoked = true;
          if (revokeCalls === 1) {
            throw new TypeError("revoke response lost");
          }
          return json({ error: "account is no longer revokable" }, 409);
        }
        if (
          url.endsWith("/connected_accounts/ca_revoke_loss") &&
          method === "GET"
        ) {
          return accountDeleted
            ? json({}, 404)
            : json({
                id: "ca_revoke_loss",
                user_id: "stella_user_1",
                toolkit: { slug: "gmail" },
                status: accountRevoked ? "REVOKED" : "ACTIVE",
              });
        }
        if (
          url.endsWith(
            "/connected_accounts/ca_revoke_loss?revoke_on_delete=true",
          ) &&
          method === "DELETE"
        ) {
          accountDeleted = true;
          return json({ deleted: true });
        }
        throw new Error(`Unexpected Composio request: ${method} ${url}`);
      }),
    );

    await expect(t.action(purge, fence)).resolves.toMatchObject({
      ready: false,
    });
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).not.toBeNull();
    await expect(t.action(purge, fence)).resolves.toEqual({
      ready: true,
      pending: [],
    });
    expect(revokeCalls).toBe(2);
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).toBeNull();
  });

  it("makes the last local acknowledgement exact and purge-lease fenced", async () => {
    const t = createTest();
    const ownerId = "owner-composio-ack-race";
    const rowId = await insertSession(t, ownerId, { updatedAt: 10 });
    const fence = await beginDeleteLease(t, ownerId);
    const [locator] = (await t.query(getBatch, { ownerId })) as Array<{
      id: typeof rowId;
      provider: string;
      sessionId: string;
      updatedAt: number;
    }>;
    await t.run(async (ctx) => ctx.db.patch(rowId, { updatedAt: 11 }));
    await expect(
      t.mutation(acknowledge, {
        ...fence,
        id: locator!.id,
        provider: locator!.provider,
        sessionId: locator!.sessionId,
        updatedAt: locator!.updatedAt,
      }),
    ).rejects.toThrow(/locator changed/u);
    await expect(
      t.run(async (ctx) => ctx.db.get(rowId)),
    ).resolves.not.toBeNull();
  });
});
