import { describe, expect, it } from "vitest";
import {
  countLeadingBootstrapStartupDocs,
  formatThreadCheckpointMessage,
  resolveCompactionProtectHeadMessages,
  splitThreadMessagesForCompaction,
} from "@stella/runtime/kernel/thread-runtime";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { PersistedRuntimeThreadPayload } from "@stella/runtime/kernel/storage/shared";

const createBootstrapDoc = (entryId: string, timestamp: number) => ({
  entryId,
  timestamp,
  role: "runtimeInternal" as const,
  content: "<startup_doc>...</startup_doc>",
  customMessage: {
    customType: "bootstrap.startup_doc",
    content: [{ type: "text" as const, text: "startup doc" }],
    display: false,
  },
});

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const createUserPayload = (
  content: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "user",
  content,
  timestamp,
});

const createAssistantToolCallPayload = (
  toolCallId: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: toolCallId,
      name: "Read",
      arguments: { path: "src/example.ts" },
    },
  ],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: zeroUsage,
  stopReason: "toolUse",
  timestamp,
});

const createAssistantTextPayload = (
  text: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp,
});

const createToolResultPayload = (
  toolCallId: string,
  text: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "toolResult",
  toolCallId,
  toolName: "Read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

describe("thread-runtime compaction planning", () => {
  it("keeps assistant tool calls and tool results in the same compacted segment", () => {
    const plan = splitThreadMessagesForCompaction(
      [
        {
          entryId: "m1",
          timestamp: 1,
          role: "user",
          content: "Head message",
          payload: createUserPayload("Head message", 1),
        },
        {
          entryId: "m2",
          timestamp: 2,
          role: "assistant",
          content: "Read(src/example.ts)",
          payload: createAssistantToolCallPayload("call-1", 2),
        },
        {
          entryId: "m3",
          timestamp: 3,
          role: "toolResult",
          content: "File contents",
          toolCallId: "call-1",
          payload: createToolResultPayload("call-1", "File contents", 3),
        },
        {
          entryId: "m4",
          timestamp: 4,
          role: "user",
          content: "Most recent user message",
          payload: createUserPayload("Most recent user message", 4),
        },
      ],
      1,
      1,
      1,
    );

    expect(plan).toMatchObject({
      fromEntryId: "m2",
      toEntryId: "m3",
    });
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "m2",
      "m3",
    ]);
  });

  it("reuses an existing checkpoint summary on subsequent compactions", () => {
    const plan = splitThreadMessagesForCompaction(
      [
        {
          entryId: "m1",
          timestamp: 1,
          role: "user",
          content: "Head message",
          payload: createUserPayload("Head message", 1),
        },
        {
          entryId: "m2",
          timestamp: 2,
          role: "assistant",
          content: formatThreadCheckpointMessage({ summary: "Earlier summary" }),
        },
        {
          entryId: "m3",
          timestamp: 3,
          role: "user",
          content: "Older message",
          payload: createUserPayload("Older message", 3),
        },
        {
          entryId: "m4",
          timestamp: 4,
          role: "assistant",
          content: "Worked on the task",
          payload: createAssistantTextPayload("Worked on the task", 4),
        },
        {
          entryId: "m5",
          timestamp: 5,
          role: "user",
          content: "Tail message",
          payload: createUserPayload("Tail message", 5),
        },
      ],
      1,
      1,
      1,
    );

    expect(plan).toMatchObject({
      previousSummary: "Earlier summary",
      fromEntryId: "m3",
      toEntryId: "m4",
    });
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "m3",
      "m4",
    ]);
  });
});

describe("latest user instruction pinning (bounded)", () => {
  const buildThread = (latestUserContent: string) => [
    {
      entryId: "spawn",
      timestamp: 1,
      role: "user" as const,
      content: "Spawn prompt: do the task",
      payload: createUserPayload("Spawn prompt: do the task", 1),
    },
    {
      entryId: "mid-1",
      timestamp: 2,
      role: "assistant" as const,
      content: `working ${"x".repeat(8_000)}`,
      payload: createAssistantTextPayload(`working ${"x".repeat(8_000)}`, 2),
    },
    {
      entryId: "follow-up",
      timestamp: 3,
      role: "user" as const,
      content: latestUserContent,
      payload: createUserPayload(latestUserContent, 3),
    },
    {
      entryId: "mid-2",
      timestamp: 4,
      role: "assistant" as const,
      content: `more work ${"x".repeat(8_000)}`,
      payload: createAssistantTextPayload(`more work ${"x".repeat(8_000)}`, 4),
    },
    {
      entryId: "tail-1",
      timestamp: 5,
      role: "assistant" as const,
      content: "recent tail reply",
      payload: createAssistantTextPayload("recent tail reply", 5),
    },
  ];

  it("reports a follow-up instruction summarized into the middle without moving the tail cut", () => {
    const messages = buildThread("Follow-up task\n\nNow do the next thing");
    const plan = splitThreadMessagesForCompaction(messages, 1, 100, 1);

    // The tail cut is decided purely by the token budget — the middle still
    // swallows the follow-up (no unbounded tail-shift back to it).
    expect(plan).toMatchObject({
      fromEntryId: "mid-1",
      toEntryId: "mid-2",
    });
    // ...but the plan carries the follow-up for verbatim pinning.
    expect(plan?.latestUserMessage?.entryId).toBe("follow-up");
  });

  it("reports an active-steer Task update the same way", () => {
    const messages = buildThread("Task update: switch to the other branch");
    const plan = splitThreadMessagesForCompaction(messages, 1, 100, 1);

    expect(plan?.latestUserMessage?.entryId).toBe("follow-up");
    expect(plan?.latestUserMessage?.content).toContain("Task update:");
  });

  it("does not pin when the latest user message survives in the kept tail", () => {
    const messages = [
      ...buildThread("older follow-up"),
      {
        entryId: "tail-user",
        timestamp: 6,
        role: "user" as const,
        content: "newest instruction, already in the tail",
        payload: createUserPayload("newest instruction, already in the tail", 6),
      },
    ];
    const plan = splitThreadMessagesForCompaction(messages, 1, 100, 2);

    expect(plan).not.toBeNull();
    expect(plan?.latestUserMessage).toBeUndefined();
  });

  it("does not pin when the latest user message is in the protected head", () => {
    const messages = [
      {
        entryId: "spawn",
        timestamp: 1,
        role: "user" as const,
        content: "Spawn prompt",
        payload: createUserPayload("Spawn prompt", 1),
      },
      {
        entryId: "mid-1",
        timestamp: 2,
        role: "assistant" as const,
        content: `working ${"x".repeat(8_000)}`,
        payload: createAssistantTextPayload(`working ${"x".repeat(8_000)}`, 2),
      },
      {
        entryId: "mid-2",
        timestamp: 3,
        role: "assistant" as const,
        content: `more ${"x".repeat(8_000)}`,
        payload: createAssistantTextPayload(`more ${"x".repeat(8_000)}`, 3),
      },
      {
        entryId: "tail-1",
        timestamp: 4,
        role: "assistant" as const,
        content: "tail reply",
        payload: createAssistantTextPayload("tail reply", 4),
      },
    ];
    const plan = splitThreadMessagesForCompaction(messages, 1, 100, 1);

    expect(plan).not.toBeNull();
    expect(plan?.latestUserMessage).toBeUndefined();
  });

  it("keeps the tail bounded when the latest user message is buried deep in a huge middle", () => {
    // ~40 x 10k chars ≈ 100k estimated tokens of middle after the buried
    // instruction. The old (rejected) design would have kept all of it
    // verbatim; the bounded design summarizes it and pins one capped copy.
    const messages = [
      {
        entryId: "spawn",
        timestamp: 1,
        role: "user" as const,
        content: "Spawn prompt",
        payload: createUserPayload("Spawn prompt", 1),
      },
      {
        entryId: "buried-instruction",
        timestamp: 2,
        role: "user" as const,
        content: "Follow-up buried deep in history",
        payload: createUserPayload("Follow-up buried deep in history", 2),
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        entryId: `mid-${index}`,
        timestamp: 3 + index,
        role: "assistant" as const,
        content: `chunk ${index} ${"x".repeat(10_000)}`,
        payload: createAssistantTextPayload(
          `chunk ${index} ${"x".repeat(10_000)}`,
          3 + index,
        ),
      })),
    ];

    const keepRecentTokens = 5_000;
    const plan = splitThreadMessagesForCompaction(
      messages,
      1,
      keepRecentTokens,
      1,
    );

    expect(plan?.latestUserMessage?.entryId).toBe("buried-instruction");
    // Boundedness proof at the plan level: the verbatim tail obeys the token
    // budget instead of stretching back ~100k tokens to the instruction.
    const middleEntryIds = plan!.middleMessages.map((m) => m.entryId);
    const tailStart = messages.findIndex(
      (m) => m.entryId === plan!.toEntryId,
    ) + 1;
    const tailTokens = messages
      .slice(tailStart)
      .reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    expect(middleEntryIds).toContain("buried-instruction");
    expect(tailTokens).toBeLessThanOrEqual(keepRecentTokens + 3_000);
  });

  it("excludes a previously pinned instruction copy from the summarized middle and its anchors", () => {
    const messages = [
      {
        entryId: "head",
        timestamp: 1,
        role: "user" as const,
        content: "Head",
        payload: createUserPayload("Head", 1),
      },
      {
        entryId: "checkpoint-1::pinned-instruction",
        timestamp: 2,
        role: "user" as const,
        content: "Previously pinned instruction",
      },
      {
        entryId: "mid-1",
        timestamp: 3,
        role: "assistant" as const,
        content: `work ${"x".repeat(8_000)}`,
        payload: createAssistantTextPayload(`work ${"x".repeat(8_000)}`, 3),
      },
      {
        entryId: "tail-1",
        timestamp: 4,
        role: "assistant" as const,
        content: "tail",
        payload: createAssistantTextPayload("tail", 4),
      },
    ];
    const plan = splitThreadMessagesForCompaction(messages, 1, 100, 1);

    expect(plan).toMatchObject({ fromEntryId: "mid-1" });
    expect(plan?.middleMessages.map((m) => m.entryId)).not.toContain(
      "checkpoint-1::pinned-instruction",
    );
    // The stale pinned copy is still the thread's latest user message, so it
    // is carried forward across the new checkpoint.
    expect(plan?.latestUserMessage?.entryId).toBe(
      "checkpoint-1::pinned-instruction",
    );
  });
});

describe("compaction head protection by agent role", () => {
  it("counts only the contiguous leading bootstrap startup docs", () => {
    expect(
      countLeadingBootstrapStartupDocs([
        createBootstrapDoc("b1", 1),
        createBootstrapDoc("b2", 2),
        {
          entryId: "u1",
          timestamp: 3,
          role: "user",
          content: "hi",
          payload: createUserPayload("hi", 3),
        },
      ]),
    ).toBe(2);

    expect(
      countLeadingBootstrapStartupDocs([
        {
          entryId: "u1",
          timestamp: 1,
          role: "user",
          content: "hi",
          payload: createUserPayload("hi", 1),
        },
      ]),
    ).toBe(0);
  });

  it("pins only bootstrap docs for the orchestrator, fixed window for subagents", () => {
    const messages = [
      createBootstrapDoc("b1", 1),
      createBootstrapDoc("b2", 2),
      {
        entryId: "u1",
        timestamp: 3,
        role: "user",
        content: "first",
        payload: createUserPayload("first", 3),
      },
    ];

    expect(
      resolveCompactionProtectHeadMessages(AGENT_IDS.ORCHESTRATOR, messages),
    ).toBe(2);
    expect(
      resolveCompactionProtectHeadMessages(AGENT_IDS.GENERAL, messages),
    ).toBe(3);
  });

  it("compacts the orchestrator's first user turn while keeping bootstrap docs at the top", () => {
    const messages = [
      createBootstrapDoc("b1", 1),
      createBootstrapDoc("b2", 2),
      {
        entryId: "u1",
        timestamp: 3,
        role: "user",
        content: "first user message",
        payload: createUserPayload("first user message", 3),
      },
      {
        entryId: "a1",
        timestamp: 4,
        role: "assistant",
        content: "early reply",
        payload: createAssistantTextPayload("early reply", 4),
      },
      {
        entryId: "u2",
        timestamp: 5,
        role: "user",
        content: "recent tail",
        payload: createUserPayload("recent tail", 5),
      },
    ];

    const plan = splitThreadMessagesForCompaction(
      messages,
      resolveCompactionProtectHeadMessages(AGENT_IDS.ORCHESTRATOR, messages),
      1,
      1,
    );

    // Compaction starts at the first user turn — the bootstrap docs (b1, b2)
    // are never swept into the summarized middle.
    expect(plan?.fromEntryId).toBe("u1");
    expect(plan?.middleMessages.map((message) => message.entryId)).not.toContain(
      "b1",
    );
    expect(plan?.middleMessages.map((message) => message.entryId)).not.toContain(
      "b2",
    );
  });
});
