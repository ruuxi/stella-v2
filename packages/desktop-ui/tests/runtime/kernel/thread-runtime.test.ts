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

  const reconstructAfterOverlay = (
    messages: Array<{
      entryId: string;
      role: string;
      content: string;
    }>,
    plan: NonNullable<ReturnType<typeof splitThreadMessagesForCompaction>>,
    summary: string,
  ) => {
    const fromIndex = messages.findIndex(
      (message) => message.entryId === plan.fromEntryId,
    );
    const toIndex = messages.findIndex(
      (message) => message.entryId === plan.toEntryId,
    );
    return [
      ...messages.slice(0, fromIndex),
      {
        entryId: "checkpoint",
        role: "assistant",
        content: formatThreadCheckpointMessage({ summary }),
      },
      ...messages.slice(toIndex + 1),
    ];
  };

  it("keeps the latest completed-path follow-up visible after overlay reconstruction", () => {
    const followUp =
      "Redesign fix-page How It Works with reusable animated mini-chat\n\nContinue on the same website fix-page work with this redesign.";
    const messages = [
      {
        entryId: "bootstrap",
        timestamp: 1,
        role: "runtimeInternal" as const,
        content: "<skills>...</skills>",
      },
      {
        entryId: "spawn",
        timestamp: 2,
        role: "user" as const,
        content: "Fix the right-side gap/clipping in website fix-page hero aura",
        payload: createUserPayload(
          "Fix the right-side gap/clipping in website fix-page hero aura",
          2,
        ),
      },
      {
        entryId: "early-assistant",
        timestamp: 3,
        role: "assistant" as const,
        content: "Inspecting the hero layout",
        payload: createAssistantTextPayload("Inspecting the hero layout", 3),
      },
      {
        entryId: "middle-1",
        timestamp: 4,
        role: "assistant" as const,
        content: "Completed the aura CSS fix and committed it.",
        payload: createAssistantTextPayload(
          "Completed the aura CSS fix and committed it.",
          4,
        ),
      },
      {
        entryId: "follow-up",
        timestamp: 5,
        role: "user" as const,
        content: followUp,
        payload: createUserPayload(followUp, 5),
      },
      {
        entryId: "redesign-work",
        timestamp: 6,
        role: "assistant" as const,
        content: "Extracting the homepage mini-chat into a shared component.",
        payload: createAssistantTextPayload(
          "Extracting the homepage mini-chat into a shared component.",
          6,
        ),
      },
      {
        entryId: "tail-tool",
        timestamp: 7,
        role: "assistant" as const,
        content: "Read(src/app/fix/fix.css)",
        payload: createAssistantToolCallPayload("call-tail", 7),
      },
      {
        entryId: "tail-result",
        timestamp: 8,
        role: "toolResult" as const,
        content: ".fix-page main { width: 100%; }",
        toolCallId: "call-tail",
        payload: createToolResultPayload(
          "call-tail",
          ".fix-page main { width: 100%; }",
          8,
        ),
      },
    ];

    const plan = splitThreadMessagesForCompaction(messages, 3, 1, 2);
    expect(plan).not.toBeNull();
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "middle-1",
    ]);
    expect(plan?.middleMessages.map((message) => message.content)).not.toContain(
      followUp,
    );

    const visible = reconstructAfterOverlay(
      messages,
      plan!,
      "Aura fix is done; redesign is in progress.",
    );
    const userTurns = visible.filter((message) => message.role === "user");
    expect(userTurns.map((message) => message.entryId)).toEqual([
      "spawn",
      "follow-up",
    ]);
    expect(userTurns[1]?.content).toBe(followUp);
    expect(visible.map((message) => message.entryId)).toEqual([
      "bootstrap",
      "spawn",
      "early-assistant",
      "checkpoint",
      "follow-up",
      "redesign-work",
      "tail-tool",
      "tail-result",
    ]);
  });

  it("keeps an active-steer Task update visible after overlay reconstruction", () => {
    const steering =
      "Task update:\n\n1. Apply the How It Works redesign and do not revert it.\n\nApply each update per its intent: answer a question or status request and stop; apply new or changed instructions and continue the task. Newer updates override earlier ones.";
    const messages = [
      {
        entryId: "bootstrap",
        timestamp: 1,
        role: "runtimeInternal" as const,
        content: "<skills>...</skills>",
      },
      {
        entryId: "spawn",
        timestamp: 2,
        role: "user" as const,
        content: "Fix the hero aura clipping",
        payload: createUserPayload("Fix the hero aura clipping", 2),
      },
      {
        entryId: "early-assistant",
        timestamp: 3,
        role: "assistant" as const,
        content: "Working on the aura CSS",
        payload: createAssistantTextPayload("Working on the aura CSS", 3),
      },
      {
        entryId: "middle-work",
        timestamp: 4,
        role: "assistant" as const,
        content: "Still editing the shared fix-page template.",
        payload: createAssistantTextPayload(
          "Still editing the shared fix-page template.",
          4,
        ),
      },
      {
        entryId: "steer",
        timestamp: 5,
        role: "user" as const,
        content: steering,
        payload: createUserPayload(steering, 5),
      },
      {
        entryId: "tail-a",
        timestamp: 6,
        role: "assistant" as const,
        content: "Applying the queued redesign update.",
        payload: createAssistantTextPayload(
          "Applying the queued redesign update.",
          6,
        ),
      },
      {
        entryId: "tail-b",
        timestamp: 7,
        role: "assistant" as const,
        content: "Checking the working tree.",
        payload: createAssistantTextPayload("Checking the working tree.", 7),
      },
    ];

    const plan = splitThreadMessagesForCompaction(messages, 3, 1, 2);
    expect(plan).not.toBeNull();
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "middle-work",
    ]);
    expect(plan?.middleMessages.map((message) => message.content)).not.toContain(
      steering,
    );

    const visible = reconstructAfterOverlay(
      messages,
      plan!,
      "Aura work was in progress when a Task update arrived.",
    );
    const userTurns = visible.filter((message) => message.role === "user");
    expect(userTurns.map((message) => message.entryId)).toEqual([
      "spawn",
      "steer",
    ]);
    expect(userTurns[1]?.content).toBe(steering);
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
