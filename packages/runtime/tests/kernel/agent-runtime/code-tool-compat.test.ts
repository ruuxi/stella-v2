import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types";
import {
  collectReplSearchableTools,
  createToolHost,
} from "@stella/runtime/kernel/tools/host";
import {
  CODE_TOOL_NAME,
  LEGACY_NODE_REPL_TOOL_NAME,
  normalizeLegacyCodeHistory,
  toolRequiresExplicitApproval,
} from "@stella/runtime/kernel/tools/code-tool";

describe("code tool protocol compatibility", () => {
  it("rewrites legacy tool call and result names without breaking their pair", () => {
    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-legacy-code",
            name: LEGACY_NODE_REPL_TOOL_NAME,
            arguments: { code: "1 + 1" },
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "test",
        usage: {
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
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-legacy-code",
        toolName: LEGACY_NODE_REPL_TOOL_NAME,
        content: [{ type: "text", text: "2" }],
        isError: false,
        timestamp: 2,
      },
    ] as AgentMessage[];

    const normalized = normalizeLegacyCodeHistory(history);

    expect(normalized).not.toBe(history);
    expect(
      normalized[0]?.role === "assistant"
        ? normalized[0].content[0]
        : undefined,
    ).toMatchObject({
      type: "toolCall",
      id: "call-legacy-code",
      name: CODE_TOOL_NAME,
    });
    expect(normalized[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-legacy-code",
      toolName: CODE_TOOL_NAME,
    });
    expect(
      history[0]?.role === "assistant" ? history[0].content[0] : undefined,
    ).toMatchObject({ name: LEGACY_NODE_REPL_TOOL_NAME });
    expect(history[1]).toMatchObject({
      toolName: LEGACY_NODE_REPL_TOOL_NAME,
    });
  });

  it("keeps current history byte-shape stable", () => {
    const history = [
      {
        role: "toolResult",
        toolCallId: "call-code",
        toolName: CODE_TOOL_NAME,
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      },
    ] as AgentMessage[];

    expect(normalizeLegacyCodeHistory(history)).toBe(history);
  });

  it("fails closed for unknown approval policy shapes", () => {
    expect(toolRequiresExplicitApproval(undefined)).toBe(false);
    expect(toolRequiresExplicitApproval(false)).toBe(false);
    expect(toolRequiresExplicitApproval("never")).toBe(false);
    expect(toolRequiresExplicitApproval({ required: false })).toBe(false);
    expect(toolRequiresExplicitApproval(true)).toBe(true);
    expect(toolRequiresExplicitApproval("on-request")).toBe(true);
    expect(toolRequiresExplicitApproval({ mode: "ask" })).toBe(true);
    expect(toolRequiresExplicitApproval(1)).toBe(true);
  });

  it("does not disclose approval-required tools to nested code discovery", () => {
    const reachable = collectReplSearchableTools(
      [
        {
          name: "safe_mcp/tool",
          description: "Safe discovered tool",
          parameters: { type: "object" },
        },
        {
          name: "purchase_mcp/tool",
          description: "Requires approval",
          parameters: { type: "object" },
          approval: { required: true },
        },
      ],
      {
        conversationId: "conversation",
        requestId: "request",
        agentType: "general",
        allowedToolNames: ["safe_mcp/tool", "purchase_mcp/tool"],
      },
    );

    expect(reachable.map((tool) => tool.name)).toEqual(["safe_mcp/tool"]);
  });

  it("rejects an approval-required extension tool through real code routing", async () => {
    let executed = false;
    const stateRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-code-tool-compat-"),
    );
    const host = createToolHost({
      stellaAppDir: stateRoot,
      extensionTools: [
        {
          name: "publish_release",
          description: "Publish a release.",
          parameters: { type: "object", additionalProperties: false },
          approval: { required: true },
          async execute() {
            executed = true;
            return { result: "published" };
          },
        },
      ],
    });
    try {
      const nested = await host.executeTool(
        "code",
        { code: "await tools.publish_release({})" },
        {
          conversationId: "conversation",
          deviceId: "device",
          requestId: "code-call",
          agentId: "agent",
          agentType: "general",
          allowedToolNames: ["code", "publish_release"],
        },
      );

      expect(executed).toBe(false);
      expect(nested.error).toContain("requires explicit approval");
      expect(nested.error).toContain("cannot be invoked from code");
    } finally {
      await host.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
