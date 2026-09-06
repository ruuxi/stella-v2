import { Type } from "@sinclair/typebox";
import { describe, expect, mock, test } from "bun:test";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import { CONNECT_DOCUMENTATION } from "@stella/runtime/kernel/connectors/connect-documentation.js";
import type { CloudCodeExecutorFactory } from "../src/cloud-code-executor.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

const {
  CLOUD_CODE_MAX_SOURCE_BYTES,
  CLOUD_CODE_MAX_TIMEOUT_MS,
  executeCloudCodeWithExecutorFactory,
} = await import("../src/cloud-code-executor.js");
const { createCloudCodeAgentTool, isCloudCodeReachableTool } = await import(
  "../src/cloud-code-tool.js"
);
mock.restore();

const loader = {} as WorkerLoader;

const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

/** A stand-in executor that runs the provider functions the way the sandbox would. */
const providerFactory = (
  run: (
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
  ) => Promise<unknown>,
): CloudCodeExecutorFactory => () => ({
  async execute(_source, providers) {
    if (!Array.isArray(providers)) throw new Error("providers required");
    try {
      return { result: await run(providers[0]?.fns ?? {}) };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

describe("cloud code AgentTool adapter", () => {
  test("advertises the device code contract: tools proxy, connect, and the parameters", async () => {
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "generation:conversation:turn",
      executeCode: async () => ({ ok: true, result: "ok" }),
    });
    expect(code.name).toBe("code");
    expect(code.parameters).toEqual({
      type: "object",
      properties: {
        code: {
          type: "string",
          minLength: 1,
          maxLength: CLOUD_CODE_MAX_SOURCE_BYTES,
          description: "JavaScript to evaluate with top-level await.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: CLOUD_CODE_MAX_TIMEOUT_MS,
          description: "Optional evaluation timeout in milliseconds.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    });
    expect(code.description).toContain("tools.$search({ query:");
    expect(code.description).toContain("tools.$describe(name)");
    expect(code.description).toContain("connect.documentation()");
    expect(code.description).not.toContain("codemode.");
    expect(code.description).not.toContain("node_repl");
  });

  test("routes a discovered MCP tool through its exact raw and sanitized names", async () => {
    let routed:
      | { toolCallId: string; params: unknown; signal: AbortSignal | undefined }
      | undefined;
    const discoveredTool: AgentTool = {
      name: "mcp.server/tool",
      label: "MCP discovered tool",
      description: "Read a value from a discovered MCP server.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      } as AgentTool["parameters"],
      execute: async (toolCallId, params, signal) => {
        routed = { toolCallId, params, signal };
        return result(`value:${String((params as { key: string }).key)}`);
      },
    };
    let providerKeys: string[] = [];
    const factory = providerFactory(async (fns) => {
      providerKeys = Object.keys(fns);
      return await fns["mcp.server/tool"]?.({ key: "alpha" });
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [discoveredTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    const outerSignal = new AbortController().signal;

    const output = await code.execute(
      "outer-call",
      { code: "await tools.mcp_servertool({ key: 'alpha' })" },
      outerSignal,
    );

    expect([...providerKeys].sort()).toEqual(
      ["$connect", "$describe", "$search", "mcp.server/tool"].sort(),
    );
    expect(routed).toBeDefined();
    expect(output.isError).toBe(false);
    // The nested value is the tool's own text, as on the device REPL.
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
      execute: async () => {
        ran = true;
        return result("published");
      },
    } satisfies AgentTool & { approval: unknown };
    const factory = providerFactory(async (fns) =>
      Object.keys(fns).filter((name) => !name.startsWith("$")),
    );
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [protectedTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const output = await code.execute("outer", {
      code: "await tools.publish_release({})",
    });

    expect(ran).toBe(false);
    expect(isCloudCodeReachableTool(protectedTool)).toBe(false);
    expect(code.description).not.toContain("publish_release");
    expect(output.isError).toBe(false);
    expect(output.content[0]).toMatchObject({ type: "text", text: "[]" });
  });

  test("validates nested arguments before calling a tool", async () => {
    let ran = false;
    const discoveredTool: AgentTool = {
      name: "mcp.read",
      label: "MCP read",
      description: "Read a value.",
      parameters: Type.Object(
        { key: Type.String() },
        { additionalProperties: false },
      ),
      execute: async () => {
        ran = true;
        return result("unexpected");
      },
    };
    const factory = providerFactory(async (fns) => {
      try {
        await fns["mcp.read"]?.({ key: 42 });
        return "unexpected";
      } catch (error) {
        throw error;
      }
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [discoveredTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const output = await code.execute("outer", {
      code: "await tools.mcp_read({ key: 42 })",
    });

    expect(ran).toBe(false);
    expect(output.isError).toBe(true);
    expect(output.content[0]).not.toEqual(
      expect.objectContaining({ text: expect.stringContaining("key: 42") }),
    );
  });

  test("a nested tool's own error rejects that call and stays catchable", async () => {
    const failing: AgentTool = {
      name: "flaky_read",
      label: "Flaky",
      description: "Sometimes fails.",
      parameters: { type: "object" } as AgentTool["parameters"],
      execute: async () => result("Nothing found for that query.", true),
    };
    const factory = providerFactory(async (fns) => {
      try {
        await fns.flaky_read?.({});
        return "unexpected";
      } catch (error) {
        return `caught: ${(error as Error).message}`;
      }
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [failing],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    const output = await code.execute("outer", {
      code: "try { await tools.flaky_read({}) } catch (e) { e.message }",
    });
    expect(output.isError).toBe(false);
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("caught: Nothing found for that query."),
    });
  });

  test("does not recursively expose code or the legacy node_repl name", async () => {
    const intrinsic = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object" },
      execute: async () => result("no"),
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [intrinsic("code"), intrinsic("node_repl")],
      executionScope: "generation:conversation:turn",
      executeCode: async (request) => ({
        ok: true,
        result: request.tools.nameMappings.map((entry) => entry.rawName),
      }),
    });
    const output = await code.execute("outer", { code: "[]" });
    expect(output.content[0]).toMatchObject({ type: "text", text: "[]" });
    expect(code.description).not.toContain("node_repl");
  });

  test("$search and $describe answer from the reachable catalog, demoted tools ride the suffix", async () => {
    const schedule: AgentTool & { demoted: { searchTerms: string[] } } = {
      name: "schedule_add",
      label: "Add schedule",
      description: "Create a scheduled trigger.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      } as AgentTool["parameters"],
      demoted: { searchTerms: ["reminder", "cron"] },
      execute: async () => result("added"),
    };
    const web: AgentTool = {
      name: "web",
      label: "Web",
      description: "Search the web.",
      parameters: { type: "object" } as AgentTool["parameters"],
      execute: async () => result("results"),
    };
    let searchHits: unknown;
    let described: unknown;
    let unknownDescribe: string | undefined;
    const factory = providerFactory(async (fns) => {
      searchHits = await fns.$search?.({ query: "reminder" });
      described = await fns.$describe?.({ name: "schedule_add" });
      try {
        await fns.$describe?.({ name: "nope" });
      } catch (error) {
        unknownDescribe = (error as Error).message;
      }
      return "done";
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [schedule, web],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    await code.execute("outer", { code: "'done'" });

    expect(searchHits).toEqual([
      {
        name: "schedule_add",
        signature: "tools.schedule_add(input: { name: string }): Promise<unknown>",
        description: "Create a scheduled trigger.",
      },
    ]);
    expect(described).toMatchObject({
      name: "schedule_add",
      invocation: "tools.schedule_add(args)",
      inputSchema: schedule.parameters,
    });
    expect(unknownDescribe).toContain('Tool "nope" is unknown');
    expect(code.description).toContain("## Demoted tools (COMPLETE");
    expect(code.description).toContain("tools.schedule_add(input:");
    expect(code.description).not.toContain("tools.web(input:");
  });

  test("connect forwards to the host client and explains its absence", async () => {
    const calls: unknown[] = [];
    let missing: string | undefined;
    const factory = providerFactory(async (fns) => {
      const discovered = await fns.$connect?.({
        method: "discover",
        args: ["gmail"],
      });
      const called = await fns.$connect?.({
        method: "call",
        args: ["gmail", "GMAIL_GET_PROFILE", { user_id: "me" }],
      });
      try {
        await fns.$connect?.({ method: "hack", args: [] });
      } catch (error) {
        missing = (error as Error).message;
      }
      return { discovered, called };
    });
    const withClient = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "generation:conversation:turn",
      connect: {
        discover: async (query) => {
          calls.push(["discover", query]);
          return { query, matches: [] };
        },
        connectors: async () => [],
        actions: async () => ({ connector: "", total: 0, shown: 0, actions: [] }),
        schema: async () => ({}),
        call: async (id, action, args) => {
          calls.push(["call", id, action, args]);
          return { email: "me@example.com" };
        },
        addMcp: async () => ({}),
        remove: async () => ({}),
      },
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    const output = await withClient.execute("outer", { code: "1" });
    expect(output.isError).toBe(false);
    expect(calls).toEqual([
      ["discover", "gmail"],
      ["call", "gmail", "GMAIL_GET_PROFILE", { user_id: "me" }],
    ]);
    expect(missing).toContain("is not a connect method");

    let absent: string | undefined;
    const withoutClient = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(
          request,
          providerFactory(async (fns) => {
            try {
              await fns.$connect?.({ method: "connectors", args: [] });
            } catch (error) {
              absent = (error as Error).message;
            }
            return null;
          }),
        ),
    });
    await withoutClient.execute("outer", { code: "1" });
    expect(absent).toContain("connect is unavailable in this session");
    expect(CONNECT_DOCUMENTATION).toContain("connect.call(id, action, args)");
  });

  test("lifts a nested map card onto the outer result", async () => {
    const map = {
      kind: "map-route",
      version: 1,
      markers: [{ id: "a", name: "A", lat: 1, lng: 2, role: "place" }],
    };
    const mapTool: AgentTool = {
      name: "map",
      label: "Map",
      description: "Map.",
      parameters: { type: "object" } as AgentTool["parameters"],
      execute: async () => ({
        content: [{ type: "text", text: "Pinned 1 place." }],
        details: { map },
      }),
    };
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [mapTool],
      executionScope: "generation:conversation:turn",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(
          request,
          providerFactory(async (fns) => await fns.map?.({})),
        ),
    });
    const output = await code.execute("outer", { code: "await tools.map({})" });
    expect(output.isError).toBe(false);
    expect((output.details as { maps?: unknown[] }).maps).toEqual([map]);
  });

  test("derives a stable execution id from scope and outer tool call", async () => {
    const seen: string[] = [];
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "generation:conversation:turn",
      executeCode: async (request) => {
        seen.push(request.executionId ?? "");
        return { ok: true, result: "ok" };
      },
    });
    await code.execute("outer-stable", { code: "'ok'" });
    await code.execute("outer-stable", { code: "'ok'" });
    await code.execute("outer-other", { code: "'ok'" });

    expect(seen[0]).toMatch(/^code:[0-9a-f]{64}$/);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});
