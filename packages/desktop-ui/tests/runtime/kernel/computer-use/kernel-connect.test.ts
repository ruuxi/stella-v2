import { describe, expect, it, vi } from "vitest";

import {
  NodeReplKernelRegistry,
  type ComputerUseSessionFactory,
} from "@stella/runtime/kernel/computer-use/kernel";
import type { ReplConnectClient } from "@stella/runtime/kernel/connectors/connect-service";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const TEST_WORKSPACE_ROOT = process.cwd();

const context = (agentId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  runId: "run-1",
  agentId,
  agentType: "general",
  stellaAppDir: TEST_WORKSPACE_ROOT,
  toolWorkspaceRoot: TEST_WORKSPACE_ROOT,
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
          "addMcp",
          "call",
          "connectors",
          "discover",
          "documentation",
          "remove",
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
      addMcp: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
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

  it("finds a GitHub action by name and description and invokes it through the proxy", async () => {
    const createPullRequest = {
      name: "GITHUB_CREATE_PULL_REQUEST",
      description: "Create a pull request from a head branch to a base branch.",
    };
    const call = vi.fn(async () => ({
      number: 42,
      html_url: "https://github.test/fromyou/stella/pull/42",
    }));
    const client: ReplConnectClient = {
      discover: vi.fn(async () => ({ query: "", matches: [] })),
      connectors: vi.fn(async () => []),
      actions: vi.fn(async (_id: string, options?: { query?: string }) => ({
        connector: "github",
        total: 1,
        shown: 1,
        actions:
          options?.query &&
          options.query
            .toLowerCase()
            .split(/\s+/)
            .every((term) =>
              `${createPullRequest.name} ${createPullRequest.description}`
                .toLowerCase()
                .includes(term),
            )
            ? [createPullRequest]
            : [],
      })),
      schema: vi.fn(async () => ({})),
      call,
      addMcp: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    };
    const registry = createRegistry(client);
    try {
      const output = await registry.evaluate(
        `const found = await connect.actions("github", { query: "create pull request" });
         const action = found.actions[0];
         const result = await connect.call("github", action.name, {
           owner: "fromyou",
           repo: "stella",
           head: "feature",
           base: "main",
           title: "Deferred tools",
         });
         nodeRepl.write(JSON.stringify({ action, result }))`,
        context("agent-connect-github"),
      );
      expect(JSON.parse(output)).toEqual({
        action: createPullRequest,
        result: {
          number: 42,
          html_url: "https://github.test/fromyou/stella/pull/42",
        },
      });
      expect(call).toHaveBeenCalledWith(
        "github",
        "GITHUB_CREATE_PULL_REQUEST",
        {
          owner: "fromyou",
          repo: "stella",
          head: "feature",
          base: "main",
          title: "Deferred tools",
        },
      );
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
      addMcp: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
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

  it("round-trips connect.addMcp and connect.remove through the host client", async () => {
    const addMcp = vi.fn(async (options: Record<string, unknown>) => ({
      imported: { id: options.id },
      toolCount: 1,
      skillPath: "/tmp/skills/x/SKILL.md",
    }));
    const remove = vi.fn(async (id: string) => ({
      removed: { commands: 1, apis: 0 },
      deletedTokenKeys: [id],
      skillRemoved: true,
    }));
    const client: ReplConnectClient = {
      discover: vi.fn(async () => ({})),
      connectors: vi.fn(async () => []),
      actions: vi.fn(async () => ({})),
      schema: vi.fn(async () => ({})),
      call: vi.fn(async () => ({})),
      addMcp,
      remove,
    };
    const registry = createRegistry(client);
    try {
      const output = await registry.evaluate(
        `const added = await connect.addMcp({ id: "fixture", transport: { url: "https://example.com/mcp" } });
         const removed = await connect.remove("fixture");
         nodeRepl.write(JSON.stringify({ added, removed }))`,
        context("agent-connect-manage"),
      );
      expect(JSON.parse(output)).toMatchObject({
        added: { imported: { id: "fixture" }, toolCount: 1 },
        removed: { deletedTokenKeys: ["fixture"], skillRemoved: true },
      });
      expect(addMcp).toHaveBeenCalledWith({
        id: "fixture",
        transport: { url: "https://example.com/mcp" },
      });
      expect(remove).toHaveBeenCalledWith("fixture");
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
