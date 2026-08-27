/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { runStorageManifestDeletes } from "./account_tts_social_purge";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;
type Mode = "reset" | "delete";
type Fence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
};

const functions = internal as unknown as {
  owner_lifecycle: {
    beginOwnerDataPurgeInternal: FunctionReference<
      "mutation",
      "internal",
      { ownerId: string; operationId: string; mode: Mode; now: number },
      {
        operationId: string;
        generation: string;
        mode: Mode;
        stage: "core" | "cloud" | "complete";
      }
    >;
    claimOwnerPurgeStageInternal: FunctionReference<
      "mutation",
      "internal",
      Omit<Fence, "leaseId"> & {
        stage: "core";
        leaseId: string;
        now: number;
      },
      { claimed: boolean; complete: boolean; mode: Mode }
    >;
  };
  account_tts_social_purge: {
    listOwnerSocialStorageManifestInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      Array<{ storageId: Id<"_storage">; deleteStorage: boolean }>
    >;
    finalizeOwnerSocialStorageInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & {
        storageId: Id<"_storage">;
        externalDeleted: boolean;
      },
      { progress: boolean }
    >;
    purgeOwnerTtsBatchInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & { mode: Mode },
      { progress: boolean; pending: string }
    >;
    purgeOwnerTtsSocialInternal: FunctionReference<
      "action",
      "internal",
      Fence,
      { ready: boolean; pending: string[] }
    >;
    purgeOwnerTtsResetInternal: FunctionReference<
      "action",
      "internal",
      Fence,
      { ready: boolean; pending: string[] }
    >;
    remainingOwnerTtsSocialInternal: FunctionReference<
      "query",
      "internal",
      { ownerId: string },
      string[]
    >;
  };
  tts_hls: {
    claimHlsSynthesis: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        nowMs: number;
      },
      null | {
        text: string;
        voice: string;
        model: string;
        speed: number | null;
        conversationId: Id<"conversations"> | null;
        expiresAt: number;
      }
    >;
    appendHlsSegment: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        seq: number;
        audio: string;
        durationSec: number;
      },
      { accepted: boolean; appended: boolean }
    >;
  };
  social: {
    messages: {
      applyMessageModerationInternal: FunctionReference<
        "mutation",
        "internal",
        {
          messageId: Id<"social_messages">;
          ownerId: string;
          ownerGeneration: string;
          originalBody: string;
          moderatedBody?: string;
          status: "clean" | "censored" | "failed";
        },
        null
      >;
    };
  };
  tts_stream: {
    readTicket: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        nowMs: number;
      },
      null | { state: string }
    >;
    failTicketAudio: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
      },
      boolean
    >;
    purgeExpired: FunctionReference<
      "mutation",
      "internal",
      { nowMs?: number; limit?: number; maxBatches?: number },
      number
    >;
  };
};

const beginCorePurge = async (
  t: TestHarness,
  ownerId: string,
  mode: Mode,
): Promise<Fence> => {
  const operationId = `${mode}-${ownerId}`;
  const begun = await t.mutation(
    functions.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode, now: 10_000 },
  );
  const leaseId = `lease-${ownerId}`;
  const claim = await t.mutation(
    functions.owner_lifecycle.claimOwnerPurgeStageInternal,
    {
      ownerId,
      operationId: begun.operationId,
      generation: begun.generation,
      stage: "core",
      leaseId,
      now: 10_001,
    },
  );
  expect(claim).toMatchObject({ claimed: true, mode });
  return {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
    leaseId,
  };
};

describe("TTS and social account purge", () => {
  it("retains the exact storage locator on delete failure and removes it after replay", async () => {
    const t = createTest();
    const ownerId = "storage-owner";
    const seeded = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        createdByOwnerId: ownerId,
        createdAt: 1,
        updatedAt: 1,
      });
      const sessionId = await ctx.db.insert("stella_sessions", {
        roomId,
        hostOwnerId: ownerId,
        hostDeviceId: "device-a",
        createdByOwnerId: ownerId,
        workspaceSlug: "private-workspace",
        workspaceFolderName: "Private workspace",
        conversationId: "private-conversation",
        status: "active",
        latestTurnOrdinal: 0,
        latestFileOpOrdinal: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const storageId = await ctx.storage.store(new Blob(["owner-private"]));
      const blobId = await ctx.db.insert("stella_session_file_blobs", {
        sessionId,
        createdByOwnerId: ownerId,
        ownerGeneration: "legacy",
        contentHash: "hash-a",
        storageId,
        sizeBytes: 13,
        contentType: "text/plain",
        createdAt: 1,
      });
      const fileId = await ctx.db.insert("stella_session_files", {
        sessionId,
        relativePath: "private.txt",
        lastActorOwnerId: ownerId,
        ownerGeneration: "legacy",
        contentHash: "hash-a",
        storageId,
        sizeBytes: 13,
        contentType: "text/plain",
        deleted: false,
        updatedAt: 1,
      });
      const opId = await ctx.db.insert("stella_session_file_ops", {
        sessionId,
        ordinal: 1,
        type: "upsert",
        relativePath: "private.txt",
        actorOwnerId: ownerId,
        actorOwnerGeneration: "legacy",
        contentHash: "hash-a",
        storageId,
        sizeBytes: 13,
        contentType: "text/plain",
        createdAt: 1,
      });
      return { storageId, blobId, fileId, opId };
    });
    const fence = await beginCorePurge(t, ownerId, "delete");
    const manifest = await t.query(
      functions.account_tts_social_purge.listOwnerSocialStorageManifestInternal,
      { ownerId },
    );
    expect(manifest).toEqual([
      { storageId: seeded.storageId, deleteStorage: true },
    ]);

    let finalized = 0;
    const failed = await runStorageManifestDeletes(
      manifest,
      async () => {
        throw new Error("simulated storage outage");
      },
      async () => {
        finalized += 1;
      },
    );
    expect(failed).toEqual(["stella_session_storage_delete"]);
    expect(finalized).toBe(0);
    const retained = await t.run(async (ctx) => ({
      blob: await ctx.db.get(seeded.blobId),
      file: await ctx.db.get(seeded.fileId),
      url: await ctx.storage.getUrl(seeded.storageId),
    }));
    expect(retained.blob?.storageId).toBe(seeded.storageId);
    expect(retained.file?.storageId).toBe(seeded.storageId);
    expect(retained.url).not.toBeNull();

    const replayPending = await runStorageManifestDeletes(
      manifest,
      async (storageId) => {
        await t.run(async (ctx) => await ctx.storage.delete(storageId));
      },
      async (entry) => {
        await t.mutation(
          functions.account_tts_social_purge.finalizeOwnerSocialStorageInternal,
          {
            ...fence,
            storageId: entry.storageId,
            externalDeleted: entry.deleteStorage,
          },
        );
      },
    );
    expect(replayPending).toEqual([]);
    const afterObjectDelete = await t.run(async (ctx) => ({
      blob: await ctx.db.get(seeded.blobId),
      file: await ctx.db.get(seeded.fileId),
      url: await ctx.storage.getUrl(seeded.storageId),
    }));
    expect(afterObjectDelete.file).toBeNull();
    expect(afterObjectDelete.url).toBeNull();
    expect(afterObjectDelete.blob?.createdByOwnerId).toBe(ownerId);

    // The blob row is the durable external-object locator. It must survive
    // until every dependent file/op locator has drained, then replay removes
    // it last. Durable confirmation makes replay idempotent even though the
    // underlying Convex storage deletion call is not.
    await t.run(async (ctx) => await ctx.db.delete(seeded.opId));
    const locatorOnlyManifest = await t.query(
      functions.account_tts_social_purge.listOwnerSocialStorageManifestInternal,
      { ownerId },
    );
    expect(locatorOnlyManifest).toEqual([
      { storageId: seeded.storageId, deleteStorage: false },
    ]);
    const locatorReplayPending = await runStorageManifestDeletes(
      locatorOnlyManifest,
      async () => {
        throw new Error("confirmed deletion must not be dispatched twice");
      },
      async (entry) => {
        await t.mutation(
          functions.account_tts_social_purge.finalizeOwnerSocialStorageInternal,
          {
            ...fence,
            storageId: entry.storageId,
            externalDeleted: entry.deleteStorage,
          },
        );
      },
    );
    expect(locatorReplayPending).toEqual([]);
    const deleted = await t.run(async (ctx) => ({
      blob: await ctx.db.get(seeded.blobId),
      url: await ctx.storage.getUrl(seeded.storageId),
    }));
    expect(deleted).toEqual({ blob: null, url: null });
  });

  it("scrubs a deleted host/member while preserving every other member's content", async () => {
    const t = createTest();
    const ownerA = "owner-a";
    const ownerB = "owner-b";
    const ids = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        title: "A private room title",
        createdByOwnerId: ownerA,
        createdAt: 1,
        updatedAt: 1,
      });
      const sessionId = await ctx.db.insert("stella_sessions", {
        roomId,
        hostOwnerId: ownerA,
        hostDeviceId: "a-device",
        createdByOwnerId: ownerA,
        workspaceSlug: "a-workspace",
        workspaceFolderName: "A workspace",
        conversationId: "a-conversation",
        status: "active",
        latestTurnOrdinal: 2,
        latestFileOpOrdinal: 2,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(roomId, { stellaSessionId: sessionId });
      const aMessageId = await ctx.db.insert("social_messages", {
        roomId,
        senderOwnerId: ownerA,
        senderOwnerGeneration: "legacy",
        kind: "text",
        body: "A private message",
        createdAt: 2,
      });
      const bMessageId = await ctx.db.insert("social_messages", {
        roomId,
        senderOwnerId: ownerB,
        senderOwnerGeneration: "legacy",
        kind: "text",
        body: "B must survive",
        createdAt: 3,
      });
      await ctx.db.insert("social_room_members", {
        roomId,
        ownerId: ownerA,
        role: "owner",
        joinedAt: 1,
        updatedAt: 1,
      });
      const bRoomMemberId = await ctx.db.insert("social_room_members", {
        roomId,
        ownerId: ownerB,
        role: "member",
        joinedAt: 2,
        lastReadMessageId: aMessageId,
        lastReadAt: 3,
        updatedAt: 3,
      });
      await ctx.db.insert("stella_session_members", {
        sessionId,
        ownerId: ownerA,
        joinedAt: 1,
        updatedAt: 1,
      });
      const bSessionMemberId = await ctx.db.insert("stella_session_members", {
        sessionId,
        ownerId: ownerB,
        joinedAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("stella_session_turns", {
        sessionId,
        ordinal: 1,
        status: "completed",
        requestedByOwnerId: ownerA,
        requesterOwnerGeneration: "legacy",
        prompt: "A private prompt",
        resultText: "A private result",
        createdAt: 2,
        updatedAt: 2,
      });
      const bTurnId = await ctx.db.insert("stella_session_turns", {
        sessionId,
        ordinal: 2,
        status: "completed",
        requestedByOwnerId: ownerB,
        requesterOwnerGeneration: "legacy",
        prompt: "B prompt",
        resultText: "B result",
        createdAt: 3,
        updatedAt: 3,
      });
      await ctx.db.insert("stella_session_file_ops", {
        sessionId,
        ordinal: 1,
        type: "mkdir",
        relativePath: "a-private",
        actorOwnerId: ownerA,
        actorOwnerGeneration: "legacy",
        createdAt: 2,
      });
      const bOpId = await ctx.db.insert("stella_session_file_ops", {
        sessionId,
        ordinal: 2,
        type: "mkdir",
        relativePath: "b-survives",
        actorOwnerId: ownerB,
        actorOwnerGeneration: "legacy",
        createdAt: 3,
      });
      await ctx.db.insert("stella_session_files", {
        sessionId,
        relativePath: "a-private",
        lastActorOwnerId: ownerA,
        ownerGeneration: "legacy",
        deleted: false,
        updatedAt: 2,
      });
      const bFileId = await ctx.db.insert("stella_session_files", {
        sessionId,
        relativePath: "b-survives",
        lastActorOwnerId: ownerB,
        ownerGeneration: "legacy",
        deleted: false,
        updatedAt: 3,
      });
      await ctx.db.insert("social_profiles", {
        ownerId: ownerA,
        username: "owner-a",
        createdAt: 1,
        updatedAt: 1,
      });
      return {
        roomId,
        sessionId,
        bMessageId,
        bRoomMemberId,
        bSessionMemberId,
        bTurnId,
        bOpId,
        bFileId,
      };
    });
    const fence = await beginCorePurge(t, ownerA, "delete");

    let result = { ready: false, pending: [] as string[] };
    for (let replay = 0; replay < 4 && !result.ready; replay += 1) {
      result = await t.action(
        functions.account_tts_social_purge.purgeOwnerTtsSocialInternal,
        fence,
      );
    }
    expect(result).toEqual({ ready: true, pending: [] });
    await expect(
      t.query(
        functions.account_tts_social_purge.remainingOwnerTtsSocialInternal,
        { ownerId: ownerA },
      ),
    ).resolves.toEqual([]);

    const preserved = await t.run(async (ctx) => ({
      room: await ctx.db.get(ids.roomId),
      session: await ctx.db.get(ids.sessionId),
      bMessage: await ctx.db.get(ids.bMessageId),
      bRoomMember: await ctx.db.get(ids.bRoomMemberId),
      bSessionMember: await ctx.db.get(ids.bSessionMemberId),
      bTurn: await ctx.db.get(ids.bTurnId),
      bOp: await ctx.db.get(ids.bOpId),
      bFile: await ctx.db.get(ids.bFileId),
    }));
    expect(preserved.bMessage?.body).toBe("B must survive");
    expect(preserved.bTurn).toMatchObject({
      requestedByOwnerId: ownerB,
      prompt: "B prompt",
      resultText: "B result",
    });
    expect(preserved.bOp).toMatchObject({
      actorOwnerId: ownerB,
      relativePath: "b-survives",
    });
    expect(preserved.bFile).toMatchObject({
      lastActorOwnerId: ownerB,
      relativePath: "b-survives",
    });
    expect(preserved.bSessionMember?.ownerId).toBe(ownerB);
    expect(preserved.bRoomMember).toMatchObject({
      ownerId: ownerB,
      role: "owner",
    });
    expect(preserved.bRoomMember?.lastReadMessageId).toBeUndefined();
    expect(preserved.session).toMatchObject({
      status: "ended",
      hostDeviceId: "",
      workspaceSlug: "deleted-account",
      conversationId: "",
    });
    expect(preserved.session?.hostOwnerId).toBeUndefined();
    expect(preserved.session?.createdByOwnerId).toBeUndefined();
    expect(preserved.room?.stellaSessionId).toBeUndefined();
    expect(preserved.room?.createdByOwnerId).toBeUndefined();
    expect(preserved.room?.title).toBeUndefined();
  });

  it("rejects a delayed HLS append after the lifecycle fence", async () => {
    const t = createTest();
    const ownerId = "hls-race-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "race-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "private speech",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        hlsStatus: "synthesizing",
        hlsAttemptId: "attempt-before-delete",
        hlsLeaseExpiresAt: Date.now() + 60_000,
        synthesisTransport: "hls",
        hlsSegments: [],
        hlsDone: false,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      });
    });
    const fence = await beginCorePurge(t, ownerId, "delete");
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "race-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-before-delete",
        seq: 0,
        audio: "cHJpdmF0ZQ==",
        durationSec: 1,
      }),
    ).rejects.toThrow(/account is being deleted/u);
    const segments = await t.run(async (ctx) =>
      ctx.db.query("tts_hls_segments").take(1),
    );
    expect(segments).toEqual([]);

    const purged = await t.action(
      functions.account_tts_social_purge.purgeOwnerTtsSocialInternal,
      fence,
    );
    expect(purged).toEqual({ ready: true, pending: [] });
  });

  it("rejects a delayed social moderation write after the lifecycle fence", async () => {
    const t = createTest();
    const ownerId = "social-race-owner";
    const messageId = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        createdByOwnerId: ownerId,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("social_messages", {
        roomId,
        senderOwnerId: ownerId,
        senderOwnerGeneration: "legacy",
        kind: "text",
        body: "private pending text",
        moderationStatus: "pending",
        createdAt: 1,
      });
    });
    await beginCorePurge(t, ownerId, "delete");

    await expect(
      t.mutation(functions.social.messages.applyMessageModerationInternal, {
        messageId,
        ownerId,
        ownerGeneration: "legacy",
        originalBody: "private pending text",
        moderatedBody: "late callback",
        status: "censored",
      }),
    ).rejects.toThrow(/account is being deleted/u);
    const message = await t.run(async (ctx) => await ctx.db.get(messageId));
    expect(message).toMatchObject({
      body: "private pending text",
      moderationStatus: "pending",
    });
  });

  it("uses a ticket-specific eight-row purge bound", async () => {
    const t = createTest();
    const ownerId = "large-ticket-owner";
    await t.run(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("tts_stream_tickets", {
          ticket: `large-${index}`,
          ownerId,
          ownerGeneration: "legacy",
          text: "x",
          voice: "Brooke",
          model: "inworld-tts-2-flash",
          audio: "YQ==",
          createdAt: index,
          expiresAt: 100_000,
        });
      }
    });
    const fence = await beginCorePurge(t, ownerId, "delete");
    await t.mutation(
      functions.account_tts_social_purge.purgeOwnerTtsBatchInternal,
      { ...fence, mode: "delete" },
    );
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(20),
    );
    expect(remaining).toHaveLength(2);
  });

  it("recovers an expired HLS claim and fences every callback from the old attempt", async () => {
    const t = createTest();
    const ownerId = "hls-recovery-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "recover me",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        hlsStatus: "pending",
        hlsSegments: [],
        hlsDone: false,
        createdAt: now,
        expiresAt: now + 15 * 60_000,
      });
    });
    const first = await t.mutation(functions.tts_hls.claimHlsSynthesis, {
      ticket: "recovery-ticket",
      ownerId,
      ownerGeneration: "legacy",
      attemptId: "attempt-one",
      nowMs: now,
    });
    expect(first).not.toBeNull();
    await expect(
      t.mutation(functions.tts_hls.claimHlsSynthesis, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-two",
        nowMs: now + 1,
      }),
    ).resolves.toBeNull();

    const recovered = await t.mutation(functions.tts_hls.claimHlsSynthesis, {
      ticket: "recovery-ticket",
      ownerId,
      ownerGeneration: "legacy",
      attemptId: "attempt-two",
      nowMs: now + 9 * 60_000,
    });
    expect(recovered).not.toBeNull();
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-one",
        seq: 0,
        audio: "b2xk",
        durationSec: 1,
      }),
    ).resolves.toEqual({ accepted: false, appended: false });
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-two",
        seq: 0,
        audio: "bmV3",
        durationSec: 1,
      }),
    ).resolves.toEqual({ accepted: true, appended: true });
  });

  it("sweeps large HLS children before parents and keeps per-table read bounds", async () => {
    const t = createTest();
    const expiredAt = Date.now() - 1;
    await t.run(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("tts_stream_tickets", {
          ticket: `expired-${index}`,
          ownerId: "expiry-owner",
          ownerGeneration: "legacy",
          text: "expired",
          voice: "Brooke",
          model: "inworld-tts-2-flash",
          createdAt: index,
          expiresAt: expiredAt,
        });
      }
      for (let index = 0; index < 49; index += 1) {
        await ctx.db.insert("tts_hls_segments", {
          ticket: `expired-${index % 10}`,
          ownerId: "expiry-owner",
          ownerGeneration: "legacy",
          seq: index,
          audio: "YQ==",
          durationSec: 1,
          createdAt: index,
          expiresAt: expiredAt,
        });
      }
    });

    await t.mutation(functions.tts_stream.purgeExpired, {
      nowMs: Date.now(),
      maxBatches: 1,
    });
    let counts = await t.run(async (ctx) => ({
      segments: (await ctx.db.query("tts_hls_segments").take(100)).length,
      tickets: (await ctx.db.query("tts_stream_tickets").take(100)).length,
    }));
    expect(counts).toEqual({ segments: 1, tickets: 10 });

    await t.mutation(functions.tts_stream.purgeExpired, {
      nowMs: Date.now(),
      maxBatches: 1,
    });
    counts = await t.run(async (ctx) => ({
      segments: (await ctx.db.query("tts_hls_segments").take(100)).length,
      tickets: (await ctx.db.query("tts_stream_tickets").take(100)).length,
    }));
    expect(counts).toEqual({ segments: 0, tickets: 2 });
  });

  it("makes a failed buffered claim terminal instead of spending again", async () => {
    const t = createTest();
    const ownerId = "buffer-failure-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        text: "do not retry",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        bufferStatus: "synthesizing",
        bufferAttemptId: "failed-attempt",
        bufferLeaseExpiresAt: now + 60_000,
        synthesisTransport: "buffered",
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    await expect(
      t.mutation(functions.tts_stream.failTicketAudio, {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "failed-attempt",
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(functions.tts_stream.readTicket, {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "retry-attempt",
        nowMs: now + 1,
      }),
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("reset purges transient TTS rows while preserving spend audit and social product state", async () => {
    const t = createTest();
    const ownerId = "reset-tts-owner";
    const profileId = await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "reset-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "reset me",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        createdAt: 1,
        expiresAt: 100_000,
      });
      await ctx.db.insert("internal_tts_usage", {
        ownerId,
        ownerGeneration: "legacy",
        provider: "inworld",
        model: "inworld-tts-2-flash",
        voice: "Brooke",
        streaming: false,
        status: "completed",
        requestChars: 8,
        synthesizedChars: 8,
        audioBytes: 10,
        textInputTokens: 2,
        audioOutputTokens: 1,
        costMicroCents: 1,
        durationMs: 1,
        createdAt: 1,
      });
      return await ctx.db.insert("social_profiles", {
        ownerId,
        username: "reset-owner",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const fence = await beginCorePurge(t, ownerId, "reset");
    const result = await t.action(
      functions.account_tts_social_purge.purgeOwnerTtsResetInternal,
      fence,
    );
    expect(result).toEqual({ ready: true, pending: [] });
    const snapshot = await t.run(async (ctx) => ({
      tickets: await ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(1),
      usage: await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(1),
      profile: await ctx.db.get(profileId),
    }));
    expect(snapshot.tickets).toEqual([]);
    expect(snapshot.usage).toHaveLength(1);
    expect(snapshot.profile?.ownerId).toBe(ownerId);
  });
});
