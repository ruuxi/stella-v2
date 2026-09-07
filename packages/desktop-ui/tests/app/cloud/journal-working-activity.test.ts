import { describe, expect, it } from "vitest";
import { journalWorkingActivity } from "@stella/contracts/journal-working-activity";
const message = (role: string, payload: Record<string, unknown>, extras = {}) =>
  ({ kind: "message", turnId: "turn", role, payload, ...extras });
const tool = (id: string, name: string) => ({ type: "toolCall", id, name });
describe("journal working activity", () => {
  it("recovers device tools and settles overlapping calls by id", () => {
    const records = [message("assistant", {content: [tool("one", "spawn_agent"), tool("two", "code")]})];
    expect(journalWorkingActivity(records, "turn")).toMatchObject({ toolName: "code", answerLanded: false });
    records.push(message("toolResult", { toolCallId: "two" }));
    expect(journalWorkingActivity(records, "turn")).toMatchObject({ toolName: "spawn_agent", toolCallId: "one" });
    records.push(message("toolResult", { toolCallId: "one" }));
    expect(journalWorkingActivity(records, "turn").toolName).toBeUndefined();
  });
  it("hands off on visible final text but not preambles or hidden messages", () => {
    const records = [message("assistant", {content: [tool("one", "code")]})];
    records.push(message("assistant", { content: "internal" }, {hidden:true}));
    expect(journalWorkingActivity(records, "turn").answerLanded).toBe(false);
    records.push(message("assistant", { content: "checking", followedByToolCall:true }));
    expect(journalWorkingActivity(records, "turn").answerLanded).toBe(false);
    records.push(message("assistant", {content: "done"}));
    expect(journalWorkingActivity(records, "turn")).toEqual({answerLanded:true,hasToolActivity:true});
  });
});
