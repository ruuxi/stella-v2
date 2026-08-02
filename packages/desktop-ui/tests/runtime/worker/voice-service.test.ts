import { describe, expect, it, vi } from "vitest";

import { VoiceRuntimeService } from "@stella/runtime/worker/voice/service";

// Since "make cloud conversations canonical" (74a586520) the voice service
// persists through the cloud journal with idempotent tool-call receipts
// instead of writing local chat-store events. These tests exercise that
// contract: catalog allowlisting, side-effect metadata preservation on the
// wire response AND in the journaled toolResult record, receipt-based
// replay/interruption semantics, and transcript journaling.

type JournalAppend = {
  conversationId: string;
  appendId: string;
  records: Array<{
    kind: string;
    role: string;
    payloadJson: string;
    hidden?: boolean;
  }>;
};

const makeService = () => {
  const journalAppends: JournalAppend[] = [];
  const completions: Array<Record<string, unknown>> = [];
  const runner = {
    beginVoiceToolCallReceipt: vi.fn(
      (args: { operationId: string; startedAt: number }) => ({
        status: "started" as const,
        operationId: args.operationId,
        startedAt: args.startedAt,
      }),
    ),
    completeVoiceToolCallReceipt: vi.fn((args) => {
      completions.push(args);
    }),
    appendCloudJournal: vi.fn(async (request: JournalAppend) => {
      journalAppends.push(request);
      return { queued: true as const, replayed: false };
    }),
    getVoiceOrchestratorConfig: vi.fn(async () => ({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "web",
          description: "Search or fetch the web.",
          parameters: { type: "object" },
        },
      ],
    })),
    executeTool: vi.fn(async () => ({
      result: "Search complete.",
      details: { text: "Search complete." },
    })),
    handleLocalChat: vi.fn(),
    webSearch: vi.fn(),
  };
  const service = new VoiceRuntimeService({
    getRunner: () => runner as never,
    getDeviceId: () => "device-1",
    emitAgentEvent: vi.fn(),
  });

  return { service, runner, journalAppends, completions };
};

const journaledMessages = (append: JournalAppend | undefined) =>
  (append?.records ?? []).map((record) => ({
    role: record.role,
    payload: JSON.parse(record.payloadJson) as Record<string, unknown>,
  }));

describe("VoiceRuntimeService direct tool execution", () => {
  it("executes only tools from the resolved voice orchestrator catalog", async () => {
    const { service, runner, journalAppends } = makeService();

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-1",
      name: "web",
      args: { query: "latest Stella news" },
    });

    expect(result.output).toBe("Search complete.");
    expect(runner.executeTool).toHaveBeenCalledWith(
      "web",
      { query: "latest Stella news" },
      expect.objectContaining({
        conversationId: "conv-1",
        agentType: "orchestrator",
        storageMode: "cloud",
        allowedToolNames: ["web"],
      }),
    );
    // The durable requestId is the receipt's operation id, not the transient
    // realtime callId.
    const context = runner.executeTool.mock.calls[0]?.[2] as {
      requestId: string;
      runId: string;
    };
    expect(context.requestId).toMatch(/^voice-operation:/);
    expect(context.runId).toBe(context.requestId);

    // The tool exchange lands in the cloud journal as a toolCall/toolResult
    // pair under a callId-derived append id.
    expect(journalAppends).toHaveLength(1);
    expect(journalAppends[0]?.conversationId).toBe("conv-1");
    expect(journalAppends[0]?.appendId).toMatch(/^voice-tool:/);
    const messages = journaledMessages(journalAppends[0]);
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(messages[0]?.payload.content).toMatchObject([
      { type: "toolCall", id: "call-1", name: "web" },
    ]);
    expect(messages[1]?.payload).toMatchObject({
      toolCallId: "call-1",
      toolName: "web",
      source: "voice",
      isError: false,
    });
    expect(runner.completeVoiceToolCallReceipt).toHaveBeenCalledOnce();
  });

  it("returns an error for tools outside the resolved catalog", async () => {
    const { service, runner } = makeService();

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-2",
      name: "perform_action",
      args: { message: "do something" },
    });

    expect(result.error).toContain("not available");
    expect(result.output).toContain("Error:");
    expect(runner.executeTool).not.toHaveBeenCalled();
  });

  it("replays a completed receipt without re-executing the tool", async () => {
    const { service, runner, journalAppends } = makeService();
    const completion = {
      response: { output: "Search complete.", details: { cached: true } },
      records: [
        {
          kind: "message",
          role: "assistant",
          payloadJson: JSON.stringify({ role: "assistant" }),
        },
        {
          kind: "message",
          role: "toolResult",
          payloadJson: JSON.stringify({ role: "toolResult" }),
        },
      ],
    };
    runner.beginVoiceToolCallReceipt.mockReturnValueOnce({
      status: "completed",
      operationId: "op-1",
      startedAt: 1_000,
      completionJson: JSON.stringify(completion),
    } as never);

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-1",
      name: "web",
      args: { query: "latest Stella news" },
    });

    expect(result).toEqual(completion.response);
    expect(runner.executeTool).not.toHaveBeenCalled();
    // Journal append is still re-issued (idempotent by appendId).
    expect(journalAppends).toHaveLength(1);
    expect(runner.completeVoiceToolCallReceipt).not.toHaveBeenCalled();
  });

  it("fails closed on a pending receipt instead of repeating a started call", async () => {
    const { service, runner } = makeService();
    runner.beginVoiceToolCallReceipt.mockReturnValueOnce({
      status: "pending",
      operationId: "op-1",
      startedAt: 1_000,
    } as never);

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    await expect(
      service.executeTool({
        requestId: "voice-session-1",
        conversationId: "conv-1",
        callId: "call-1",
        name: "web",
        args: { query: "latest Stella news" },
      }),
    ).rejects.toThrow("cannot be repeated safely");
    expect(runner.executeTool).not.toHaveBeenCalled();
  });

  it("preserves file metadata from html tool results for chat artifacts", async () => {
    const { service, runner, journalAppends } = makeService();
    const filePath = "/Users/me/.stella/outputs/html/nvidia-news.html";
    const fileChanges = [{ path: filePath, kind: { type: "add" as const } }];

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "html",
          description: "Write HTML.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result: `Canvas "NVIDIA News" saved to ${filePath} and opened in the panel.`,
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
        createdAt: 1_234,
        bytes: 4096,
      },
      fileChanges,
    } as never);

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-html",
      name: "html",
      args: {
        slug: "nvidia-news",
        title: "NVIDIA News",
        html: "<!doctype html><html></html>",
      },
    });

    expect(result).toMatchObject({
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
      },
      fileChanges,
    });
    const toolResult = journaledMessages(journalAppends[0]).find(
      (message) => message.role === "toolResult",
    );
    expect(toolResult?.payload).toMatchObject({
      toolName: "html",
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
      },
      fileChanges,
    });
  });

  it("preserves image_gen job metadata for inline image cards", async () => {
    const { service, runner, journalAppends } = makeService();

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "image_gen",
          description: "Generate images.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result:
        "image_gen job job-1 submitted. The generated image will appear automatically when it finishes.",
      details: {
        jobId: "job-1",
        capability: "text_to_image",
        prompt: "a product mockup",
        numImages: 3,
        status: "submitted",
      },
    } as never);

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-image",
      name: "image_gen",
      args: {
        prompt: "a product mockup",
        num_images: 3,
      },
    });

    expect(result.details).toMatchObject({
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a product mockup",
      numImages: 3,
      status: "submitted",
    });
    const toolResult = journaledMessages(journalAppends[0]).find(
      (message) => message.role === "toolResult",
    );
    expect(toolResult?.payload).toMatchObject({
      toolName: "image_gen",
      details: {
        jobId: "job-1",
        capability: "text_to_image",
        prompt: "a product mockup",
        numImages: 3,
      },
    });
  });

  it("preserves generic artifact side effects from other tools", async () => {
    const { service, runner, journalAppends } = makeService();
    const producedFiles = [
      { path: "/Users/me/Desktop/deck.pptx", kind: { type: "add" as const } },
    ];
    const officePreviewRef = {
      sessionId: "office-session-1",
      title: "deck.pptx",
      sourcePath: "/Users/me/Desktop/deck.pptx",
    };

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "exec_command",
          description: "Run a command.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result: "Created deck.pptx",
      details: {
        officePreviewRef,
      },
      producedFiles,
    } as never);

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-shell",
      name: "exec_command",
      args: { cmd: "make deck" },
    });

    expect(result).toMatchObject({
      details: { officePreviewRef },
      producedFiles,
    });
    const toolResult = journaledMessages(journalAppends[0]).find(
      (message) => message.role === "toolResult",
    );
    expect(toolResult?.payload).toMatchObject({
      details: { officePreviewRef },
      producedFiles,
    });
  });

  it("journals a persisted voice transcript under a stable event-derived append id", async () => {
    const { service, journalAppends } = makeService();

    const outcome = await service.persistTranscript({
      conversationId: "conv-1",
      eventId: "evt-1",
      timestamp: 1_700_000_000_000,
      role: "user",
      text: "Please check this from voice.",
      uiVisibility: "visible",
    });

    expect(outcome).toEqual({ ok: true });
    expect(journalAppends).toHaveLength(1);
    expect(journalAppends[0]?.appendId).toMatch(/^voice-transcript:/);
    const [record] = journalAppends[0]!.records;
    expect(record).toMatchObject({ kind: "message", role: "user" });
    expect(record?.hidden).toBe(false);
    expect(JSON.parse(record!.payloadJson)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Please check this from voice." }],
      timestamp: 1_700_000_000_000,
      source: "voice",
    });
  });

  it("persists structured voiceSession metadata on the end-of-session summary", async () => {
    const { service, journalAppends } = makeService();

    await service.persistTranscript({
      conversationId: "conv-1",
      eventId: "evt-2",
      timestamp: 1_700_000_084_000,
      role: "assistant",
      text: "Voice session\n\nDuration: 1m 24s",
      uiVisibility: "visible",
      voiceSession: { durationMs: 84_000 },
    });

    const [record] = journalAppends[0]!.records;
    expect(record).toMatchObject({ kind: "message", role: "assistant" });
    expect(JSON.parse(record!.payloadJson)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Voice session\n\nDuration: 1m 24s" }],
      source: "voice",
      voiceSession: { durationMs: 84_000 },
    });
  });

  it("rejects transcripts without a durable eventId or valid timestamp", async () => {
    const { service } = makeService();

    await expect(
      service.persistTranscript({
        conversationId: "conv-1",
        eventId: "   ",
        timestamp: 1_700_000_000_000,
        role: "user",
        text: "hi",
      }),
    ).rejects.toThrow("eventId is required");
    await expect(
      service.persistTranscript({
        conversationId: "conv-1",
        eventId: "evt-3",
        timestamp: Number.NaN,
        role: "user",
        text: "hi",
      }),
    ).rejects.toThrow("timestamp is invalid");
  });
});
