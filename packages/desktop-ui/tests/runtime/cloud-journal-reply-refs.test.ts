/**
 * Cloud-mode reply references: the journal keeps the model-facing `refs`
 * fence, the projection strips it from the rendered text and resolves the
 * citations against the loaded window, and a lifecycle turn that cited
 * nothing still attaches to the agent named in its hidden prompt.
 */
import { describe, expect, it } from "vitest";
import { journalRecordsToMessageRecords } from "@/features/cloud/journal-message-records";
import type { JournalRecord } from "@/features/cloud/conversation-protocol";
import { countReplyRefs } from "@/features/chat/services/reply-counts-store";
import { replyRefsFromPayload } from "@/features/chat/lib/reply-refs";

const message = (
  seq: number,
  turnId: string,
  role: "user" | "assistant",
  text: string,
  extra: Partial<Extract<JournalRecord, { kind: "message" }>> = {},
): JournalRecord => ({
  kind: "message",
  seq,
  turnId,
  createdAtMs: 1_000 + seq,
  role,
  hidden: false,
  payload: { role, content: [{ type: "text", text }], timestamp: 1_000 + seq },
  ...extra,
});

describe("cloud journal reply refs", () => {
  it("strips the fence and resolves message and agent citations", () => {
    const records: JournalRecord[] = [
      message(1, "t1", "user", "Compare vendor pricing", { clientMsgId: "u1" }),
      message(2, "t1", "assistant", "On it."),
      message(3, "t2", "user", "Any news?", { clientMsgId: "u2" }),
      message(
        4,
        "t2",
        "assistant",
        "Yes: done.\n\n```refs\n#1\nagent:pricing-research\n#3\n```",
      ),
    ];
    const messages = journalRecordsToMessageRecords(records);
    const reply = messages.find((m) => m._id === "cloud:t2:message:4");
    expect(reply?.payload?.text).toBe("Yes: done.");
    expect(replyRefsFromPayload(reply?.payload)).toEqual([
      {
        kind: "message",
        sequence: 1,
        id: "u1",
        role: "user",
        preview: "Compare vendor pricing",
      },
      {
        kind: "agent",
        threadId: "pricing-research",
        title: "pricing-research",
      },
    ]);
    expect(countReplyRefs(messages)).toEqual({
      messages: { u1: 1 },
      agents: { "pricing-research": 1 },
    });
  });

  it("falls back to the agent named in a hidden lifecycle prompt", () => {
    const records: JournalRecord[] = [
      message(
        7,
        "t3",
        "user",
        "[Agent completed]\ndescription: Pricing research\nthread_id: pricing-research\nresult: ok",
        { hidden: true },
      ),
      message(8, "t3", "assistant", "Pricing research is finished."),
    ];
    const messages = journalRecordsToMessageRecords(records);
    const reply = messages.find((m) => m._id === "cloud:t3:message:8");
    expect(reply?.payload?.text).toBe("Pricing research is finished.");
    expect(replyRefsFromPayload(reply?.payload)).toEqual([
      {
        kind: "agent",
        threadId: "pricing-research",
        title: "pricing-research",
      },
    ]);
  });

  it("ignores unknown sequence numbers and never keeps a fence in the text", () => {
    const records: JournalRecord[] = [
      message(1, "t1", "user", "hi", { clientMsgId: "u1" }),
      message(2, "t1", "assistant", "hello\n\n```refs\n#999\n```"),
    ];
    const messages = journalRecordsToMessageRecords(records);
    const reply = messages.find((m) => m._id === "cloud:t1:message:2");
    expect(reply?.payload?.text).toBe("hello");
    expect(replyRefsFromPayload(reply?.payload)).toEqual([]);
  });
});
