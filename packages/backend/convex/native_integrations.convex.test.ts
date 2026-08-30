/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|connector-owner";

const createTest = () => convexTest(schema, modules);
const beginNativeRun = makeFunctionReference<"mutation", any, any>(
  "composio_native_dispatch:beginComposioNativeRunInternal",
);
const settleNativeRun = makeFunctionReference<"mutation", any, boolean>(
  "composio_native_dispatch:settleComposioNativeRunInternal",
);
const getIntegrationCallQuiescence = makeFunctionReference<
  "query",
  { ownerId: string; now: number },
  { ready: boolean; nextCheckAt?: number }
>("cloud_purge:getOwnerIntegrationCallQuiescenceInternal");
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "connector-owner",
    tokenIdentifier: ownerId,
  });

const inputSchema = {
  type: "object",
  properties: {
    trace_: { type: "string" },
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

const staleGoogleAdsMutationSchema = {
  type: "object",
  properties: {
    customer_id: { type: "string" },
    operations: { type: "array", items: { type: "object" } },
  },
  required: ["operations"],
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

const publishGoogleAds = async (t: ReturnType<typeof createTest>) =>
  await t.mutation(internal.data.integrations.upsertPublicIntegration, {
    id: "googleads",
    name: "Google Ads",
    provider: "composio",
    category: "advertising",
    auth: ["OAUTH2"],
    catalogToolCount: 2,
    actions: [
      {
        name: "GOOGLEADS_MUTATE_CAMPAIGNS",
        title: "Mutate campaigns",
        inputSchemaJson: JSON.stringify(staleGoogleAdsMutationSchema),
      },
      {
        name: "GOOGLEADS_MUTATE_AD_GROUPS",
        title: "Mutate ad groups",
        inputSchemaJson: JSON.stringify(staleGoogleAdsMutationSchema),
      },
    ],
    description: "Connect Google Ads to Stella.",
    connector: { type: "composio", toolkit: "googleads", provider: "composio" },
    enabled: true,
    usagePolicy: "ready",
  });

const storeSession = async (
  t: ReturnType<typeof createTest>,
  provider = "outlook",
) =>
  await t.mutation(internal.data.integrations.upsertUserIntegrationForOwner, {
    ownerId,
    ownerGeneration: "legacy",
    provider,
    mode: "composio",
    externalId: "session_existing",
    config: {},
  });

const runRequest = (
  action: string,
  input: Record<string, unknown>,
  requestId = "native-run-request-0001",
  id = "outlook",
) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-stella-request-id": requestId,
  },
  body: JSON.stringify({ id, action, input }),
});

const connectedToolkitResponse = (toolkit: string) =>
  new Response(
    JSON.stringify({
      items: [{ toolkit: { slug: toolkit }, is_connected: true }],
    }),
    { status: 200 },
  );

const decodeProxyBody = (body: unknown) => {
  const envelope = JSON.parse(String(body)) as {
    binary_body: { base64: string };
  };
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(envelope.binary_body.base64), (character) =>
        character.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>;
};

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

  it("repairs published Google Ads mutation schemas with official top-level options", async () => {
    const t = createTest();
    const response = await t.fetch("/api/admin/native-integrations/upsert", {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "googleads",
        name: "Google Ads",
        provider: "composio",
        category: "advertising",
        auth: ["OAUTH2"],
        catalogToolCount: 1,
        actions: [
          {
            name: "GOOGLEADS_MUTATE_CAMPAIGNS",
            title: "Mutate campaigns",
            inputSchema: staleGoogleAdsMutationSchema,
          },
        ],
        description: "Connect Google Ads to Stella.",
        connector: { type: "composio", toolkit: "googleads" },
        enabled: true,
        usagePolicy: "ready",
      }),
    });
    expect(response.status).toBe(200);

    const actionResponse = await asOwner(t).fetch(
      "/api/native-integrations/actions?id=googleads&action=GOOGLEADS_MUTATE_CAMPAIGNS",
    );
    expect(actionResponse.status).toBe(200);
    const payload = (await actionResponse.json()) as {
      actions: Array<{ inputSchema: Record<string, unknown> }>;
    };
    expect(payload.actions[0]?.inputSchema).toMatchObject({
      required: ["operations"],
      properties: {
        validate_only: { type: "boolean" },
        partial_failure: { type: "boolean" },
        response_content_type: { type: "string" },
      },
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

  it.each(["delete", "source migration", "destination migration"] as const)(
    "does not resurrect a session row when %s starts during provider creation",
    async (race) => {
      vi.useFakeTimers();
      const t = createTest();
      await publishOutlook(t);
      let sessionDeleted = false;
      let releaseSession!: () => void;
      let creationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        creationStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/session")) {
          creationStarted();
          await blocked;
          return Response.json({ session_id: "trs_racy_session" });
        }
        if (url.endsWith("/session/trs_racy_session")) {
          if (method === "DELETE") {
            sessionDeleted = true;
            return Response.json({ deleted: true });
          }
          return sessionDeleted
            ? Response.json({}, { status: 404 })
            : Response.json({});
        }
        throw new Error(`unexpected Composio request: ${url}`);
      });

      const pending = asOwner(t).fetch(
        "/api/native-integrations/connect-link",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "outlook" }),
        },
      );
      await started;
      await t.run(async (ctx) => {
        if (race === "delete") {
          await ctx.db.insert("cloud_owner_lifecycles", {
            ownerId,
            generation: "generation-after-admission",
            state: "deleting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          await ctx.db.insert("auth_owner_migrations", {
            fromOwnerId:
              race === "source migration" ? ownerId : "another-owner",
            toOwnerId:
              race === "destination migration" ? ownerId : "another-owner",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      });
      releaseSession();
      const response = await pending;
      expect(response.status).toBe(502);
      await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_provider", (q) =>
            q.eq("ownerId", ownerId).eq("provider", "outlook"),
          )
          .collect(),
      );
      expect(rows).toEqual([]);
    },
  );

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

  it("sends campaign validate-only mutations as exact official Google Ads JSON", async () => {
    const t = createTest();
    await publishGoogleAds(t);
    await storeSession(t, "googleads");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(connectedToolkitResponse("googleads"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 200, data: { results: [] }, headers: {} }),
          { status: 200 },
        ),
      );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest(
        "GOOGLEADS_MUTATE_CAMPAIGNS",
        {
          customer_id: "439-929-3264",
          operations: [
            {
              create: {
                name: "Stella validation only",
                campaign_budget: "customers/4399293264/campaignBudgets/1",
                advertising_channel_type: "SEARCH",
                manual_cpc: {},
                network_settings: {
                  target_google_search: true,
                  target_search_network: false,
                },
              },
            },
          ],
          validate_only: true,
          partial_failure: false,
          response_content_type: "MUTABLE_RESOURCE",
        },
        "native-run-request-googleads-0001",
        "googleads",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      successful: true,
      data: { results: [] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/session/session_existing/proxy_execute",
    );
    const proxyEnvelope = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(proxyEnvelope).toMatchObject({
      toolkit_slug: "googleads",
      endpoint:
        "https://googleads.googleapis.com/v23/customers/4399293264/campaigns:mutate",
      method: "POST",
      binary_body: { content_type: "application/json" },
    });
    expect(decodeProxyBody(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({
      operations: [
        {
          create: {
            name: "Stella validation only",
            campaignBudget: "customers/4399293264/campaignBudgets/1",
            advertisingChannelType: "SEARCH",
            manualCpc: {},
            networkSettings: {
              targetGoogleSearch: true,
              targetSearchNetwork: false,
            },
          },
        },
      ],
      validateOnly: true,
      partialFailure: false,
      responseContentType: "MUTABLE_RESOURCE",
    });
  });

  it("restores reserved Google Ads names through nested repeated operations", async () => {
    const t = createTest();
    await publishGoogleAds(t);
    await storeSession(t, "googleads");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(connectedToolkitResponse("googleads"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 200, data: { results: [] } }), {
          status: 200,
        }),
      );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest(
        "GOOGLEADS_MUTATE_AD_GROUPS",
        {
          customer_id: "4399293264",
          operations: [
            {
              create: {
                campaign: "customers/4399293264/campaigns/1",
                name: "First",
                type: "SEARCH_STANDARD",
                targeting_setting: {
                  target_restrictions: [
                    { targeting_dimension: "AUDIENCE", bid_only: false },
                  ],
                },
              },
            },
            {
              create: {
                campaign: "customers/4399293264/campaigns/1",
                name: "Second",
                type_: "SEARCH_STANDARD",
              },
            },
          ],
          validate_only: true,
          partial_failure: false,
        },
        "native-run-request-googleads-0001",
        "googleads",
      ),
    );
    expect(response.status).toBe(200);
    const providerBody = decodeProxyBody(fetchMock.mock.calls[1]?.[1]?.body);
    expect(providerBody).toEqual({
      operations: [
        {
          create: {
            campaign: "customers/4399293264/campaigns/1",
            name: "First",
            type: "SEARCH_STANDARD",
            targetingSetting: {
              targetRestrictions: [
                { targetingDimension: "AUDIENCE", bidOnly: false },
              ],
            },
          },
        },
        {
          create: {
            campaign: "customers/4399293264/campaigns/1",
            name: "Second",
            type: "SEARCH_STANDARD",
          },
        },
      ],
      validateOnly: true,
      partialFailure: false,
    });
    expect(JSON.stringify(providerBody)).not.toContain('"type_"');
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

    const input = {
      trace_: "preserve-exactly",
      payload: { tags: ["work"], status: "draft" },
    };
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

  it("requires a stable request binding before the first provider read", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = runRequest("OUTLOOK_QUERY_EMAILS", {
      payload: { tags: ["work"], status: "draft" },
    });
    delete (request.headers as Record<string, string>)["x-stella-request-id"];

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      request,
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("cloud_integration_call_receipts").collect(),
      ),
    ).toEqual([]);
  });

  it("rejects identical and changed-body request-id replays before provider IO", async () => {
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestId = "native-run-request-replay-0001";
    const firstInput = { payload: { tags: ["one"], status: "draft" } };
    const first = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", firstInput, requestId),
    );
    expect(first.status).toBe(200);

    const identical = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest("OUTLOOK_QUERY_EMAILS", firstInput, requestId),
    );
    const changed = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest(
        "OUTLOOK_QUERY_EMAILS",
        { payload: { tags: ["two"], status: "draft" } },
        requestId,
      ),
    );
    expect(identical.status).toBe(409);
    expect(changed.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const receipts = await t.run(async (ctx) =>
      ctx.db.query("cloud_integration_call_receipts").collect(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      ownerId,
      ownerGeneration: "legacy",
      requestId,
      state: "succeeded",
      attempts: 1,
    });
  });

  it("retains the exact lease when execute crosses the provider boundary but its response is lost", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const requestId = "native-run-request-lost-execute-0001";
    let leaseAtProviderBoundary:
      | { leaseId: string; leaseExpiresAt: number }
      | undefined;
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
      .mockImplementationOnce(async () => {
        const receipt = await t.run(async (ctx) =>
          ctx.db
            .query("cloud_integration_call_receipts")
            .withIndex("by_owner_generation_request", (q) =>
              q
                .eq("ownerId", ownerId)
                .eq("ownerGeneration", "legacy")
                .eq("requestId", requestId),
            )
            .unique(),
        );
        if (!receipt?.leaseId || receipt.leaseExpiresAt === undefined) {
          throw new Error("expected exact native-run lease before execute");
        }
        leaseAtProviderBoundary = {
          leaseId: receipt.leaseId,
          leaseExpiresAt: receipt.leaseExpiresAt,
        };
        throw new TypeError(
          "transport closed after execute request was written",
        );
      });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = runRequest(
      "OUTLOOK_QUERY_EMAILS",
      { payload: { tags: ["lost-response"], status: "draft" } },
      requestId,
    );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/run",
      request,
    );
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/session/session_existing/execute",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");

    const receipt = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_owner_generation_request", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("ownerGeneration", "legacy")
            .eq("requestId", requestId),
        )
        .unique(),
    );
    expect(receipt).toMatchObject({
      state: "dispatching",
      errorCode: "provider_outcome_unknown",
      attempts: 1,
    });
    expect(leaseAtProviderBoundary).toBeDefined();
    expect(receipt?.leaseExpiresAt).toBe(
      leaseAtProviderBoundary!.leaseExpiresAt,
    );
    expect(receipt?.leaseId).toBe(leaseAtProviderBoundary!.leaseId);

    const replay = await asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest(
        "OUTLOOK_QUERY_EMAILS",
        { payload: { tags: ["lost-response"], status: "draft" } },
        requestId,
      ),
    );
    expect(replay.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const leaseExpiresAt = receipt!.leaseExpiresAt!;
    await expect(
      t.query(getIntegrationCallQuiescence, {
        ownerId,
        now: leaseExpiresAt - 1,
      }),
    ).resolves.toEqual({ ready: false, nextCheckAt: leaseExpiresAt });
    await expect(
      t.query(getIntegrationCallQuiescence, {
        ownerId,
        now: leaseExpiresAt,
      }),
    ).resolves.toEqual({ ready: true });
  });

  it.each(["delete", "source migration", "destination migration"] as const)(
    "publishes the lease before provider IO and refuses execute after %s wins the final recheck",
    async (race) => {
      const t = createTest();
      await publishOutlook(t);
      await storeSession(t);
      let markStatusStarted!: () => void;
      let releaseStatus!: () => void;
      const statusStarted = new Promise<void>((resolve) => {
        markStatusStarted = resolve;
      });
      const statusBlocked = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(async () => {
          markStatusStarted();
          await statusBlocked;
          return new Response(
            JSON.stringify({
              items: [{ toolkit: { slug: "outlook" }, is_connected: true }],
            }),
            { status: 200 },
          );
        })
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { messages: [] } }), {
            status: 200,
          }),
        );
      const requestId = "native-run-request-delete-race-0001";
      const pending = asOwner(t).fetch(
        "/api/native-integrations/run",
        runRequest(
          "OUTLOOK_QUERY_EMAILS",
          { payload: { tags: ["race"], status: "draft" } },
          requestId,
        ),
      );
      await statusStarted;
      const duringIo = await t.run(async (ctx) =>
        ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_owner_generation_request", (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("ownerGeneration", "legacy")
              .eq("requestId", requestId),
          )
          .unique(),
      );
      expect(duringIo).toMatchObject({
        state: "dispatching",
        attempts: 1,
      });
      expect(duringIo?.leaseExpiresAt).toEqual(expect.any(Number));

      await t.run(async (ctx) => {
        if (race === "delete") {
          await ctx.db.insert("cloud_owner_lifecycles", {
            ownerId,
            generation: "generation-after-admission",
            state: "deleting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          await ctx.db.insert("auth_owner_migrations", {
            fromOwnerId:
              race === "source migration" ? ownerId : "another-owner",
            toOwnerId:
              race === "destination migration" ? ownerId : "another-owner",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      });
      releaseStatus();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(fetchMock).toHaveBeenCalledOnce();
      const settled = await t.run(async (ctx) => ctx.db.get(duringIo!._id));
      expect(settled).toMatchObject({ state: "failed", attempts: 1 });
      expect(settled?.leaseExpiresAt).toBeUndefined();
    },
  );

  it("performs no provider execute when a suspended status read resumes past the persisted physical deadline", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    let markStatusStarted!: () => void;
    let releaseStatus!: () => void;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const statusBlocked = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        markStatusStarted();
        await statusBlocked;
        return new Response(
          JSON.stringify({
            items: [{ toolkit: { slug: "outlook" }, is_connected: true }],
          }),
          { status: 200 },
        );
      });
    const requestId = "native-run-request-expired-race-0001";
    const pending = asOwner(t).fetch(
      "/api/native-integrations/run",
      runRequest(
        "OUTLOOK_QUERY_EMAILS",
        { payload: { tags: ["expired"], status: "draft" } },
        requestId,
      ),
    );
    await statusStarted;
    const receiptId = await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_owner_generation_request", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("ownerGeneration", "legacy")
            .eq("requestId", requestId),
        )
        .unique();
      if (!receipt) throw new Error("expected durable native-run receipt");
      await ctx.db.patch(receipt._id, { leaseExpiresAt: 1 });
      return receipt._id;
    });
    releaseStatus();

    const response = await pending;
    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    const settled = await t.run(async (ctx) => ctx.db.get(receiptId));
    expect(settled).toMatchObject({ state: "failed", attempts: 1 });
    expect(settled?.leaseExpiresAt).toBeUndefined();
  });

  it("makes exact native-run settlement idempotent without rewriting outcomes", async () => {
    const t = createTest();
    await publishOutlook(t);
    await storeSession(t);
    const action = await t.run(async (ctx) =>
      ctx.db
        .query("integration_actions")
        .withIndex("by_integrationId_and_name", (q) =>
          q.eq("integrationId", "outlook").eq("name", "OUTLOOK_QUERY_EMAILS"),
        )
        .unique(),
    );
    const claim = {
      ownerId,
      ownerGeneration: "legacy",
      integrationId: "outlook",
      toolkit: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      revision: String(action!.updatedAt),
      expectedSessionId: "session_existing",
      requestId: "native-run-settlement-0001",
      fingerprint: "a".repeat(64),
      leaseId: "11111111-1111-4111-8111-111111111111",
      now: Date.now(),
    };
    await t.mutation(beginNativeRun, claim);
    const settlement = {
      ownerId,
      ownerGeneration: "legacy",
      requestId: claim.requestId,
      fingerprint: claim.fingerprint,
      leaseId: claim.leaseId,
      outcome: "succeeded" as const,
      now: claim.now + 1,
    };
    await expect(t.mutation(settleNativeRun, settlement)).resolves.toBe(true);
    await expect(
      t.mutation(settleNativeRun, {
        ...settlement,
        now: claim.now + 2,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(settleNativeRun, {
        ...settlement,
        outcome: "failed",
        now: claim.now + 3,
      }),
    ).rejects.toThrow(/outcome changed/u);
  });
});
