import { describe, expect, it } from "vitest";
import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";
import {
  buildUsageTimeline,
  filterUsageRecords,
  groupUsageByThread,
  summarizeUsage,
} from "../../../src/app/usage/usage-data";

const record = (
  overrides: Partial<LocalModelUsageRecord>,
): LocalModelUsageRecord => ({
  id: "call-1",
  timestamp: new Date("2026-08-08T12:00:00Z").getTime(),
  conversationId: "conversation-1",
  conversationTitle: "Evaluation",
  threadId: "thread-orchestrator",
  threadName: "Orchestrator",
  agentType: "orchestrator",
  provider: "fireworks",
  api: "openai-responses",
  model: "deepseek-v4-flash",
  inputTokens: 100,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  outputTokens: 50,
  reasoningTokens: 20,
  totalTokens: 450,
  inputCostUsd: 0.001,
  cacheReadCostUsd: 0.001,
  cacheWriteCostUsd: 0,
  outputCostUsd: 0.002,
  totalCostUsd: 0.004,
  stopReason: "stop",
  ...overrides,
});

describe("usage data", () => {
  it("aggregates cost, token classes, and cache rate without double-counting reasoning", () => {
    const summary = summarizeUsage([
      record({}),
      record({
        id: "call-2",
        inputTokens: 100,
        cacheReadTokens: 0,
        outputTokens: 40,
        reasoningTokens: 10,
        totalTokens: 140,
        totalCostUsd: 0.006,
      }),
    ]);
    expect(summary).toMatchObject({
      calls: 2,
      inputTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 90,
      reasoningTokens: 30,
      totalTokens: 590,
      totalCostUsd: 0.01,
      cacheReadRate: 0.6,
    });
  });

  it("filters and groups orchestrator and nested agent threads", () => {
    const records = [
      record({}),
      record({
        id: "call-2",
        threadId: "thread-agent",
        threadName: "Inspect pricing",
        agentType: "general",
        agentDepth: 2,
        totalCostUsd: 0.02,
      }),
    ];
    expect(filterUsageRecords(records, { agentType: "general" })).toHaveLength(
      1,
    );
    expect(groupUsageByThread(records)).toEqual([
      expect.objectContaining({
        threadId: "thread-agent",
        agentType: "general",
        agentDepth: 2,
        totalCostUsd: 0.02,
      }),
      expect.objectContaining({ threadId: "thread-orchestrator" }),
    ]);
  });

  it("tracks per-thread time span, latest metadata, and distinct models", () => {
    const earlier = new Date("2026-08-08T10:00:00Z").getTime();
    const later = new Date("2026-08-08T14:00:00Z").getTime();
    const [group] = groupUsageByThread([
      record({ id: "call-2", timestamp: later, threadName: "Renamed" }),
      record({ id: "call-1", timestamp: earlier, model: "deepseek-v4" }),
    ]);
    expect(group).toMatchObject({
      firstAt: earlier,
      lastAt: later,
      threadName: "Renamed",
      models: ["deepseek-v4-flash", "deepseek-v4"],
    });
  });

  it("buckets a seven-day timeline by local day", () => {
    const points = buildUsageTimeline(
      [
        record({}),
        record({
          id: "call-2",
          timestamp: new Date("2026-08-09T03:00:00Z").getTime(),
        }),
      ],
      "7d",
    );
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points.reduce((total, point) => total + point.calls, 0)).toBe(2);
  });
});
