import { describe, expect, test } from "bun:test";
import {
  activeCloudTurnId,
  projectCloudConversationMessages,
} from "../cloud-journal-projection";
import type { CloudJournalRecord } from "../cloud-conversation-protocol";

type WithoutCreatedAt<T> = T extends CloudJournalRecord
  ? Omit<T, "createdAtMs">
  : never;

const record = (
  value: WithoutCreatedAt<CloudJournalRecord>,
): CloudJournalRecord =>
  ({ ...value, createdAtMs: value.seq * 10 }) as CloudJournalRecord;

describe("cloud journal projection", () => {
  test("reconciles an optimistic prompt by stable clientMsgId", () => {
    const records = [
      record({
        kind: "message",
        seq: 1,
        turnId: "turn-1",
        role: "user",
        hidden: false,
        clientMsgId: "mobile:one",
        payload: { content: "hello" },
      }),
      record({
        kind: "message",
        seq: 2,
        turnId: "turn-1",
        role: "assistant",
        hidden: false,
        payload: { content: "hi" },
      }),
    ];
    const messages = projectCloudConversationMessages({
      records,
      pending: [
        {
          accountScope: "anonymous:one",
          clientMsgId: "mobile:one",
          text: "hello",
          createdAtMs: 1,
          conversationId: "conversation",
          turnId: null,
          error: null,
          cancelRequested: false,
        },
      ],
      live: null,
    });

    expect(messages.map((message) => message.id)).toEqual([
      "mobile:one",
      "cloud:turn-1:message:2",
    ]);
    expect(messages[1]?.requestId).toBe("mobile:one");
  });

  test("drops an incomplete leading turn from a bounded window", () => {
    const messages = projectCloudConversationMessages({
      records: [
        record({
          kind: "message",
          seq: 40,
          turnId: "cut-off",
          role: "assistant",
          hidden: false,
          payload: { content: "orphan" },
        }),
        record({
          kind: "message",
          seq: 41,
          turnId: "whole",
          role: "user",
          hidden: false,
          payload: { content: "question" },
        }),
      ],
      pending: [],
      live: null,
      hasOlder: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("question");
  });

  test("finds a started turn for stop even before deltas arrive", () => {
    const records = [
      record({
        kind: "turn",
        seq: 3,
        turnId: "turn-running",
        phase: "started",
      }),
    ];
    expect(activeCloudTurnId(records, null)).toBe("turn-running");
  });

  test("attaches file cards after the turn messages instead of rendering them first", () => {
    const messages = projectCloudConversationMessages({
      conversationId: "conversation",
      records: [
        record({
          kind: "message",
          seq: 1,
          turnId: "turn-files",
          role: "user",
          hidden: false,
          payload: { content: "make a report" },
        }),
        record({
          kind: "message",
          seq: 2,
          turnId: "turn-files",
          role: "assistant",
          hidden: false,
          payload: { content: "done" },
        }),
        record({
          kind: "card",
          seq: 3,
          turnId: "turn-files",
          card: {
            type: "files",
            files: [
              {
                path: "report.pdf",
                name: "report.pdf",
                sizeBytes: 100,
                contentType: "application/pdf",
              },
            ],
          },
        }),
      ],
      pending: [],
      live: null,
    });

    expect(messages.map((message) => message.text)).toEqual([
      "make a report",
      "done",
    ]);
    expect(messages[1]?.artifacts?.[0]?.payload.kind).toBe("pdf");
  });
});
