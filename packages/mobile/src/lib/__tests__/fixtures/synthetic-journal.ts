import type { JournalRecord } from "../../cloud-conversation-protocol";

type Unsequenced = JournalRecord extends infer R
  ? R extends JournalRecord
    ? Omit<R, "seq" | "createdAtMs">
    : never
  : never;

/**
 * A deterministic, realistically shaped DO journal for performance ratchets:
 * each turn is a prompt, a tool call with its result, a markdown reply and the
 * turn's phases. Every fifth turn spawns a task whose completion is relayed by
 * the next turn's reply, so the lifecycle projection has work to do.
 */
export const syntheticJournal = (turns: number): JournalRecord[] => {
  const records: JournalRecord[] = [];
  let seq = 0;
  const push = (record: Unsequenced) => {
    seq += 1;
    records.push({ ...record, seq, createdAtMs: 1_700_000_000_000 + seq * 1_000 } as JournalRecord);
  };
  const reply = (turn: number) =>
    [
      `## Result ${turn}`,
      "",
      `Here is what I found for request ${turn}. The **important** part is that`,
      "the list below covers each option with `inline code` and a [link](https://example.com).",
      "",
      "- First option with some explanatory text that wraps onto a second line",
      "- Second option, also fairly long so the paragraph has realistic weight",
      "- Third option",
      "",
      "```ts",
      `const answer${turn} = compute(${turn});`,
      "```",
    ].join("\n");
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    push({ kind: "turn", turnId, phase: "started" });
    push({
      kind: "message", turnId, role: "user", hidden: false, clientMsgId: `send-${turn}`,
      payload: { content: `Question number ${turn}: can you look into this for me?` },
    });
    push({
      kind: "message", turnId, role: "assistant", hidden: false,
      payload: { content: [{ type: "toolCall", id: `call-${turn}`, name: "web_search", arguments: { query: `q${turn}` } }] },
    });
    push({
      kind: "message", turnId, role: "toolResult", hidden: false,
      payload: { toolCallId: `call-${turn}`, content: [{ type: "text", text: "result ".repeat(40) }] },
    });
    if (turn % 5 === 0) {
      push({
        kind: "card", turnId,
        card: { type: "agent-lifecycle", eventId: `event-start-${turn}`, event: {
          type: "agent-started",
          payload: { agentId: `agent-${turn}`, attemptGeneration: 1, description: `Task ${turn}`, isFollowUp: false },
        } },
      } as unknown as Unsequenced);
    }
    if (turn % 5 === 1) {
      push({
        kind: "card", turnId,
        card: { type: "agent-lifecycle", eventId: `event-done-${turn}`, event: {
          type: "agent-completed",
          payload: { agentId: `agent-${turn - 1}`, attemptGeneration: 1, result: "Finished the task." },
        } },
      } as unknown as Unsequenced);
    }
    push({
      kind: "message", turnId, role: "assistant", hidden: false,
      payload: { content: [{ type: "text", text: reply(turn) }] },
    });
    push({ kind: "turn", turnId, phase: "completed" });
  }
  return records;
};
