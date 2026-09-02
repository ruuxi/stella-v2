import { describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClaudeCodeToolMcpHost } from "@stella/runtime/kernel/integrations/claude-code-tool-mcp-host.js";
import {
  buildCloudClaudeTakeoverArgs,
  buildClaudeChildEnv,
  assertNativeHistoryParity,
  createCloudClaudeMcpConfig,
  nativeHistoryCursorFromRows,
  resolveClaudeModelArgs,
  resolveClaudeReasoningArgs,
  runNativeAgentTurn,
} from "./native-agent-turn.js";
import { sealNativeState } from "./native-state-integrity.js";

describe("native engine reasoning selection", () => {
  it("fails closed when a restored native session is absent or behind canonical history", async () => {
    const testRoot = await mkdtemp(
      path.join(tmpdir(), "stella-native-parity-"),
    );
    const root = path.join(testRoot, "native");
    await mkdir(root, { mode: 0o700 });
    const row = {
      turnId: "turn-1",
      role: "assistant",
      payloadJson: '{"role":"assistant","content":"done"}',
    };
    const cursor = nativeHistoryCursorFromRows([row]);
    const integrityKey = "a".repeat(64);
    const expectedOwner = {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
    const parityArgs = {
      stateRoot: root,
      engine: "anthropic" as const,
      threadId: "thread-1",
      integrityKey,
      expectedOwner,
    };
    try {
      await expect(
        assertNativeHistoryParity({
          ...parityArgs,
          expectedCursor: nativeHistoryCursorFromRows([]),
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertNativeHistoryParity({
          ...parityArgs,
          expectedCursor: cursor,
        }),
      ).rejects.toThrow("does not match");
      await writeFile(path.join(root, "session-started"), "session-1\n");
      await writeFile(
        path.join(root, "native-session.jsonl"),
        '{"role":"assistant","content":"durable"}\n',
      );
      await sealNativeState({
        stateRoot: root,
        engine: "anthropic",
        threadId: "thread-1",
        sessionId: "session-1",
        cursor,
        integrityKey,
        expectedOwner,
      });
      await expect(
        assertNativeHistoryParity({
          ...parityArgs,
          expectedCursor: cursor,
        }),
      ).resolves.toBeUndefined();
      await writeFile(
        path.join(root, "native-session.jsonl"),
        '{"role":"assistant","content":"attacker rewrite"}\n',
      );
      await expect(
        assertNativeHistoryParity({
          ...parityArgs,
          expectedCursor: cursor,
        }),
      ).rejects.toThrow("state bytes have changed");
      await expect(
        assertNativeHistoryParity({
          ...parityArgs,
          expectedCursor: nativeHistoryCursorFromRows([
            { ...row, turnId: "turn-2" },
          ]),
        }),
      ).rejects.toThrow("does not match");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("preserves Claude Code's own default", () => {
    expect(resolveClaudeModelArgs("default")).toEqual([]);
    expect(resolveClaudeModelArgs("claude-sonnet-4-6")).toEqual([
      "--model",
      "claude-sonnet-4-6",
    ]);
    expect(resolveClaudeReasoningArgs("default")).toEqual([]);
  });

  it("maps Stella's extended effort names to Claude Code", () => {
    expect(resolveClaudeReasoningArgs("none")).toEqual([
      "--thinking",
      "disabled",
    ]);
    expect(resolveClaudeReasoningArgs("minimal")).toEqual([
      "--effort",
      "low",
      "--thinking",
      "enabled",
    ]);
    expect(resolveClaudeReasoningArgs("xhigh")).toEqual([
      "--effort",
      "max",
      "--thinking",
      "enabled",
    ]);
  });

  it("does not pass executor token variable names into Claude", () => {
    const env = buildClaudeChildEnv({
      initialEnv: {
        STELLA_TURN_TOKEN: "executor-token",
        STELLA_CODEX_TURN_TOKEN: "codex-token",
        KEEP_ME: "safe",
      },
      gatewayOrigin: "https://gateway.example.test",
      stateRoot: "/workspace/drive/.stella/claude",
      capability: "turn-capability-jwt",
      reasoningEffort: "none",
    });
    expect(env.STELLA_TURN_TOKEN).toBeUndefined();
    expect(env.STELLA_CODEX_TURN_TOKEN).toBeUndefined();
    expect(env.KEEP_ME).toBe("safe");
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.example.test/v1/relay",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("turn-capability-jwt");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-stella-agent-type: general\nx-stella-llm-credential: anthropic",
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("turn-token");
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("unset");
  });

  it("uses Stella's takeover surface for cloud Claude", () => {
    const args = buildCloudClaudeTakeoverArgs({
      model: "claude-sonnet-4-6[1m]",
      reasoningEffort: "high",
      systemPrompt: "Stella cloud agent prompt",
      mcpConfigPath: "/workspace/state/turn-mcp.json",
      resume: false,
      sessionId: "session-id",
      inputPrompt: "Do the work",
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(
      args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
    expect(
      args.slice(
        args.indexOf("--setting-sources"),
        args.indexOf("--setting-sources") + 2,
      ),
    ).toEqual(["--setting-sources", ""]);
    expect(
      JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}"),
    ).toMatchObject({
      workflowKeywordTriggerEnabled: false,
      disableWorkflows: true,
    });
    expect(
      args.slice(
        args.indexOf("--system-prompt"),
        args.indexOf("--system-prompt") + 2,
      ),
    ).toEqual(["--system-prompt", "Stella cloud agent prompt"]);
    expect(args).not.toContain("--append-system-prompt");
    expect(
      args.slice(
        args.indexOf("--mcp-config"),
        args.indexOf("--mcp-config") + 2,
      ),
    ).toEqual(["--mcp-config", "/workspace/state/turn-mcp.json"]);
  });

  it("preserves Claude takeover arguments when resuming", () => {
    const args = buildCloudClaudeTakeoverArgs({
      model: "default",
      reasoningEffort: "default",
      systemPrompt: "Stella",
      mcpConfigPath: "/tmp/mcp.json",
      resume: true,
      sessionId: "session-id",
      inputPrompt: "Continue",
    });
    expect(args.slice(args.indexOf("--resume"), -1)).toEqual([
      "--resume",
      "session-id",
    ]);
    expect(args).toContain("--tools");
    expect(args).not.toContain("--session-id");
  });

  it("keeps the private Claude MCP credential outside the workspace", async () => {
    const config = await createCloudClaudeMcpConfig({
      type: "http",
      url: "http://127.0.0.1:1234/private",
      headers: { Authorization: "Bearer secret" },
    });
    try {
      expect(config.path.startsWith(`${tmpdir()}${path.sep}`)).toBe(true);
      expect(config.path.startsWith("/workspace/")).toBe(false);
      expect((await stat(path.dirname(config.path))).mode & 0o777).toBe(0o700);
      expect((await stat(config.path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({
        mcpServers: {
          stella: {
            type: "http",
            url: "http://127.0.0.1:1234/private",
            headers: { Authorization: "Bearer secret" },
          },
        },
      });
    } finally {
      await config.cleanup();
    }
    await expect(stat(config.path)).rejects.toThrow();
  });

  it("refuses cloud Claude before touching the workspace when its bridge is absent", async () => {
    await expect(
      runNativeAgentTurn({
        prompt: "Do the work",
        systemPrompt: "Stella",
        execution: {
          engine: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          reasoningEffort: "high",
        },
        gatewayOrigin: "https://gateway.example.test",
        capability: "turn-capability-jwt",
        threadId: "thread",
        turnId: "turn",
        authoritativeHistoryCursor: nativeHistoryCursorFromRows([]),
        stateIntegrityKey: "b".repeat(64),
        emitEvent: () => undefined,
      }),
    ).rejects.toThrow("Stella's Claude tool bridge is unavailable.");
  });

  it("exposes only the authenticated Stella MCP catalog and executes through it", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host = await createClaudeCodeToolMcpHost({
      tools: [
        {
          name: "cloud_echo",
          description: "Echo one cloud value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      identityScope: "thread:turn",
      getActiveTurn: () => ({
        identityScope: "thread:turn",
        executeTool: async (_toolCallId, name, args) => {
          calls.push({ name, args });
          return { result: `echo:${String(args.value)}` };
        },
      }),
    });
    const client = new Client(
      { name: "cloud-bridge-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      expect((await fetch(host.url)).status).toBe(401);
      const transport = new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: {
          headers: { Authorization: host.authorizationHeader },
        },
      });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["cloud_echo"],
      );
      await host.waitForClientReady(undefined, 100);
      const result = await client.callTool({
        name: "cloud_echo",
        arguments: { value: "hello" },
      });
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
      expect(calls).toEqual([{ name: "cloud_echo", args: { value: "hello" } }]);
    } finally {
      await client.close().catch(() => undefined);
      await host.close();
    }
  });
});
