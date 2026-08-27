import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import type { CloudCodeExecutorFactory } from "../src/cloud-code-executor.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

const { executeCloudCodeWithExecutorFactory } =
  await import("../src/cloud-code-executor.js");
const { createCloudCodeAgentTool } = await import("../src/cloud-code-tool.js");
mock.restore();

const loader = {} as WorkerLoader;

const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

describe("cloud code AgentTool adapter", () => {
  test("routes a discovered MCP tool through its exact raw and sanitized names", async () => {
    let routed:
      | { toolCallId: string; params: unknown; signal: AbortSignal | undefined }
      | undefined;
    const discoveredTool: AgentTool & { codeEligibility: "read_only" } = {
      name: "mcp.server/tool",
      label: "MCP discovered tool",
      description: "Read a value from a discovered MCP server.",
      parameters: Type.Object(
        { key: Type.String() },
        { additionalProperties: false },
      ),
      codeEligibility: "read_only",
      execute: async (toolCallId, params, signal) => {
        routed = { toolCallId, params, signal };
        return result(`value:${String((params as { key: string }).key)}`);
      },
    };
    let providerKeys: string[] = [];
    const factory: CloudCodeExecutorFactory = () => ({
      async execute(_source, providers) {
        if (!Array.isArray(providers)) throw new Error("providers required");
        providerKeys = Object.keys(providers[0]?.fns ?? {});
        const value = await providers[0]?.fns["mcp.server/tool"]?.({
          key: "alpha",
        });
        return { result: value };
      },
    });
    const code = createCloudCodeAgentTool({
      loader,
      tools: [discoveredTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    const outerSignal = new AbortController().signal;

    expect(code.name).toBe("code");
    expect(code.description).toContain("mcp_servertool -> mcp.server/tool");
    expect(code.description).not.toContain("node_repl");
    const output = await code.execute(
      "outer-call",
      { code: "async () => codemode.mcp_servertool({ key: 'alpha' })" },
      outerSignal,
    );

    expect(providerKeys).toEqual(["mcp.server/tool"]);
    expect(routed).toBeDefined();
    expect(output.isError).toBe(false);
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("value:alpha"),
    });
    expect(routed?.params).toEqual({ key: "alpha" });
    expect(routed?.toolCallId).toMatch(/^code:[0-9a-f]{64}:1:mcp_servertool$/);
    expect(routed?.signal).toBeInstanceOf(AbortSignal);
  });

  test("keeps approval-required tools direct and undisclosed inside code", async () => {
    let ran = false;
    const protectedTool = {
      name: "publish_release",
      label: "Publish release",
      description: "Publish a release.",
      parameters: { type: "object", additionalProperties: false },
      approval: { required: true },
      codeEligibility: "read_only" as const,
      execute: async () => {
        ran = true;
        return result("published");
      },
    } satisfies AgentTool & { approval: unknown };
    const factory: CloudCodeExecutorFactory = () => ({
      async execute(_source, providers) {
        if (!Array.isArray(providers)) throw new Error("providers required");
        return { result: Object.keys(providers[0]?.fns ?? {}) };
      },
    });
    const code = createCloudCodeAgentTool({
      loader,
      tools: [protectedTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const output = await code.execute("outer", {
      code: "async () => codemode.publish_release({})",
    });

    expect(ran).toBe(false);
    expect(code.description).not.toContain("publish_release");
    expect(output.isError).toBe(false);
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "[]",
    });
  });

  test("validates nested arguments before calling a discovered tool", async () => {
    let ran = false;
    const discoveredTool: AgentTool & { codeEligibility: "read_only" } = {
      name: "mcp.read",
      label: "MCP read",
      description: "Read a value.",
      parameters: Type.Object(
        { key: Type.String() },
        { additionalProperties: false },
      ),
      codeEligibility: "read_only",
      execute: async () => {
        ran = true;
        return result("unexpected");
      },
    };
    const factory: CloudCodeExecutorFactory = () => ({
      async execute(_source, providers) {
        if (!Array.isArray(providers)) throw new Error("providers required");
        try {
          await providers[0]?.fns["mcp.read"]?.({ key: 42 });
          return { result: "unexpected" };
        } catch (error) {
          return {
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    const code = createCloudCodeAgentTool({
      loader,
      tools: [discoveredTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const output = await code.execute("outer", {
      code: "async () => codemode.mcp_read({ key: 42 })",
    });

    expect(ran).toBe(false);
    expect(output.isError).toBe(true);
    expect(output.content[0]).not.toEqual(
      expect.objectContaining({ text: expect.stringContaining("key: 42") }),
    );
  });

  test("does not recursively expose code or the legacy node_repl name", () => {
    const intrinsic = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object" },
      execute: async () => result("no"),
    });
    const code = createCloudCodeAgentTool({
      loader,
      tools: [intrinsic("code"), intrinsic("node_repl")],
      executionScope: "generation:conversation:turn",
      executeCode: async () => ({ ok: true, result: "ok" }),
    });

    expect(code.description).toContain("(no nested tools)");
    expect(code.description).not.toContain("node_repl");
  });

  test("fails closed for tools without an explicit read-only Code policy", async () => {
    let ran = false;
    const unclassified: AgentTool = {
      name: "looks_like_a_read",
      label: "Unclassified",
      description: "The prose claims this only reads, but prose is not policy.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        ran = true;
        return result("unexpected");
      },
    };
    const code = createCloudCodeAgentTool({
      loader,
      tools: [unclassified],
      executionScope: "generation:conversation:turn",
      executeCode: async (request) => ({
        ok: true,
        result: request.tools.nameMappings.map((entry) => entry.rawName),
      }),
    });

    const output = await code.execute("outer", { code: "async () => []" });
    expect(ran).toBe(false);
    expect(code.description).not.toContain("looks_like_a_read");
    expect(output.content[0]).toMatchObject({ type: "text", text: "[]" });
  });

  test("derives a stable execution id from scope and outer tool call", async () => {
    const seen: string[] = [];
    const code = createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "generation:conversation:turn",
      executeCode: async (request) => {
        seen.push(request.executionId ?? "");
        return { ok: true, result: "ok" };
      },
    });
    await code.execute("outer-stable", { code: "async () => 'ok'" });
    await code.execute("outer-stable", { code: "async () => 'ok'" });
    await code.execute("outer-other", { code: "async () => 'ok'" });

    expect(seen[0]).toMatch(/^code:[0-9a-f]{64}$/);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});
