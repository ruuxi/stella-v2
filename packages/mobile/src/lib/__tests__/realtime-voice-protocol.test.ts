import { describe, expect, test } from "bun:test";
import {
  buildComputerVoiceInstructions,
  buildMobileRealtimeSessionUpdate,
  buildNormalChatVoiceInstructions,
  findVoiceActionCompletion,
  managedVoiceConversationId,
  mergeComputerVoiceTools,
  realtimeErrorMessage,
} from "../realtime-voice-protocol";

describe("realtime voice protocol", () => {
  test("keeps local transcript keys out of managed voice requests", () => {
    expect(managedVoiceConversationId("cloud")).toBe(undefined);
    expect(managedVoiceConversationId("carplay")).toBe(undefined);
    expect(managedVoiceConversationId("  jn7realconversationid  ")).toBe(
      "jn7realconversationid",
    );
  });

  test("carries only the latest 16 attached normal-chat messages", () => {
    const instructions = buildNormalChatVoiceInstructions(
      Array.from({ length: 18 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}`,
      })),
    );

    expect(instructions.includes("User: message 0\n")).toBe(false);
    expect(instructions.includes("Stella: message 1\n")).toBe(false);
    expect(instructions).toContain("message 2");
    expect(instructions).toContain("message 17");
    expect(instructions).toContain("attached normal Stella chat");
  });

  test("wraps the connected desktop orchestrator context and tools", () => {
    const instructions = buildComputerVoiceInstructions({
      instructions: "Use the computer runtime.",
      tools: [],
      history: [
        { role: "user", content: "Open the budget file" },
        { role: "assistant", content: "Which one?" },
      ],
    });

    expect(instructions).toContain("Use the computer runtime.");
    expect(instructions).toContain("[User]\nOpen the budget file");
    expect(instructions).toContain("[Stella]\nWhich one?");

    expect(
      mergeComputerVoiceTools([
        {
          type: "function",
          name: "web",
          description: "Search the web.",
          parameters: { type: "object" },
        },
      ]).map((tool) => tool.name),
    ).toEqual(["web", "no_response", "goodbye"]);
  });

  test("normalizes Computer tools and avoids immutable session fields", () => {
    const tools = mergeComputerVoiceTools([
      {
        type: "function",
        name: "image_gen",
        description: "Generate an image.",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
          allOf: [{ not: { required: ["tooManyReferences"] } }],
        },
      },
    ]);
    expect(tools[0]?.parameters).toEqual({
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    });

    const update = buildMobileRealtimeSessionUpdate({
      eventId: "mobile-session-update-1",
      execution: "computer",
      instructions: "Use the paired computer.",
      tools,
    });
    expect(update).toEqual({
      type: "session.update",
      event_id: "mobile-session-update-1",
      session: {
        type: "realtime",
        instructions: "Use the paired computer.",
        tools,
        tool_choice: "auto",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
        },
      },
    });
  });

  test("extracts provider error messages", () => {
    expect(
      realtimeErrorMessage({
        error: { message: "Session expired" },
      }),
    ).toBe("Session expired");
  });

  test("correlates completion to the exact voice-triggered chat turn", () => {
    const messages = [
      {
        id: "unrelated",
        requestId: "typed-message",
        role: "assistant" as const,
        text: "Unrelated answer",
      },
      {
        id: "voice-error",
        requestId: "voice-message",
        role: "assistant" as const,
        text: "Your computer could not be reached.",
        stopped: true,
      },
    ];

    expect(findVoiceActionCompletion(messages, "voice-message")).toEqual({
      text: "Your computer could not be reached.",
      failed: true,
    });
    expect(findVoiceActionCompletion(messages, "missing")).toBeNull();
  });

  test("waits for a voice-triggered background task to settle", () => {
    const runningTask = {
      id: "agent-1",
      title: "Research flights",
      status: "running" as const,
      createdAt: 1,
    };
    const messages = [
      {
        id: "voice-reply",
        requestId: "voice-message",
        role: "assistant" as const,
        text: "I started a background agent.",
        tasks: [runningTask],
      },
    ];

    expect(findVoiceActionCompletion(messages, "voice-message")).toBeNull();
    expect(
      findVoiceActionCompletion(
        [
          {
            ...messages[0]!,
            tasks: [
              {
                ...runningTask,
                status: "completed" as const,
                resultText: "Flight UA 123 is on time.",
                completedAt: 2,
              },
            ],
          },
        ],
        "voice-message",
      ),
    ).toEqual({
      text: "Research flights: Flight UA 123 is on time.",
      failed: false,
    });
  });

  test("waits when a completed spawn call arrives before its task row", () => {
    const reply = {
      id: "voice-reply",
      requestId: "voice-message",
      role: "assistant" as const,
      text: "I started the research.",
      toolSteps: [
        {
          id: "spawn-1",
          toolName: "spawn_agent",
          status: "completed" as const,
        },
      ],
    };

    expect(findVoiceActionCompletion([reply], "voice-message")).toBeNull();
    expect(
      findVoiceActionCompletion(
        [
          {
            ...reply,
            tasks: [
              {
                id: "agent-1",
                title: "First agent",
                status: "completed" as const,
                createdAt: 1,
              },
            ],
          },
        ],
        "voice-message",
      ),
    ).toEqual({
      text: "First agent: completed",
      failed: false,
    });
  });

  test("waits for every completed spawn call to gain a task row", () => {
    const messages = [
      {
        id: "voice-reply",
        requestId: "voice-message",
        role: "assistant" as const,
        text: "I started two agents.",
        tasks: [
          {
            id: "agent-1",
            title: "First agent",
            status: "completed" as const,
            createdAt: 1,
          },
        ],
        toolSteps: [
          {
            id: "spawn-1",
            toolName: "spawn_agent",
            status: "completed" as const,
          },
          {
            id: "spawn-2",
            toolName: "mcp__stella__spawn_agent",
            status: "completed" as const,
          },
        ],
      },
    ];

    expect(findVoiceActionCompletion(messages, "voice-message")).toBeNull();
  });

  test("treats a requested pause as success and rejects stale resume state", () => {
    const actionMessage = {
      id: "voice-message",
      role: "user" as const,
      text: "Pause the task",
      canonicalCreatedAt: 100,
    };
    const pauseReply = {
      id: "pause-reply",
      requestId: "voice-message",
      role: "assistant" as const,
      text: "Paused.",
      toolSteps: [
        {
          id: "pause-1",
          toolName: "pause_agent",
          status: "completed" as const,
          args: { thread_id: "agent-1" },
        },
      ],
    };
    const pausedTask = {
      id: "agent-1",
      title: "Research",
      status: "canceled" as const,
      createdAt: 1,
      updatedAt: 110,
    };
    expect(
      findVoiceActionCompletion([actionMessage, pauseReply], "voice-message", [
        pausedTask,
      ]),
    ).toEqual({
      text: "Research: paused",
      failed: false,
    });

    const resumeReply = {
      ...pauseReply,
      text: "Resuming.",
      toolSteps: [
        {
          id: "resume-1",
          toolName: "send_input",
          status: "completed" as const,
          args: { thread_id: "agent-1" },
        },
      ],
    };
    expect(
      findVoiceActionCompletion([actionMessage, resumeReply], "voice-message", [
        { ...pausedTask, status: "completed", updatedAt: 90 },
      ]),
    ).toBeNull();
  });

  test("reports stopped replies and terminal task failures honestly", () => {
    const messages = [
      {
        id: "voice-reply",
        requestId: "voice-message",
        role: "assistant" as const,
        text: "The request timed out.",
        stopped: true,
      },
    ];

    expect(findVoiceActionCompletion(messages, "voice-message")).toEqual({
      text: "The request timed out.",
      failed: true,
    });
    expect(
      findVoiceActionCompletion(
        [
          {
            ...messages[0]!,
            stopped: false,
            tasks: [
              {
                id: "agent-2",
                title: "Use computer",
                status: "error" as const,
                errorMessage: "The paired computer went offline.",
                createdAt: 1,
              },
            ],
          },
        ],
        "voice-message",
      ),
    ).toEqual({
      text: "Use computer: The paired computer went offline.",
      failed: true,
    });
  });
});
