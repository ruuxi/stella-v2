import { describe, expect, it, vi } from "vitest";

import {
  NodeReplKernelRegistry,
  type ComputerUseSessionFactory,
} from "@stella/runtime/kernel/computer-use/kernel";
import type { ReplConnectClient } from "@stella/runtime/kernel/connectors/connect-service";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const context = (agentId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  runId: "run-1",
  agentId,
  agentType: "general",
  stellaAppDir: "/workspace",
  toolWorkspaceRoot: "/workspace/project",
  storageMode: "local",
});

const stubSessionFactory: ComputerUseSessionFactory = () => ({
  request: async () => {
    throw new Error("computer use is not exercised by these tests.");
  },
});

const createRegistry = (connectClient?: ReplConnectClient) =>
  new NodeReplKernelRegistry({
    sessionFactory: stubSessionFactory,
    idleTimeoutMs: 60_000,
    ...(connectClient ? { connectClient } : {}),
  });

describe("node_repl connect client dispatch", () => {
  it("exposes a frozen enumerable connect client with documentation", async () => {
    const registry = createRegistry();
    try {
      const output = await registry.evaluate(
        `nodeRepl.write(JSON.stringify({
            frozen: Object.isFrozen(connect),
            keys: Object.keys(connect).sort(),
            doc: connect.documentation().includes("connect.call(id, action, args)"),
          }))`,
        context("agent-connect-shape"),
      );
      expect(JSON.parse(output)).toEqual({
        frozen: true,
        keys: [
          "actions",
          "call",
          "connectors",
          "discover",
          "documentation",
          "schema",
        ],
        doc: true,
      });
    } finally {
      await registry.dispose();
    }
  }, 30_000);

  it("round-trips connect.actions through the host-side client", async () => {
    const actions = vi.fn(async (id: string, options?: unknown) => ({
      connector: id,
      total: 2,
      shown: 2,
      actions: [
        { name: "GMAIL_SEND_EMAIL", description: "Send an email." },
        { name: "GMAIL_CREATE_DRAFT", description: "Create a draft." },
      ],
      options,
    }));
    const client: ReplConnectClient = {
      discover: vi.fn(async () => ({ query: "", matches: [] })),
      connectors: vi.fn(async () => []),
      actions,
      schema: vi.fn(async () => ({})),
      call: vi.fn(async () => ({})),
    };
    const registry = createRegistry(client);
    try {
      const output = await registry.evaluate(
        `nodeRepl.write(JSON.stringify(await connect.actions("gmail", { query: "send", limit: 2 })))`,
        context("agent-connect-actions"),
      );
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        connector: "gmail",
        total: 2,
        options: { query: "send", limit: 2 },
      });
      expect(actions).toHaveBeenCalledWith("gmail", {
        query: "send",
        limit: 2,
      });
    } finally {
      await registry.dispose();
    }
  }, 30_000);

  it("propagates broker errors as thrown Errors inside the REPL", async () => {
    const client: ReplConnectClient = {
      discover: vi.fn(async () => ({})),
      connectors: vi.fn(async () => []),
      actions: vi.fn(async () => ({})),
      schema: vi.fn(async () => ({})),
      call: vi.fn(async () => {
        throw new Error(
          "Connector provider failed. (status 502, request req-safe-123)",
        );
      }),
    };
    const registry = createRegistry(client);
    try {
      const output = await registry.evaluate(
        `await connect.call("outlook", "OUTLOOK_QUERY_EMAILS", { folder: "inbox" }).catch((error) => "caught: " + error.message)`,
        context("agent-connect-error"),
      );
      expect(output).toContain(
        "caught: Connector provider failed. (status 502, request req-safe-123)",
      );
      expect(client.call).toHaveBeenCalledWith(
        "outlook",
        "OUTLOOK_QUERY_EMAILS",
        { folder: "inbox" },
      );
    } finally {
      await registry.dispose();
    }
  }, 30_000);

  it("fails cleanly when no connect client is wired", async () => {
    const registry = createRegistry();
    try {
      const output = await registry.evaluate(
        `await connect.connectors().catch((error) => "caught: " + error.message)`,
        context("agent-connect-missing"),
      );
      expect(output).toContain(
        "caught: connect is not available in this session.",
      );
    } finally {
      await registry.dispose();
    }
  }, 30_000);
});
