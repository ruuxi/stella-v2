import { mkdtempSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      "call",
      "connectors",
      "discover",
      "documentation",
      "schema",
    ]);
    expect(connect.documentation()).toContain("connect.discover(query)");
    expect(connect.documentation()).toContain(
      "discover → actions → schema → call",
    );
    expect(connect.documentation()).not.toContain("stella-connect");

    await connect.discover("  google docs ");
    await connect.connectors();
    await connect.actions("googledocs", { query: "comment", limit: 5 });
    await connect.schema("googledocs", "GOOGLEDOCS_CREATE_COMMENT");
    await connect.call("googledocs", "GOOGLEDOCS_CREATE_COMMENT", { a: 1 });
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
