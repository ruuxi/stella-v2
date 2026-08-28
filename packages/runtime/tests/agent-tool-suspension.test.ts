import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { Api, AssistantMessage, Model } from "../ai/types.js";
import { createAssistantMessageEventStream } from "../ai/utils/event-stream.js";
import { Agent } from "../kernel/agent-core/agent.js";
import {
  executePreparedToolCall,
  type PreparedToolCall,
} from "../kernel/agent-core/agent-loop.js";
import {
  AgentToolSuspendedError,
  isAgentToolSuspendedError,
} from "../kernel/agent-core/suspension.js";
import type { AgentEvent, AgentTool } from "../kernel/agent-core/types.js";
import type { BrowserSessionClient } from "../kernel/browser-use/client.js";
import { NodeReplKernelRegistry } from "../kernel/computer-use/kernel.js";
import {
  createBrowserOnlyComputerUseSession,
  createToolHost,
} from "../kernel/tools/host.js";
import type { ToolContext } from "../kernel/tools/types.js";

const suspension = (
  toolCallId = "gateway-placeholder",
): CloudBrowserSuspension => ({
  schemaVersion: 1,
  outcome: "waiting_for_user",
  interactionId: "interaction-1",
  interactionRevision: 1,
  interactionKind: "login_takeover",
  toolCallId,
  requestDigest: "a".repeat(64),
  profileId: "default",
  profileEpoch: 1,
  displayOrigin: "https://example.test",
  displayTitle: "Example",
  expiresAt: Date.now() + 60_000,
});

const makePrepared = (execute: AgentTool["execute"]): PreparedToolCall => ({
  kind: "prepared",
  toolCall: {
    type: "toolCall",
    id: "canonical-tool-call",
    name: "code",
    arguments: {},
  },
  tool: {
    name: "code",
    label: "Code",
    description: "test code tool",
    parameters: { type: "object", properties: {} } as never,
    execute,
  },
  args: {},
});

const model = {
  id: "suspension-test",
  name: "Suspension test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const assistantToolCall = (): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: "canonical-tool-call",
      name: "code",
      arguments: { code: "await browser.command('url')" },
    },
  ],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: Date.now(),
});

describe("agent tool suspension", () => {
  it("provides a browser-only Linux computer stub with no desktop authority", async () => {
    const session = createBrowserOnlyComputerUseSession();
    await expect(session.request({} as never)).rejects.toThrow(
      "Typed Computer Use is not available in browser-only cloud execution.",
    );
  });

  it("keeps cloud code denied unless the trusted host injects its browser transport", async () => {
    const stateRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-cloud-code-host-"),
    );
    const context: ToolContext = {
      conversationId: "conversation-1",
      deviceId: "cloud",
      requestId: "turn-1",
      runId: "turn-1",
      agentId: "thread-1",
      agentType: "general",
      workingDirectory: stateRoot,
      stellaAppDir: stateRoot,
      stellaDataDir: stateRoot,
      toolWorkspaceRoot: stateRoot,
      storageMode: "cloud",
      allowedToolNames: ["code"],
    };
    const denied = createToolHost({
      stellaAppDir: stateRoot,
      stellaDataDir: stateRoot,
      recoverStaleSecrets: false,
      enableShellShims: false,
    });
    const browserSession = {
      command: async () => {
        throw new Error("unexpected browser command");
      },
      chain: async () => {
        throw new Error("unexpected browser chain");
      },
      dispose: async () => undefined,
    } as BrowserSessionClient;
    const allowed = createToolHost({
      stellaAppDir: stateRoot,
      stellaDataDir: stateRoot,
      recoverStaleSecrets: false,
      enableShellShims: false,
      allowCloudCode: true,
      browserSessionFactory: () => browserSession,
    });
    try {
      await expect(
        denied.executeTool("code", { code: "1 + 1" }, context),
      ).resolves.toEqual({
        error: "code is not available in cloud execution.",
      });
      await expect(
        allowed.executeTool("code", { code: "1 + 1" }, context),
      ).resolves.toMatchObject({ result: "2" });
      await expect(
        allowed.executeTool(
          "code",
          {
            code: `JSON.stringify({
              browser: typeof browser,
              newTab: typeof browser.tabs.new,
              loginTakeover: typeof browser.requestLoginTakeover,
              frozenNamespace: typeof frozen,
            })`,
          },
          context,
        ),
      ).resolves.toMatchObject({
        result:
          "'{\"browser\":\"object\",\"newTab\":\"function\",\"loginTakeover\":\"function\",\"frozenNamespace\":\"undefined\"}'",
      });
    } finally {
      await Promise.all([denied.shutdown(), allowed.shutdown()]);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("escapes a tool window, binds the canonical call id, and awaits updates", async () => {
    let releaseUpdate!: () => void;
    const updateSettled = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const run = executePreparedToolCall(
      makePrepared(async (_id, _args, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "working" }] });
        throw new AgentToolSuspendedError(suspension());
      }),
      undefined,
      (event) =>
        event.type === "tool_execution_update" ? updateSettled : undefined,
      1_000,
    );
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(releaseUpdate).toBeTypeOf("function"));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseUpdate();

    const error = await run.catch((failure: unknown) => failure);
    expect(isAgentToolSuspendedError(error)).toBe(true);
    if (!isAgentToolSuspendedError(error)) throw error;
    expect(error.suspension.toolCallId).toBe("canonical-tool-call");
  });

  it("keeps ordinary tool failures as model-visible error results", async () => {
    await expect(
      executePreparedToolCall(
        makePrepared(async () => {
          throw new Error("ordinary failure");
        }),
        undefined,
        () => undefined,
        1_000,
      ),
    ).resolves.toMatchObject({
      isError: true,
      result: { content: [{ type: "text", text: "ordinary failure" }] },
    });
  });

  it("leaves Agent at the assistant tool-call boundary without terminal error events", async () => {
    const message = assistantToolCall();
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    });
    const tool: AgentTool = {
      name: "code",
      label: "Code",
      description: "test code tool",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        throw new AgentToolSuspendedError(suspension());
      },
    };
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn,
      toolExecution: "sequential",
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const error = await agent
      .prompt("Sign in to Example.")
      .catch((failure: unknown) => failure);
    expect(isAgentToolSuspendedError(error)).toBe(true);

    expect(agent.state.messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", id: "canonical-tool-call", name: "code" }],
    });
    expect(agent.state.error).toBeUndefined();
    expect(agent.state.isStreaming).toBe(false);
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(
      false,
    );
    expect(
      events.some(
        (event) =>
          event.type === "message_end" && event.message.role === "toolResult",
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
  });

  it("terminates the code worker so JavaScript catch cannot swallow browser suspension", async () => {
    const dispose = vi.fn(async () => undefined);
    const beginTurn = vi.fn();
    const command = vi.fn(async () => {
      throw new AgentToolSuspendedError(suspension());
    });
    const browserSession = {
      command,
      beginTurn,
      chain: async () => {
        throw new Error("unexpected chain");
      },
      dispose,
    } as BrowserSessionClient;
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({
        request: async () => {
          throw new Error("browser-only computer stub should not be called");
        },
      }),
      browserSessionFactory: () => browserSession,
      disposeTimeoutMs: 1_000,
    });
    const context: ToolContext = {
      conversationId: "conversation-1",
      deviceId: "cloud",
      requestId: "outer-code-tool-call",
      agentId: "thread-1",
      agentType: "general",
      workingDirectory: process.cwd(),
      toolWorkspaceRoot: process.cwd(),
      storageMode: "cloud",
      allowedToolNames: ["code"],
    };
    try {
      const error = await registry
        .startCell(
          `await (async () => {
            try {
              await browser.requestLoginTakeover({
                allowedOrigins: ["https://www.demoblaze.com"],
                displayOrigin: "https://www.demoblaze.com",
                startUrl: "https://www.demoblaze.com/index.html",
                verification: {
                  expectedOrigin: "https://www.demoblaze.com",
                  authenticatedSelector: "#nameofuser",
                  loggedOutSelector: "#login2",
                  resumeUrl: "https://www.demoblaze.com/index.html",
                },
              });
              return "completed";
            } catch {
              return "swallowed";
            }
          })()`,
          context,
          { yieldTimeMs: 2_000 },
        )
        .catch((failure: unknown) => failure);
      expect(command).toHaveBeenCalledOnce();
      expect(beginTurn).toHaveBeenCalledWith("outer-code-tool-call");
      expect(command).toHaveBeenCalledWith(
        "cloud_login_takeover",
        expect.not.objectContaining({ toolCallId: expect.anything() }),
        expect.any(Object),
      );
      if (!isAgentToolSuspendedError(error)) throw error;
      expect(isAgentToolSuspendedError(error)).toBe(true);
    } finally {
      await registry.dispose();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("joins browser end-turn checkpointing before disposing the code kernel", async () => {
    const lifecycle: string[] = [];
    let releaseEndTurn: (() => void) | undefined;
    const endTurn = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          lifecycle.push("checkpoint:start");
          releaseEndTurn = () => {
            lifecycle.push("checkpoint:done");
            resolve();
          };
        }),
    );
    const browserSession = {
      beginTurn: vi.fn(),
      endTurn,
      command: vi.fn(async (action, params = {}) => ({
        sessionId: "thread-1",
        bridgeSessionId: "cloud-browser-run",
        requestId: "browser-request-1",
        action,
        params,
        result: {
          id: "browser-request-1",
          success: true as const,
          data: { tabs: [] },
        },
        attempts: 1,
        durationMs: 0,
      })),
      chain: async () => {
        throw new Error("unexpected chain");
      },
      dispose: vi.fn(async () => {
        lifecycle.push("dispose");
      }),
    } as BrowserSessionClient;
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({
        request: async () => {
          throw new Error("browser-only computer stub should not be called");
        },
      }),
      browserSessionFactory: () => browserSession,
      disposeTimeoutMs: 1_000,
    });
    const context: ToolContext = {
      conversationId: "conversation-1",
      deviceId: "cloud",
      requestId: "outer-code-tool-call",
      agentId: "thread-1",
      agentType: "general",
      workingDirectory: process.cwd(),
      toolWorkspaceRoot: process.cwd(),
      storageMode: "cloud",
      allowedToolNames: ["code"],
    };
    try {
      await registry.startCell("await browser.tabs.list()", context, {
        yieldTimeMs: 2_000,
      });
      let settled = false;
      const ending = registry
        .endBrowserTurn("outer-code-tool-call", "retain-tabs")
        .then(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(endTurn).toHaveBeenCalledWith(
        "outer-code-tool-call",
        "retain-tabs",
      );
      expect(settled).toBe(false);
      expect(lifecycle).toEqual(["checkpoint:start"]);
      releaseEndTurn?.();
      await ending;
      expect(lifecycle).toEqual(["checkpoint:start", "checkpoint:done"]);
    } finally {
      await registry.dispose();
    }
    expect(lifecycle).toEqual([
      "checkpoint:start",
      "checkpoint:done",
      "dispose",
    ]);
  });
});
