import { describe, expect, test } from "bun:test";
import { ReplyArrivalHaptics } from "../reply-arrival-haptics";
import {
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "../cloud-journal-projection";
import type {
  JournalRecord,
  JournalMessageRecord,
  TurnPhase,
} from "../cloud-conversation-protocol";
const prompt = (
  id = "send-1",
  turnId = "turn-1",
  seq = 1,
): JournalMessageRecord => ({
  kind: "message",
  role: "user",
  hidden: false,
  seq,
  turnId,
  createdAtMs: seq,
  clientMsgId: `dispatch-${id}`,
  payload: { content: "hello", originUserMessageId: id },
});
const answer = (turnId = "turn-1", seq = 3): JournalMessageRecord => ({
  kind: "message",
  role: "assistant",
  hidden: false,
  seq,
  turnId,
  createdAtMs: seq,
  payload: { content: "Here is your reply." },
});
const terminal = (phase: TurnPhase): JournalRecord => ({
  kind: "turn",
  phase,
  seq: 4,
  turnId: "turn-1",
  createdAtMs: 4,
});
const display = (records: JournalRecord[]) =>
  projectCloudConversationMessages({ records });
describe("assistant reply arrival haptics", () => {
  test("notifies on displayed canonical reply before terminal; never on replay or delayed completion", () => {
    const tracker = new ReplyArrivalHaptics();
    tracker.arm("send-1");
    expect(tracker.take(display([prompt()]), [prompt()])).toEqual([]);
    const records = [prompt(), answer()];
    expect(tracker.take(display(records), records)).toEqual(["send-1"]);
    expect(tracker.take(display(records), records)).toEqual([]);
    const completed = [...records, terminal("completed")];
    expect(tracker.take(display(completed), completed)).toEqual([]);
  });
  test("legacy Computer admission rebind connects dispatch to local send identity", () => {
    const tracker = new ReplyArrivalHaptics();
    tracker.arm("send-1");
    const user = prompt();
    delete user.payload.originUserMessageId;
    const records = [user, answer()];
    const canonical = display(records);
    expect(tracker.take(canonical, records)).toEqual([]);
    expect(
      tracker.take(
        rebindCanonicalCloudMessages(
          canonical,
          new Map([["send-1", "dispatch-send-1"]]),
        ),
        records,
      ),
    ).toEqual(["send-1"]);
  });
  test("history, restored outbox and unrelated replies do not arm haptics", () => {
    const tracker = new ReplyArrivalHaptics();
    const records = [prompt(), answer(), terminal("completed")];
    expect(tracker.take(display(records), records)).toEqual([]);
    tracker.arm("new-send");
    expect(tracker.take(display(records), records)).toEqual([]);
  });
  test("atomic live head advancement preserves eligibility; reconnect replay retires it", () => {
    const tracker = new ReplyArrivalHaptics();
    tracker.arm("send-1");
    const records = [prompt(), answer()];
    tracker.observeConnection({
      status: "live",
      epoch: 1,
      headSeq: 3,
      records,
    });
    expect(tracker.take(display(records), records)).toEqual(["send-1"]);
    tracker.arm("send-1");
    tracker.observeConnection({
      status: "live",
      epoch: 1,
      headSeq: 3,
      records: [prompt()],
    });
    tracker.observeConnection({
      status: "live",
      epoch: 1,
      headSeq: 3,
      records,
    });
    expect(tracker.take(display(records), records)).toEqual([]);
    tracker.arm("send-1");
    tracker.observeConnection({
      status: "connecting",
      epoch: 1,
      headSeq: 3,
      records,
    });
    expect(tracker.take(display(records), records)).toEqual([]);
  });
  test("stop/background/unmount reset and a new authority instance have no pending replies", () => {
    const tracker = new ReplyArrivalHaptics();
    tracker.arm("send-1");
    tracker.reset();
    const records = [prompt(), answer()];
    expect(tracker.take(display(records), records)).toEqual([]);
    expect(new ReplyArrivalHaptics().take(display(records), records)).toEqual(
      [],
    );
  });
  test.each(["failed", "canceled", "timeout"] as const)(
    "%s turns and synthetic notices never notify",
    (phase) => {
      const tracker = new ReplyArrivalHaptics();
      tracker.arm("send-1");
      const records = [prompt(), terminal(phase)];
      expect(tracker.take(display(records), records)).toEqual([]);
      const late = [prompt(), answer(), terminal(phase)];
      expect(tracker.take(display(late), late)).toEqual([]);
    },
  );
  test("hidden, empty, tool preamble and error rows do not notify", () => {
    for (const reply of [
      { ...answer(), hidden: true },
      { ...answer(), payload: { content: "" } },
      {
        ...answer(),
        payload: {
          content: [
            { type: "text", text: "Looking" },
            { type: "toolCall", id: "t", name: "Search" },
          ],
        },
      },
      { ...answer(), payload: { content: "Failed", stopReason: "error" } },
    ]) {
      const tracker = new ReplyArrivalHaptics();
      tracker.arm("send-1");
      const records = [prompt(), reply];
      expect(tracker.take(display(records), records)).toEqual([]);
    }
  });
  test("consecutive fresh sends notify once each", () => {
    const tracker = new ReplyArrivalHaptics();
    tracker.arm("send-1");
    tracker.arm("send-2");
    const first = [prompt(), answer()];
    expect(tracker.take(display(first), first)).toEqual(["send-1"]);
    const both = [...first, prompt("send-2", "turn-2", 5), answer("turn-2", 7)];
    expect(tracker.take(display(both), both)).toEqual(["send-2"]);
    expect(tracker.take(display(both), both)).toEqual([]);
  });
});
