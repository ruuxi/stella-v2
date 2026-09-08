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
  test("keeps an older rejected send before newer successful computer replies", () => {
    const canonical: ChatMessage[] = [
      { id: "first", role: "user", text: "First", createdAt: 100 },
      { id: "first-reply", role: "assistant", requestId: "first", text: "First reply", createdAt: 200 },
      { id: "third", role: "user", text: "Third", createdAt: 500 },
      { id: "third-reply", role: "assistant", requestId: "third", text: "Third reply", createdAt: 600 },
    ];
    const merged = mergeCanonicalCloudMessages({
      canonical,
      local: [
        { id: "second", role: "user", text: "Second", createdAt: 300 },
        { id: "second-error", role: "assistant", requestId: "second", text: "Computer unavailable", createdAt: 300 },
      ],
      dispatchBindings: new Map([["second", "blocked-dispatch"]]),
      acknowledgedDispatchIds: new Set(),
    });
    expect(merged.map(row => row.id)).toEqual([
      "first", "first-reply", "second", "second-error", "third", "third-reply",
    ]);
  });

  test("keeps an optimistic reply after its canonical user even with clock skew", () => {
    const merged = mergeCanonicalCloudMessages({
      canonical: [{ id: "user", role: "user", text: "Hello", createdAt: 200 }],
      local: [{ id: "pending", role: "assistant", requestId: "user", text: "", createdAt: 100 }],
      dispatchBindings: new Map([["user", "dispatch"]]),
      acknowledgedDispatchIds: new Set(["dispatch"]),
    });
    expect(merged.map(row => row.id)).toEqual(["user", "pending"]);
  });

  test("projects structured attachments and removes only their exact generated transport suffix", () => {
    const text = "What plant is this?\n\nAttached in my drive:\n- Photos/plant.jpg";
    const project = (paths?: string[]) => projectCloudConversationMessages({ records: [message({
      kind: "message", seq: 1, turnId: "photo-turn", role: "user", hidden: false,
      clientMsgId: "photo-send", payload: { content: text,
        ...(paths ? { providerContext: { attachments: paths } } : {}) },
    })] })[0]!;
    expect(project(["Photos/plant.jpg"])).toMatchObject({
      text: "What plant is this?", attachmentPaths: ["Photos/plant.jpg"],
      attachmentPreviews: [{ path: "Photos/plant.jpg", name: "plant.jpg" }],
    });
    expect(project().text).toBe(text);
    expect(project(["Photos/other.jpg"]).text).toBe(text);
  });

  test("keeps authored attachment wording before the exact structured suffix", () => {
    const authored = "Explain this phrase: Attached in my drive:\n- Photos/plant.jpg";
    const [projected] = projectCloudConversationMessages({ records: [message({
      kind: "message", seq: 1, turnId: "photo-turn", role: "user", hidden: false,
      payload: { content: authored + "\n\nAttached in my drive:\n- Photos/plant.jpg",
        providerContext: { attachments: ["Photos/plant.jpg"] } },
    })] });
    expect(projected?.text).toBe(authored);
  });

  test("keeps the picked image preview through canonical acknowledgement by identity", () => {
    const [canonical] = projectCloudConversationMessages({ records: [message({
      kind: "message", seq: 1, turnId: "photo-turn", role: "user", hidden: false,
      clientMsgId: "dispatch", payload: { originUserMessageId: "local-photo", content: "Look",
        providerContext: { attachments: ["Photos/plant.jpg"] } },
    })] });
    const merged = mergeCanonicalCloudMessages({ canonical: [canonical!],
      local: [{ id: "local-photo", role: "user", text: "Look", thumbnailUris: ["file:///plant.jpg"],
        attachmentPreviews: [{ path: "Photos/plant.jpg", name: "plant.jpg", imageUri: "file:///plant.jpg" }] }],
      dispatchBindings: new Map([["local-photo", "dispatch"]]), acknowledgedDispatchIds: new Set(["dispatch"]),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.attachmentPreviews?.[0]?.imageUri).toBe("file:///plant.jpg");
    expect(merged[0]?.thumbnailUris).toEqual(["file:///plant.jpg"]);
  });

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

  test("projects a cloud map call, a map lifted out of code, and a drive-backed html canvas", () => {
    const map = {
      kind: "map-route",
      version: 1,
      title: "Coffee",
      markers: [{ id: "m1", name: "Blue Bottle", lat: 37.78, lng: -122.4, role: "place" }],
    };
    const records: JournalRecord[] = [
      message({ kind: "message", seq: 1, turnId: "t1", role: "user", hidden: false, payload: { content: "Coffee near me?" } }),
      message({
        kind: "message", seq: 2, turnId: "t1", role: "assistant", hidden: false,
        payload: { content: [
          { type: "toolCall", id: "call-map", name: "map", arguments: { places: ["Blue Bottle"] } },
          { type: "toolCall", id: "call-code", name: "code", arguments: { code: "await tools.map({})" } },
          { type: "toolCall", id: "call-html", name: "html", arguments: { slug: "coffee-guide" } },
        ] },
      }),
      message({
        kind: "message", seq: 3, turnId: "t1", role: "toolResult", hidden: true,
        payload: { toolCallId: "call-map", toolName: "map", content: "Pinned 1 place.", details: { map } },
      }),
      message({
        kind: "message", seq: 4, turnId: "t1", role: "toolResult", hidden: true,
        payload: { toolCallId: "call-code", toolName: "code", content: "ok", details: { code: { ok: true }, maps: [map, { kind: "not-a-map" }] } },
      }),
      message({
        kind: "message", seq: 5, turnId: "t1", role: "toolResult", hidden: true,
        payload: { toolCallId: "call-html", toolName: "html", content: "saved", details: { filePath: "outputs/html/coffee-guide.html", driveBacked: true } },
      }),
      { kind: "card", seq: 6, turnId: "t1", createdAtMs: 60, card: { type: "files", files: [
        { path: "outputs/html/coffee-guide.html", name: "coffee-guide.html", sizeBytes: 1200, contentType: "text/html; charset=utf-8", stored: true },
      ] } } as JournalRecord,
      message({ kind: "message", seq: 7, turnId: "t1", role: "assistant", hidden: false, payload: { content: "Here you go." } }),
    ];
    const messages = projectCloudConversationMessages({ conversationId: "conv-1", records });
    const withMaps = messages.find((entry) => entry.artifacts?.some((artifact) => artifact.payload.kind === "map-route"));
    const maps = withMaps?.artifacts?.filter((artifact) => artifact.payload.kind === "map-route") ?? [];
    expect(maps.map((artifact) => artifact.id)).toEqual([
      "cloud:t1:map:call-map:0",
      "cloud:t1:map:call-code:0",
    ]);
    expect(maps[0]?.payload).toMatchObject({ kind: "map-route", version: 1, title: "Coffee" });
    const canvas = messages
      .flatMap((entry) => entry.artifacts ?? [])
      .find((artifact) => artifact.payload.kind === "canvas-html");
    expect(canvas?.payload).toMatchObject({
      kind: "canvas-html",
      filePath: "outputs/html/coffee-guide.html",
      slug: "coffee-guide",
      title: "Coffee Guide",
      driveBacked: true,
    });
  });
});
