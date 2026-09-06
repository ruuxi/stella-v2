import { buildAutomaticExecutionAdmission } from "./execution-placement-core";
import { describe, expect, test } from "bun:test";
import { mergeMessagesById } from "./chat-merge";
import {
  acknowledgeDesktopChatOutboxRecords,
  appendDesktopChatOutboxRecord,
  desktopChatOutboxPrompt,
  markDesktopChatOutboxRecordCanceled,
  parseDesktopChatOutbox,
  partitionDesktopChatOutboxForAuthority,
  restoreOutboxMessages,
  type DesktopChatOutboxAuthority,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";

const pending = (
  sendId: string,
  text: string,
  createdAt: number,
): Omit<DesktopChatOutboxRecord, "sequence"> => ({
  sendId,
  userMessageId: sendId,
  text,
  displayText: text,
  createdAt,
  attachments: [],
});

const authorityA1: DesktopChatOutboxAuthority = {
  accountScope: "account:a",
  ownerGeneration: "generation:1",
  conversationId: "conversation:a",
};
const authorityA2: DesktopChatOutboxAuthority = {
  ...authorityA1,
  ownerGeneration: "generation:2",
};
const authorityB: DesktopChatOutboxAuthority = {
  accountScope: "account:b",
  ownerGeneration: "generation:1",
  conversationId: "conversation:b",
};

describe("chat durable outbox", () => {
  test("new attachment sends keep titles clean while legacy admission hashes survive restart", () => {
    const attachments: DesktopChatOutboxRecord["attachments"] = [
      { path: "uploads/photo.png", name: "photo.png", kind: "image" },
      { path: "uploads/notes.txt", name: "notes.txt", kind: "file" },
    ];
    const legacy = appendDesktopChatOutboxRecord([], {
      ...pending("old-photo", "Describe these", 1), attachments,
    }).record;
    const fresh = appendDesktopChatOutboxRecord([], {
      ...pending("new-photo", "Describe these", 2), attachments, structuredAttachments: true,
    }).record;
    const replay = parseDesktopChatOutbox(JSON.parse(JSON.stringify([legacy, fresh])));
    const oldReplay = replay.find((record) => record.sendId === legacy.sendId);
    const newReplay = replay.find((record) => record.sendId === fresh.sendId);
    const admission = (record: DesktopChatOutboxRecord, prompt = desktopChatOutboxPrompt(record)) =>
      buildAutomaticExecutionAdmission({ idempotencyKey: record.sendId, conversationId: "conv", kind: "chat", prompt,
        attachments: record.attachments.map(({ path }) => path),
      });
    const legacyPrompt = "Describe these\n\nAttached in my drive:\n- uploads/photo.png\n- uploads/notes.txt";
    expect(oldReplay!.structuredAttachments).toBeUndefined();
    expect(newReplay!.structuredAttachments).toBe(true);
    expect(desktopChatOutboxPrompt(oldReplay!)).toBe(legacyPrompt);
    expect(admission(oldReplay!).payloadHash).toBe(admission(legacy, legacyPrompt).payloadHash);
    expect(desktopChatOutboxPrompt(newReplay!)).toBe("Describe these");
    expect(admission(newReplay!).payloadHash).toBe(admission(fresh).payloadHash);
    expect(admission(newReplay!).body.payload.attachments).toEqual([
      "uploads/photo.png", "uploads/notes.txt",
    ]);
    for (const invalidFlag of [false, "true", 1, undefined]) {
      const [parsed] = parseDesktopChatOutbox([{ ...legacy, structuredAttachments: invalidFlag }]);
      expect(parsed!.structuredAttachments).toBeUndefined();
      expect(desktopChatOutboxPrompt(parsed!)).toBe(legacyPrompt);
    }
  });
  test("does not expose a transmissible record before durable enqueue completes", () => {
    const durable: DesktopChatOutboxRecord[] = [];
    const attemptedBeforeCommit = durable.find(
      (record) => record.sendId === "send-1",
    );
    expect(attemptedBeforeCommit).toBe(undefined);

    const committed = appendDesktopChatOutboxRecord(
      durable,
      pending("send-1", "hello", 1_000),
    );
    expect(committed.record.sendId).toBe("send-1");
    expect(committed.records).toHaveLength(1);
  });

  test("persists journal identity opt-in while preserving pre-upgrade retry hashes", () => {
    const oldSend = appendDesktopChatOutboxRecord([], pending("old-send", "hello", 1)).record;
    const newSend = appendDesktopChatOutboxRecord([], {
      ...pending("new-send", "hello", 2), userMessageEventId: "new-send",
    }).record;
    const replay = parseDesktopChatOutbox(JSON.parse(JSON.stringify([oldSend, newSend])));
    const oldReplay = replay.find(record => record.sendId === "old-send")!;
    const newReplay = replay.find(record => record.sendId === "new-send")!;
    expect(oldReplay.userMessageEventId).toBeUndefined();
    expect(newReplay.userMessageEventId).toBe("new-send");
    const admission = (record: DesktopChatOutboxRecord) => buildAutomaticExecutionAdmission({
      idempotencyKey: record.sendId, conversationId: "conv", kind: "chat", prompt: record.text,
      ...(record.userMessageEventId ? { userMessageEventId: record.userMessageEventId } : {}),
    });
    expect(admission(oldReplay).payloadHash).toBe(admission(oldSend).payloadHash);
    expect(admission(newReplay).payloadHash).toBe(admission(newSend).payloadHash);
    expect(admission(newReplay).body.payload.userMessageEventId).toBe("new-send");
  });

  test("replays every interruption window with one stable identity", () => {
    let outbox = appendDesktopChatOutboxRecord(
      [],
      pending("send-1", "hello", 1_000),
    ).records;
    const canonicalRows = new Map<string, { id: string; text: string }>();
    const accept = (record: DesktopChatOutboxRecord) => {
      if (!canonicalRows.has(record.userMessageId)) {
        canonicalRows.set(record.userMessageId, {
          id: record.userMessageId,
          text: record.text,
        });
      }
      return record.userMessageId;
    };

    // Persisted before send, close during send, acceptance/ack loss, ack before
    // cleanup, and unlimited reconnect replay all deliver the same record.
    const record = outbox[0]!;
    for (let replay = 0; replay < 20; replay += 1) {
      expect(accept(record)).toBe("send-1");
    }
    expect([...canonicalRows.values()]).toEqual([
      { id: "send-1", text: "hello" },
    ]);

    outbox = acknowledgeDesktopChatOutboxRecords(outbox, new Set(["send-1"]));
    outbox = acknowledgeDesktopChatOutboxRecords(outbox, new Set(["send-1"]));
    expect(outbox).toEqual([]);
  });

  test("keeps a cancel intent durable until the exact server dispatch is terminal", () => {
    let records = appendDesktopChatOutboxRecord(
      [],
      pending("send-cancel", "stop this", 1_000),
    ).records;
    records = markDesktopChatOutboxRecordCanceled(
      records,
      "send-cancel",
      "cancel:send-cancel",
      2_000,
    );
    const restarted = parseDesktopChatOutbox(
      JSON.parse(JSON.stringify(records)),
    );
    expect(restarted[0]).toMatchObject({
      sendId: "send-cancel",
      cancelRequestId: "cancel:send-cancel",
      cancelRequestedAt: 2_000,
    });
    expect(
      acknowledgeDesktopChatOutboxRecords(restarted, new Set()),
    ).toHaveLength(1);
    expect(
      acknowledgeDesktopChatOutboxRecords(restarted, new Set(["send-cancel"])),
    ).toEqual([]);
  });

  test("preserves compose order and keeps intentional identical messages distinct", () => {
    const first = appendDesktopChatOutboxRecord(
      [],
      pending("send-a", "same text", 5_000),
    );
    const second = appendDesktopChatOutboxRecord(
      first.records,
      pending("send-b", "same text", 5_000),
    );
    const third = appendDesktopChatOutboxRecord(
      second.records,
      pending("send-c", "later", 1),
    );

    expect(third.records.map((record) => record.sendId)).toEqual([
      "send-a",
      "send-b",
      "send-c",
    ]);
    expect(third.records.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  test("hydrates a missing optimistic row once and reconciles canonical replay in place", () => {
    const outbox = appendDesktopChatOutboxRecord(
      [],
      pending("send-1", "hello", 1_000),
    ).records;
    const restored = restoreOutboxMessages([], outbox);
    const restoredAgain = restoreOutboxMessages(restored, outbox);
    expect(restoredAgain).toHaveLength(1);

    const merged = mergeMessagesById(restoredAgain, [
      {
        id: "send-1",
        role: "user",
        text: "hello",
        createdAt: 9_000,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "send-1",
      role: "user",
      text: "hello",
      createdAt: 1_000,
      canonicalCreatedAt: 9_000,
    });
  });

  test("makes duplicate and out-of-order canonical acknowledgments harmless", () => {
    let records = appendDesktopChatOutboxRecord(
      [],
      pending("send-a", "a", 1),
    ).records;
    records = appendDesktopChatOutboxRecord(
      records,
      pending("send-b", "b", 2),
    ).records;
    records = appendDesktopChatOutboxRecord(
      records,
      pending("send-c", "c", 3),
    ).records;

    records = acknowledgeDesktopChatOutboxRecords(records, new Set(["send-b"]));
    records = acknowledgeDesktopChatOutboxRecords(
      records,
      new Set(["send-b", "send-a"]),
    );
    expect(records.map((record) => record.sendId)).toEqual(["send-c"]);
  });

  test("retains the drive paths a restart needs to replay the turn", () => {
    const outbox = appendDesktopChatOutboxRecord([], {
      ...pending("cloud-attach", "Look at these", 10),
      attachments: [
        {
          path: "uploads/2026-08-29/photo.png",
          name: "photo.png",
          kind: "image",
          previewUri: "file:///photo.png",
        },
        {
          path: "uploads/2026-08-29/lease.pdf",
          name: "lease.pdf",
          kind: "file",
        },
      ],
    }).records;
    expect(outbox[0]?.attachments.map((entry) => entry.path)).toEqual([
      "uploads/2026-08-29/photo.png",
      "uploads/2026-08-29/lease.pdf",
    ]);
    expect(restoreOutboxMessages([], outbox)[0]).toMatchObject({
      id: "cloud-attach",
      queued: true,
      hasImage: true,
      thumbnailUris: ["file:///photo.png"],
      documentNames: ["lease.pdf"],
    });
  });

  test("an image whose local preview is gone still reads as an image", () => {
    const outbox = appendDesktopChatOutboxRecord([], {
      ...pending("no-preview", "Photo", 11),
      attachments: [
        {
          path: "uploads/2026-08-29/photo.jpg",
          name: "photo.jpg",
          kind: "image",
        },
      ],
    }).records;
    const restored = restoreOutboxMessages([], outbox)[0];
    expect(restored).toMatchObject({ hasImage: true });
    expect(restored?.thumbnailUris).toBeUndefined();
  });

  test("account switches quarantine other owners and replay only exact scope", () => {
    let records = appendDesktopChatOutboxRecord([], {
      ...pending("send-a", "from a", 1),
      authority: authorityA1,
    }).records;
    records = appendDesktopChatOutboxRecord(records, {
      ...pending("send-b", "from b", 2),
      authority: authorityB,
    }).records;
    records = appendDesktopChatOutboxRecord(
      records,
      pending("legacy", "unscoped", 3),
    ).records;

    const forB = partitionDesktopChatOutboxForAuthority(records, authorityB);
    expect(forB.active.map((record) => record.sendId)).toEqual(["send-b"]);
    expect(forB.stale).toEqual([]);
    expect(forB.retained.map((record) => record.sendId)).toEqual([
      "send-a",
      "send-b",
      "legacy",
    ]);

    const backToA = partitionDesktopChatOutboxForAuthority(
      forB.retained,
      authorityA1,
    );
    expect(backToA.active.map((record) => record.sendId)).toEqual(["send-a"]);
  });

  test("owner generation rotation deletes only stale same-account work", () => {
    let records = appendDesktopChatOutboxRecord([], {
      ...pending("old-a", "old generation", 1),
      authority: authorityA1,
    }).records;
    records = appendDesktopChatOutboxRecord(records, {
      ...pending("other-account", "keep quarantined", 2),
      authority: authorityB,
    }).records;

    const rotated = partitionDesktopChatOutboxForAuthority(
      records,
      authorityA2,
    );
    expect(rotated.active).toEqual([]);
    expect(rotated.stale.map((record) => record.sendId)).toEqual(["old-a"]);
    expect(rotated.retained.map((record) => record.sendId)).toEqual([
      "other-account",
    ]);
  });

  test("scoped acknowledgement and cancellation cannot mutate another owner", () => {
    let records = appendDesktopChatOutboxRecord([], {
      ...pending("same-send", "from a", 1),
      authority: authorityA1,
    }).records;
    records = appendDesktopChatOutboxRecord(records, {
      ...pending("same-send", "from b", 2),
      authority: authorityB,
    }).records;

    records = markDesktopChatOutboxRecordCanceled(
      records,
      "same-send",
      "cancel:b",
      5,
      authorityB,
    );
    expect(
      records.find(
        (record) => record.authority?.accountScope === authorityA1.accountScope,
      )?.cancelRequestId,
    ).toBeUndefined();
    expect(
      records.find(
        (record) => record.authority?.accountScope === authorityB.accountScope,
      ),
    ).toMatchObject({ authority: authorityB, cancelRequestId: "cancel:b" });

    const acknowledgedB = acknowledgeDesktopChatOutboxRecords(
      records,
      new Set(["same-send"]),
      authorityB,
    );
    expect(acknowledgedB).toHaveLength(1);
    expect(acknowledgedB[0]?.authority).toEqual(authorityA1);
  });

  test("rejects a reused scope identity with different routing bytes", () => {
    const records = appendDesktopChatOutboxRecord([], {
      ...pending("send-conflict", "first", 1),
      authority: authorityA1,
    }).records;
    expect(() =>
      appendDesktopChatOutboxRecord(records, {
        ...pending("send-conflict", "changed", 1),
        authority: authorityA1,
      }),
    ).toThrow("Conflicting durable chat outbox identity");
  });

  test("replays the chosen cloud model with the same signed payload after preferences change", () => {
    const chosen = { engine: "stella" as const, provider: "stella" as const, model: "stella/sonnet", reasoningEffort: "high" as const };
    const records = appendDesktopChatOutboxRecord([], {
      ...pending("cloud-model-send", "hello", 1),
      authority: authorityA1,
      executionTarget: { mode: "cloud" },
      execution: chosen,
    }).records;
    const [replayed] = parseDesktopChatOutbox(JSON.parse(JSON.stringify(records)));
    chosen.model = "stella/opus";
    expect(replayed!.execution?.model).toBe("stella/sonnet");
    const admission = (execution: typeof replayed.execution) => buildAutomaticExecutionAdmission({
      idempotencyKey: replayed!.sendId,
      conversationId: "conv:model",
      kind: "chat",
      prompt: replayed!.text,
      target: { mode: "cloud" },
      ...(execution ? { execution } : {}),
    });
    const before = admission(records[0]!.execution);
    const after = admission(replayed!.execution);
    expect(after.payloadHash).toBe(before.payloadHash);
    expect(after.body.payload.execution?.model).toBe("stella/sonnet");
    expect(admission(chosen).payloadHash).not.toBe(after.payloadHash);
  });

  test("computer replay does not acquire a cloud model override", () => {
    const records = appendDesktopChatOutboxRecord([], {
      ...pending("computer-send", "hello", 1),
      executionTarget: { mode: "device", deviceId: "desktop" },
      execution: { engine: "stella", provider: "stella", model: "stella/sonnet", reasoningEffort: "default" },
    }).records;
    expect(records[0]!.execution).toBeUndefined();
  });

  test("freezes an exact execution target across durable replay", () => {
    const records = appendDesktopChatOutboxRecord([], {
      ...pending("send-to-windows", "run there", 1),
      authority: authorityA1,
      executionTarget: { mode: "device", deviceId: " desktop-windows " },
    }).records;
    expect(parseDesktopChatOutbox(JSON.parse(JSON.stringify(records)))).toEqual(
      [
        expect.objectContaining({
          sendId: "send-to-windows",
          executionTarget: { mode: "device", deviceId: "desktop-windows" },
        }),
      ],
    );
  });
});
