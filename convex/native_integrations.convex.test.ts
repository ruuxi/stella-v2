/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

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
  await t.mutation(
    internal.data.integrations.upsertUserIntegrationForOwner,
    {
      ownerId,
      provider: "outlook",
      mode: "composio",
      externalId: "session_existing",
      config: {},
    },
  );

const runRequest = (action: string, input: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "outlook", action, input }),
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
          q
            .eq("integrationId", "outlook")
            .eq("name", "OUTLOOK_QUERY_EMAILS"),
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
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
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
