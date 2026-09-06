import { describe, expect, test } from "bun:test";
import {
  canonicalCloudDispatchIdForTurn,
  canonicalCloudDispatchIds,
  mergeCanonicalCloudMessages,
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "../cloud-journal-projection";
import type { JournalRecord } from "../cloud-conversation-protocol";
import type { ChatMessage } from "../../types";

const message = (
  value: Omit<Extract<JournalRecord, { kind: "message" }>, "createdAtMs">,
): JournalRecord => ({ ...value, createdAtMs: value.seq * 10 });

describe("cloud journal projection", () => {
  test("binds one server dispatch to one stable optimistic row", () => {
    const records: JournalRecord[] = [
      message({
        kind: "message",
        seq: 1,
        turnId: "turn-1",
        role: "user",
        hidden: false,
        clientMsgId: "exec:server-1",
        payload: { content: "hello" },
      }),
      message({
        kind: "message",
        seq: 2,
        turnId: "turn-1",
        role: "assistant",
        hidden: false,
        payload: { content: "hi" },
      }),
    ];
    const projected = projectCloudConversationMessages({
      conversationId: "conversation",
      records,
    });
    const bindings = new Map<string, string | null>([
      ["mobile-local-1", "exec:server-1"],
    ]);
    const canonical = rebindCanonicalCloudMessages(projected, bindings);
    const local: ChatMessage[] = [
      { id: "old-local-history", role: "user", text: "stale" },
      { id: "mobile-local-1", role: "user", text: "hello" },
      {
        id: "mobile-local-reply",
        requestId: "mobile-local-1",
        role: "assistant",
        text: "temporary result",
      },
    ];
    const merged = mergeCanonicalCloudMessages({
      canonical,
      local,
      dispatchBindings: bindings,
      acknowledgedDispatchIds: canonicalCloudDispatchIds(records),
    });

    expect(merged.map((row) => row.id)).toEqual([
      "mobile-local-1",
      "cloud:turn-1:message:2",
    ]);
    expect(merged[0]?.canonicalId).toBe("cloud:turn-1:message:1");
    expect(merged[1]?.requestId).toBe("mobile-local-1");
    expect(merged.map((row) => row.sequence)).toEqual([1, 2]);
  });

  test("journal-before-admission retains one stable bubble per rapid identical send", () => {
    const local: ChatMessage[] = [
      { id: "mobile-first", role: "user", text: "same prompt" },
      { id: "mobile-second", role: "user", text: "same prompt", queued: true },
    ];
    const bindings = new Map<string, string | null>([
      ["mobile-first", null], ["mobile-second", null],
    ]);
    const records: JournalRecord[] = [message({
      kind: "message", seq: 1, turnId: "turn-first", role: "user", hidden: false,
      clientMsgId: "dsp:first",
      payload: { content: "same prompt", originUserMessageId: "mobile-first" },
    })];
    const merge = () => mergeCanonicalCloudMessages({
      canonical: rebindCanonicalCloudMessages(projectCloudConversationMessages({ records }), bindings),
      local, dispatchBindings: bindings,
      acknowledgedDispatchIds: canonicalCloudDispatchIds(records),
    });
    expect(merge().map(row => row.id)).toEqual(["mobile-first", "mobile-second"]);
    bindings.set("mobile-first", "dsp:first");
    expect(merge().map(row => row.id)).toEqual(["mobile-first", "mobile-second"]);
    records.push(message({
      kind: "message", seq: 2, turnId: "turn-first", role: "assistant", hidden: false,
      payload: { content: "first answer" },
    }));
    expect(merge()[1]).toMatchObject({ role: "assistant", requestId: "mobile-first" });
    expect(merge().filter(row => row.role === "user").map(row => row.id))
      .toEqual(["mobile-first", "mobile-second"]);
  });

  test("keeps the unresolved assistant slot until its canonical row arrives", () => {
    const records: JournalRecord[] = [
      message({
        kind: "message",
        seq: 9,
        turnId: "turn-live",
        role: "user",
        hidden: false,
        clientMsgId: "exec:live",
        payload: { content: "run it" },
      }),
    ];
    const bindings = new Map<string, string | null>([
      ["mobile-live", "exec:live"],
    ]);
    const canonical = rebindCanonicalCloudMessages(
      projectCloudConversationMessages({ records }),
      bindings,
    );
    const merged = mergeCanonicalCloudMessages({
      canonical,
      local: [
        { id: "mobile-live", role: "user", text: "run it" },
        {
          id: "mobile-live-reply",
          requestId: "mobile-live",
          role: "assistant",
          text: "Still working",
        },
      ],
      dispatchBindings: bindings,
      acknowledgedDispatchIds: canonicalCloudDispatchIds(records),
    });

    expect(merged.map((row) => row.id)).toEqual([
      "mobile-live",
      "mobile-live-reply",
    ]);
  });

  test("withholds an incomplete leading turn until pagination fills its prompt", () => {
    const partial: JournalRecord[] = [
      message({
        kind: "message",
        seq: 40,
        turnId: "cut-off",
        role: "assistant",
        hidden: false,
        payload: { content: "orphan" },
      }),
      message({
        kind: "message",
        seq: 41,
        turnId: "whole",
        role: "user",
        hidden: false,
        payload: { content: "question" },
      }),
    ];
    const before = projectCloudConversationMessages({
      records: partial,
      hasOlder: true,
    });
    const after = projectCloudConversationMessages({
      records: [
        message({
          kind: "message",
          seq: 39,
          turnId: "cut-off",
          role: "user",
          hidden: false,
          payload: { content: "earlier question" },
        }),
        ...partial,
      ],
      hasOlder: false,
    });

    expect(before.map((row) => row.text)).toEqual(["question"]);
    expect(after.map((row) => row.text)).toEqual([
      "earlier question",
      "orphan",
      "question",
    ]);
  });

  test("skipped durable rows preserve sequence without rendering duplicates", () => {
    const rows: JournalRecord[] = [
      message({
        kind: "message",
        seq: 1,
        turnId: "turn",
        role: "user",
        hidden: false,
        payload: { content: "hello" },
      }),
      {
        kind: "skipped",
        seq: 2,
        turnId: "turn",
        createdAtMs: 20,
        originalKind: "future",
      },
      message({
        kind: "message",
        seq: 3,
        turnId: "turn",
        role: "assistant",
        hidden: false,
        payload: { content: "hi" },
      }),
    ];
    const projected = projectCloudConversationMessages({
      records: rows,
    });
    expect(projected.map((row) => row.sequence)).toEqual([1, 3]);
    expect(new Set(projected.map((row) => row.id)).size).toBe(projected.length);
  });

  test("recovers a running turn's placement dispatch from its canonical prompt", () => {
    const records: JournalRecord[] = [
      message({
        kind: "message",
        seq: 8,
        turnId: "turn-running",
        role: "user",
        hidden: false,
        clientMsgId: "exec:server-running",
        payload: { content: "keep going" },
      }),
      {
        kind: "turn",
        seq: 9,
        turnId: "turn-running",
        createdAtMs: 90,
        phase: "started",
      },
    ];

    expect(canonicalCloudDispatchIdForTurn(records, "turn-running")).toBe(
      "exec:server-running",
    );
    expect(canonicalCloudDispatchIdForTurn(records, "other-turn")).toBeNull();
  });
});
