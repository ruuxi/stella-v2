import { describe, expect, it, vi } from "vitest";

import type { ResolvedNativeCatalog } from "@stella/runtime/kernel/connectors/catalog-cache";
import type { NativeConnectorCatalogEntry } from "@stella/runtime/kernel/connectors/native-integrations";
import {
  createBackendConnectorActionBroker,
  createBackendConnectorActionsBroker,
} from "@stella/runtime/worker/backend-connector-action-broker";

const composioEntry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: "Outlook",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "OUTLOOK" },
  actions: [
    {
      name: "OUTLOOK_SEND_EMAIL",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "body"],
        additionalProperties: true,
      },
    },
    {
      name: "OUTLOOK_QUERY_EMAILS",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      name: "OUTLOOK_DELETE_EMAIL",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
  ],
};

const catalog = (entry = composioEntry): ResolvedNativeCatalog => ({
  entries: [entry],
  source: "cache",
  sources: { [entry.id]: "cache" },
});

const makeBroker = (options: {
  fetchImpl?: typeof fetch;
  authToken?: string;
  refreshSiteAuth?: () => Promise<{
    baseUrl: string;
    authToken: string;
  } | null>;
  entry?: NativeConnectorCatalogEntry;
}) =>
  createBackendConnectorActionBroker({
    stellaDataDir: "/unused",
    getSiteAuth: () => ({
      baseUrl: "https://site.invalid",
      authToken: options.authToken ?? "current-token",
    }),
    refreshSiteAuth:
      options.refreshSiteAuth ??
      (async () => ({
        baseUrl: "https://site.invalid",
        authToken: "fresh-token",
      })),
    resolveCatalog: async () => catalog(options.entry),
    isEnabled: async () => true,
    fetchImpl: options.fetchImpl,
  });

describe("backend connector action broker", () => {
  it("loads authoritative action schemas without rewriting provider fields", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.pathname).toBe("/api/native-integrations/actions");
      expect(requestUrl.searchParams.get("id")).toBe("googleads");
      expect(requestUrl.searchParams.get("action")).toBe(
        "GOOGLEADS_MUTATE_AD_GROUPS",
      );
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer current-token",
      );
      return new Response(
        JSON.stringify({
          actionCount: 1,
          actions: [
            {
              name: "GOOGLEADS_MUTATE_AD_GROUPS",
              inputSchema: {
                type: "object",
                properties: {
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
                          },
                        },
                      },
                    },
                  },
                  validate_only: { type: "boolean" },
                  partial_failure: { type: "boolean" },
                },
              },
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      );
    });
    const broker = createBackendConnectorActionsBroker({
      stellaDataDir: "/unused",
      getSiteAuth: () => ({
        baseUrl: "https://site.invalid",
        authToken: "current-token",
      }),
      refreshSiteAuth: async () => null,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await broker({
      connectorId: "googleads",
      action: "GOOGLEADS_MUTATE_AD_GROUPS",
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain('"type"');
    expect(JSON.stringify(result)).toContain('"name_"');
    expect(JSON.stringify(result)).not.toContain('"type_"');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 403])(
    "dispatches a mutating action only once after backend %s",
    async (status) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "auth rejected" }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      const refreshSiteAuth = vi.fn(async () => ({
        baseUrl: "https://site.invalid",
        authToken: "must-not-be-used-after-dispatch",
      }));
      const result = await makeBroker({
        fetchImpl: fetchImpl as typeof fetch,
        refreshSiteAuth,
      })({
        connectorId: "outlook",
        action: "OUTLOOK_SEND_EMAIL",
        input: { to: "example@example.com", body: "hello" },
      });
      expect(result).toMatchObject({ ok: false, status });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(refreshSiteAuth).not.toHaveBeenCalled();
    },
  );

  it("refreshes a known-expired JWT before the only dispatch", async () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 }),
    ).toString("base64url");
    const fetchImpl = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer fresh-token",
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const refreshSiteAuth = vi.fn(async () => ({
      baseUrl: "https://site.invalid",
      authToken: "fresh-token",
    }));
    const result = await makeBroker({
      authToken: `x.${payload}.y`,
      refreshSiteAuth,
      fetchImpl: fetchImpl as typeof fetch,
    })({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: {},
    });
    expect(result.ok).toBe(true);
    expect(refreshSiteAuth).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails before dispatch when refresh cannot restore an expired session", async () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString(
      "base64url",
    );
    const fetchImpl = vi.fn();
    const result = await makeBroker({
      authToken: `x.${payload}.y`,
      refreshSiteAuth: async () => null,
      fetchImpl: fetchImpl as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_DELETE_EMAIL", input: {} });
    expect(result).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects noncanonical connectors and cross-toolkit or arbitrary actions", async () => {
    const fetchImpl = vi.fn();
    const broker = makeBroker({ fetchImpl: fetchImpl as typeof fetch });
    await expect(
      broker({ connectorId: "outlook", action: "GMAIL_SEND_EMAIL", input: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "action_not_allowed" });
    await expect(
      broker({ connectorId: "unknown", action: "UNKNOWN_RUN", input: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "connector_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches toolkit-prefixed actions when the catalog entry has no actions list", async () => {
    // The live backend catalog endpoint returns entries without an
    // `actions` array; the broker must fall back to the toolkit-prefix
    // check instead of rejecting everything against an empty allowlist.
    const { actions: _actions, ...rest } = composioEntry;
    const entryWithoutActions: NativeConnectorCatalogEntry = { ...rest };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await makeBroker({
      entry: entryWithoutActions,
      fetchImpl: fetchImpl as typeof fetch,
    })({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: {},
    });
    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("still rejects cross-toolkit actions when the catalog entry has no actions list", async () => {
    const { actions: _actions, ...rest } = composioEntry;
    const entryWithoutActions: NativeConnectorCatalogEntry = { ...rest };
    const fetchImpl = vi.fn();
    const result = await makeBroker({
      entry: entryWithoutActions,
      fetchImpl: fetchImpl as typeof fetch,
    })({
      connectorId: "outlook",
      action: "GMAIL_SEND_EMAIL",
      input: {},
    });
    expect(result).toMatchObject({ ok: false, reason: "action_not_allowed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the strict allowlist when the catalog entry carries actions", async () => {
    const fetchImpl = vi.fn();
    // Toolkit prefix matches but the action is not in the populated list.
    const result = await makeBroker({ fetchImpl: fetchImpl as typeof fetch })({
      connectorId: "outlook",
      action: "OUTLOOK_NOT_IN_CATALOG",
      input: {},
    });
    expect(result).toMatchObject({ ok: false, reason: "action_not_allowed" });
    expect(fetchImpl).not.toHaveBeenCalled();

    // Input schema still enforced for allowlisted actions.
    const schemaResult = await makeBroker({
      fetchImpl: fetchImpl as typeof fetch,
    })({
      connectorId: "outlook",
      action: "OUTLOOK_SEND_EMAIL",
      input: { to: "example@example.com" },
    });
    expect(schemaResult).toMatchObject({
      ok: false,
      reason: "action_not_allowed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unfinished local entries and redacts tokens from backend errors", async () => {
    const localEntry: NativeConnectorCatalogEntry = {
      ...composioEntry,
      provider: "oauth-catalog",
      localExecution: "incomplete",
      backendConnector: undefined,
    };
    await expect(
      makeBroker({ entry: localEntry })({
        connectorId: "outlook",
        action: "OUTLOOK_QUERY_EMAILS",
        input: {},
      }),
    ).resolves.toMatchObject({ ok: false, reason: "connector_unavailable" });

    const secret = "eyJheader.eyJpayload.signature";
    const result = await makeBroker({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: `Bearer ${secret}` }), {
            status: 502,
          }),
      ) as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_QUERY_EMAILS", input: {} });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      reason: "backend_error",
    });
  });

  it("redacts auth-shaped fields from successful action results", async () => {
    const result = await makeBroker({
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [],
              access_token: "backend-secret",
              nested: { authorization: "Bearer backend-secret" },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_QUERY_EMAILS", input: {} });
    expect(result).toMatchObject({
      ok: true,
      result: {
        messages: [],
        access_token: "[REDACTED]",
        nested: { authorization: "[REDACTED]" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("backend-secret");
  });
});
