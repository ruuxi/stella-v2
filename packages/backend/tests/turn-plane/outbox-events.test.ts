import { describe, expect, it } from "bun:test";
import {
  parseOutboxEvent,
  sortOutboxBatch,
} from "../../convex/lib/outbox_events";

const base = {
  v: 1,
  key: "k",
  ownerId: "owner",
  ownerGeneration: "gen",
  emittedAt: 1,
};

describe("parseOutboxEvent", () => {
  it("accepts every contract kind and drops unknown fields", () => {
    const execution = {
      engine: "stella",
      provider: "stella",
      model: "stella/default",
      reasoningEffort: "default",
    };
    const cases: Array<Record<string, unknown>> = [
      {
        kind: "conversation.created",
        conversationId: "c",
        createdAt: 1,
        title: "t",
        execution,
        extra: 1,
      },
      {
        kind: "conversation.index",
        conversationId: "c",
        epoch: 1,
        lastSeq: 2,
        updatedAt: 3,
        activity: "idle",
      },
      { kind: "conversation.deleted", conversationId: "c", deletedAt: 1 },
      {
        kind: "turn.started",
        turnId: "t",
        turnKind: "chat",
        conversationId: "c",
        sessionId: "s",
        lane: "chat",
        agentType: "orchestrator",
        execution,
        prompt: "p",
        createdAt: 1,
      },
      {
        kind: "turn.event",
        turnId: "t",
        sessionId: "s",
        eventSeq: 0,
        eventKind: "progress",
        payload: {},
        terminal: false,
        createdAt: 1,
      },
      {
        kind: "thread.spawned",
        threadId: "th",
        conversationId: "c",
        parentTurnId: "t",
        agentDepth: 1,
        attemptGeneration: 1,
        description: "d",
        prompt: "p",
        execution,
        placement: "cloud",
        createdAt: 1,
      },
      {
        kind: "thread.completed",
        threadId: "th",
        turnId: "t",
        attemptGeneration: 1,
        status: "completed",
        completedAt: 1,
      },
      { kind: "build.recorded", buildId: "b", payload: { buildId: "b" } },
    ];
    for (const raw of cases) {
      const parsed = parseOutboxEvent({ ...base, ...raw });
      expect(parsed.ok, raw.kind as string).toBe(true);
      if (parsed.ok) expect("extra" in parsed.event).toBe(false);
    }
  });

  it("rejects the wrong version, unknown kinds, and structurally bad events with their identity", () => {
    expect(
      parseOutboxEvent({
        ...base,
        v: 2,
        kind: "conversation.deleted",
        conversationId: "c",
        deletedAt: 1,
      }),
    ).toEqual({
      ok: false,
      kind: "conversation.deleted",
      key: "k",
      reason: "invalid",
    });
    expect(parseOutboxEvent({ ...base, kind: "nope" })).toMatchObject({
      ok: false,
      kind: "nope",
    });
    expect(
      parseOutboxEvent({
        ...base,
        kind: "turn.event",
        turnId: "t",
        sessionId: "s",
        eventSeq: -1,
        eventKind: "x",
        payload: {},
        terminal: false,
        createdAt: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseOutboxEvent({
        ...base,
        kind: "thread.spawned",
        threadId: "th",
        conversationId: "c",
        parentTurnId: "t",
        agentDepth: 1,
        attemptGeneration: 1,
        description: "d",
        prompt: "p",
        execution: {
          engine: "stella",
          provider: "anthropic",
          model: "x",
          reasoningEffort: "default",
        },
        placement: "cloud",
        createdAt: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(parseOutboxEvent(null)).toMatchObject({
      ok: false,
      kind: "",
      key: "",
    });
  });
});

describe("sortOutboxBatch", () => {
  it("applies parents before children while keeping delivery order within a kind", () => {
    const sorted = sortOutboxBatch([
      { kind: "turn.event", id: 1 },
      { kind: "thread.completed", id: 2 },
      { kind: "turn.started", id: 3 },
      { kind: "turn.event", id: 4 },
      { kind: "conversation.created", id: 5 },
      { kind: "thread.spawned", id: 6 },
    ] as const);
    expect(sorted.map((entry) => entry.id)).toEqual([5, 3, 6, 1, 4, 2]);
  });
});
