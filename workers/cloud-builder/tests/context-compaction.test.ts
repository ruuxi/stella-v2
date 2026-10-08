import { expect, test } from "bun:test";
import { compactCloudHistory } from "../src/context-compaction.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";

// An 8k window compacts at 8k tokens and keeps an 800-token tail.
const policy = {
  contextWindow: 8_000,
  modelMaxTokens: 4_000,
  systemPrompt: "You write checkpoint summaries.",
  retryDelaysMs: [],
};
const messages = [
  {
    role: "user",
    content: `Remember the launch date is Friday.\n${"background ".repeat(400)}`,
    timestamp: 1,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "I'll use Friday." }],
    usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
    timestamp: 2,
  },
  { role: "user", content: "What remains?", timestamp: 3 },
] as AgentMessage[];
const rows = messages.map((message, index) => ({
  seq: index + 1,
  role: message.role,
  hidden: false,
}));

test("compaction summarizes the old span and keeps the recent tail verbatim", async () => {
  let request = "";
  const result = await compactCloudHistory({
    ...policy,
    messages,
    rows,
    summarize: async ({ prompt }) => {
      request = prompt;
      return "The launch is Friday.";
    },
  });
  expect(request).toContain("launch date is Friday");
  expect(result.compacted).toBe(true);
  expect(result.messages).toEqual([messages[1]!, messages[2]!]);
  expect(result.checkpoint).toEqual({
    coveredThroughSeq: 1,
    summary: "The launch is Friday.",
    writtenAtSeq: 3,
  });

  // The size reported before the compaction no longer counts.
  let calls = 0;
  const next = await compactCloudHistory({
    ...policy,
    messages: result.messages,
    rows: result.rows,
    checkpoint: structuredClone(result.checkpoint),
    summarize: async () => {
      calls++;
      return "unexpected";
    },
  });
  expect(next.compacted).toBe(false);
  expect(calls).toBe(0);
});

test("a failed summary leaves the checkpoint and history as they were", async () => {
  const checkpoint = { coveredThroughSeq: 0, summary: "Earlier summary" };
  const result = await compactCloudHistory({
    ...policy,
    messages,
    rows,
    checkpoint,
    summarize: async () => "",
  });
  expect(result.compacted).toBe(false);
  expect(result.checkpoint).toEqual({
    coveredThroughSeq: 0,
    summary: "Earlier summary",
  });
  expect(result.messages).toHaveLength(3);
});
