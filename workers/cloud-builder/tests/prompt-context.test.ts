import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  preparePromptContext,
  beforeUserContext,
  materializeProviderContext,
  promptContextCheckpointChanged,
  promptContextHistoryStartAfterSeq,
  reusablePromptContext,
} from "../src/prompt-context.js";
import { stampUserMessageSequences } from "../src/journal.js";
import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";

const policy = {
  ownerGeneration: "owner-1",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 0,
  updatedAt: 0,
};
const tool = (
  description: string,
  result: string,
  name = "test",
): AgentTool => ({
  name,
  description,
  label: name,
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: result }],
    details: {},
  }),
});
const input = {
  policy,
  systemPrompt: "initial memory/personality/locale/skills",
  tools: [tool("initial description", "turn-1")],
  startSeq: 1,
  journalEpoch: 1,
};

describe("cloud prompt context", () => {
  test("freezes bytes across restart, appends updates once, and binds fresh executable closures", async () => {
    const first = preparePromptContext(input);
    const second = preparePromptContext({
      ...input,
      previous: structuredClone(first.state),
      systemPrompt: "updated memory/personality/locale/skills",
      tools: [tool("updated description", "turn-2")],
    });
    expect(second.state.systemPrompt).toBe(first.state.systemPrompt);
    expect(JSON.stringify(second.state.tools)).toBe(
      JSON.stringify(first.state.tools),
    );
    expect(second.boundary).toBe(false);
    expect(await beforeUserContext("hello", second.deltas)).toHaveLength(2);
    expect(await second.tools[0]!.execute("id", {})).toMatchObject({
      content: [{ text: "turn-2" }],
    });
    expect(
      preparePromptContext({
        ...input,
        previous: second.state,
        systemPrompt: second.state.latestSystemPrompt,
        tools: [tool("updated description", "turn-3")],
      }).deltas,
    ).toEqual([]);
    const unchanged = preparePromptContext({
      ...input,
      previous: second.state,
      systemPrompt: second.state.latestSystemPrompt,
      tools: [tool("updated description", "turn-4")],
    });
    expect(unchanged.state).toBe(second.state);
    expect(unchanged.boundary).toBe(false);
    const reverted = preparePromptContext({ ...input, previous: second.state });
    expect(reverted.deltas).toHaveLength(2);
    expect(reverted.state).not.toBe(second.state);
  });

  test("holds added tools, disables removed ones, and adopts the new descriptors at a history boundary", async () => {
    const first = preparePromptContext(input);
    const changed = {
      ...input,
      previous: first.state,
      tools: [tool("new description", "new result", "new_tool")],
    };
    const held = preparePromptContext(changed);
    expect(held.tools.map((entry) => entry.name)).toEqual(["test"]);
    expect(await held.tools[0]!.execute("id", {})).toMatchObject({
      details: { unavailable: true },
    });
    const compacted = preparePromptContext({ ...changed, startSeq: 50 });
    expect(compacted.boundary).toBe(true);
    expect(compacted.tools.map((entry) => entry.name)).toEqual(["new_tool"]);
    expect(compacted.deltas).toEqual([]);
  });

  test("live prompt and next-turn replay have identical timestamp, sequence tag, and hidden updates", async () => {
    const context = preparePromptContext(input);
    const canonical = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 123,
      providerContext: {
        version: 1,
        epoch: context.state.epoch,
        clock: "2026-09-04T00:00:00.000Z",
        prepend: await beforeUserContext("hello", ["updated memory"]),
      },
    } as AgentMessage;
    const rows = [{ seq: 10, role: "user", hidden: false }];
    const live = materializeProviderContext(
      stampUserMessageSequences([canonical], rows),
      context.state.epoch,
    );
    const replay = materializeProviderContext(
      stampUserMessageSequences([JSON.parse(JSON.stringify(canonical))], rows),
      context.state.epoch,
    );
    expect(replay).toEqual(live);
    expect(JSON.stringify(live)).toContain("current-time");
    expect(canonical).toMatchObject({ content: [{ text: "hello" }] });
    expect(live).toHaveLength(2);
  });

  test("permission and wipe boundaries remove old context updates immediately", () => {
    const first = preparePromptContext(input);
    for (const changed of [
      { ...policy, memoryEnabled: false },
      { ...policy, memoryEpoch: "epoch-2" },
      { ...policy, ownerGeneration: "owner-2" },
    ]) {
      const fresh = preparePromptContext({
        ...input,
        previous: first.state,
        policy: changed,
        systemPrompt: "safe current context",
      });
      expect(fresh.boundary).toBe(true);
      expect(fresh.state.systemPrompt).toBe("safe current context");
      const replay = materializeProviderContext(
        [
          {
            role: "user",
            content: "hello",
            timestamp: 0,
            providerContext: {
              version: 1,
              epoch: first.state.epoch,
              clock: "then",
              prepend: ["revoked memory"],
            },
          } as AgentMessage,
        ],
        fresh.state.epoch,
      );
      expect(JSON.stringify(replay)).not.toContain("revoked memory");
    }
  });

  test("invalidated context does not reuse an old checkpoint or filter history", () => {
    const stored = preparePromptContext(input).state;
    const storedCheckpoint = {
      coveredThroughSeq: 42,
      summary: "old summary from another owner or journal epoch",
    };

    for (const invalidated of [
      {
        storedContext: { ...stored, ownerGeneration: "owner-2" },
        ownerGeneration: "owner-1",
        journalEpoch: stored.journalEpoch,
      },
      {
        storedContext: { ...stored, journalEpoch: stored.journalEpoch - 1 },
        ownerGeneration: stored.ownerGeneration,
        journalEpoch: stored.journalEpoch,
      },
    ]) {
      const previousContext = reusablePromptContext(invalidated);
      const previousCheckpoint = previousContext ? storedCheckpoint : undefined;

      expect(previousContext).toBeUndefined();
      expect(previousCheckpoint).toBeUndefined();
      expect(
        promptContextHistoryStartAfterSeq({
          previousContext,
          previousCheckpoint,
        }),
      ).toBe(-1);
      expect(
        promptContextCheckpointChanged({
          storedContext: invalidated.storedContext,
          previousContext,
          storedCheckpoint,
          nextCheckpoint: undefined,
        }),
      ).toBe(true);
    }
  });
});
