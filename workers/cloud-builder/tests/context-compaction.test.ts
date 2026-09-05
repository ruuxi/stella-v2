import { expect, test } from "bun:test";
import { compactCloudHistory } from "../src/context-compaction.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
const messages = [
  { role: "user", content: "Remember the launch date is Friday", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: "I'll use Friday." }],
    timestamp: 2,
  },
  { role: "user", content: "What remains?", timestamp: 3 },
] as AgentMessage[];
const rows = messages.map((message, index) => ({
  seq: index + 1,
  role: message.role,
  hidden: false,
}));
test("compaction summarizes the removed prefix and preserves the recent user boundary", async () => {
  let request = "";
  const result = await compactCloudHistory({
    messages,
    rows,
    threshold: 1,
    keepTokens: 25,
    summarize: async (prompt) => {
      request = prompt;
      return "The launch is Friday.";
    },
  });
  expect(request).toContain("launch date is Friday");
  expect(result.compacted).toBe(true);
  expect(result.messages).toEqual([messages[2]!]);
  expect(result.checkpoint).toEqual({
    coveredThroughSeq: 2,
    summary: "The launch is Friday.",
  });
  let calls = 0;
  const next = await compactCloudHistory({
    messages: result.messages,
    rows: result.rows,
    checkpoint: structuredClone(result.checkpoint),
    summarize: async () => {
      calls++;
      return "unexpected";
    },
  });
  expect(next.checkpoint).toEqual(result.checkpoint);
  expect(calls).toBe(0);
});
test("a failed summary never replaces the checkpoint or discards history", async () => {
  const checkpoint = { coveredThroughSeq: 0, summary: "Earlier summary" };
  await expect(
    compactCloudHistory({
      messages,
      rows,
      checkpoint,
      threshold: 1,
      keepTokens: 25,
      summarize: async () => "",
    }),
  ).rejects.toThrow("invalid summary");
  expect(checkpoint).toEqual({
    coveredThroughSeq: 0,
    summary: "Earlier summary",
  });
  expect(messages).toHaveLength(3);
});
