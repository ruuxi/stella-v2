/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_SECRET = "cloud-integrations-service-secret";
const OWNER_ID = "owner:cloud-integration-http";
const OWNER_GENERATION = "generation:cloud-integration-http";
const TURN_ID = "turn:cloud-integration-http";
const TURN_TOKEN = "turn-token-cloud-integration-http";
const READ_TOOL = "native__gmail__GMAIL_GET_PROFILE";
const WRITE_TOOL = "native__gmail__GMAIL_SEND_EMAIL";
const POLICY_VERSION = "2026-08-26.gmail-get-profile.v1";
const TOOLKIT_VERSION = "20260817_00";
const INPUT_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: { user_id: { type: "string" } },
  additionalProperties: false,
});
const REVIEWED_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: { user_id: { type: "string", minLength: 1, maxLength: 320 } },
  additionalProperties: false,
});

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const reviewedRevision = async () =>
  `v2:${await sha256Hex(
    JSON.stringify({
      version: 2,
      integrationId: "gmail",
      action: "GMAIL_GET_PROFILE",
      providerAnnotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        source: "composio_tool_tags",
      },
      providerInputSchemaJson: INPUT_SCHEMA_JSON,
      stellaPolicy: {
        effect: "read",
        requiresApproval: false,
        policyVersion: POLICY_VERSION,
        toolkitVersion: TOOLKIT_VERSION,
        reviewedInputSchemaJson: REVIEWED_SCHEMA_JSON,
        source: "stella_admin",
      },
    }),
  )}`;

const createTest = async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agent_turns", {
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      sessionId: "session:cloud-integration-http",
      conversationId: "conversation:cloud-integration-http",
      prompt: "Read a connected message.",
      status: "running",
      kind: "chat",
      agentType: "orchestrator",
      activeTokenHash: await sha256Hex(TURN_TOKEN),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cloud_turn_tokens", {
      tokenHash: await sha256Hex(TURN_TOKEN),
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      turnId: TURN_ID,
      agentType: "orchestrator",
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await ctx.db.insert("integrations_public", {
      id: "gmail",
      name: "Gmail",
      provider: "composio",
      actionCount: 4,
      connector: {
        type: "composio",
        toolkit: "gmail",
        provider: "composio",
      },
      enabled: true,
      usagePolicy: "ready",
      updatedAt: 10,
    });
    await ctx.db.insert("user_integrations", {
      ownerId: OWNER_ID,
      provider: "gmail",
      mode: "composio",
      externalId: "trs_owner_session",
      config: { composioUserId: "stella_test_user" },
      createdAt: 10,
      updatedAt: 10,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_GET_PROFILE",
      title: "Get profile",
      description: "Read the connected Gmail profile.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        source: "composio_tool_tags",
      },
      codeModePolicy: {
        effect: "read",
        requiresApproval: false,
        policyVersion: POLICY_VERSION,
        toolkitVersion: TOOLKIT_VERSION,
        reviewedInputSchemaJson: REVIEWED_SCHEMA_JSON,
        source: "stella_admin",
      },
      codeModeEligible: true,
      searchText: "GMAIL_GET_PROFILE Get profile Read Gmail profile",
      inputSchemaJson: INPUT_SCHEMA_JSON,
      updatedAt: 11,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_PROVIDER_ONLY_READ",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        source: "composio_tool_tags",
      },
      searchText: "GMAIL_PROVIDER_ONLY_READ",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 11,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_SEND_EMAIL",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        source: "composio_tool_tags",
      },
      searchText: "GMAIL_SEND_EMAIL",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 12,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_UNKNOWN_EFFECT",
      searchText: "GMAIL_UNKNOWN_EFFECT",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 13,
    });
  });
  return t;
};

const rpcRequest = (
  method: string,
  params: Record<string, unknown> = {},
  id: string | number = "rpc-1",
  authenticated = true,
) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(authenticated
      ? {
          authorization: `Bearer ${SERVICE_SECRET}`,
          "x-stella-turn-token": TURN_TOKEN,
        }
      : {}),
  },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});

const initializeParams = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "stella-cloud-test", version: "1" },
};

beforeEach(() => {
  process.env.BUILDER_SERVICE_SECRET = SERVICE_SECRET;
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  process.env.COMPOSIO_TOOL_ROUTER_URL =
    "https://tool-router.test/api/v3.1/tool_router";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/cloud/integrations/mcp", () => {
  it("requires both service auth and an active orchestrator turn token", async () => {
    const t = await createTest();
    const response = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest(
        "initialize",
        initializeParams,
        "initialize-unauthorized",
        false,
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32001, message: "Unauthorized" },
    });

    await t.run(async (ctx) => {
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique();
      if (!turn) throw new Error("missing turn");
      await ctx.db.patch(turn._id, {
        status: "completed",
        updatedAt: Date.now(),
      });
    });
    const finished = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("initialize", initializeParams, "initialize-finished"),
    );
    expect(finished.status).toBe(401);
  });

  it("implements initialize and tools/list with a fail-closed live catalog", async () => {
    const t = await createTest();
    const initialized = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("initialize", initializeParams, "initialize-1"),
    );
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "initialize-1",
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
      },
    });
    const notification = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_SECRET}`,
        "x-stella-turn-token": TURN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const listed = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/list", {}, "list-1"),
    );
    const payload = (await listed.json()) as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    expect(payload.result?.tools).toHaveLength(1);
    expect(payload.result?.tools?.[0]).toMatchObject({
      name: READ_TOOL,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      _meta: {
        "stella/revision": await reviewedRevision(),
        "stella/codePolicyVersion": POLICY_VERSION,
      },
    });
    expect(JSON.stringify(payload)).not.toContain(WRITE_TOOL);
    expect(JSON.stringify(payload)).not.toContain("GMAIL_PROVIDER_ONLY_READ");
    expect(JSON.stringify(payload)).not.toContain("GMAIL_UNKNOWN_EFFECT");
  });

  it("enforces MCP request, notification, ping, GET, and bounded batch semantics", async () => {
    const t = await createTest();
    const malformedInitialize = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("initialize", {}, "bad-initialize"),
    );
    await expect(malformedInitialize.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });

    const invalidId = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: rpcRequest("ping").headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" }),
    });
    await expect(invalidId.json()).resolves.toMatchObject({
      error: { code: -32600 },
    });

    const ping = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("ping", {}, "ping-1"),
    );
    await expect(ping.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "ping-1",
      result: {},
    });

    const notificationHeaders = rpcRequest("ping").headers;
    const genericNotification = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/unknown-safe-notification",
      }),
    });
    expect(genericNotification.status).toBe(202);
    expect(await genericNotification.text()).toBe("");

    const notificationWithId = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("notifications/initialized", {}, "not-a-notification"),
    );
    expect(notificationWithId.status).toBe(400);
    await expect(notificationWithId.json()).resolves.toMatchObject({
      id: "not-a-notification",
      error: { code: -32600 },
    });

    const mixedBatch = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: "batch-ping", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    });
    await expect(mixedBatch.json()).resolves.toEqual([
      { jsonrpc: "2.0", id: "batch-ping", result: {} },
    ]);

    const notificationBatch = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/unknown" },
      ]),
    });
    expect(notificationBatch.status).toBe(202);
    expect(await notificationBatch.text()).toBe("");

    const initializeBatch = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "batch-initialize",
          method: "initialize",
          params: initializeParams,
        },
      ]),
    });
    expect(initializeBatch.status).toBe(400);
    await expect(initializeBatch.json()).resolves.toMatchObject({
      error: { code: -32600 },
    });

    const oversizedBatch = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify(
        Array.from({ length: 17 }, (_, index) => ({
          jsonrpc: "2.0",
          id: `ping-${index}`,
          method: "ping",
        })),
      ),
    });
    expect(oversizedBatch.status).toBe(400);

    const getResponse = await t.fetch("/api/cloud/integrations/mcp", {
      method: "GET",
    });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
  });

  it("paginates more than eight eligible tools with opaque tamper-evident cursors", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        const suffix = String(index).padStart(2, "0");
        await ctx.db.insert("integration_actions", {
          integrationId: "gmail",
          name: `GMAIL_READ_${suffix}`,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            source: "composio_tool_tags",
          },
          codeModePolicy: {
            effect: "read",
            requiresApproval: false,
            policyVersion: `test.gmail-read-${suffix}.v1`,
            toolkitVersion: TOOLKIT_VERSION,
            reviewedInputSchemaJson:
              '{"type":"object","additionalProperties":false}',
            source: "stella_admin",
          },
          codeModeEligible: true,
          searchText: `GMAIL_READ_${suffix}`,
          inputSchemaJson: '{"type":"object","additionalProperties":false}',
          updatedAt: 20 + index,
        });
      }
    });

    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await t.fetch(
        "/api/cloud/integrations/mcp",
        rpcRequest(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          `list-page-${names.length}`,
        ),
      );
      const envelope = (await response.json()) as {
        result: { tools: Array<{ name: string }>; nextCursor?: string };
      };
      names.push(...envelope.result.tools.map((tool) => tool.name));
      cursor = envelope.result.nextCursor;
    } while (cursor !== undefined);
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
    expect(names).toContain(READ_TOOL);

    const first = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/list", {}, "list-forged-source"),
    );
    const firstPayload = (await first.json()) as {
      result: { nextCursor: string };
    };
    const validCursor = firstPayload.result.nextCursor;
    const forgedCursor = `${validCursor.slice(0, -1)}${validCursor.endsWith("a") ? "b" : "a"}`;
    const forged = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/list", { cursor: forgedCursor }, "list-forged"),
    );
    await expect(forged.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });

    const otherOwnerId = "owner:cursor-cross-scope";
    const otherGeneration = "generation:cursor-cross-scope";
    const otherTurnId = "turn:cursor-cross-scope";
    const otherToken = "turn-token-cursor-cross-scope";
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: otherOwnerId,
        generation: otherGeneration,
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("agent_turns", {
        ownerId: otherOwnerId,
        ownerGeneration: otherGeneration,
        turnId: otherTurnId,
        sessionId: "session:cursor-cross-scope",
        conversationId: "conversation:cursor-cross-scope",
        prompt: "List connected tools.",
        status: "running",
        kind: "chat",
        agentType: "orchestrator",
        activeTokenHash: await sha256Hex(otherToken),
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("cloud_turn_tokens", {
        tokenHash: await sha256Hex(otherToken),
        ownerId: otherOwnerId,
        ownerGeneration: otherGeneration,
        turnId: otherTurnId,
        agentType: "orchestrator",
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    const crossOwner = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_SECRET}`,
        "content-type": "application/json",
        "x-stella-turn-token": otherToken,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "list-cross-owner",
        method: "tools/list",
        params: { cursor: validCursor },
      }),
    });
    await expect(crossOwner.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });
  });

  it("dispatches a real connected read through tools/call and exactly replays", async () => {
    const t = await createTest();
    const revision = await reviewedRevision();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/session/trs_owner_session/toolkits")) {
          return Response.json({
            items: [
              {
                toolkit: { slug: "gmail" },
                connection: {
                  isActive: true,
                  connectedAccount: { id: "ca_1", status: "ACTIVE" },
                },
              },
            ],
          });
        }
        if (url.endsWith("/tools/execute/GMAIL_GET_PROFILE")) {
          return Response.json({
            data: { emailAddress: "person@example.test" },
          });
        }
        throw new Error(`unexpected upstream request: ${url}`);
      });
    const params = {
      name: READ_TOOL,
      arguments: { user_id: "me" },
      _meta: { revision },
    };

    const first = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/call", params, "call-stable-1"),
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          data: { emailAddress: "person@example.test" },
        },
        _meta: { replayed: false },
      },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    const executeInit = upstream.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(executeInit?.body))).toEqual({
      user_id: "stella_test_user",
      version: TOOLKIT_VERSION,
      arguments: { user_id: "me" },
    });

    const replay = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/call", params, "call-stable-1"),
    );
    await expect(replay.json()).resolves.toMatchObject({
      result: { _meta: { replayed: true } },
    });
    expect(upstream).toHaveBeenCalledTimes(2);

    const conflict = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest(
        "tools/call",
        { ...params, arguments: { user_id: "another-user" } },
        "call-stable-1",
      ),
    );
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: -32000 },
    });
    expect(upstream).toHaveBeenCalledTimes(2);

    const numericId = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/call", params, 7),
    );
    await expect(numericId.json()).resolves.toMatchObject({
      result: { _meta: { replayed: false } },
    });
    const stringId = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest("tools/call", params, "7"),
    );
    await expect(stringId.json()).resolves.toMatchObject({
      result: { _meta: { replayed: false } },
    });
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("preserves own __proto__ keys through validation and never fingerprints reduced input", async () => {
    const t = await createTest();
    const revision = await reviewedRevision();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("invalid input must not reach Composio"));
    const response = await t.fetch("/api/cloud/integrations/mcp", {
      method: "POST",
      headers: rpcRequest("ping").headers,
      body: `{"jsonrpc":"2.0","id":"proto-input","method":"tools/call","params":{"name":"${READ_TOOL}","arguments":{"user_id":"me","__proto__":{"polluted":true}},"_meta":{"revision":"${revision}"}}}`,
    });
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "reset",
    "source migration",
    "lease loss",
    "turn completion",
    "token expiry",
    "token deletion",
  ] as const)(
    "revalidates the final dispatch fence after a slow status check: %s",
    async (race) => {
      const t = await createTest();
      const revision = await reviewedRevision();
      let executeReached = false;
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.endsWith("/session/trs_owner_session/toolkits")) {
            await t.run(async (ctx) => {
              if (race === "reset") {
                const lifecycle = await ctx.db
                  .query("cloud_owner_lifecycles")
                  .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
                  .unique();
                if (!lifecycle) throw new Error("missing lifecycle");
                await ctx.db.patch(lifecycle._id, {
                  state: "resetting",
                  updatedAt: Date.now(),
                });
              } else if (race === "source migration") {
                await ctx.db.insert("auth_owner_migrations", {
                  fromOwnerId: OWNER_ID,
                  toOwnerId: "owner:destination-during-status",
                  status: "running",
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                });
              } else if (race === "lease loss") {
                const receipts = await ctx.db
                  .query("cloud_integration_call_receipts")
                  .withIndex("by_ownerId_state_leaseExpiresAt", (q) =>
                    q.eq("ownerId", OWNER_ID).eq("state", "dispatching"),
                  )
                  .collect();
                if (receipts.length !== 1) throw new Error("missing receipt");
                await ctx.db.patch(receipts[0]._id, { leaseExpiresAt: 0 });
              } else if (race === "turn completion") {
                const turn = await ctx.db
                  .query("agent_turns")
                  .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
                  .unique();
                if (!turn) throw new Error("missing turn");
                await ctx.db.patch(turn._id, {
                  status: "completed",
                  updatedAt: Date.now(),
                });
              } else {
                const tokenHash = await sha256Hex(TURN_TOKEN);
                const token = await ctx.db
                  .query("cloud_turn_tokens")
                  .withIndex("by_tokenHash", (q) =>
                    q.eq("tokenHash", tokenHash),
                  )
                  .unique();
                if (!token) throw new Error("missing token");
                if (race === "token deletion") {
                  await ctx.db.delete(token._id);
                } else {
                  await ctx.db.patch(token._id, { expiresAt: 0 });
                }
              }
            });
            return Response.json({
              items: [
                {
                  toolkit: { slug: "gmail" },
                  connection: {
                    isActive: true,
                    connectedAccount: { id: "ca_1", status: "ACTIVE" },
                  },
                },
              ],
            });
          }
          if (url.endsWith("/tools/execute/GMAIL_GET_PROFILE")) {
            executeReached = true;
          }
          throw new Error(`unexpected upstream request: ${url}`);
        });

      const response = await t.fetch(
        "/api/cloud/integrations/mcp",
        rpcRequest(
          "tools/call",
          {
            name: READ_TOOL,
            arguments: { user_id: "me" },
            _meta: { revision },
          },
          `race-${race.replace(" ", "-")}`,
        ),
      );
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32010 },
      });
      expect(executeReached).toBe(false);
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it("durably fences an MCP cancellation received during the status check", async () => {
    const t = await createTest();
    const revision = await reviewedRevision();
    let executeReached = false;
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/session/trs_owner_session/toolkits")) {
          const cancelled = await t.fetch("/api/cloud/integrations/mcp", {
            method: "POST",
            headers: rpcRequest("ping").headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                requestId: "cancel-during-status",
                reason: "test cancellation",
              },
            }),
          });
          expect(cancelled.status).toBe(202);
          return Response.json({
            items: [
              {
                toolkit: { slug: "gmail" },
                connection: {
                  isActive: true,
                  connectedAccount: { id: "ca_1", status: "ACTIVE" },
                },
              },
            ],
          });
        }
        if (url.endsWith("/tools/execute/GMAIL_GET_PROFILE")) {
          executeReached = true;
        }
        throw new Error(`unexpected upstream request: ${url}`);
      });

    const response = await t.fetch(
      "/api/cloud/integrations/mcp",
      rpcRequest(
        "tools/call",
        {
          name: READ_TOOL,
          arguments: { user_id: "me" },
          _meta: { revision },
        },
        "cancel-during-status",
      ),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32010 },
    });
    expect(executeReached).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("records an ambiguous execute failure as unknown and retries only because the action is read-only", async () => {
    const t = await createTest();
    const revision = await reviewedRevision();
    let executeAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/session/trs_owner_session/toolkits")) {
        return Response.json({
          items: [
            {
              toolkit: { slug: "gmail" },
              connection: {
                isActive: true,
                connectedAccount: { id: "ca_1", status: "ACTIVE" },
              },
            },
          ],
        });
      }
      if (url.endsWith("/tools/execute/GMAIL_GET_PROFILE")) {
        executeAttempts += 1;
        if (executeAttempts === 1) {
          throw new TypeError("network connection ended without a response");
        }
        return Response.json({ data: { emailAddress: "person@example.test" } });
      }
      throw new Error(`unexpected upstream request: ${url}`);
    });
    const request = rpcRequest(
      "tools/call",
      {
        name: READ_TOOL,
        arguments: { user_id: "me" },
        _meta: { revision },
      },
      "ambiguous-read-call",
    );

    const first = await t.fetch("/api/cloud/integrations/mcp", request);
    await expect(first.json()).resolves.toMatchObject({
      error: { code: -32014 },
    });
    const unknown = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    );
    expect(unknown).toMatchObject({ state: "unknown", attempts: 1 });

    const retry = await t.fetch("/api/cloud/integrations/mcp", request);
    await expect(retry.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          data: { emailAddress: "person@example.test" },
        },
      },
    });
    expect(executeAttempts).toBe(2);
    const succeeded = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
    );
    expect(succeeded).toMatchObject({ state: "succeeded", attempts: 2 });
  });

  it("never dispatches a write or unknown-effect action guessed by name", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("denied tools must not reach Composio"));

    for (const [name, revision] of [
      [WRITE_TOOL, "12"],
      ["native__gmail__GMAIL_UNKNOWN_EFFECT", "13"],
    ] as const) {
      const response = await t.fetch(
        "/api/cloud/integrations/mcp",
        rpcRequest(
          "tools/call",
          { name, arguments: {}, _meta: { revision } },
          `denied-${revision}`,
        ),
      );
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32010 },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
