import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createPiTools } from "@stella/runtime/kernel/agent-runtime/tool-adapters.js";
import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";

const createCommandTool = ({
  stellaDataDir,
  toolResult,
  onRawUpdate,
}: {
  stellaDataDir: string;
  toolResult: {
    result?: unknown;
    details?: unknown;
    error?: string;
  };
  onRawUpdate?: (update: unknown) => void;
}) => {
  const [tool] = createPiTools({
    runId: "run-command-output",
    rootRunId: "run-command-output",
    conversationId: "conversation-command-output",
    agentType: "general",
    deviceId: "device-command-output",
    stellaAppDir: stellaDataDir,
    stellaDataDir,
    agentDepth: 1,
    toolsAllowlist: ["exec_command"],
    toolCatalog: [
      {
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: {} },
      },
    ],
    store: {} as never,
    toolExecutor: async (_name, _args, _context, _signal, onUpdate) => {
      onRawUpdate?.(toolResult);
      onUpdate?.(toolResult);
      return toolResult;
    },
  });
  if (!tool) throw new Error("exec_command adapter was not created");
  return tool;
};

describe("command output pipeline", () => {
  it("stores command output once, caps plain model text at 10 KB, and preserves spill access", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-command-output-"),
    );
    try {
      const rawOutput = [
        "HEAD-MARKER",
        "🙂".repeat(4_000),
        "MIDDLE-ONLY-MARKER",
        "界".repeat(5_000),
        "STDERR-TAIL-MARKER",
      ].join("\n");
      const rawModelText = [
        "Wall time: 0.25 seconds",
        "Process exited with code 7",
        "Original token count: 4006",
        "Output:",
        rawOutput,
      ].join("\n");
      const rawDetails = {
        session_id: null,
        running: false,
        exit_code: 7,
        wall_time_seconds: 0.25,
        original_token_count: 4006,
        cwd: stellaDataDir,
        command: "example-command",
        original_output_bytes: Buffer.byteLength(rawOutput, "utf8"),
        raw_output_truncated: false,
      };
      const rawResult = { result: rawModelText, details: rawDetails };
      const rawUpdates: unknown[] = [];
      const modelUpdates: unknown[] = [];
      const tool = createCommandTool({
        stellaDataDir,
        toolResult: rawResult,
        onRawUpdate: (update) => rawUpdates.push(update),
      });

      const adapted = await tool.execute(
        "call-command-output",
        {},
        undefined,
        (update) => modelUpdates.push(update),
      );
      const content = adapted.content[0];
      const modelText = content?.type === "text" ? content.text : "";
      const details = adapted.details as typeof rawDetails & {
        toolOutputArtifact: {
          path: string;
          bytes: number;
          read: { tool: string; arguments: { file_path: string } };
        };
      };

      expect(rawUpdates).toEqual([rawResult]);
      expect(modelUpdates).toHaveLength(1);
      const partial = modelUpdates[0] as { content: Array<{ text?: string }> };
      expect(
        Buffer.byteLength(partial.content[0]?.text ?? "", "utf8"),
      ).toBeLessThanOrEqual(10_000);
      expect(Buffer.byteLength(modelText, "utf8")).toBeLessThanOrEqual(10_000);
      expect(modelText).toMatch(
        /^Wall time: 0\.25 seconds\nProcess exited with code 7/,
      );
      expect(modelText).toContain("\nOutput:\nHEAD-MARKER");
      expect(modelText).toContain("STDERR-TAIL-MARKER");
      expect(modelText).toContain("Tool output truncated");
      expect(modelText).toContain("Total output lines:");
      expect(modelText).toContain(
        "TOOL_OUTPUT_TRUNCATED complete post-sanitization output preserved",
      );
      expect(modelText).toContain("Read more with Read({ file_path:");
      expect(modelText).not.toContain('"output"');
      expect(modelText).not.toContain('"session_id"');

      expect(details).toMatchObject({
        session_id: null,
        running: false,
        exit_code: 7,
        raw_output_truncated: false,
      });
      expect(details).not.toHaveProperty("output");
      expect(JSON.stringify(details)).not.toContain("HEAD-MARKER");
      expect(details.toolOutputArtifact.read).toEqual(
        expect.objectContaining({
          tool: "Read",
          arguments: expect.objectContaining({
            file_path: details.toolOutputArtifact.path,
          }),
        }),
      );
      await expect(
        readFile(details.toolOutputArtifact.path, "utf8"),
      ).resolves.toBe(rawModelText);

      const store = { recordRunEvent: vi.fn() };
      const recorder = createRunEventRecorder({
        store: store as never,
        runId: "run-command-output",
        conversationId: "conversation-command-output",
        agentType: "general",
        userMessageId: "user-command-output",
      });
      const event = recorder.recordToolEnd({
        toolCallId: "call-command-output",
        toolName: "exec_command",
        result: modelText,
        details,
        isError: adapted.isError,
      });
      expect(event).not.toHaveProperty("result");
      expect(event.resultPreview).toContain("Process exited with code 7");
      expect(event.details).not.toHaveProperty("output");
      expect(JSON.stringify(event.details)).not.toContain("HEAD-MARKER");
      expect(JSON.stringify(store.recordRunEvent.mock.calls)).not.toContain(
        "MIDDLE-ONLY-MARKER",
      );
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("preserves command errors as compact plain text", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-command-error-"),
    );
    try {
      const tool = createCommandTool({
        stellaDataDir,
        toolResult: { error: "Failed to start command runner" },
      });
      const adapted = await tool.execute(
        "call-command-error",
        {},
        undefined,
        undefined,
      );
      expect(adapted).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: [TOOL_ERROR] Failed to start command runner",
          },
        ],
      });
      expect(adapted.content[0]?.type).toBe("text");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });
});
