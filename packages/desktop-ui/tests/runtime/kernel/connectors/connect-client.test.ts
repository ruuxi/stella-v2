import http from "node:http";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadConnectorAccessToken,
  saveConnectorAccessToken,
} from "@stella/runtime/kernel/connectors/oauth";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

import {
  writeCachedServerCatalog,
  resolveNativeConnectorCatalog,
} from "@stella/runtime/kernel/connectors/catalog-cache";
import type { NativeConnectorCatalogEntry } from "@stella/runtime/kernel/connectors/native-integrations";
import {
  CONNECT_ACTIONS_DEFAULT_LIMIT,
  ConnectorBrokerActionError,
  createReplConnectClient,
} from "@stella/runtime/kernel/connectors/connect-service";
import {
  installConnectWorkerApi,
  type ConnectWorkerCall,
} from "@stella/runtime/kernel/connectors/connect-worker-api";
import {
  createConnectorStatusTool,
  resetConnectorStatusCatalogMemo,
} from "@stella/runtime/kernel/tools/defs/connector-status";
import { startCliBridgeServer } from "@stella/runtime/worker/cli-bridge-server";

const roots: string[] = [];
const bridges: Array<{ stop: () => Promise<void> }> = [];

const backendEntry = (
  id: string,
  name: string,
  toolkit = id.toUpperCase(),
  actions?: NativeConnectorCatalogEntry["actions"],
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: actions?.length ?? 12,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} test integration.`,
  connectable: true,
  backendConnector: { type: "composio", toolkit },
  ...(actions ? { actions } : {}),
});

const makeRoot = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-client-"));
  roots.push(root);
  await mkdir(path.join(root, "connectors"), { recursive: true });
  return root;
};

const enable = async (root: string, ids: string[]) => {
  await writeFile(
    path.join(root, "connectors/native-integrations.json"),
    JSON.stringify({
      version: 1,
      integrations: Object.fromEntries(
        ids.map((id) => [id, { enabled: true, updatedAt: Date.now() }]),
      ),
    }),
  );
};

const startBridge = async (root: string, handlers: Record<string, unknown>) => {
  const bridge = await startCliBridgeServer({
    socketPath: path.join(root, "bridge.sock"),
    handlers: {
      requestConnectorCredential: async () => ({
        ok: false as const,
        reason: "unused",
      }),
      ...handlers,
    },
  });
  bridges.push(bridge);
  return bridge;
};

afterEach(async () => {
  resetConnectorStatusCatalogMemo();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installConnectWorkerApi (in-REPL surface)", () => {
  it("is self-contained when stringified, frozen, and enumerable", async () => {
    const restored = (0, eval)(
      `(${installConnectWorkerApi.toString()})`,
    ) as typeof installConnectWorkerApi;
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const connect = restored(async (method, args) => {
      calls.push({ method, args });
      return { ok: true };
    });

    expect(Object.isFrozen(connect)).toBe(true);
    expect(Object.keys(connect).sort()).toEqual([
      "actions",
      "addMcp",
      "call",
      "connectors",
      "discover",
      "documentation",
      "remove",
      "schema",
    ]);
    expect(connect.documentation()).toContain("connect.discover(query)");
    expect(connect.documentation()).toContain(
      "discover → actions → schema → call",
    );
    expect(connect.documentation()).toContain("connect.addMcp(");
    expect(connect.documentation()).toContain("connect.remove(id)");
    // One example each for the two transports.
    expect(connect.documentation()).toContain(
      'transport: { url: "https://mcp.linear.app/mcp" }',
    );
    expect(connect.documentation()).toContain(
      'transport: { command: "npx", args: ["-y", "my-mcp-server"] }',
    );
    // The doc must not claim the client can only call connectors.
    expect(connect.documentation()).toContain("manages connectors too");
    expect(connect.documentation()).not.toContain("stella-connect");

    await connect.discover("  google docs ");
    await connect.connectors();
    await connect.actions("googledocs", { query: "comment", limit: 5 });
    await connect.schema("googledocs", "GOOGLEDOCS_CREATE_COMMENT");
    await connect.call("googledocs", "GOOGLEDOCS_CREATE_COMMENT", { a: 1 });
    await connect.addMcp({ id: "svc", transport: { url: "https://x.test/mcp" } });
    await connect.remove(" svc ");
    expect(calls).toEqual([
      { method: "discover", args: ["google docs"] },
      { method: "connectors", args: [] },
      {
        method: "actions",
        args: ["googledocs", { query: "comment", limit: 5 }],
      },
      { method: "schema", args: ["googledocs", "GOOGLEDOCS_CREATE_COMMENT"] },
      {
        method: "call",
        args: ["googledocs", "GOOGLEDOCS_CREATE_COMMENT", { a: 1 }],
      },
      {
        method: "addMcp",
        args: [{ id: "svc", transport: { url: "https://x.test/mcp" } }],
      },
      { method: "remove", args: ["svc"] },
    ]);
  });

  it("rejects malformed arguments before touching the protocol", async () => {
    const callConnect: ConnectWorkerCall = vi.fn(async () => null);
    const connect = installConnectWorkerApi(callConnect);
    expect(() => connect.discover("   ")).toThrow(/non-empty string/);
    expect(() =>
      connect.actions("gmail", [] as unknown as { query?: string }),
    ).toThrow(/plain object/);
    expect(() =>
      connect.call(
        "gmail",
        "GMAIL_SEND",
        5 as unknown as Record<string, unknown>,
      ),
    ).toThrow(/plain object/);
    expect(() => connect.schema("gmail", "")).toThrow(/non-empty string/);
    expect(() =>
      connect.addMcp(5 as unknown as Record<string, unknown>),
    ).toThrow(/plain object/);
    expect(() => connect.remove("   ")).toThrow(/non-empty string/);
    expect(callConnect).not.toHaveBeenCalled();
  });
});

describe("createReplConnectClient catalog surface", () => {
  it("preserves cached backend provider semantics for actions/schema", async () => {
    const root = await makeRoot();
    const entries = [
      backendEntry("outlook", "Outlook", "OUTLOOK"),
      backendEntry("gmail", "Gmail", "GMAIL"),
      backendEntry("notion", "Notion", "NOTION"),
    ];
    await writeCachedServerCatalog(root, entries);
    await enable(
      root,
      entries.map((entry) => entry.id),
    );
    const client = createReplConnectClient({ stellaAppDir: root });

    for (const [id, tool] of [
      ["outlook", "OUTLOOK_RUN_ACTION"],
      ["gmail", "GMAIL_RUN_ACTION"],
      ["notion", "NOTION_RUN_ACTION"],
    ] as const) {
      const list = (await client.actions(id)) as {
        actions: Array<{ name: string }>;
        total: number;
      };
      expect(list.actions).toEqual([expect.objectContaining({ name: tool })]);
      const schema = (await client.schema(id, tool)) as {
        inputSchema: Record<string, unknown> | null;
      };
      expect(schema.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("caps action listings, filters by query, and clamps limits", async () => {
    const root = await makeRoot();
    const actions = Array.from({ length: 40 }, (_, index) => ({
      name: `ACME_ACTION_${index}`,
      description:
        index === 7
          ? "Send an invoice email to a customer."
          : `Action ${index}.`,
      inputSchema: {
        type: "object",
        required: ["target"],
        properties: {
          target: { type: "string" },
          dry_run: { type: "boolean" },
        },
      },
    }));
    const entry = backendEntry("acme", "Acme", "ACME", actions);
    await writeCachedServerCatalog(root, [entry]);
    await enable(root, ["acme"]);
    const client = createReplConnectClient({ stellaAppDir: root });

    const capped = (await client.actions("acme")) as {
      total: number;
      shown: number;
      actions: Array<{ name: string; params?: string }>;
      hint?: string;
    };
    expect(capped.total).toBe(40);
    expect(capped.shown).toBe(CONNECT_ACTIONS_DEFAULT_LIMIT);
    expect(capped.actions).toHaveLength(CONNECT_ACTIONS_DEFAULT_LIMIT);
    expect(capped.hint).toMatch(/connect\.schema/);
    expect(capped.actions[0]?.params).toBe(
      "required: target; optional: dry_run",
    );

    const filtered = (await client.actions("acme", {
      query: "invoice email",
    })) as { total: number; actions: Array<{ name: string }> };
    expect(filtered.total).toBe(1);
    expect(filtered.actions[0]?.name).toBe("ACME_ACTION_7");

    const clamped = (await client.actions("acme", { limit: 10_000 })) as {
      shown: number;
    };
    expect(clamped.shown).toBe(40);

    const floored = (await client.actions("acme", { limit: -3 })) as {
      shown: number;
    };
    expect(floored.shown).toBe(1);
  });

  it("keeps bundled incomplete metadata non-executable while Gmail stays local", async () => {
    const root = await makeRoot();
    await enable(root, ["outlook", "gmail"]);
    const client = createReplConnectClient({ stellaAppDir: root });

    // Bundled Outlook is planning metadata only: listing works, calling fails.
    const outlookActions = (await client.actions("outlook", {
      limit: 5,
    })) as { total: number };
    expect(outlookActions.total).toBeGreaterThan(0);
    await expect(
      client.call("outlook", "OUTLOOK_QUERY_EMAILS", {}),
    ).rejects.toThrow(/local execution is incomplete/);

    const gmail = (await client.actions("gmail", { limit: 100 })) as {
      actions: Array<{ name: string }>;
    };
    expect(gmail.actions).toContainEqual(
      expect.objectContaining({ name: "gmail.search" }),
    );
  });

  it("lists enabled connectors and discovers with the shared cap and hints", async () => {
    const root = await makeRoot();
    const backendOnly = backendEntry(
      "acme_backend_only",
      "Acme Backend Only",
      "ACME",
    );
    await writeCachedServerCatalog(root, [backendOnly]);
    await enable(root, [backendOnly.id]);
    await writeFile(
      path.join(root, "connectors/commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "linear-mcp",
            displayName: "Linear MCP",
            description: "Issue tracking via imported MCP.",
            transport: "streamable_http",
            url: "https://example.invalid/mcp",
            auth: { type: "none" },
          },
        ],
      }),
    );
    const client = createReplConnectClient({ stellaAppDir: root });

    const connectors = (await client.connectors()) as Array<{
      id: string;
      kind: string;
      connected: boolean;
    }>;
    expect(connectors).toContainEqual(
      expect.objectContaining({
        id: "acme_backend_only",
        kind: "native",
        connected: true,
      }),
    );
    expect(connectors).toContainEqual(
      expect.objectContaining({ id: "linear-mcp", kind: "mcp" }),
    );

    const discovery = (await client.discover("acme backend")) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(discovery.matches.length).toBeLessThanOrEqual(8);
    const match = discovery.matches.find(
      (candidate) => candidate.id === "acme_backend_only",
    );
    expect(match).toEqual(
      expect.objectContaining({
        id: "acme_backend_only",
        catalogSource: "cache",
        provider: "backend-composio",
        toolCount: 1,
        executable: true,
      }),
    );
    expect(String(match?.next)).toContain(
      'connect.actions("acme_backend_only")',
    );
    expect(String(match?.next)).not.toContain("stella-connect");

    const mcpDiscovery = (await client.discover("linear issues")) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(
      mcpDiscovery.matches.find((candidate) => candidate.id === "linear-mcp"),
    ).toEqual(expect.objectContaining({ id: "linear-mcp", kind: "mcp" }));
  });

  it("agrees with connector_status on cached catalog source and provider", async () => {
    const root = await makeRoot();
    const outlook = backendEntry("outlook", "Outlook", "OUTLOOK");
    await writeCachedServerCatalog(root, [outlook]);
    await enable(root, ["outlook"]);

    const resolved = await resolveNativeConnectorCatalog({
      stellaDataDir: root,
    });
    expect(resolved.source).toBe("cache");

    const status = await createConnectorStatusTool({
      stellaDataDir: root,
    }).execute(
      { connector: "outlook" },
      { conversationId: "c1", deviceId: "d1", requestId: "r1" },
    );
    const client = createReplConnectClient({ stellaAppDir: root });
    const discovery = (await client.discover("outlook email")) as {
      matches: Array<Record<string, unknown>>;
    };
    const match = discovery.matches.find((entry) => entry.id === "outlook");
    expect(status.details).toMatchObject({
      catalogSource: match?.catalogSource,
      provider: match?.provider,
      toolCount: match?.toolCount,
      executable: match?.executable,
    });
    expect(String(status.result)).not.toContain("stella-connect");
  });

  it("rejects unknown connectors and unknown actions with actionable hints", async () => {
    const root = await makeRoot();
    const client = createReplConnectClient({ stellaAppDir: root });
    await expect(client.actions("nonexistent_connector")).rejects.toThrow(
      /connect\.discover/,
    );
    await expect(
      client.schema("gmail", "GMAIL_NOT_A_REAL_ACTION"),
    ).rejects.toThrow(/connect\.actions\("gmail"/);
    await expect(
      client.call("nonexistent_connector", "X_Y", {}),
    ).rejects.toThrow(/not installed/);
  });
});

describe("createReplConnectClient broker round-trip", () => {
  const outlookRoot = async () => {
    const root = await makeRoot();
    await writeCachedServerCatalog(root, [
      backendEntry("outlook", "Outlook", "OUTLOOK"),
    ]);
    await enable(root, ["outlook"]);
    return root;
  };

  it("discovers backend actions and preserves Google Ads request fields", async () => {
    const root = await makeRoot();
    await writeCachedServerCatalog(root, [
      backendEntry("googleads", "Google Ads", "GOOGLEADS"),
    ]);
    await enable(root, ["googleads"]);
    const mutationSchema = {
      type: "object",
      additionalProperties: false,
      required: ["customer_id", "operations"],
      properties: {
        customer_id: { type: "string" },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              create: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  name_: { type: "string" },
                  nested_values: {
                    type: "array",
                    items: { type: "object" },
                  },
                },
              },
            },
          },
        },
        validate_only: { type: "boolean" },
        partial_failure: { type: "boolean" },
        response_content_type: { type: "string" },
      },
    };
    const catalogActions = [
      {
        name: "GOOGLEADS_MUTATE_CAMPAIGNS",
        description: "Mutate campaigns.",
        inputSchema: mutationSchema,
      },
      {
        name: "GOOGLEADS_MUTATE_AD_GROUPS",
        description: "Mutate ad groups.",
        inputSchema: mutationSchema,
      },
      {
        name: "GOOGLEADS_SEARCH_STREAM_GAQL",
        description: "Run a read-only GAQL query.",
        inputSchema: {
          type: "object",
          required: ["customer_id", "query"],
          properties: {
            customer_id: { type: "string" },
            query: { type: "string" },
          },
        },
      },
    ];
    const listBackendConnectorActions = vi.fn(
      async (params: { action?: string; query?: string }) => {
        const actions = catalogActions.filter(
          (candidate) =>
            (!params.action || candidate.name === params.action) &&
            (!params.query ||
              candidate.name
                .toLowerCase()
                .includes(params.query.toLowerCase())),
        );
        return {
          ok: true as const,
          actionCount: catalogActions.length,
          actions,
          nextCursor: null,
        };
      },
    );
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { data: { validated: true } },
    }));
    const bridge = await startBridge(root, {
      listBackendConnectorActions,
      runBackendConnectorAction,
    });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });

    const listed = await client.actions("googleads", {
      query: "mutate",
      limit: 100,
    });
    expect(listed.actions.map((action) => action.name)).toEqual([
      "GOOGLEADS_MUTATE_CAMPAIGNS",
      "GOOGLEADS_MUTATE_AD_GROUPS",
    ]);
    const campaignSchema = await client.schema(
      "googleads",
      "GOOGLEADS_MUTATE_CAMPAIGNS",
    );
    expect(campaignSchema.inputSchema).toEqual(mutationSchema);
    expect(campaignSchema.inputSchema.properties).toEqual(
      expect.objectContaining({
        validate_only: { type: "boolean" },
        partial_failure: { type: "boolean" },
        response_content_type: { type: "string" },
      }),
    );

    const campaignArguments = {
      customer_id: "1234567890",
      operations: [
        {
          create: {
            name: "Synthetic campaign",
            nested_values: [{ enabled: false }, { bid: 0 }],
          },
        },
      ],
      validate_only: true,
      partial_failure: false,
      response_content_type: "MUTABLE_RESOURCE",
    };
    await client.call(
      "googleads",
      "GOOGLEADS_MUTATE_CAMPAIGNS",
      campaignArguments,
    );
    expect(runBackendConnectorAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectorId: "googleads",
        action: "GOOGLEADS_MUTATE_CAMPAIGNS",
        input: campaignArguments,
      }),
    );

    const adGroupArguments = {
      customer_id: "1234567890",
      operations: [
        {
          create: {
            type: "SEARCH_STANDARD",
            name_: "preserve_this_key",
            nested_values: [{ enabled: false }, { bid: 0 }],
          },
        },
      ],
      validate_only: true,
      partial_failure: false,
    };
    expect(JSON.stringify(adGroupArguments)).toContain('"type"');
    expect(JSON.stringify(adGroupArguments)).not.toContain('"type_"');
    await client.call(
      "googleads",
      "GOOGLEADS_MUTATE_AD_GROUPS",
      adGroupArguments,
    );
    expect(runBackendConnectorAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectorId: "googleads",
        action: "GOOGLEADS_MUTATE_AD_GROUPS",
        input: adGroupArguments,
      }),
    );

    const readInput = {
      customer_id: "1234567890",
      query: "SELECT campaign.id FROM campaign LIMIT 1",
    };
    await client.call("googleads", "GOOGLEADS_SEARCH_STREAM_GAQL", readInput);
    expect(runBackendConnectorAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "GOOGLEADS_SEARCH_STREAM_GAQL",
        input: readInput,
      }),
    );
  });

  it("executes through the bridge broker and returns the parsed result", async () => {
    const root = await outlookRoot();
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, messages: [{ id: "m1" }] },
    }));
    const bridge = await startBridge(root, { runBackendConnectorAction });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });

    const result = await client.call("outlook", "OUTLOOK_QUERY_EMAILS", {
      folder: "inbox",
      limit: 1,
    });
    expect(result).toMatchObject({ ok: true, messages: [{ id: "m1" }] });
    expect(runBackendConnectorAction).toHaveBeenCalledOnce();
    expect(runBackendConnectorAction.mock.calls[0]?.[0]).toMatchObject({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: { folder: "inbox", limit: 1 },
    });
  });

  it("unwraps RUN_ACTION envelopes into the nested broker action", async () => {
    const root = await outlookRoot();
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { done: true },
    }));
    const bridge = await startBridge(root, { runBackendConnectorAction });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });

    await client.call("outlook", "OUTLOOK_RUN_ACTION", {
      action: "OUTLOOK_QUERY_EMAILS",
      arguments: { folder: "inbox" },
    });
    expect(runBackendConnectorAction.mock.calls[0]?.[0]).toMatchObject({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: { folder: "inbox" },
    });
  });

  it("lets the trusted broker resolve an enabled id when the cache is cold", async () => {
    const root = await outlookRoot();
    await unlink(path.join(root, "connectors/catalog-cache.json"));
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true },
    }));
    const bridge = await startBridge(root, { runBackendConnectorAction });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });
    await expect(
      client.call("outlook", "OUTLOOK_QUERY_EMAILS", { folder: "inbox" }),
    ).resolves.toMatchObject({ ok: true });
    expect(runBackendConnectorAction).toHaveBeenCalledOnce();
  });

  it("throws the broker's message with diagnostics on refusal", async () => {
    const root = await outlookRoot();
    const bridge = await startBridge(root, {
      runBackendConnectorAction: async () => ({
        ok: false as const,
        reason: "backend_error",
        status: 502,
        requestId: "req-safe-123",
        message: "Connector provider failed.",
      }),
    });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });

    const failure = await client
      .call("outlook", "OUTLOOK_QUERY_EMAILS", {})
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ConnectorBrokerActionError);
    expect((failure as Error).message).toBe(
      "Connector provider failed. (status 502, request req-safe-123)",
    );
    expect((failure as ConnectorBrokerActionError).reason).toBe(
      "backend_error",
    );
  });

  it("preserves the signed-out failure message verbatim", async () => {
    const root = await outlookRoot();
    const bridge = await startBridge(root, {
      runBackendConnectorAction: async () => ({
        ok: false as const,
        reason: "not_signed_in",
        message: "Sign in to Stella before using this integration.",
      }),
    });
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: bridge.socketPath,
    });
    await expect(
      client.call("outlook", "OUTLOOK_QUERY_EMAILS", {}),
    ).rejects.toThrow("Sign in to Stella before using this integration.");
  });

  it("fails honestly when the broker socket is unreachable", async () => {
    const root = await outlookRoot();
    const client = createReplConnectClient({
      stellaAppDir: root,
      cliBridgeSocketPath: path.join(root, "missing.sock"),
    });
    await expect(
      client.call("outlook", "OUTLOOK_QUERY_EMAILS", {}),
    ).rejects.toThrow("The Stella connector broker is unavailable.");
  });
});

describe("connect.addMcp / connect.remove management surface", () => {
  beforeEach(() => {
    installTestSafeStorage();
  });
  afterEach(() => {
    resetTestSafeStorage();
  });

  const FIXTURE_INSTRUCTIONS = "Use fixture.read to fetch fixture records.";

  const writeStdioFixtureServer = async (root: string) => {
    const serverPath = path.join(root, "mcp-server.cjs");
    await writeFile(
      serverPath,
      `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: ${JSON.stringify(FIXTURE_INSTRUCTIONS)} }
    : request.method === "tools/list"
      ? { tools: [{ name: "fixture.read", description: "Read fixture", inputSchema: { type: "object" } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
    );
    return serverPath;
  };

  const readCommands = async (root: string) =>
    JSON.parse(
      await readFile(path.join(root, "connectors/commands.json"), "utf-8"),
    ) as { commands: Array<{ id: string }> };

  it("rejects malformed options before touching disk", async () => {
    const root = await makeRoot();
    const client = createReplConnectClient({ stellaAppDir: root });

    await expect(
      client.addMcp({ id: "Bad/Id", transport: { url: "https://x.test" } }),
    ).rejects.toThrow(/Invalid connector id/);
    await expect(client.addMcp({ id: "svc" })).rejects.toThrow(
      /transport: \{ url \}/,
    );
    await expect(
      client.addMcp({
        id: "svc",
        transport: { url: "https://x.test/mcp", command: "npx" },
      }),
    ).rejects.toThrow(/exactly one of url or command/);
    await expect(
      client.addMcp({ id: "svc", transport: { url: "ftp://x.test" } }),
    ).rejects.toThrow(/http\(s\)/);
    await expect(
      client.addMcp({
        id: "svc",
        transport: { url: "https://x.test/mcp" },
        auth: { type: "password" },
      }),
    ).rejects.toThrow(/auth\.type/);

    await expect(stat(path.join(root, "connectors/commands.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("imports a stdio MCP: probes tools, persists config, and writes a skill with server instructions", async () => {
    const root = await makeRoot();
    const serverPath = await writeStdioFixtureServer(root);
    const client = createReplConnectClient({ stellaAppDir: root });

    const result = (await client.addMcp({
      id: "Fixture-MCP",
      name: "Fixture MCP",
      transport: { command: process.execPath, args: [serverPath] },
    })) as {
      imported: { id: string; transport: string };
      toolCount: number;
      skillPath: string;
      probeDeferred?: true;
    };

    expect(result.imported).toMatchObject({
      id: "fixture-mcp",
      transport: "stdio",
    });
    expect(result.toolCount).toBe(1);
    expect(result.probeDeferred).toBeUndefined();

    const commands = await readCommands(root);
    expect(commands.commands).toEqual([
      expect.objectContaining({ id: "fixture-mcp", displayName: "Fixture MCP" }),
    ]);

    const skill = await readFile(result.skillPath, "utf-8");
    expect(result.skillPath).toBe(
      path.join(root, "skills", "fixture-mcp", "SKILL.md"),
    );
    expect(skill).toContain("<!-- stella-connect-mcp-skill -->");
    expect(skill).toContain("`fixture.read`");
    expect(skill).toContain(FIXTURE_INSTRUCTIONS);
    expect(skill).toContain('await connect.actions("fixture-mcp"');
    expect(skill).not.toContain("stella-connect ");

    // The imported connector is immediately listable through the client.
    const actions = (await client.actions("fixture-mcp")) as {
      actions: Array<{ name: string }>;
    };
    expect(actions.actions).toEqual([
      expect.objectContaining({ name: "fixture.read" }),
    ]);
  });

  it("surfaces non-auth probe failures without persisting anything", async () => {
    const root = await makeRoot();
    const client = createReplConnectClient({ stellaAppDir: root });
    await expect(
      client.addMcp({
        id: "broken",
        transport: {
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
        },
      }),
    ).rejects.toThrow();
    await expect(
      stat(path.join(root, "connectors/commands.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(path.join(root, "skills", "broken")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defers the probe on auth, then completes the skill once actions() succeeds with a credential", async () => {
    const root = await makeRoot();
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: string | Buffer) => {
        body += String(chunk);
      });
      req.on("end", () => {
        if (req.headers.authorization !== "Bearer secret-token") {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("auth required");
          return;
        }
        const message = JSON.parse(body || "{}") as {
          id?: string;
          method?: string;
        };
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "hosted", version: "1" },
                instructions: "Hosted fixture guidance.",
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "hosted.read",
                      description: "Read hosted fixture",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    try {
      const client = createReplConnectClient({ stellaAppDir: root });
      const result = (await client.addMcp({
        id: "hosted-fixture",
        transport: { url: `http://127.0.0.1:${address.port}/mcp` },
        auth: { type: "api_key", tokenKey: "hosted-fixture" },
      })) as {
        toolCount: number;
        skillPath: string;
        probeDeferred?: true;
        hint?: string;
      };

      // No bridge socket → no credential dialog → the probe defers but the
      // import is preserved (the user declared the auth shape on purpose).
      expect(result.probeDeferred).toBe(true);
      expect(result.toolCount).toBe(0);
      expect(result.hint).toContain('connect.actions("hosted-fixture")');
      const commands = await readCommands(root);
      expect(commands.commands).toEqual([
        expect.objectContaining({
          id: "hosted-fixture",
          transport: "streamable_http",
        }),
      ]);
      const stubSkill = await readFile(result.skillPath, "utf-8");
      expect(stubSkill).toContain(
        "Action list deferred until credentials are configured",
      );

      // The credential lands (out of band here); the next successful tools
      // listing rewrites the stub skill with real actions + instructions.
      await saveConnectorAccessToken(root, "hosted-fixture", "secret-token");
      const actions = (await client.actions("hosted-fixture")) as {
        actions: Array<{ name: string }>;
      };
      expect(actions.actions).toEqual([
        expect.objectContaining({ name: "hosted.read" }),
      ]);
      const refreshed = await readFile(result.skillPath, "utf-8");
      expect(refreshed).toContain("`hosted.read`");
      expect(refreshed).toContain("Hosted fixture guidance.");
      expect(refreshed).not.toContain(
        "Action list deferred until credentials are configured",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("removes an imported connector: config, generated skill, and stored tokens", async () => {
    const root = await makeRoot();
    const serverPath = await writeStdioFixtureServer(root);
    const client = createReplConnectClient({ stellaAppDir: root });
    const imported = (await client.addMcp({
      id: "fixture-mcp",
      transport: { command: process.execPath, args: [serverPath] },
      auth: { type: "api_key" },
    })) as { skillPath: string; probeDeferred?: true };
    // auth.tokenKey defaults to the connector id.
    await saveConnectorAccessToken(root, "fixture-mcp", "stored-secret");
    await expect(
      loadConnectorAccessToken(root, "fixture-mcp"),
    ).resolves.toBe("stored-secret");

    const removed = (await client.remove("fixture-mcp")) as {
      removed: { commands: number; apis: number };
      deletedTokenKeys: string[];
      skillRemoved: boolean;
    };
    expect(removed).toEqual({
      removed: { commands: 1, apis: 0 },
      deletedTokenKeys: ["fixture-mcp"],
      skillRemoved: true,
    });
    expect((await readCommands(root)).commands).toEqual([]);
    await expect(stat(imported.skillPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      loadConnectorAccessToken(root, "fixture-mcp"),
    ).resolves.toBeNull();
  });

  it("never deletes a user-authored skill directory on remove", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "connectors/commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "hand-rolled",
            displayName: "Hand Rolled",
            transport: "streamable_http",
            url: "https://example.invalid/mcp",
            auth: { type: "none" },
          },
        ],
      }),
    );
    const skillDir = path.join(root, "skills", "hand-rolled");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# my own notes\n");
    const client = createReplConnectClient({ stellaAppDir: root });

    const removed = (await client.remove("hand-rolled")) as {
      skillRemoved: boolean;
    };
    expect(removed.skillRemoved).toBe(false);
    await expect(
      readFile(path.join(skillDir, "SKILL.md"), "utf-8"),
    ).resolves.toContain("my own notes");
  });

  it("refuses to remove unknown ids and native Store integrations", async () => {
    const root = await makeRoot();
    await writeCachedServerCatalog(root, [backendEntry("outlook", "Outlook")]);
    const client = createReplConnectClient({ stellaAppDir: root });
    await expect(client.remove("missing-connector")).rejects.toThrow(
      /not installed/,
    );
    await expect(client.remove("outlook")).rejects.toThrow(/Store/);
  });
});
