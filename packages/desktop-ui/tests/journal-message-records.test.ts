import { describe, expect, test } from "bun:test";
import type { MessageRecord } from "@stella/contracts/local-chat";
import {
  activeCloudUserMessageIds,
  completeJournalWindowRecords,
  hasIncompleteLeadingJournalTurn,
  journalRecordsToMessageRecords,
  mergeCanonicalMessagesWithLocalCache,
} from "../src/features/cloud/journal-message-records";
import type { JournalRecord } from "../src/features/cloud/conversation-protocol";

const records: JournalRecord[] = [
  {
    kind: "message",
    seq: 1,
    turnId: "desktop:mac:run",
    createdAtMs: 10,
    role: "user",
    hidden: false,
    clientMsgId: "local-user",
    payload: { role: "user", content: "Do it", timestamp: 10 },
  },
  {
    kind: "message",
    seq: 2,
    turnId: "desktop:mac:run",
    createdAtMs: 11,
    role: "assistant",
    hidden: false,
    payload: {
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        {
          type: "toolCall",
          id: "call-1",
          name: "web",
          arguments: { query: "Stella" },
        },
      ],
      timestamp: 11,
    },
  },
  {
    kind: "message",
    seq: 3,
    turnId: "desktop:mac:run",
    createdAtMs: 12,
    role: "toolResult",
    hidden: false,
    payload: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "web",
      content: [{ type: "text", text: "Found it" }],
      isError: false,
      timestamp: 12,
    },
  },
];

describe("journalRecordsToMessageRecords", () => {
  test("preserves the prompt identity and attaches exact tool events", () => {
    const projected = journalRecordsToMessageRecords(records);
    expect(projected).toHaveLength(2);
    expect(projected[0]?._id).toBe("local-user");
    expect(projected[1]?.payload?.userMessageId).toBe("local-user");
    expect(projected[1]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  test("projects canonical voice-session metadata into the existing card contract", () => {
    const projected = journalRecordsToMessageRecords([
      {
        kind: "message",
        seq: 4,
        turnId: "voice:mac:summary",
        createdAtMs: 13,
        role: "assistant",
        hidden: false,
        payload: {
          role: "assistant",
          content: [{ type: "text", text: "Voice session" }],
          source: "voice",
          voiceSession: { durationMs: 12_000 },
          timestamp: 13,
        },
      },
    ]);

    expect(projected[0]?.payload).toMatchObject({
      text: "Voice session",
      source: "voice",
      metadata: { voiceSession: { durationMs: 12_000 } },
    });
  });

  test("withholds a record-count-truncated leading turn until its prompt is backfilled", () => {
    const assistantTail = Array.from({ length: 120 }, (_, index) => ({
      kind: "message" as const,
      seq: index + 2,
      turnId: "tool-heavy-turn",
      createdAtMs: index + 2,
      role: "assistant" as const,
      hidden: false,
      payload: {
        role: "assistant",
        content: [{ type: "text", text: `Part ${index}` }],
        timestamp: index + 2,
      },
    }));
    expect(hasIncompleteLeadingJournalTurn(assistantTail, true)).toBe(true);
    expect(completeJournalWindowRecords(assistantTail, true)).toEqual([]);

    const withPrompt: JournalRecord[] = [
      {
        kind: "message",
        seq: 1,
        turnId: "tool-heavy-turn",
        createdAtMs: 1,
        role: "user",
        hidden: false,
        clientMsgId: "tool-heavy-prompt",
        payload: {
          role: "user",
          content: [{ type: "text", text: "Use many tools" }],
          timestamp: 1,
        },
      },
      ...assistantTail,
    ];
    expect(hasIncompleteLeadingJournalTurn(withPrompt, true)).toBe(false);
    expect(completeJournalWindowRecords(withPrompt, true)).toHaveLength(121);
  });
});

describe("mergeCanonicalMessagesWithLocalCache", () => {
  test("canonical rows replace local logical slots without text matching", () => {
    const canonical = journalRecordsToMessageRecords(records);
    const local: MessageRecord[] = [
      {
        _id: "local-user",
        timestamp: 10,
        type: "user_message",
        payload: { text: "Do it" },
        toolEvents: [],
      },
      {
        _id: "local-assistant",
        timestamp: 11,
        type: "assistant_message",
        payload: { text: "On it.", userMessageId: "local-user" },
        toolEvents: [],
      },
    ];
    const merged = mergeCanonicalMessagesWithLocalCache(canonical, local);
    expect(merged).toHaveLength(2);
    expect(merged.some((message) => message._id === "local-assistant")).toBe(
      false,
    );
  });

  test("keeps assistant cache rows until their canonical ordinal arrives", () => {
    const canonical = journalRecordsToMessageRecords(records.slice(0, 1));
    const local: MessageRecord[] = [
      {
        _id: "local-assistant",
        timestamp: 11,
        type: "assistant_message",
        payload: { text: "On it.", userMessageId: "local-user" },
        toolEvents: [],
      },
    ];
    expect(
      mergeCanonicalMessagesWithLocalCache(
        canonical,
        local,
        new Set(["local-user"]),
      ).map((message) => message._id),
    ).toEqual(["local-user", "local-assistant"]);
  });

  test("keeps journal order when device clocks disagree", () => {
    const canonical: MessageRecord[] = [
      {
        _id: "cloud-first",
        timestamp: 200,
        type: "user_message",
        payload: { text: "First" },
        toolEvents: [],
      },
      {
        _id: "cloud-second",
        timestamp: 100,
        type: "user_message",
        payload: { text: "Second" },
        toolEvents: [],
      },
    ];

    const cacheOnly: MessageRecord[] = [
      {
        _id: "local-third",
        timestamp: 50,
        type: "assistant_message",
        payload: { text: "Third", userMessageId: "active-user" },
        toolEvents: [],
      },
    ];

    expect(
      mergeCanonicalMessagesWithLocalCache(
        canonical,
        cacheOnly,
        new Set(["active-user"]),
      ).map((message) => message._id),
    ).toEqual(["cloud-first", "cloud-second", "local-third"]);
  });

  test("retires cache-only output once the cloud turn is terminal", () => {
    const canonical = journalRecordsToMessageRecords(records.slice(0, 1));
    const local: MessageRecord[] = [
      {
        _id: "local-assistant",
        timestamp: 11,
        type: "assistant_message",
        payload: { text: "Local only", userMessageId: "local-user" },
        toolEvents: [],
      },
    ];
    expect(
      mergeCanonicalMessagesWithLocalCache(canonical, local, new Set()).map(
        (message) => message._id,
      ),
    ).toEqual(["local-user"]);
  });

  test("keeps a durable device sync-failure notice after restart", () => {
    const canonical = journalRecordsToMessageRecords(records.slice(0, 1));
    const local: MessageRecord[] = [
      {
        _id: "cloud-sync-error:device:turn",
        timestamp: 12,
        type: "assistant_message",
        payload: {
          text: "Start a new conversation to keep going.",
          userMessageId: "local-user",
          source: "cloud-sync-error",
        },
        toolEvents: [],
      },
    ];
    expect(
      mergeCanonicalMessagesWithLocalCache(canonical, local, new Set()).map(
        (message) => message._id,
      ),
    ).toEqual(["local-user", "cloud-sync-error:device:turn"]);
  });
});

describe("activeCloudUserMessageIds", () => {
  test("keeps overlays only while their canonical turn is started", () => {
    const started: JournalRecord = {
      kind: "turn",
      seq: 4,
      turnId: "desktop:mac:run",
      createdAtMs: 13,
      phase: "started",
      lane: "chat",
      source: "desktop",
    };
    expect(activeCloudUserMessageIds([...records, started])).toEqual(
      new Set(["local-user"]),
    );
    const canceled: JournalRecord = {
      ...started,
      seq: 5,
      phase: "canceled",
    };
    expect(activeCloudUserMessageIds([...records, started, canceled])).toEqual(
      new Set(),
    );
  });
});
