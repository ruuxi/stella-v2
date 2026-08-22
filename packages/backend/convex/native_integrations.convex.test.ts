/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  canonicalizePublicConnectorId,
  isSafeComposioActionName,
  normalizeComposioConnectorIdentity,
  publicConnectorIdForComposioToolkitSlug,
} from "./lib/composio_identifiers.js";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|connector-owner";

const createTest = () => convexTest(schema, modules);
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "connector-owner",
    tokenIdentifier: ownerId,
  });

const inputSchema = {
  type: "object",
  properties: {
    payload: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["draft", "sent"] },
      },
      required: ["tags", "status"],
      additionalProperties: false,
    },
  },
  required: ["payload"],
  additionalProperties: false,
};

const publishOutlook = async (t: ReturnType<typeof createTest>) =>
  await t.mutation(internal.data.integrations.upsertPublicIntegration, {
    id: "outlook",
    name: "Outlook",
    provider: "composio",
    category: "email",
    auth: ["OAUTH2"],
    catalogToolCount: 2,
    actions: [
      {
        name: "OUTLOOK_QUERY_EMAILS",
        title: "Query emails",
        inputSchemaJson: JSON.stringify(inputSchema),
      },
      {
        name: "OUTLOOK_SEND_EMAIL",
        title: "Send email",
        inputSchemaJson: JSON.stringify({
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
          additionalProperties: false,
        }),
      },
    ],
    description: "Connect Outlook to Stella.",
    connector: { type: "composio", toolkit: "outlook", provider: "composio" },
    enabled: true,
    usagePolicy: "ready",
  });

const storeSession = async (t: ReturnType<typeof createTest>) =>
  await t.mutation(internal.data.integrations.upsertUserIntegrationForOwner, {
    ownerId,
    provider: "outlook",
    mode: "composio",
    externalId: "session_existing",
    config: {},
  });

const runRequest = (action: string, input: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "outlook", action, input }),
});

describe("Composio exact identifier policy", () => {
  it("keeps exact public ids while resolving only explicit compatibility aliases", () => {
    expect(canonicalizePublicConnectorId("peopledatalabs")).toBe(
      "peopledatalabs",
    );
    expect(canonicalizePublicConnectorId("people_data_labs")).toBe(
      "peopledatalabs",
    );
    expect(canonicalizePublicConnectorId("people__data__labs")).toBe(
      "people__data__labs",
    );
  });

  it("maps leading-digit public ids only to explicit Composio toolkit slugs", () => {
    expect(publicConnectorIdForComposioToolkitSlug("_21risk")).toBe("21risk");
    expect(publicConnectorIdForComposioToolkitSlug("_2chat")).toBe("2chat");
    expect(publicConnectorIdForComposioToolkitSlug("_1password")).toBe(
      "1password",
    );
    expect(normalizeComposioConnectorIdentity("21risk", "_21risk")).toEqual({
      id: "21risk",
      toolkit: "_21risk",
    });
    expect(normalizeComposioConnectorIdentity("21risk", "21risk")).toBeNull();
    expect(
      normalizeComposioConnectorIdentity("outlook", "_outlook"),
    ).toBeNull();
  });

  it("accepts digit-leading actions only for their exact connector", () => {
    expect(isSafeComposioActionName("44api", "44API_GET_RECORDS")).toBe(true);
    expect(isSafeComposioActionName("outlook", "44API_GET_RECORDS")).toBe(
      false,
    );
    expect(isSafeComposioActionName("44api", "44API_GET-RECORDS")).toBe(false);
    expect(isSafeComposioActionName("7shifts", "7SHIFTS_LIST_SHIFTS")).toBe(
      true,
    );
    expect(isSafeComposioActionName("outlook", "7SHIFTS_LIST_SHIFTS")).toBe(
      false,
    );
    expect(isSafeComposioActionName("7shifts", "7SHIFTS_LIST-SHIFTS")).toBe(
      false,
    );
  });
});

beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  process.env.STELLA_ADMIN_API_SECRET = "test-admin-secret";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Composio integration catalog and execution", () => {
  it("publishes canonical ids and exact toolkit/action exceptions", async () => {
    const t = createTest();
    const publish = (id: string, toolkit: string, action: string) =>
      t.fetch("/api/admin/native-integrations/upsert", {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id,
          name: id,
          provider: "composio",
          category: "integrations",
          auth: ["API_KEY"],
          actions: [
            {
              name: action,
              inputSchema: { type: "object", properties: {} },
            },
          ],
          description: `${id} integration`,
          connector: { type: "composio", toolkit },
          enabled: true,
          usagePolicy: "ready",
        }),
      });

    expect((await publish("44api", "44api", "44API_GET_RECORDS")).status).toBe(
      200,
    );
    expect(
      (await publish("7shifts", "7shifts", "7SHIFTS_LIST_SHIFTS")).status,
    ).toBe(200);
    expect(
      (await publish("outlook", "outlook", "44API_GET_RECORDS")).status,
    ).toBe(400);
    expect(
      (await publish("21risk", "_21risk", "RISK_LIST_RECORDS")).status,
    ).toBe(200);
    expect(
      (await publish("people_data_labs", "peopledatalabs", "PDL_ENRICH"))
        .status,
    ).toBe(200);

    const catalog = await t.fetch("/api/native-integrations/catalog");
    const payload = (await catalog.json()) as {
      integrations: Array<{
        id: string;
        connector: { toolkit: string };
      }>;
    };
    expect(payload.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "44api",
          connector: expect.objectContaining({ toolkit: "44api" }),
        }),
        expect.objectContaining({
          id: "7shifts",
          connector: expect.objectContaining({ toolkit: "7shifts" }),
        }),
        expect.objectContaining({
          id: "21risk",
          connector: expect.objectContaining({ toolkit: "_21risk" }),
        }),
        expect.objectContaining({
          id: "peopledatalabs",
          connector: expect.objectContaining({ toolkit: "peopledatalabs" }),
        }),
      ]),
    );

    await expect(
      t.query(internal.data.integrations.getPublicIntegrationAction, {
        id: "people_data_labs",
        name: "PDL_ENRICH",
      }),
    ).resolves.toMatchObject({ id: "peopledatalabs" });
    await expect(
      t.query(internal.data.integrations.getPublicIntegrationAction, {
        id: "44api",
        name: "44API_GET_RECORDS",
      }),
    ).resolves.toMatchObject({
      id: "44api",
      action: { name: "44API_GET_RECORDS" },
    });
    await expect(
      t.query(internal.data.integrations.getPublicIntegrationAction, {
        id: "7shifts",
        name: "7SHIFTS_LIST_SHIFTS",
      }),
    ).resolves.toMatchObject({
      id: "7shifts",
      action: { name: "7SHIFTS_LIST_SHIFTS" },
    });
  });

  it("ingests the publisher shape atomically and preserves old actions after rejection", async () => {
    const t = createTest();
    const publish = (actions: unknown[]) =>
      t.fetch("/api/admin/native-integrations/upsert", {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "outlook",
          name: "Outlook",
          provider: "composio",
          category: "email",
          auth: ["OAUTH2"],
          catalogToolCount: actions.length,
          actions,
          description: "Connect Outlook to Stella.",
          connector: { type: "composio", toolkit: "outlook" },
          enabled: true,
          usagePolicy: "ready",
        }),
      });

    const accepted = await publish([
      {
        name: "OUTLOOK_QUERY_EMAILS",
        title: "Query emails",
        inputSchema,
      },
    ]);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, actionCount: 1 });

    const rejected = await publish([
      { name: "OUTLOOK_QUERY_EMAILS", title: "Missing schema" },
    ]);
    expect(rejected.status).toBe(400);

    const invalidSchema = await publish([
      {
        name: "OUTLOOK_QUERY_EMAILS",
        title: "Invalid schema",
        inputSchema: { type: "not-a-json-schema-type" },
      },
    ]);
    expect(invalidSchema.status).toBe(400);
    expect(await invalidSchema.json()).toEqual({
      error:
        "Integration action has an invalid input schema: OUTLOOK_QUERY_EMAILS.",
    });

    const retained = await asOwner(t).fetch(
      "/api/native-integrations/actions?id=outlook&action=OUTLOOK_QUERY_EMAILS",
    );
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      actions: [{ name: "OUTLOOK_QUERY_EMAILS", inputSchema }],
    });
  });

  it("preserves a safe 44API public alias while executing the exact upstream slug", async () => {
    const t = createTest();
    await t.mutation(internal.data.integrations.upsertPublicIntegration, {
      id: "44api",
      name: "44API",
      provider: "composio",
      category: "utilities",
      auth: ["API_KEY"],
      catalogToolCount: 1,
      actions: [
        {
          name: "FORTYFOUR_API_LOOKUP_PHONE",
          providerActionName: "44API_LOOKUP_PHONE",
          inputSchemaJson: JSON.stringify({
            type: "object",
            properties: { phone: { type: "string" } },
            required: ["phone"],
            additionalProperties: false,
          }),
        },
      ],
      connector: {
        type: "composio",
        toolkit: "44api",
        provider: "composio",
      },
      enabled: true,
      usagePolicy: "ready",
    });
    await t.mutation(internal.data.integrations.upsertUserIntegrationForOwner, {
      ownerId,
      provider: "44api",
      mode: "composio",
      externalId: "session_44api",
      config: {},
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                toolkit: { slug: "44api" },
                connected_account: { status: "ACTIVE" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ successful: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const response = await asOwner(t).fetch("/api/native-integrations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "44api",
        action: "FORTYFOUR_API_LOOKUP_PHONE",
        input: { phone: "+15551234567" },
      }),
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      tool_slug: "44API_LOOKUP_PHONE",
      arguments: { phone: "+15551234567" },
    });
  });

  it("rejects mismatched or cross-toolkit provider action aliases", async () => {
    const t = createTest();
    const publish = (id: string, name: string, providerActionName: string) =>
      t.mutation(internal.data.integrations.upsertPublicIntegration, {
        id,
        name: id,
        provider: "composio",
        auth: ["API_KEY"],
        catalogToolCount: 1,
        actions: [
          {
            name,
            providerActionName,
            inputSchemaJson: JSON.stringify({ type: "object" }),
          },
        ],
        connector: { type: "composio", toolkit: id },
        enabled: true,
        usagePolicy: "ready",
      });

    await expect(
      publish("44api", "FORTYFOUR_API_LOOKUP_PHONE", "44API_LOOKUP_EMAIL"),
    ).rejects.toThrow(/provider action alias is invalid/u);
    await expect(
      publish("outlook", "OUTLOOK_LIST_MESSAGES", "44API_LOOKUP_PHONE"),
    ).rejects.toThrow(/provider action alias is invalid/u);
  });

  it("keeps production-shaped catalog records hidden until actions are persisted", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("integrations_public", {
        id: "outlook",
        name: "Outlook",
        provider: "composio",
        connector: { type: "composio", toolkit: "outlook" },
        enabled: true,
        usagePolicy: "ready",
        updatedAt: Date.now(),
      });
    });

    const before = await t.fetch("/api/native-integrations/catalog");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ integrations: [] });

    await publishOutlook(t);
    const after = await t.fetch("/api/native-integrations/catalog");
    expect(after.status).toBe(200);
    const payload = (await after.json()) as {
      integrations: Array<Record<string, unknown>>;
    };
    expect(payload.integrations).toHaveLength(1);
    expect(payload.integrations[0]).toMatchObject({
      id: "outlook",
      provider: "composio",
      catalogToolCount: 2,
    });
    expect(payload.integrations[0]).not.toHaveProperty("actions");
  });

  it("serves authenticated exact actions and bounded paginated listings", async () => {
    const t = createTest();
    await publishOutlook(t);

    const unauthorized = await t.fetch(
      "/api/native-integrations/actions?id=outlook&action=OUTLOOK_QUERY_EMAILS",
    );
    expect(unauthorized.status).toBe(401);

    const exact = await asOwner(t).fetch(
      "/api/native-integrations/actions?id=outlook&action=OUTLOOK_QUERY_EMAILS",
    );
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      id: "outlook",
      actionCount: 1,
      actions: [{ name: "OUTLOOK_QUERY_EMAILS", inputSchema }],
      nextCursor: null,
    });

    const first = await asOwner(t).fetch(
      "/api/native-integrations/actions?id=outlook&limit=1",
    );
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as {
      actions: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(firstPayload.actions).toHaveLength(1);
    expect(firstPayload.nextCursor).toEqual(expect.any(String));

    const second = await asOwner(t).fetch(
      `/api/native-integrations/actions?id=outlook&limit=1&cursor=${encodeURIComponent(firstPayload.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as {
      actions: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(secondPayload.actions).toHaveLength(1);
    expect(secondPayload.actions[0]?.name).not.toBe(
      firstPayload.actions[0]?.name,
    );
    expect(secondPayload.nextCursor).toBeNull();
  });

  it("rejects unknown, cross-toolkit, invalid-input, and missing-schema calls before Composio", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    for (const [action, input, expectedStatus] of [
      ["OUTLOOK_UNKNOWN", {}, 400],
      ["GMAIL_SEND_EMAIL", {}, 400],
      [
        "OUTLOOK_QUERY_EMAILS",
        { payload: { tags: ["ok"], status: "invalid" } },
        400,
      ],
      [
        "OUTLOOK_QUERY_EMAILS",
        { payload: { tags: ["ok"], status: "draft", extra: true } },
        400,
      ],
    ] as const) {
      const response = await asOwner(t).fetch(
        "/api/native-integrations/run",
        runRequest(action, input),
      );
      expect(response.status).toBe(expectedStatus);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await t.run(async (ctx) => {
      const action = await ctx.db
        .query("integration_actions")
        .withIndex("by_integrationId_and_name", (q) =>
          q.eq("integrationId", "outlook").eq("name", "OUTLOOK_QUERY_EMAILS"),
        )
        .unique();
      await ctx.db.patch(action!._id, { inputSchemaJson: "" });
    });
    const missingSchema = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(missingSchema.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create or execute a session when the connection was revoked", async () => {
    const t = createTest();
    await publishOutlook(t);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              toolkit: { slug: "outlook" },
              connection: {
                connectedAccount: { status: "REVOKED" },
                isActive: false,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const disconnected = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(disconnected.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    await storeSession(t);

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/session/session_existing/toolkits",
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  it("treats an item-level ACTIVE connected_account as connected (real tool-router shape)", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                name: "Outlook",
                slug: "outlook",
                enabled: true,
                connected_account: {
                  id: "ca_12345",
                  user_id: "stella_abcdef",
                  status: "ACTIVE",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messages: [] } }), {
          status: 200,
        }),
      );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { messages: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/session/session_existing/execute",
    );
  });

  it("treats an item-level INITIATED connected_account as not connected (real tool-router shape)", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              name: "Outlook",
              slug: "outlook",
              enabled: true,
              connected_account: {
                id: "ca_12345",
                user_id: "stella_abcdef",
                status: "INITIATED",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/execute")),
    ).toBe(false);
  });

  it("treats a toolkit item without a connected_account as not connected (real tool-router shape)", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ name: "Outlook", slug: "outlook", enabled: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/execute")),
    ).toBe(false);
  });

  it("redacts Composio error bodies before any execute retry", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const secret = "provider-secret-that-must-not-be-logged";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: secret }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const consoleMock = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleMock.mock.calls)).not.toContain(secret);
  });

  it("rejects oversized Composio responses without executing an action", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", {
        payload: { tags: ["ok"], status: "draft" },
      }),
    );
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("executes a canonical schema-valid action through an existing active session", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ toolkit: { slug: "outlook" }, is_connected: true }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messages: [] } }), {
          status: 200,
        }),
      );

    const input = { payload: { tags: ["work"], status: "draft" } };
    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", input),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { messages: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/session/session_existing/execute",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      tool_slug: "OUTLOOK_QUERY_EMAILS",
      arguments: input,
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/session") && init?.method === "POST",
      ),
    ).toBe(false);
  });
});
