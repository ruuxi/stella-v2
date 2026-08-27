/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  REMOTE_TURN_ATTEMPT_HARD_MS,
  REMOTE_TURN_ATTEMPT_LEASE_MS,
  REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS,
} from "./channels/connector_delivery";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "https://issuer.test|connector-attempt-owner";
const OWNER_GENERATION = "legacy";
const DEVICE_ID = "desktop-attempt-device";
const BASE_NOW = 2_000_000;

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
type Harness = ReturnType<typeof createTest>;

const asOwner = (t: Harness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "connector-attempt-owner",
    tokenIdentifier: OWNER_ID,
  });

const seedRequest = async (
  t: Harness,
  overrides: Partial<{
    requestId: string;
    ownerBindingState: "bound" | "legacy_unbound";
    ownerId: string;
    ownerGeneration: string;
  }> = {},
) =>
  await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", {
      ownerId: overrides.ownerId ?? OWNER_ID,
      isDefault: false,
      eventCount: 1,
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    });
    const requestId = overrides.requestId ?? "request-a";
    const eventId = await ctx.db.insert("events", {
      conversationId,
      timestamp: BASE_NOW,
      type: "remote_turn_request",
      requestId,
      targetDeviceId: DEVICE_ID,
      ...(overrides.ownerBindingState === "legacy_unbound"
        ? { ownerBindingState: "legacy_unbound" as const }
        : {
            ownerBindingState: "bound" as const,
            ownerId: overrides.ownerId ?? OWNER_ID,
            ownerGeneration: overrides.ownerGeneration ?? OWNER_GENERATION,
          }),
      requestState: "pending",
      payload: {
        provider: "stella_app",
        deliveryMeta: {},
        text: "hello",
      },
    });
    return { conversationId, requestId, eventId };
  });

const acquire = async (
  t: Harness,
  args: {
    conversationId: Id<"conversations">;
    requestId: string;
    attemptId?: string;
    now?: number;
  },
) =>
  await t.mutation(
    internal.channels.connector_delivery.acquireRemoteTurnAttemptInternal,
    {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptId: args.attemptId ?? "attempt-a",
      source: "desktop",
      deviceId: DEVICE_ID,
      now: args.now ?? BASE_NOW,
    },
  );

const beginPurge = async (
  t: Harness,
  mode: "reset" | "delete",
  operationId: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId: OWNER_ID, operationId, mode, now: BASE_NOW + 100 },
  );
  const leaseId = `lease-${operationId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId: OWNER_ID,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId,
    now: BASE_NOW + 101,
  });
  return {
    ownerId: OWNER_ID,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
    mode,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("remote-turn exact attempt leases", () => {
  it("binds admission to the immutable owner generation and fixed hard deadline", async () => {
    const t = createTest();
    const request = await seedRequest(t);
    const first = await acquire(t, request);
    expect(first).toEqual({
      acquired: true,
      status: "reserved",
      attemptId: "attempt-a",
      leaseExpiresAt: BASE_NOW + REMOTE_TURN_ATTEMPT_LEASE_MS,
      hardExpiresAt: BASE_NOW + REMOTE_TURN_ATTEMPT_HARD_MS,
      quiescentAfterAt:
        BASE_NOW +
        REMOTE_TURN_ATTEMPT_LEASE_MS +
        REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS,
    });
    await expect(acquire(t, request)).resolves.toEqual(first);
    await expect(
      acquire(t, { ...request, attemptId: "attempt-b" }),
    ).resolves.toMatchObject({ acquired: false, status: "busy" });

    const heartbeat = await t.mutation(
      internal.channels.connector_delivery.heartbeatRemoteTurnAttemptInternal,
      {
        requestId: request.requestId,
        conversationId: request.conversationId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptId: "attempt-a",
        source: "desktop",
        deviceId: DEVICE_ID,
        now: BASE_NOW + 20_000,
      },
    );
    expect(heartbeat).toMatchObject({
      allowed: true,
      hardExpiresAt: first.hardExpiresAt,
      leaseExpiresAt: BASE_NOW + 20_000 + REMOTE_TURN_ATTEMPT_LEASE_MS,
    });

    await expect(
      t.mutation(
        internal.channels.connector_delivery.acquireRemoteTurnAttemptInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: "reopened-generation",
          attemptId: "wrong-generation",
          source: "desktop",
          deviceId: DEVICE_ID,
          now: BASE_NOW + 1,
        },
      ),
    ).resolves.toMatchObject({ acquired: false, status: "cancelled" });
  });

  it("retains cancellation debt through the admitted provider bound and rejects late writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW + 1_000);
    const t = createTest();
    const request = await seedRequest(t, { requestId: "cancel-race" });
    await acquire(t, request);
    const provider = await t.mutation(
      internal.channels.connector_delivery
        .beginRemoteTurnProviderDispatchInternal,
      {
        requestId: request.requestId,
        conversationId: request.conversationId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptId: "attempt-a",
        source: "desktop",
        deviceId: DEVICE_ID,
        providerDispatchId: "provider-a",
        now: BASE_NOW + 500,
      },
    );
    expect(provider.deadlineAt).toBeGreaterThan(BASE_NOW + 500);
    const beforeCancel = await t.run(async (ctx) =>
      ctx.db.get(request.eventId),
    );
    const leaseExpiresAt = beforeCancel?.attemptLeaseExpiresAt;
    const quiescentAfterAt = beforeCancel?.attemptQuiescentAfterAt;
    if (leaseExpiresAt === undefined || quiescentAfterAt === undefined) {
      throw new Error("Attempt did not retain a quiescence deadline.");
    }

    await asOwner(t).mutation(
      api.channels.connector_delivery.cancelRemoteTurn,
      { requestId: request.requestId },
    );
    const cancelled = await t.run(async (ctx) => ctx.db.get(request.eventId));
    expect(cancelled).toMatchObject({
      requestState: "cancelled",
      requestTerminalReason: "user_cancelled",
      activeAttemptId: "attempt-a",
      activeAttemptState: "cancel_requested",
      attemptLeaseExpiresAt: leaseExpiresAt,
      attemptQuiescentAfterAt: quiescentAfterAt,
    });

    vi.setSystemTime(quiescentAfterAt - 1);
    await t.mutation(
      internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
      {
        requestId: request.requestId,
        attemptId: "attempt-a",
        quiescentAfterAt,
      },
    );
    expect(
      await t.run(async (ctx) => ctx.db.get(request.eventId)),
    ).toMatchObject({
      activeAttemptId: "attempt-a",
      requestState: "cancelled",
    });

    const exactTuple = {
      requestId: request.requestId,
      conversationId: request.conversationId,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptId: "attempt-a",
      source: "desktop" as const,
      deviceId: DEVICE_ID,
    };
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .acknowledgeRemoteTurnUsageDispositionInternal,
        {
          ...exactTuple,
          now: BASE_NOW + 1_001,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .appendRemoteTurnAssistantMessageInternal,
        {
          ...exactTuple,
          provider: "stella_app",
          text: "must not persist",
          appendAssistantEvent: true,
          now: BASE_NOW + 1_001,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        internal.channels.connector_delivery.beginRemoteTurnDeliveryInternal,
        { ...exactTuple, now: BASE_NOW + 1_001 },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.channels.connector_delivery.markRemoteTurnFulfilled, {
        ...exactTuple,
        now: BASE_NOW + 1_001,
      }),
    ).resolves.toMatchObject({ acknowledged: false });

    await t.mutation(
      internal.channels.connector_delivery.finishRemoteTurnAttemptInternal,
      { ...exactTuple, outcome: "aborted", now: BASE_NOW + 1_002 },
    );
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .settleRemoteTurnProviderDispatchInternal,
        {
          ...exactTuple,
          providerDispatchId: "provider-a",
          outcome: "outcome_unknown",
          now: BASE_NOW + 1_003,
        },
      ),
    ).resolves.toBe(false);
    expect(
      await t.run(async (ctx) => ctx.db.get(request.eventId)),
    ).toMatchObject({
      requestState: "cancelled",
      lastAttemptOutcome: "aborted",
    });
  });

  it("keeps reset/delete fenced until the exact remote attempt is quiescent", async () => {
    const t = createTest();
    const request = await seedRequest(t, { requestId: "purge-race" });
    await acquire(t, request);
    await t.mutation(
      internal.channels.connector_delivery
        .beginRemoteTurnProviderDispatchInternal,
      {
        requestId: request.requestId,
        conversationId: request.conversationId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptId: "attempt-a",
        source: "desktop",
        deviceId: DEVICE_ID,
        providerDispatchId: "provider-purge-race",
        now: BASE_NOW + 50,
      },
    );
    const admitted = await t.run(async (ctx) => ctx.db.get(request.eventId));
    const leaseExpiresAt = admitted?.attemptLeaseExpiresAt;
    const quiescentAfterAt = admitted?.attemptQuiescentAfterAt;
    expect(leaseExpiresAt).toBeTypeOf("number");
    expect(quiescentAfterAt).toBeTypeOf("number");
    const purge = await beginPurge(t, "reset", "remote-turn-purge-race");

    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: BASE_NOW + 102 },
      ),
    ).resolves.toMatchObject({
      ready: false,
      cancellationRequested: 1,
      retryAfterAt: quiescentAfterAt,
    });
    expect(
      await t.run(async (ctx) => ctx.db.get(request.eventId)),
    ).toMatchObject({
      requestState: "cancelled",
      activeAttemptId: "attempt-a",
      activeAttemptState: "cancel_requested",
      attemptLeaseExpiresAt: leaseExpiresAt,
      attemptQuiescentAfterAt: quiescentAfterAt,
    });

    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: quiescentAfterAt! - 1 },
      ),
    ).resolves.toMatchObject({ ready: false });
    expect(
      await t.run(async (ctx) => ctx.db.get(request.eventId)),
    ).toMatchObject({ activeAttemptId: "attempt-a" });

    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: quiescentAfterAt! },
      ),
    ).resolves.toMatchObject({ ready: true, quiesced: 1 });
    const quiesced = await t.run(async (ctx) => ctx.db.get(request.eventId));
    expect(quiesced).toMatchObject({
      requestState: "cancelled",
      lastAttemptId: "attempt-a",
      lastAttemptOutcome: "timed_out",
    });
    expect(quiesced?.activeAttemptId).toBeUndefined();
  });

  it("migration closes acquire and begin while legacy rows are quarantined", async () => {
    const t = createTest();
    const request = await seedRequest(t, { requestId: "migration-race" });
    await acquire(t, request);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: OWNER_ID,
        toOwnerId: "https://issuer.test|destination",
        status: "running",
        createdAt: BASE_NOW + 1,
        updatedAt: BASE_NOW + 1,
      });
    });
    const pulse = await t.mutation(
      internal.channels.connector_delivery.heartbeatRemoteTurnAttemptInternal,
      {
        requestId: request.requestId,
        conversationId: request.conversationId,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        attemptId: "attempt-a",
        source: "desktop",
        deviceId: DEVICE_ID,
        now: BASE_NOW + 2,
      },
    );
    expect(pulse).toMatchObject({ allowed: false, cancelRequested: true });
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .beginRemoteTurnProviderDispatchInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "attempt-a",
          source: "desktop",
          deviceId: DEVICE_ID,
          providerDispatchId: "blocked-provider",
          now: BASE_NOW + 3,
        },
      ),
    ).rejects.toThrow();

    const legacy = await seedRequest(t, {
      requestId: "legacy-unbound",
      ownerBindingState: "legacy_unbound",
    });
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .terminalizeLegacyRemoteTurnInternal,
        {
          eventId: legacy.eventId,
          requestId: legacy.requestId,
          now: BASE_NOW + 4,
        },
      ),
    ).resolves.toBe(true);
    expect(
      await t.run(async (ctx) => ctx.db.get(legacy.eventId)),
    ).toMatchObject({
      requestState: "cancelled",
      ownerBindingState: "legacy_unbound",
      requestTerminalReason: "legacy_unbound",
    });
  });

  it("rejects stale watchdogs and destination attempts on both sides of a live migration", async () => {
    const t = createTest();
    const destinationOwnerId = "https://issuer.test|migration-destination";
    const orphanRequest = await seedRequest(t, {
      requestId: "stale-orphan-watchdog",
    });
    const cronRequest = await seedRequest(t, {
      requestId: "stale-cron-watchdog",
    });
    const destinationRequest = await seedRequest(t, {
      requestId: "incoming-destination-attempt",
      ownerId: destinationOwnerId,
      ownerGeneration: OWNER_GENERATION,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: OWNER_ID,
        toOwnerId: destinationOwnerId,
        status: "running",
        createdAt: BASE_NOW + 1,
        updatedAt: BASE_NOW + 1,
      });
    });

    for (const [request, source] of [
      [orphanRequest, "orphan_watchdog"],
      [cronRequest, "cron_watchdog"],
    ] as const) {
      await expect(
        t.mutation(
          internal.channels.connector_delivery.acquireRemoteTurnAttemptInternal,
          {
            requestId: request.requestId,
            conversationId: request.conversationId,
            ownerId: OWNER_ID,
            ownerGeneration: OWNER_GENERATION,
            attemptId: `stale-${source}`,
            source,
            now: BASE_NOW + 2,
          },
        ),
      ).resolves.toMatchObject({ acquired: false, status: "cancelled" });
    }

    await expect(
      t.mutation(
        internal.channels.connector_delivery.acquireRemoteTurnAttemptInternal,
        {
          requestId: destinationRequest.requestId,
          conversationId: destinationRequest.conversationId,
          ownerId: destinationOwnerId,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "incoming-destination",
          source: "desktop",
          deviceId: DEVICE_ID,
          now: BASE_NOW + 2,
        },
      ),
    ).resolves.toMatchObject({ acquired: false, status: "cancelled" });

    const rows = await t.run(
      async (ctx) =>
        await Promise.all([
          ctx.db.get(orphanRequest.eventId),
          ctx.db.get(cronRequest.eventId),
          ctx.db.get(destinationRequest.eventId),
        ]),
    );
    expect(rows[0]).toMatchObject({
      requestState: "cancelled",
      requestTerminalReason: "ownership_migrated",
    });
    expect(rows[1]).toMatchObject({
      requestState: "cancelled",
      requestTerminalReason: "ownership_migrated",
    });
    expect(rows[2]).toMatchObject({
      requestState: "cancelled",
      requestTerminalReason: "owner_data_changed",
    });
    for (const row of rows) expect(row?.activeAttemptId).toBeUndefined();
  });

  it.each(["reset", "delete"] as const)(
    "keeps %s conversation deletion fail-closed through the exact attempt grace",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(BASE_NOW);
      const t = createTest();
      const request = await seedRequest(t, {
        requestId: `${mode}-conversation-drain-race`,
      });
      await acquire(t, request);
      await t.mutation(
        internal.channels.connector_delivery
          .beginRemoteTurnProviderDispatchInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "attempt-a",
          source: "desktop",
          deviceId: DEVICE_ID,
          providerDispatchId: `${mode}-provider-dispatch`,
          now: BASE_NOW + 50,
        },
      );
      const admitted = await t.run(async (ctx) => ctx.db.get(request.eventId));
      const quiescentAfterAt = admitted?.attemptQuiescentAfterAt;
      if (quiescentAfterAt === undefined) {
        throw new Error("Attempt did not retain a quiescence deadline.");
      }
      const purge = await beginPurge(
        t,
        mode,
        `${mode}-conversation-drain-purge`,
      );
      const cancellation = await t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: BASE_NOW + 102 },
      );
      expect(cancellation).toMatchObject({
        ready: false,
        cancellationRequested: 1,
        retryAfterAt: quiescentAfterAt,
      });
      expect(
        await t.run(async (ctx) => ctx.db.get(request.eventId)),
      ).toMatchObject({
        activeAttemptId: "attempt-a",
        activeAttemptState: "cancel_requested",
        attemptQuiescentAfterAt: quiescentAfterAt,
      });
      const deleteArgs = {
        ownerId: purge.ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        conversationId: request.conversationId,
      };

      await expect(
        t.mutation(internal.reset._deleteConversationBatch, deleteArgs),
      ).rejects.toThrow(/must be quiescent/u);
      await expect(
        t.mutation(
          internal.channels.connector_delivery
            .quiesceOwnerRemoteTurnsForPurgeInternal,
          { ...purge, now: quiescentAfterAt - 1 },
        ),
      ).resolves.toMatchObject({ ready: false });
      await expect(
        t.mutation(internal.reset._deleteConversationBatch, deleteArgs),
      ).rejects.toThrow(/must be quiescent/u);

      await expect(
        t.mutation(
          internal.channels.connector_delivery
            .quiesceOwnerRemoteTurnsForPurgeInternal,
          { ...purge, now: quiescentAfterAt },
        ),
      ).resolves.toMatchObject({ ready: true, quiesced: 1 });
      for (let pass = 0; pass < 8; pass += 1) {
        const result = await t.mutation(
          internal.reset._deleteConversationBatch,
          deleteArgs,
        );
        if (!result.hasMore) break;
      }
      expect(
        await t.run(async (ctx) => ctx.db.get(request.conversationId)),
      ).toBeNull();
    },
  );

  it.each(["reset", "delete"] as const)(
    "discovers and quiesces an ownerless legacy transport during %s",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(BASE_NOW);
      const t = createTest();
      const request = await seedRequest(t, {
        requestId: `${mode}-ownerless-legacy-transport`,
        ownerBindingState: "legacy_unbound",
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(request.eventId, {
          requestState: "claimed",
          claimedAt: BASE_NOW,
          activeAttemptId: "legacy-active-attempt",
          activeAttemptSource: "desktop",
          activeAttemptDeviceId: DEVICE_ID,
          activeAttemptState: "active",
          activeAttemptPhase: "running",
          attemptStartedAt: BASE_NOW,
          // Malformed legacy bounds must be normalized upward from immutable
          // attempt time; purge discovery cannot clear on these early values.
          attemptLeaseExpiresAt: BASE_NOW + 200,
          attemptHardExpiresAt: BASE_NOW + 100,
          attemptQuiescentAfterAt: BASE_NOW + 150,
          lastProviderDispatchId: "legacy-provider-dispatch",
          lastProviderDispatchOutcome: "in_flight",
          lastProviderDispatchAt: BASE_NOW + 50,
        });
      });
      const purge = await beginPurge(t, mode, `${mode}-ownerless-legacy-purge`);
      const deleteArgs = {
        ownerId: purge.ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        conversationId: request.conversationId,
      };

      // This row has no ownerId, so only the conversation-scoped index can
      // keep its authority/event row alive before the bounded scan reaches it.
      await expect(
        t.mutation(internal.reset._deleteConversationBatch, deleteArgs),
      ).rejects.toThrow(/must be quiescent/u);

      const first = await t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: BASE_NOW + 102 },
      );
      expect(first).toMatchObject({
        ready: false,
        cancellationRequested: 1,
        processed: 1,
      });
      const cancelled = await t.run(async (ctx) => ctx.db.get(request.eventId));
      expect(cancelled).toMatchObject({
        ownerBindingState: "legacy_unbound",
        requestState: "cancelled",
        requestTerminalReason: "legacy_unbound",
        activeAttemptId: "legacy-active-attempt",
        activeAttemptState: "cancel_requested",
        attemptLeaseExpiresAt: BASE_NOW + 200,
        attemptHardExpiresAt: BASE_NOW + REMOTE_TURN_ATTEMPT_HARD_MS,
        attemptQuiescentAfterAt:
          BASE_NOW +
          REMOTE_TURN_ATTEMPT_HARD_MS +
          REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS,
      });
      expect(cancelled?.ownerId).toBeUndefined();
      const quiescentAfterAt = cancelled!.attemptQuiescentAfterAt!;

      const repeated = await t.mutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...purge, now: BASE_NOW + 1_000 },
      );
      expect(repeated).toMatchObject({
        ready: false,
        retryAfterAt: quiescentAfterAt,
      });
      expect(
        await t.run(async (ctx) => ctx.db.get(request.eventId)),
      ).toMatchObject({
        attemptLeaseExpiresAt: cancelled!.attemptLeaseExpiresAt,
        attemptHardExpiresAt: cancelled!.attemptHardExpiresAt,
        attemptQuiescentAfterAt: quiescentAfterAt,
      });
      await expect(
        t.mutation(internal.reset._deleteConversationBatch, deleteArgs),
      ).rejects.toThrow(/must be quiescent/u);

      await expect(
        t.mutation(
          internal.channels.connector_delivery
            .quiesceOwnerRemoteTurnsForPurgeInternal,
          { ...purge, now: quiescentAfterAt },
        ),
      ).resolves.toMatchObject({ ready: false, quiesced: 1 });
      await expect(
        t.mutation(
          internal.channels.connector_delivery
            .quiesceOwnerRemoteTurnsForPurgeInternal,
          { ...purge, now: quiescentAfterAt + 1 },
        ),
      ).resolves.toMatchObject({ ready: true });
      expect(
        await t.run(async (ctx) => ctx.db.get(request.eventId)),
      ).toMatchObject({
        ownerBindingState: "legacy_unbound",
        requestState: "cancelled",
        lastAttemptId: "legacy-active-attempt",
        lastAttemptOutcome: "timed_out",
      });
      for (let pass = 0; pass < 8; pass += 1) {
        const result = await t.mutation(
          internal.reset._deleteConversationBatch,
          deleteArgs,
        );
        if (!result.hasMore) break;
      }
      expect(
        await t.run(async (ctx) => ctx.db.get(request.conversationId)),
      ).toBeNull();
    },
  );

  it("keeps late claimed completion receipts inside the orphan recovery horizon", async () => {
    const t = createTest();
    const request = await seedRequest(t, { requestId: "late-completion" });
    await t.run(async (ctx) => {
      await ctx.db.patch(request.eventId, {
        requestState: "claimed",
        claimedAt: BASE_NOW + 5 * 60_000,
        completionAttemptId: "late-attempt",
        completionText: "durable exact reply",
        completionAcceptedAt: BASE_NOW + 13 * 60_000,
      });
    });
    const orphans = await t.query(
      internal.channels.connector_delivery.findOrphanedTurnRequests,
      { nowMs: BASE_NOW + 15 * 60_000 },
    );
    expect(orphans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: request.requestId,
          claimed: true,
          completionText: "durable exact reply",
        }),
      ]),
    );
  });

  it("keeps a crash after exact assistant persistence delivery-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
    const t = createTest();
    const request = await seedRequest(t, { requestId: "append-crash" });
    const receipt = await acquire(t, request);
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .appendRemoteTurnAssistantMessageInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "attempt-a",
          source: "desktop",
          deviceId: DEVICE_ID,
          provider: "stella_app",
          text: "persisted before crash",
          appendAssistantEvent: true,
          now: BASE_NOW + 1,
        },
      ),
    ).resolves.toBe(true);

    vi.setSystemTime(receipt.quiescentAfterAt);
    await t.mutation(
      internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
      {
        requestId: request.requestId,
        attemptId: "attempt-a",
        quiescentAfterAt: receipt.quiescentAfterAt,
      },
    );
    expect(
      await t.run(async (ctx) => ctx.db.get(request.eventId)),
    ).toMatchObject({
      requestState: "claimed",
      completionText: "persisted before crash",
      lastAttemptOutcome: "timed_out",
    });
    const orphans = await t.query(
      internal.channels.connector_delivery.findOrphanedTurnRequests,
      { nowMs: receipt.quiescentAfterAt + 1 },
    );
    expect(orphans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: request.requestId,
          claimed: true,
          completionText: "persisted before crash",
        }),
      ]),
    );
  });

  it("stores an exact completion receipt for a silent response without an assistant event", async () => {
    const t = createTest();
    const request = await seedRequest(t, { requestId: "silent-completion" });
    await acquire(t, request);

    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .appendRemoteTurnAssistantMessageInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "attempt-a",
          source: "desktop",
          deviceId: DEVICE_ID,
          provider: "stella_app",
          text: "(Stella had nothing to say.)",
          appendAssistantEvent: false,
          now: BASE_NOW + 1,
        },
      ),
    ).resolves.toBe(true);

    const state = await t.run(async (ctx) => {
      const requestRow = await ctx.db.get(request.eventId);
      const assistantEvents = await ctx.db
        .query("events")
        .withIndex("by_conversationId_and_timestamp", (q) =>
          q.eq("conversationId", request.conversationId),
        )
        .filter((q) => q.eq(q.field("type"), "assistant_message"))
        .collect();
      return { requestRow, assistantEvents };
    });
    expect(state.requestRow).toMatchObject({
      requestState: "claimed",
      activeAttemptPhase: "completion_accepted",
      completionAttemptId: "attempt-a",
      completionText: "(Stella had nothing to say.)",
    });
    expect(state.assistantEvents).toEqual([]);
  });

  it.each(["succeeded", "outcome_unknown"] as const)(
    "keeps a crashed %s provider dispatch delivery-only instead of replaying spend",
    async (providerOutcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(BASE_NOW);
      const t = createTest();
      const request = await seedRequest(t, {
        requestId: `provider-crash-${providerOutcome}`,
      });
      await acquire(t, request);
      await t.mutation(
        internal.channels.connector_delivery
          .beginRemoteTurnProviderDispatchInternal,
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          attemptId: "attempt-a",
          source: "desktop",
          deviceId: DEVICE_ID,
          providerDispatchId: "provider-a",
          now: BASE_NOW + 1,
        },
      );
      await expect(
        t.mutation(
          internal.channels.connector_delivery
            .settleRemoteTurnProviderDispatchInternal,
          {
            requestId: request.requestId,
            conversationId: request.conversationId,
            ownerId: OWNER_ID,
            ownerGeneration: OWNER_GENERATION,
            attemptId: "attempt-a",
            source: "desktop",
            deviceId: DEVICE_ID,
            providerDispatchId: "provider-a",
            outcome: providerOutcome,
            now: BASE_NOW + 2,
          },
        ),
      ).resolves.toBe(true);
      const beforeExpiry = await t.run(async (ctx) =>
        ctx.db.get(request.eventId),
      );
      const quiescentAfterAt = beforeExpiry?.attemptQuiescentAfterAt;
      if (quiescentAfterAt === undefined) throw new Error("Missing quiescence");
      vi.setSystemTime(quiescentAfterAt);
      await t.mutation(
        internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
        {
          requestId: request.requestId,
          attemptId: "attempt-a",
          quiescentAfterAt,
        },
      );
      expect(
        await t.run(async (ctx) => ctx.db.get(request.eventId)),
      ).toMatchObject({
        requestState: "claimed",
        lastProviderDispatchOutcome: providerOutcome,
        lastAttemptOutcome: "timed_out",
      });
      await expect(
        t.query(internal.channels.connector_delivery.findOrphanedTurnRequests, {
          nowMs: quiescentAfterAt + 1,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: request.requestId,
            claimed: true,
          }),
        ]),
      );
    },
  );
});
