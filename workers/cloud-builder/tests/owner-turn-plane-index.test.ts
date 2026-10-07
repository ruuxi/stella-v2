import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import { DispatchError } from "../src/owner-store/registry.js";
import {
  completeConversationEdit,
  createOwnerStoreHarness,
  OWNER_ID,
  type OwnerStoreHarness,
} from "./helpers/owner-store-harness.js";

const GEN = "generation-1";
const CONV = "6f0e2a7c-1b3d-4c5e-8f9a-0b1c2d3e4f5a";
const execution = { engine: "stella", provider: "stella", model: "stella/default", reasoningEffort: "default" } as const;

const base = (kind: OwnerEvent["kind"], key: string) => ({
  v: 1 as const,
  kind,
  key,
  ownerId: OWNER_ID,
  ownerGeneration: GEN,
  emittedAt: 1,
});

const created = (conversationId = CONV, createdAt = 1_000): OwnerEvent => ({
  ...base("conversation.created", conversationId),
  kind: "conversation.created",
  conversationId,
  createdAt,
  title: "Plan the trip",
});

const indexEvent = (fields: { epoch: number; lastSeq: number; updatedAt: number; lastPreview?: string; force?: boolean }): OwnerEvent => ({
  ...base("conversation.index", `${CONV}:${fields.epoch}:${fields.lastSeq}`),
  kind: "conversation.index",
  conversationId: CONV,
  activity: "idle",
  ...fields,
});

let h: OwnerStoreHarness;
beforeEach(() => {
  h = createOwnerStoreHarness();
});
afterEach(() => h.close());

describe("conversations", () => {
  test("create is idempotent by client id and shows up in the recent view", async () => {
    const recent = await h.watch("conversations.recent", {});
    expect(recent()).toEqual([]);
    const first = await h.call("conversations.create", { clientCreateId: "client-create-1", title: "Hello" });
    const again = await h.call("conversations.create", { clientCreateId: "client-create-1", title: "Other" });
    expect(again).toEqual(first);
    expect(recent()).toEqual([first]);
    expect(await h.call("conversations.bootstrap", { clientCreateId: "client-create-1" })).toEqual({
      ownerId: OWNER_ID,
      ownerGeneration: GEN,
      conversationId: first.conversationId,
    });
    expect(await h.call("conversations.bootstrap", { clientCreateId: "client-create-2" })).toMatchObject({
      conversationId: null,
    });
  });

  test("refuses a non-Stella engine without a connected credential", async () => {
    const error = await h.callError("conversations.create", {
      clientCreateId: "client-create-3",
      execution: { engine: "anthropic", provider: "anthropic", model: "claude", reasoningEffort: "default" },
    });
    expect(error.code).toBe("CONFLICT");
  });

  test("index events are fenced on epoch and sequence; deletion hides the row for good", async () => {
    const get = await h.watch("conversations.get", { conversationId: CONV });
    await h.ownerEvents([created()]);
    expect(get()).toMatchObject({ conversationId: CONV, title: "Plan the trip", updatedAt: 1_000 });

    await h.ownerEvents([indexEvent({ epoch: 1, lastSeq: 5, updatedAt: 2_000, lastPreview: "five" })]);
    expect(get()).toMatchObject({ lastPreview: "five", updatedAt: 2_000, activity: "idle" });
    // Older sequence and older epoch are dropped.
    await h.ownerEvents([indexEvent({ epoch: 1, lastSeq: 4, updatedAt: 3_000, lastPreview: "four" })]);
    await h.ownerEvents([indexEvent({ epoch: 0, lastSeq: 9, updatedAt: 3_000, lastPreview: "old epoch" })]);
    expect(get()).toMatchObject({ lastPreview: "five", updatedAt: 2_000 });
    // A rewind's new epoch wins even at a lower sequence.
    await h.ownerEvents([indexEvent({ epoch: 2, lastSeq: 1, updatedAt: 4_000, lastPreview: "rewound" })]);
    expect(get()).toMatchObject({ lastPreview: "rewound", updatedAt: 4_000 });

    await h.ownerEvents([{ ...base("conversation.deleted", CONV), kind: "conversation.deleted", conversationId: CONV, deletedAt: 5_000 }]);
    expect(get()).toBeNull();
    await h.ownerEvents([indexEvent({ epoch: 3, lastSeq: 7, updatedAt: 6_000, lastPreview: "late" })]);
    expect(get()).toBeNull();
    expect((await h.call("conversations.page", {})).conversations).toEqual([]);
  });

  test("pages through history newest first", async () => {
    for (let index = 0; index < 5; index++) {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      await h.ownerEvents([created(id, 1_000 + index)]);
    }
    const first = await h.call("conversations.page", { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.conversations.map((row: any) => row.createdAt)).toEqual([1_004, 1_003]);
    const last = first.conversations.at(-1);
    const second = await h.call("conversations.page", {
      limit: 3,
      before: { updatedAt: last.updatedAt, conversationId: last.conversationId },
    });
    expect(second.conversations.map((row: any) => row.createdAt)).toEqual([1_002, 1_001, 1_000]);
    expect(second.hasMore).toBe(false);
  });
});

describe("fork and rewind", () => {
  const forkArgs = { sourceConversationId: CONV, throughSeq: 3, expectedEpoch: 1, expectedLastSeq: 5, requestId: "fork-request-1" };
  const rewindArgs = { conversationId: CONV, throughSeq: 3, expectedEpoch: 1, expectedLastSeq: 5, requestId: "rewind-request-1", activeTurnPolicy: "conflict" };

  beforeEach(async () => {
    await h.ownerEvents([created(), indexEvent({ epoch: 1, lastSeq: 5, updatedAt: 2_000, lastPreview: "five" })]);
  });

  test("fork publishes a new conversation and replays by request id", async () => {
    const recent = await h.watch("conversations.recent", {});
    const fork = await h.call("conversations.fork", forkArgs);
    expect(fork).toMatchObject({ sourceEpoch: 1, throughSeq: 3, targetEpoch: 1, lastSeq: 3, replayed: false });
    expect(fork.conversationId).not.toBe(CONV);
    expect(h.host.edits).toEqual([
      expect.objectContaining({
        kind: "fork",
        ownerId: OWNER_ID,
        ownerGeneration: GEN,
        sourceConversationId: CONV,
        targetConversationId: fork.conversationId,
        title: "Plan the trip",
        sourceCreatedAt: 1_000,
      }),
    ]);
    expect(recent().map((row: any) => row.conversationId)).toEqual([fork.conversationId, CONV]);
    expect(recent()[0]).toMatchObject({ title: "Plan the trip", lastPreview: "kept", activity: "idle" });

    expect(await h.call("conversations.fork", forkArgs)).toEqual({ ...fork, replayed: true });
    expect(h.host.edits).toHaveLength(1);
    expect(await h.callError("conversations.fork", { ...forkArgs, throughSeq: 2 })).toMatchObject({ code: "CONFLICT" });
  });

  test("an unfinished fork resumes the same target on retry", async () => {
    h.editResponder = (request) => {
      if (request.kind !== "fork") throw new Error("expected a fork");
      return { complete: false, kind: "fork", operationId: request.operationId, sourceConversationId: CONV, targetConversationId: request.targetConversationId, sourceEpoch: 1, throughSeq: 3, targetEpoch: 1, lastSeq: 1, pendingAtSeq: 2 };
    };
    expect(await h.callError("conversations.fork", forkArgs)).toMatchObject({ code: "UNAVAILABLE" });
    const target = h.host.edits[0]!.kind === "fork" ? h.host.edits[0]!.targetConversationId : "";
    expect(new Set(h.host.edits.map((edit) => edit.kind === "fork" && edit.targetConversationId))).toEqual(new Set([target]));

    h.editResponder = completeConversationEdit;
    expect(await h.call("conversations.fork", forkArgs)).toMatchObject({ conversationId: target, replayed: false });
  });

  test("rewind advances the epoch and a late flush from the cut suffix can't undo it", async () => {
    const get = await h.watch("conversations.get", { conversationId: CONV });
    const rewind = await h.call("conversations.rewind", rewindArgs);
    expect(rewind).toEqual({ conversationId: CONV, previousEpoch: 1, nextEpoch: 2, lastSeq: 3, replayed: false });
    expect(h.host.edits).toEqual([expect.objectContaining({ kind: "rewind", conversationId: CONV, activeTurnPolicy: "conflict" })]);
    expect(get()).toMatchObject({ lastPreview: "kept", lastRole: "user", activity: "idle" });

    await h.ownerEvents([indexEvent({ epoch: 1, lastSeq: 6, updatedAt: 9_000, lastPreview: "cut" })]);
    expect(get()).toMatchObject({ lastPreview: "kept" });
    expect(await h.call("conversations.rewind", rewindArgs)).toEqual({ ...rewind, replayed: true });
  });

  test("edits refuse missing conversations, bad boundaries and a stale generation", async () => {
    expect(await h.callError("conversations.rewind", { ...rewindArgs, conversationId: "00000000-0000-4000-8000-000000000009" })).toMatchObject({ code: "NOT_FOUND" });
    expect(await h.callError("conversations.fork", { ...forkArgs, throughSeq: 6 })).toMatchObject({ code: "BAD_REQUEST" });
    expect(await h.callError("conversations.fork", { ...forkArgs, requestId: "short" })).toMatchObject({ code: "BAD_REQUEST" });

    h.editResponder = (request) => {
      h.snapshot = { ...h.snapshot, ownerGeneration: "generation-2" };
      return { complete: false, kind: "rewind", operationId: request.operationId, conversationId: CONV, previousEpoch: 1, nextEpoch: 2, lastSeq: 3 };
    };
    expect(await h.callError("conversations.rewind", rewindArgs)).toMatchObject({ code: "CONFLICT" });
    expect(h.host.edits).toHaveLength(1);
  });

  test("a deleted source stops the fork before it publishes", async () => {
    h.editResponder = async (request) => {
      await h.ownerEvents([{ ...base("conversation.deleted", CONV), kind: "conversation.deleted", conversationId: CONV, deletedAt: 3_000 }]);
      return completeConversationEdit(request);
    };
    expect(await h.callError("conversations.fork", forkArgs)).toMatchObject({ code: "NOT_FOUND" });
    expect((await h.call("conversations.page", {})).conversations).toEqual([]);
  });
});

const spawnArgs = (overrides: Record<string, unknown> = {}) => ({
  ownerGeneration: GEN,
  clientMsgId: "spawn-request-1",
  description: "Research flights",
  prompt: "Find three flights to Lisbon.",
  originDeviceId: "desktop-1",
  originConversationId: "local-conversation-1",
  ...overrides,
});

describe("desktop-dispatched cloud agents", () => {
  beforeEach(async () => {
    await h.ownerEvents([created()]);
  });

  test("spawn records the attempt, dispatches it, and replays by request id", async () => {
    const running = await h.watch("agentThreads.running", { conversationId: CONV });
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    expect(control).toMatchObject({ conversationId: CONV, attemptGeneration: 1, status: "running" });
    expect(running()).toHaveLength(1);

    expect(h.host.dispatched).toEqual([]);
    await h.runJobs();
    expect(h.host.dispatched).toEqual([
      expect.objectContaining({
        threadId: control.threadId,
        conversationId: CONV,
        attemptGeneration: 1,
        prompt: "Find three flights to Lisbon.",
        originDeviceId: "desktop-1",
        originConversationId: "local-conversation-1",
        ownerGeneration: GEN,
      }),
    ]);

    const replay = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    expect(replay.threadId).toBe(control.threadId);
    const conflict = await h.callError("agentThreads.spawnFromDesktop", spawnArgs({ prompt: "Something else." }));
    expect(conflict.code).toBe("CONFLICT");
  });

  test("a stale generation is refused", async () => {
    const stale = await h.callError("agentThreads.spawnFromDesktop", spawnArgs({ ownerGeneration: "old" }));
    expect(stale).toMatchObject({ code: "CONFLICT", reason: "owner_generation_stale" });
  });

  test("an unknown conversation is refused; no conversation means the newest one", async () => {
    const missing = await h.callError(
      "agentThreads.spawnFromDesktop",
      spawnArgs({ conversationId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(missing).toMatchObject({ code: "NOT_FOUND", reason: "conversation_not_found" });
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    expect(control.conversationId).toBe(CONV);
  });

  test("a refused dispatch fails the thread; a transient one retries", async () => {
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    h.dispatchOutcome = new DispatchError("Network hiccup.", true);
    const now = Date.now();
    await h.runJobs(now);
    const get = await h.watch("agentThreads.get", { conversationId: CONV, threadId: control.threadId });
    expect(get()).toMatchObject({ status: "running" });
    h.dispatchOutcome = new DispatchError("Sign in to use cloud agents.", false);
    await h.runJobs(now + 20_000);
    expect(get()).toMatchObject({ status: "failed", errorMessage: "Sign in to use cloud agents." });
    expect(h.host.dispatched).toHaveLength(2);
  });

  test("the originating desktop sees the result until it acknowledges it", async () => {
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    await h.runJobs();
    const device = await h.watch("agentThreads.forDevice", { originDeviceId: "desktop-1", ownerGeneration: GEN });
    expect(device()).toHaveLength(1);
    const turnId = h.host.dispatched[0]!.turnId;
    await h.ownerEvents([
      {
        ...base("thread.completed", `${control.threadId}:${turnId}:1`),
        kind: "thread.completed",
        threadId: control.threadId,
        turnId,
        attemptGeneration: 1,
        status: "completed",
        resultJson: JSON.stringify({ finalText: "Found three." }),
        completedAt: Date.now() + 5,
      },
    ]);
    const [row] = device();
    expect(row).toMatchObject({ status: "completed", originDeviceId: "desktop-1", originConversationId: "local-conversation-1" });
    // Desktop-dispatched results deliver to the desktop, not as a card.
    expect(h.host.cards).toEqual([]);

    const stale = await h.call("agentThreads.acknowledgeDelivery", {
      threadId: control.threadId,
      originDeviceId: "desktop-1",
      ownerGeneration: GEN,
      attemptGeneration: 1,
      terminalUpdatedAt: row.updatedAt - 1,
    });
    expect(stale).toEqual({ acknowledged: false, superseded: true });
    const ack = await h.call("agentThreads.acknowledgeDelivery", {
      threadId: control.threadId,
      originDeviceId: "desktop-1",
      ownerGeneration: GEN,
      attemptGeneration: 1,
      terminalUpdatedAt: row.updatedAt,
    });
    expect(ack).toEqual({ acknowledged: true, superseded: false });
    expect(device()).toEqual([]);

    const continued = await h.call("agentThreads.continueFromDesktop", {
      ownerGeneration: GEN,
      threadId: control.threadId,
      expectedAttemptGeneration: 1,
      expectedTerminalUpdatedAt: row.updatedAt,
      description: "Book the cheapest",
      prompt: "Book the cheapest one.",
      originDeviceId: "desktop-1",
      originConversationId: "local-conversation-1",
      controlRequestId: "continue-request-1",
    });
    expect(continued).toMatchObject({ threadId: control.threadId, attemptGeneration: 2, status: "running" });
    expect(device()).toHaveLength(1);
    const stale2 = await h.callError("agentThreads.continueFromDesktop", {
      ownerGeneration: GEN,
      threadId: control.threadId,
      expectedAttemptGeneration: 1,
      expectedTerminalUpdatedAt: row.updatedAt,
      description: "Again",
      prompt: "Again.",
      originDeviceId: "desktop-1",
      originConversationId: "local-conversation-1",
      controlRequestId: "continue-request-2",
    });
    expect(stale2).toMatchObject({ code: "CONFLICT", reason: "thread_changed" });
  });

  test("cancel stops the exact running attempt and replays its receipt", async () => {
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    await h.runJobs();
    const args = {
      ownerGeneration: GEN,
      threadId: control.threadId,
      expectedAttemptGeneration: 1,
      expectedThreadUpdatedAt: control.threadUpdatedAt,
      originDeviceId: "desktop-1",
      originConversationId: "local-conversation-1",
      controlRequestId: "cancel-request-1",
    };
    const result = await h.call("agentThreads.cancel", args);
    expect(result).toMatchObject({ canceled: true, control: { status: "canceled", attemptGeneration: 1 } });
    expect(h.host.canceled).toEqual([
      expect.objectContaining({ threadId: control.threadId, attemptGeneration: 1, cancelRequestId: "cancel-request-1" }),
    ]);
    expect(await h.call("agentThreads.cancel", args)).toEqual(result);
    expect(h.host.canceled).toHaveLength(1);
  });

  test("cancel reports a change instead of stopping a different attempt", async () => {
    const control = await h.call("agentThreads.spawnFromDesktop", spawnArgs());
    h.cancelOutcome = "changed";
    const error = await h.callError("agentThreads.cancel", {
      ownerGeneration: GEN,
      threadId: control.threadId,
      expectedAttemptGeneration: 1,
      expectedThreadUpdatedAt: control.threadUpdatedAt,
      originDeviceId: "desktop-1",
      originConversationId: "local-conversation-1",
      controlRequestId: "cancel-request-2",
    });
    expect(error).toMatchObject({ code: "CONFLICT", reason: "thread_changed" });
  });
});

describe("orchestrator-spawned cloud agents", () => {
  test("outbox events build the thread, and completion files a card under its parent turn", async () => {
    await h.ownerEvents([created()]);
    const recent = await h.watch("agentThreads.recent", {});
    await h.ownerEvents([
      {
        ...base("thread.spawned", "thr-a:1"),
        kind: "thread.spawned",
        threadId: "thr-a",
        conversationId: CONV,
        parentTurnId: "parent-turn",
        agentDepth: 1,
        attemptGeneration: 1,
        description: "Summarize docs",
        prompt: "Summarize.",
        execution,
        placement: "cloud",
        createdAt: 2_000,
      },
      {
        ...base("turn.started", "agent-turn-1"),
        kind: "turn.started",
        turnId: "agent-turn-1",
        turnKind: "agent",
        conversationId: CONV,
        sessionId: "thr-a",
        lane: "agent",
        threadId: "thr-a",
        attemptGeneration: 1,
        agentType: "general",
        execution,
        prompt: "Summarize.",
        createdAt: 2_000,
      },
      {
        ...base("turn.event", "agent-turn-1:1:1"),
        kind: "turn.event",
        turnId: "agent-turn-1",
        attemptGeneration: 1,
        sessionId: "thr-a",
        eventSeq: 1,
        eventKind: "output_files",
        payload: { files: [{ path: "/notes.md", size: 10 }, { path: "/notes.md", size: 12 }] },
        terminal: false,
        createdAt: 2_100,
      },
    ]);
    expect(recent()).toEqual([expect.objectContaining({ threadId: "thr-a", status: "running", parentTurnId: "parent-turn" })]);

    // A late event from attempt 0 changes nothing; completion of attempt 1 lands.
    await h.ownerEvents([
      {
        ...base("thread.completed", "thr-a:agent-turn-1:1"),
        kind: "thread.completed",
        threadId: "thr-a",
        turnId: "agent-turn-1",
        attemptGeneration: 1,
        status: "completed",
        resultJson: JSON.stringify({ finalText: "Done." }),
        completedAt: 3_000,
      },
    ]);
    expect(recent()).toEqual([expect.objectContaining({ threadId: "thr-a", status: "completed" })]);
    expect(h.host.cards).toEqual([
      {
        conversationId: CONV,
        ownerGeneration: GEN,
        sourceTurnId: "parent-turn",
        card: { type: "files", files: [{ path: "/notes.md", size: 12 }] },
      },
    ]);
    // Replaying the completion is a no-op.
    await h.ownerEvents([
      {
        ...base("thread.completed", "thr-a:agent-turn-1:1"),
        kind: "thread.completed",
        threadId: "thr-a",
        turnId: "agent-turn-1",
        attemptGeneration: 1,
        status: "completed",
        completedAt: 3_000,
      },
    ]);
    expect(h.host.cards).toHaveLength(1);
  });
});

describe("desktop (computer) agents", () => {
  const start = (attemptGeneration: number, overrides: Record<string, unknown> = {}) =>
    ({
      threadId: "local-agent-1",
      ownerGeneration: GEN,
      conversationId: CONV,
      originDeviceId: "desktop-1",
      description: "Tidy downloads",
      agentType: "general",
      attemptGeneration,
      ...overrides,
    }) as Record<string, unknown>;

  test("attempts follow the start, complete and cancel rules", async () => {
    expect((await h.callError("computerThreads.start", start(1))).reason).toBe("conversation_not_found");
    await h.ownerEvents([created()]);
    expect((await h.callError("computerThreads.start", start(2))).reason).toBe("initial_attempt_invalid");
    expect(await h.call("computerThreads.start", start(1))).toEqual({ threadId: "local-agent-1" });
    expect(await h.call("computerThreads.start", start(1))).toEqual({ threadId: "local-agent-1" });
    expect((await h.callError("computerThreads.start", start(1, { description: "x" }))).reason).toBe("attempt_replay_conflict");

    const ids = { threadId: "local-agent-1", originDeviceId: "desktop-1", ownerGeneration: GEN };
    expect(await h.call("computerThreads.complete", { ...ids, attemptGeneration: 1, status: "completed", result: "Cleaned." })).toEqual({
      updated: true,
      status: "completed",
    });
    expect(await h.call("computerThreads.get", ids)).toMatchObject({ status: "completed", result: "Cleaned.", attemptGeneration: 1 });

    expect(await h.call("computerThreads.start", start(2))).toEqual({ threadId: "local-agent-1" });
    expect((await h.callError("computerThreads.start", start(1))).reason).toBe("attempt_stale");
    expect(await h.call("computerThreads.cancel", { ...ids, attemptGeneration: 1 })).toEqual({ canceled: false, status: "running" });
    expect(await h.call("computerThreads.cancel", { ...ids, attemptGeneration: 2 })).toEqual({ canceled: true, status: "canceled" });
    expect(await h.call("computerThreads.get", ids)).toMatchObject({ status: "canceled", error: "Canceled on this computer." });
  });
});
