import { describe, expect, test } from "bun:test";
import { VOICE_APPEND_MAX_CHARS } from "@stella/contracts/backend/voice";
import {
  buildAttachedChatVoiceHistory,
  buildComputerVoiceHistory,
  buildVoiceAppendEvent,
  buildVoiceSessionInstructions,
  findVoiceActionCompletion,
  parseVoiceDelegationCreated,
  parseVoiceTranscriptDelta,
  realtimeErrorMessage,
  splitVoiceAppendContent,
  VoiceTranscriptAccumulator,
} from "../realtime-voice-protocol";

describe("realtime voice protocol", () => {
  test("carries the attached chat as bounded startup history", () => {
    const history = buildAttachedChatVoiceHistory(
      Array.from({ length: 18 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}`,
      })),
    );

    expect(history.at(0)).toEqual({ role: "user", text: "message 0" });
    expect(history.at(-1)).toEqual({ role: "assistant", text: "message 17" });
    expect(history).toHaveLength(18);
    expect(buildVoiceSessionInstructions("phone")).toContain(
      "Delegate anything",
    );
  });

  test("carries the connected computer's turns as startup history", () => {
    const history = buildComputerVoiceHistory({
      instructions: "Use the computer runtime.",
      history: [
        { role: "user", content: "Open the budget file" },
        { role: "assistant", content: "Which one?" },
        { role: "tool", content: "budget.xlsx opened" },
      ],
    });

    expect(history).toEqual([
      { role: "user", text: "Open the budget file" },
      { role: "assistant", text: "Which one?" },
      {
        role: "developer",
        text: "Earlier tool from the computer's chat: budget.xlsx opened",
      },
    ]);
    expect(buildVoiceSessionInstructions("computer")).toContain(
      "connected computer",
    );
  });

  test("returns work through bounded appends tied to a delegation", () => {
    const delegation = parseVoiceDelegationCreated({
      type: "session.delegation.created",
      delegation: { id: "dlg_1", target: "client" },
      offset_ms: 1_400,
    });
    expect(delegation).toEqual({
      id: "dlg_1",
      target: "client",
      offsetMs: 1_400,
    });

    const chunks = splitVoiceAppendContent(
      "x".repeat(VOICE_APPEND_MAX_CHARS + 5),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toHaveLength(5);
    expect(
      buildVoiceAppendEvent({
        kind: "commentary",
        eventId: "mobile-append-1",
        delegationId: "dlg_1",
        content: "The flight is on time.",
      }),
    ).toEqual({
      type: "session.commentary.append",
      event_id: "mobile-append-1",
      delegation_id: "dlg_1",
      content: "The flight is on time.",
    });
  });

  test("accumulates transcript fragments into one spoken turn", () => {
    const accumulator = new VoiceTranscriptAccumulator();
    for (const event of [
      {
        type: "session.input_transcript.delta",
        delta: "book a ",
        start_ms: 0,
        end_ms: 400,
      },
      {
        type: "session.input_transcript.delta",
        delta: "flight tomorrow",
        start_ms: 400,
        end_ms: 900,
      },
    ]) {
      const fragment = parseVoiceTranscriptDelta(event);
      expect(fragment?.role).toBe("user");
      accumulator.append(fragment!);
    }

    expect(accumulator.take()).toBe("book a flight tomorrow");
    expect(accumulator.text).toBe("");
    expect(
      parseVoiceTranscriptDelta({ type: "session.output_transcript.delta" }),
    ).toBeNull();
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
          toolName: "send_message",
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
