/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

import {
  resolveRoute,
  canaryBucket,
  composioPathBlocked,
  type ConnectorRollout,
} from "./connectors/routing";
import {
  validateManifest,
  listProviderManifests,
  getProviderManifest,
  requireEnabledProvider,
  scopesForGroups,
  grantedScopesSatisfy,
  connectScopeGroupsForConnector,
  connectorBindingsSatisfiedByScopes,
  buildAuthorizationUrl,
  pkceChallengeS256,
  generateOAuthState,
  buildTokenEndpointRequest,
  resolveProviderResourceOrigin,
  parseScopeString,
} from "./connectors/oauth/providers";
import {
  buildCrmProviderRequest,
  CRM_ACTION_OPERATIONS,
  CRM_ACTION_REQUIRED_SCOPES,
} from "./connectors/executors/crm";
import {
  buildDesignFinanceProviderRequest,
  DESIGN_FINANCE_ACTION_OPERATIONS,
  DESIGN_FINANCE_ACTION_REQUIRED_SCOPES,
} from "./connectors/executors/design_finance";
import {
  buildApiKeyProviderRequest,
  canonicalizeDeferredActionName,
  DEFERRED_API_KEY_PROVIDERS,
  resolveDeferredActionOrigin,
  resolveDeferredTenantOrigin,
  validateDeferredApiKeyProviderCatalog,
} from "./connectors/executors/api_key";
import {
  buildProductivityProviderRequest,
  PRODUCTIVITY_ACTION_OPERATIONS,
  PRODUCTIVITY_ACTION_REQUIRED_SCOPES,
} from "./connectors/executors/productivity";
import {
  mergeTokenSet,
  unionScopes,
  expiryFromExpiresIn,
  accessTokenIsFresh,
} from "./connectors/oauth/token_set";
import {
  connectorErrorHttpStatus,
  classifyProviderStatus,
  classifyTokenEndpointError,
  ConnectorError,
} from "./connectors/errors";
import {
  executeFirstPartyAction,
  firstPartyActionBelongsToConnector,
  firstPartyActionOperation,
  firstPartyProviderForConnectorAction,
} from "./connectors/executors/first_party";
import {
  buildSocialProviderRequest,
  SOCIAL_ACTION_OPERATIONS,
  SOCIAL_ACTION_REQUIRED_SCOPES,
} from "./connectors/executors/social";
import {
  buildDeveloperDataProviderRequest,
  DEVELOPER_DATA_ACTION_OPERATIONS,
  DEVELOPER_DATA_ACTION_REQUIRED_SCOPES,
} from "./connectors/executors/developer_data";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|connector-owner";
const otherOwnerId = "https://issuer.test|other-owner";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "connector-owner",
    tokenIdentifier: ownerId,
  });

const MASTER_KEY = btoa(
  String.fromCharCode(
    ...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
  ),
);

const setConnectorEnv = () => {
  process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({
    "1": MASTER_KEY,
  });
  process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
  process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK = "1";
  process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "1";
  process.env.STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL =
    "https://connect.stella.test";
  process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "microsoft";
  process.env.STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_ID = "microsoft-client";
  process.env.STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_SECRETS_JSON =
    JSON.stringify({
      "1": "microsoft-test-secret",
    });
  process.env.STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_SECRET_VERSION = "1";
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_ID = "mock-client";
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_SECRETS_JSON = JSON.stringify({
    "1": "mock-secret",
  });
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_SECRET_VERSION = "1";
};

beforeEach(() => {
  setConnectorEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Pure unit: provider manifests + scopes + PKCE
// ---------------------------------------------------------------------------

describe("provider manifests", () => {
  it("every registered manifest is internally consistent", () => {
    for (const manifest of listProviderManifests()) {
      expect(validateManifest(manifest)).toEqual([]);
    }
  });

  it("binds every social connector to fixed provider-owned scope groups", () => {
    const expectations = [
      ["twitter", "twitter", ["write"]],
      ["youtube", "youtube", ["write"]],
      ["reddit", "reddit", ["write"]],
      ["linkedin", "linkedin", ["member_write"]],
      ["meta", "facebook", ["social_all"]],
      ["meta", "instagram", ["social_all"]],
      ["meta", "metaads", ["social_all"]],
    ] as const;

    for (const [provider, connectorId, expectedGroups] of expectations) {
      const manifest = getProviderManifest(provider)!;
      expect(
        connectScopeGroupsForConnector(manifest, connectorId, ["read"]),
      ).toEqual(expectedGroups);
      expect(() =>
        connectScopeGroupsForConnector(manifest, "unrelated_connector", [
          "read",
        ]),
      ).toThrow(/unregistered_scope/);
    }
  });

  it("shares a Meta grant only with connectors whose read scopes were granted", () => {
    const manifest = getProviderManifest("meta")!;
    const satisfied = connectorBindingsSatisfiedByScopes(
      manifest,
      scopesForGroups(manifest, ["social_all"]),
    );
    expect(satisfied.map(({ connectorId }) => connectorId).sort()).toEqual([
      "facebook",
      "instagram",
      "metaads",
    ]);
  });

  it("registers the mock provider only behind the env flag", () => {
    expect(getProviderManifest("mock")).not.toBeNull();
    delete process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK;
    expect(getProviderManifest("mock")).toBeNull();
  });

  it("registers supported CRM OAuth providers without enabling them", () => {
    for (const provider of [
      "hubspot",
      "gong",
      "pipedrive",
      "salesforce",
      "attio",
    ]) {
      expect(getProviderManifest(provider)?.verificationStatus).toBe(
        "unverified",
      );
      expect(() => requireEnabledProvider(provider)).toThrow(
        /provider_disabled/,
      );
    }
  });

  it("registers design and finance OAuth providers without enabling them", () => {
    for (const provider of ["figma", "stripe"]) {
      expect(getProviderManifest(provider)?.verificationStatus).toBe(
        "unverified",
      );
      expect(() => requireEnabledProvider(provider)).toThrow(
        /provider_disabled/,
      );
    }
    const figma = getProviderManifest("figma")!;
    expect(figma.refreshEndpoint).toBe(
      "https://api.figma.com/v1/oauth/refresh",
    );
    expect(figma.tokenEndpointAuth).toBe("client_secret_basic");
    expect(getProviderManifest("stripe")?.tokenEndpointAuth).toBe(
      "client_secret_basic",
    );
    const url = new URL(
      buildAuthorizationUrl({
        manifest: figma,
        clientId: "client",
        redirectUri:
          "https://connect.stella.test/api/connectors/oauth/callback",
        state: "state",
        codeChallenge: "unused",
        scopes: ["current_user:read", "file_content:read"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "current_user:read,file_content:read",
    );
  });

  it("registers GitHub and Supabase without enabling unverified manifests", () => {
    const github = getProviderManifest("github")!;
    expect(github.apiOrigin).toBe("https://api.github.com");
    expect(github.accessTokensExpire).toBe(false);
    expect(Object.keys(github.connectorBindings ?? {})).toEqual(["github"]);

    const supabase = getProviderManifest("supabase")!;
    expect(supabase.apiOrigin).toBe("https://api.supabase.com");
    expect(supabase.sendsScopesInAuthorization).toBe(false);
    expect(supabase.tokenEndpointAuth).toBe("client_secret_basic");

    for (const provider of ["github", "supabase"]) {
      expect(getProviderManifest(provider)?.verificationStatus).toBe(
        "unverified",
      );
      expect(() => requireEnabledProvider(provider)).toThrow(
        /provider_disabled/,
      );
    }
  });

  it("registers productivity OAuth manifests without enabling them", () => {
    for (const provider of [
      "notion",
      "slack",
      "airtable",
      "asana",
      "clickup",
      "monday",
      "linear",
      "atlassian",
      "canvas",
    ]) {
      expect(getProviderManifest(provider)?.verificationStatus).toBe(
        "unverified",
      );
      expect(() => requireEnabledProvider(provider)).toThrow(
        /provider_disabled/,
      );
    }
  });

  it("uses provider-specific token and scope encodings", () => {
    const notion = getProviderManifest("notion")!;
    const request = buildTokenEndpointRequest({
      manifest: notion,
      clientId: "client",
      clientSecret: "secret",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client",
        client_secret: "secret",
        code: "code",
      }).toString(),
    });
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.authorization).toMatch(/^Basic /u);
    expect(JSON.parse(request.body)).toEqual({
      grant_type: "authorization_code",
      code: "code",
    });

    for (const provider of ["clickup", "atlassian"]) {
      const jsonRequest = buildTokenEndpointRequest({
        manifest: getProviderManifest(provider)!,
        clientId: "client",
        clientSecret: "secret",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "client",
          client_secret: "secret",
          code: "code",
        }).toString(),
      });
      expect(jsonRequest.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(jsonRequest.body)).toMatchObject({
        client_id: "client",
        client_secret: "secret",
        code: "code",
      });
    }

    const linear = getProviderManifest("linear")!;
    const url = new URL(
      buildAuthorizationUrl({
        manifest: linear,
        clientId: "client",
        redirectUri:
          "https://connect.stella.test/api/connectors/oauth/callback",
        state: "state",
        codeChallenge: "unused",
        scopes: ["read", "write"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe("read,write");
  });

  it("omits dynamic scope parameters for app-scoped providers", () => {
    const manifest = getProviderManifest("pipedrive")!;
    const url = new URL(
      buildAuthorizationUrl({
        manifest,
        clientId: "client",
        redirectUri:
          "https://connect.stella.test/api/connectors/oauth/callback",
        state: "state",
        codeChallenge: "challenge",
        scopes: ["deals:read"],
      }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("fails closed for unlisted providers and open for the self-enabling mock", () => {
    expect(() => requireEnabledProvider("google-workspace")).toThrow(
      /provider_disabled/,
    );
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "google-workspace";
    expect(requireEnabledProvider("google-workspace").key).toBe(
      "google-workspace",
    );
    delete process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS;
    expect(requireEnabledProvider("mock").key).toBe("mock");
  });

  it("registers separate Google Workspace and YouTube grants plus shared Meta", () => {
    expect(getProviderManifest("google-workspace")?.key).toBe(
      "google-workspace",
    );
    expect(getProviderManifest("youtube")?.key).toBe("youtube");
    expect(getProviderManifest("meta")?.scopeGroups.social_all).toBeDefined();
    expect(getProviderManifest("facebook")).toBeNull();
    expect(() => requireEnabledProvider("twitter")).toThrow(
      /provider_disabled/,
    );
  });

  it("unions scope groups and rejects unknown groups", () => {
    const manifest = getProviderManifest("mock")!;
    expect(scopesForGroups(manifest, ["read"]).sort()).toEqual(
      ["mock.profile", "mock.read"].sort(),
    );
    expect(() => scopesForGroups(manifest, ["nope"])).toThrow(
      /unregistered_scope/,
    );
    expect(() => scopesForGroups(manifest, [])).toThrow(/unregistered_scope/);
  });

  it("computes RFC 7636 S256 challenge and >=32 byte state", async () => {
    // RFC 7636 Appendix B test vector.
    const challenge = await pkceChallengeS256(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(generateOAuthState().length).toBeGreaterThanOrEqual(32);
  });

  it("scope superset check is exact", () => {
    expect(grantedScopesSatisfy(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(grantedScopesSatisfy(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("applies basic client authentication without leaving credentials in the body", () => {
    const manifest = {
      ...getProviderManifest("mock")!,
      tokenEndpointAuth: "client_secret_basic" as const,
    };
    const request = buildTokenEndpointRequest({
      manifest,
      clientId: "client id",
      clientSecret: "secret/value",
      body: new URLSearchParams({
        client_id: "client id",
        client_secret: "secret/value",
      }).toString(),
    });
    expect(request.headers.authorization).toMatch(/^Basic /);
    expect(new URLSearchParams(request.body).has("client_id")).toBe(false);
    expect(new URLSearchParams(request.body).has("client_secret")).toBe(false);
  });

  it("requests GitHub JSON tokens and omits Supabase's deprecated dynamic scope", () => {
    const github = getProviderManifest("github")!;
    const tokenRequest = buildTokenEndpointRequest({
      manifest: github,
      clientId: "github-client",
      clientSecret: "github-secret",
      body: new URLSearchParams({
        code: "code",
        client_id: "github-client",
        client_secret: "github-secret",
      }).toString(),
    });
    expect(tokenRequest.headers.accept).toBe("application/json");
    expect(new URLSearchParams(tokenRequest.body).get("client_id")).toBe(
      "github-client",
    );

    const supabase = getProviderManifest("supabase")!;
    const authorizationUrl = new URL(
      buildAuthorizationUrl({
        manifest: supabase,
        clientId: "supabase-client",
        redirectUri:
          "https://connect.stella.test/api/connectors/oauth/callback",
        state: "state",
        codeChallenge: "challenge",
        scopes: ["all"],
      }),
    );
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  it("accepts only allowlisted provider-issued tenant origins", () => {
    const manifest = {
      ...getProviderManifest("mock")!,
      resourceOriginHostSuffixes: ["api.gong.io"],
    };
    expect(
      resolveProviderResourceOrigin(manifest, "https://acme.api.gong.io/v2"),
    ).toBe("https://acme.api.gong.io");
    expect(() =>
      resolveProviderResourceOrigin(manifest, "https://api.gong.io.evil.test"),
    ).toThrow(/code_exchange_failed/);
    expect(() =>
      resolveProviderResourceOrigin(manifest, "http://acme.api.gong.io"),
    ).toThrow(/code_exchange_failed/);
  });
});

describe("Microsoft provider family", () => {
  it("shares one grant while evaluating each connector's required scopes", () => {
    const manifest = getProviderManifest("microsoft")!;
    expect(connectScopeGroupsForConnector(manifest, "outlook", [])).toEqual([
      "microsoft_all",
    ]);
    const outlookScopes = scopesForGroups(manifest, ["outlook"]);
    const satisfied = connectorBindingsSatisfiedByScopes(
      manifest,
      outlookScopes,
    );
    expect(satisfied.map((binding) => binding.connectorId)).toContain(
      "outlook",
    );
    expect(satisfied.map((binding) => binding.connectorId)).not.toContain(
      "microsoft_teams",
    );
    expect(satisfied.map((binding) => binding.connectorId)).not.toContain(
      "excel",
    );
  });

  it("requests exactly the reviewed least-privilege delegated Entra scopes", () => {
    const manifest = getProviderManifest("microsoft")!;

    // The exact delegated permissions the Entra app registration must expose.
    // Keep in lockstep with the runtime kernel Microsoft Graph scope source of
    // truth (microsoft-graph/scopes.ts); a change here without a matching Entra
    // consent update silently breaks connect or over-requests permissions.
    const IDENTITY = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
    ];
    const OUTLOOK = ["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"];
    const TEAMS = [
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
    ];
    const EXCEL = ["Files.ReadWrite"];

    expect(scopesForGroups(manifest, ["identity"])).toEqual(IDENTITY);
    expect(scopesForGroups(manifest, ["outlook"])).toEqual([
      ...IDENTITY,
      ...OUTLOOK,
    ]);
    expect(scopesForGroups(manifest, ["microsoft_teams"])).toEqual([
      ...IDENTITY,
      ...TEAMS,
    ]);
    expect(scopesForGroups(manifest, ["excel"])).toEqual([
      ...IDENTITY,
      ...EXCEL,
    ]);

    // One consent screen requests the full deduped union for every member.
    const union = scopesForGroups(manifest, ["microsoft_all"]);
    expect([...union].sort()).toEqual(
      [...new Set([...IDENTITY, ...OUTLOOK, ...TEAMS, ...EXCEL])].sort(),
    );
    for (const connector of ["outlook", "microsoft_teams", "excel"]) {
      expect(connectScopeGroupsForConnector(manifest, connector, [])).toEqual([
        "microsoft_all",
      ]);
    }

    // Never leak tenant-wide application/admin file or site scopes that would
    // force broad admin consent beyond the delegated Teams channel reads.
    for (const forbidden of [
      "Files.ReadWrite.All",
      "Files.Read.All",
      "Sites.ReadWrite.All",
      "Sites.Read.All",
      "Mail.ReadWrite.All",
    ]) {
      expect(union).not.toContain(forbidden);
    }
  });

  it("builds an Entra PKCE URL without Google-only authorization params", () => {
    const manifest = getProviderManifest("microsoft")!;
    const url = new URL(
      buildAuthorizationUrl({
        manifest,
        clientId: "client-id",
        redirectUri:
          "https://connect.stella.test/api/connectors/oauth/callback",
        state: "state",
        codeChallenge: "challenge",
        scopes: scopesForGroups(manifest, ["microsoft_all"]),
      }),
    );
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain("ChannelMessage.Send");
  });

  it("owns only the reviewed connector/action pairs", () => {
    expect(firstPartyActionOperation("microsoft", "OUTLOOK_SEND_EMAIL")).toBe(
      "write",
    );
    expect(
      firstPartyActionBelongsToConnector(
        "microsoft",
        "outlook",
        "OUTLOOK_SEND_EMAIL",
      ),
    ).toBe(true);
    expect(
      firstPartyActionBelongsToConnector(
        "microsoft",
        "excel",
        "OUTLOOK_SEND_EMAIL",
      ),
    ).toBe(false);
    expect(
      firstPartyProviderForConnectorAction("excel", "EXCEL_GET_RANGE"),
    ).toBe("microsoft");
  });

  it("maps Outlook send inputs to one fixed-origin Graph request", async () => {
    const manifest = getProviderManifest("microsoft")!;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 202 }));
    const result = await executeFirstPartyAction({
      manifest,
      accessToken: "server-token",
      action: "OUTLOOK_SEND_EMAIL",
      input: {
        to: "one@example.com,two@example.com",
        to_name: "One",
        subject: "Hello",
        body: "<b>Hi</b>",
        is_html: true,
        cc_emails: ["copy@example.com"],
        from_address: "sender@example.com",
        save_to_sent_items: false,
      },
      operation: "write",
    });
    expect(result.output).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer server-token",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.message.toRecipients).toHaveLength(2);
    expect(body.message.toRecipients[0].emailAddress).toEqual({
      address: "one@example.com",
      name: "One",
    });
    expect(body.message.from.emailAddress.address).toBe("sender@example.com");
    expect(body.message.body.contentType).toBe("html");
    expect(body.saveToSentItems).toBe(false);
  });

  it("honors current Outlook list filters without quoting Graph search", async () => {
    const manifest = getProviderManifest("microsoft")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: "message-1",
            subject: "Quarterly budget",
            conversationId: "thread-1",
            hasAttachments: true,
            from: { emailAddress: { address: "boss@example.com" } },
          },
          {
            id: "message-2",
            subject: "Unrelated",
            conversationId: "thread-2",
            hasAttachments: false,
            from: { emailAddress: { address: "other@example.com" } },
          },
        ],
      }),
    );
    const result = await executeFirstPartyAction({
      manifest,
      accessToken: "server-token",
      action: "OUTLOOK_LIST_MESSAGES",
      input: {
        search: "budget report",
        conversation_id: "thread-1",
        has_attachments: true,
        subject_contains: "BUDGET",
        from_address: "BOSS@example.com",
      },
      operation: "read",
    });

    expect((result.output as { value: unknown[] }).value).toHaveLength(1);
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.searchParams.get("$search")).toBe("budget report");
    expect(url.searchParams.get("$filter")).toBeNull();
    expect(url.searchParams.get("$orderby")).toBeNull();
    expect(url.searchParams.get("$select")).toContain("conversationId");
    expect((init?.headers as Record<string, string>).ConsistencyLevel).toBe(
      "eventual",
    );
  });

  it("expands recurring Outlook events only with a bounded calendar window", async () => {
    const manifest = getProviderManifest("microsoft")!;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ value: [] }));
    await executeFirstPartyAction({
      manifest,
      accessToken: "server-token",
      action: "OUTLOOK_LIST_EVENTS",
      input: {
        calendar_id: "calendar",
        filter:
          "start/dateTime ge '2026-08-01T00:00:00Z' and end/dateTime le '2026-09-01T00:00:00Z'",
        expand_recurring_events: true,
      },
      operation: "read",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1.0/me/calendars/calendar/calendarView");
    expect(url.searchParams.get("startDateTime")).toBe("2026-08-01T00:00:00Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-09-01T00:00:00Z");
  });

  it("maps Teams pagination and Excel writes without accepting an arbitrary host", async () => {
    const manifest = getProviderManifest("microsoft")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        value: [{ id: "message-1" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/t/channels/c/messages?$skiptoken=next",
      }),
    );
    const page = await executeFirstPartyAction({
      manifest,
      accessToken: "server-token",
      action: "MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES",
      input: { team_id: "t", channel_id: "c", top: 25 },
      operation: "read",
    });
    expect((page.output as Record<string, unknown>).next_page_token).toEqual(
      expect.any(String),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("%24top=25");
    for (const nextLink of [
      "https://graph.microsoft.com/v1.0/me/messages?$top=1",
      "https://attacker.invalid/v1.0/teams/t/channels/c/messages",
    ]) {
      const pageToken = btoa(nextLink)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      await expect(
        executeFirstPartyAction({
          manifest,
          accessToken: "server-token",
          action: "MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES",
          input: { team_id: "t", channel_id: "c", page_token: pageToken },
          operation: "read",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ address: "Sheet1!A1:B1" }));
    await executeFirstPartyAction({
      manifest,
      accessToken: "server-token",
      action: "EXCEL_UPDATE_RANGE",
      input: {
        item_id: "workbook",
        worksheet_id: "Sheet 1",
        address: "A1:B1",
        values: [["a", "b"]],
        session_id: "session",
      },
      operation: "write",
    });
    const [excelUrl, excelInit] = fetchMock.mock.calls[1]!;
    expect(String(excelUrl)).toContain(
      "/v1.0/me/drive/items/workbook/workbook/worksheets/Sheet%201/range",
    );
    expect(
      (excelInit?.headers as Record<string, string>)["workbook-session-id"],
    ).toBe("session");
    expect(JSON.parse(String(excelInit?.body))).toEqual({
      values: [["a", "b"]],
    });
  });
});

describe("combined provider-family ownership", () => {
  it("preserves exact social toolkit ids and rejects sibling Meta actions", () => {
    expect(
      firstPartyProviderForConnectorAction(
        "facebook",
        "FACEBOOK_LIST_MANAGED_PAGES",
      ),
    ).toBe("meta");
    expect(
      firstPartyProviderForConnectorAction(
        "instagram",
        "INSTAGRAM_GET_USER_INFO",
      ),
    ).toBe("meta");
    expect(
      firstPartyProviderForConnectorAction(
        "metaads",
        "METAADS_GET_AD_ACCOUNTS",
      ),
    ).toBe("meta");
    expect(
      firstPartyActionBelongsToConnector(
        "meta",
        "instagram",
        "FACEBOOK_CREATE_POST",
      ),
    ).toBe(false);
  });

  it("preserves exact CRM toolkit ids and rejects cross-connector actions", () => {
    expect(
      firstPartyProviderForConnectorAction(
        "salesforce",
        "SALESFORCE_RUN_SOQL_QUERY",
      ),
    ).toBe("salesforce");
    expect(
      firstPartyProviderForConnectorAction("attio", "ATTIO_CREATE_RECORD"),
    ).toBe("attio");
    expect(
      firstPartyActionBelongsToConnector(
        "hubspot",
        "gong",
        "HUBSPOT_LIST_CONTACTS",
      ),
    ).toBe(false);
  });

  it("keeps Figma and Stripe actions in separate provider families", () => {
    expect(
      firstPartyProviderForConnectorAction("figma", "FIGMA_GET_FILE"),
    ).toBe("figma");
    expect(
      firstPartyProviderForConnectorAction("stripe", "STRIPE_CREATE_REFUND"),
    ).toBe("stripe");
    expect(
      firstPartyActionBelongsToConnector(
        "stripe",
        "figma",
        "STRIPE_CREATE_REFUND",
      ),
    ).toBe(false);
  });
});

describe("social first-party request adapters", () => {
  it("uses only canonical catalog actions and covers read plus write", () => {
    for (const [provider, operations] of Object.entries(
      SOCIAL_ACTION_OPERATIONS,
    )) {
      expect(Object.values(operations)).toContain("read");
      expect(Object.values(operations)).toContain("write");
      for (const action of Object.keys(operations)) {
        expect(
          SOCIAL_ACTION_REQUIRED_SCOPES[provider]?.[action]?.length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("builds provider-shaped YouTube and Reddit requests", () => {
    expect(
      buildSocialProviderRequest("youtube", "YOUTUBE_CREATE_PLAYLIST", {
        title: "Launches",
        privacyStatus: "private",
      }),
    ).toMatchObject({
      method: "POST",
      path: "/youtube/v3/playlists?part=snippet,status",
      body: {
        snippet: { title: "Launches" },
        status: { privacyStatus: "private" },
      },
    });
    expect(
      buildSocialProviderRequest("reddit", "REDDIT_CREATE_REDDIT_POST", {
        subreddit: "test",
        title: "Hello",
        text: "World",
      }),
    ).toMatchObject({
      method: "POST",
      path: "/api/submit",
      bodyEncoding: "form",
      body: { sr: "test", title: "Hello", kind: "self", text: "World" },
    });
  });

  it("rejects missing provider identifiers and unknown actions", () => {
    expect(() =>
      buildSocialProviderRequest("meta", "FACEBOOK_CREATE_POST", {
        message: "x",
      }),
    ).toThrow(/invalid_input/);
    expect(
      buildSocialProviderRequest("twitter", "TWITTER_UNKNOWN", {}),
    ).toBeNull();
  });
});

describe("CRM provider request adapters", () => {
  it("covers one canonical read and write per OAuth CRM provider", () => {
    for (const [provider, actions] of Object.entries(CRM_ACTION_OPERATIONS)) {
      expect(Object.values(actions)).toContain("read");
      expect(Object.values(actions)).toContain("write");
      for (const action of Object.keys(actions)) {
        expect(
          CRM_ACTION_REQUIRED_SCOPES[provider]?.[action]?.length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("builds fixed provider paths for representative canonical actions", () => {
    expect(
      buildCrmProviderRequest("hubspot", "HUBSPOT_LIST_CONTACTS", {
        limit: 25,
      }),
    ).toMatchObject({
      method: "GET",
      path: "/crm/v3/objects/contacts?limit=25",
    });
    expect(
      buildCrmProviderRequest("pipedrive", "PIPEDRIVE_ADD_A_DEAL", {
        title: "Expansion",
      }),
    ).toMatchObject({ method: "POST", path: "/api/v1/deals" });
    expect(
      buildCrmProviderRequest("salesforce", "SALESFORCE_RUN_SOQL_QUERY", {
        q: "SELECT Id FROM Account",
      })?.path,
    ).toContain("SELECT%20Id%20FROM%20Account");
    expect(
      buildCrmProviderRequest("attio", "ATTIO_CREATE_RECORD", {
        object_type: "people",
        values: { name: "Ada" },
      }),
    ).toMatchObject({ method: "POST", path: "/v2/objects/people/records" });
    expect(
      buildCrmProviderRequest("gong", "GONG_GET_CALL_TRANSCRIPT", {
        filter: { callIds: ["call-1"] },
      }),
    ).toMatchObject({ method: "POST", path: "/v2/calls/transcript" });
    expect(
      buildCrmProviderRequest("pipedrive", "PIPEDRIVE_DEALS_UPDATE_DEAL", {
        id: 42,
        fields: { title: "Renewal" },
      }),
    ).toMatchObject({ method: "PUT", path: "/api/v1/deals/42" });
    expect(
      buildCrmProviderRequest("salesforce", "SALESFORCE_UPDATE_RECORD", {
        sobject: "Account",
        id: "001xx",
        fields: { Name: "Acme" },
      }),
    ).toMatchObject({
      method: "PATCH",
      path: "/services/data/v61.0/sobjects/Account/001xx",
    });
    expect(
      buildCrmProviderRequest("attio", "ATTIO_QUERY_RECORDS", {
        object: "people",
        limit: 10,
      }),
    ).toMatchObject({
      method: "POST",
      path: "/v2/objects/people/records/query",
    });
  });

  it("rejects missing fields and unsafe Salesforce object paths", () => {
    expect(() =>
      buildCrmProviderRequest("pipedrive", "PIPEDRIVE_ADD_A_DEAL", {}),
    ).toThrow(/invalid_input/);
    expect(() =>
      buildCrmProviderRequest("salesforce", "SALESFORCE_CREATE_A_RECORD", {
        object: "../Account",
        fields: { Name: "Nope" },
      }),
    ).toThrow(/invalid_input/);
  });
});

describe("design and finance provider request adapters", () => {
  it("catalogs read and write actions with required scopes", () => {
    for (const [provider, actions] of Object.entries(
      DESIGN_FINANCE_ACTION_OPERATIONS,
    )) {
      expect(Object.values(actions)).toContain("read");
      expect(Object.values(actions)).toContain("write");
      for (const action of Object.keys(actions)) {
        expect(
          DESIGN_FINANCE_ACTION_REQUIRED_SCOPES[provider]?.[action]?.length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("builds only fixed-origin relative request plans", () => {
    expect(
      buildDesignFinanceProviderRequest("figma", "FIGMA_GET_FILE", {
        file_key: "a/b",
        depth: 2,
      }),
    ).toEqual({ method: "GET", path: "/v1/files/a%2Fb?depth=2" });
    expect(
      buildDesignFinanceProviderRequest("stripe", "STRIPE_CREATE_CUSTOMER", {
        email: "person@example.com",
        metadata: { source: "stella" },
      }),
    ).toMatchObject({
      method: "POST",
      path: "/v1/customers",
      bodyEncoding: "form",
    });
    expect(() =>
      buildDesignFinanceProviderRequest("stripe", "STRIPE_CREATE_REFUND", {
        amount: 500,
      }),
    ).toThrow(/invalid_input/);
  });

  it("executes Stripe form bodies at the manifest origin without token egress", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "cus_test" }));
    const result = await executeFirstPartyAction({
      manifest: getProviderManifest("stripe")!,
      accessToken: "stripe-access",
      action: "STRIPE_CREATE_CUSTOMER",
      input: {
        email: "person@example.com",
        metadata: { source: "stella" },
      },
      operation: "write",
    });
    expect(result.output).toEqual({ id: "cus_test" });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(rawUrl)).toBe("https://api.stripe.com/v1/customers");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer stripe-access",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("email")).toBe("person@example.com");
    expect(body.get("metadata[source]")).toBe("stella");
  });
});

describe("deferred API-key provider request catalog", () => {
  it("validates every deferred provider and keeps ownership unique", () => {
    expect(validateDeferredApiKeyProviderCatalog()).toEqual([]);
    const ids = DEFERRED_API_KEY_PROVIDERS.map(
      (provider) => provider.connectorId,
    );
    expect(ids.sort()).toEqual(
      [
        "1password",
        "abyssale",
        "0codekit",
        "peopledatalabs",
        "21risk",
        "2chat",
        "7shifts",
        "apollo",
        "ashby",
        "firecrawl",
        "tavily",
        "exa",
        "serpapi",
        "perplexityai",
        "posthog",
        "ably",
        "abuseipdb",
        "snowflake",
        "abstract",
        "44api",
      ].sort(),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds representative plans without accepting an origin or token", () => {
    expect(
      buildApiKeyProviderRequest(
        "peopledatalabs",
        "PEOPLEDATALABS_ENRICH_PERSON_DATA",
        { email: "person@example.com" },
      ),
    ).toEqual({
      method: "GET",
      path: "/v5/person/enrich?email=person%40example.com",
    });
    expect(
      buildApiKeyProviderRequest("21risk", "TWENTY_ONE_RISK_GET_REPORTS", {
        top: 10,
        filter: "status eq 'open'",
      }),
    ).toEqual({
      method: "GET",
      path: "/odata/Reports?%24top=10&%24filter=status+eq+%27open%27",
    });
    expect(buildApiKeyProviderRequest("2chat", "TWOCHAT_GET_INFO", {})).toEqual(
      { method: "GET", path: "/open/info" },
    );
    expect(
      buildApiKeyProviderRequest("0codekit", "ZEROCODEKIT_MERGE_PDF", {
        files: ["https://example.com/a.pdf"],
      }),
    ).toEqual({
      method: "POST",
      path: "/pdf/merge",
      body: { files: ["https://example.com/a.pdf"] },
    });
    expect(() =>
      buildApiKeyProviderRequest("0codekit", "ZEROCODEKIT_MERGE_PDF", {}),
    ).toThrow();
    expect(
      buildApiKeyProviderRequest("serpapi", "SERPAPI_NEWS_SEARCH", {
        q: "coffee",
      }),
    ).toEqual({ method: "GET", path: "/search?engine=google_news&q=coffee" });
    expect(
      buildApiKeyProviderRequest("abuseipdb", "ABUSEIPDB_CHECK_IP", {
        ipAddress: "8.8.8.8",
        maxAgeInDays: 90,
      }),
    ).toEqual({
      method: "GET",
      path: "/api/v2/check?ipAddress=8.8.8.8&maxAgeInDays=90",
    });
    expect(
      buildApiKeyProviderRequest("ably", "ABLY_GET_CHANNEL_HISTORY", {
        channel: "my room",
        limit: 10,
      }),
    ).toEqual({ method: "GET", path: "/channels/my%20room/messages?limit=10" });
    expect(
      buildApiKeyProviderRequest("firecrawl", "FIRECRAWL_CRAWL_GET", {
        id: "job-1",
      }),
    ).toEqual({ method: "GET", path: "/v2/crawl/job-1" });
  });

  it("has a relative-path request builder for every catalog action", () => {
    const samples: Record<string, Record<string, unknown>> = {
      ONEPASSWORD_LIST_VAULTS: {},
      ONEPASSWORD_LIST_ITEMS: { vaultUuid: "vault" },
      ONEPASSWORD_GET_ITEM: { vaultUuid: "vault", itemUuid: "item" },
      ONEPASSWORD_CREATE_ITEM: {
        vaultUuid: "vault",
        category: "LOGIN",
        title: "Example",
      },
      ABYSSALE_LIST_TEMPLATES: {},
      ABYSSALE_GET_TEMPLATE: { templateId: "template" },
      ABYSSALE_GENERATE_IMAGE: { templateId: "template" },
      ABYSSALE_GENERATE_IMAGE_ASYNC: { templateId: "template" },
      ZEROCODEKIT_PDF_METADATA: { url: "https://example.com/a.pdf" },
      ZEROCODEKIT_HTML_TO_PDF: { html: "<p>hi</p>" },
      ZEROCODEKIT_MERGE_PDF: { files: ["https://example.com/a.pdf"] },
      PEOPLEDATALABS_ENRICH_PERSON_DATA: { email: "person@example.com" },
      PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC: {},
      PEOPLEDATALABS_ENRICH_COMPANY_DATA: { website: "example.com" },
      PEOPLEDATALABS_SEARCH_COMPANY_ELASTIC: {},
      TWENTY_ONE_RISK_GET_REPORTS: {},
      TWENTY_ONE_RISK_GET_COMPLIANCE: {},
      TWENTY_ONE_RISK_GET_ORGANIZATIONS: {},
      TWENTY_ONE_RISK_GET_PROPERTIES: {},
      TWENTY_ONE_RISK_GET_RISK_MODELS: {},
      TWOCHAT_GET_INFO: {},
      TWOCHAT_LIST_WHATSAPP_NUMBERS: {},
      TWOCHAT_SEND_WHATSAPP_MESSAGE: {
        to_number: "+10000000000",
        from_number: "+19999999999",
        text: "hello",
      },
      SEVENSHIFTS_WHOAMI: {},
      SEVENSHIFTS_LIST_USERS: { companyId: "company" },
      SEVENSHIFTS_LIST_SHIFTS: { companyId: "company" },
      SEVENSHIFTS_CREATE_SHIFT: {
        companyId: "company",
        location_id: 1,
        user_id: 2,
        start: "2026-01-01T09:00:00Z",
        end: "2026-01-01T17:00:00Z",
      },
      "7SHIFTS_LIST_SHIFTS": { company_id: "company" },
      "7SHIFTS_CREATE_DEPARTMENT": {
        company_id: "company",
        location_id: "location",
        name: "Front of House",
        default: false,
      },
      APOLLO_PEOPLE_SEARCH: {},
      APOLLO_ORGANIZATION_SEARCH: {},
      APOLLO_PEOPLE_ENRICH: {},
      APOLLO_CREATE_CONTACT: { first_name: "Ada", last_name: "Lovelace" },
      APOLLO_CREATE_TASK: {
        priority: "high",
        type: "email",
        contact_ids: ["contact"],
      },
      ASHBY_LIST_CANDIDATES: {},
      ASHBY_SEARCH_CANDIDATES: {},
      ASHBY_CREATE_CANDIDATE: { name: "Ada Lovelace" },
      ASHBY_LIST_JOBS: {},
      ASHBY_CREATE_NOTE: { candidateId: "candidate", note: "Follow up" },
      FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM: { url: "https://example.com" },
      FIRECRAWL_SEARCH: { query: "stella" },
      FIRECRAWL_CRAWL: { url: "https://example.com" },
      FIRECRAWL_CRAWL_GET: { id: "job-1" },
      TAVILY_SEARCH: { query: "stella" },
      TAVILY_EXTRACT: { urls: ["https://example.com"] },
      TAVILY_MAP: { url: "https://example.com" },
      TAVILY_CRAWL: { url: "https://example.com" },
      EXA_SEARCH: { query: "stella" },
      EXA_GET_CONTENTS_ACTION: { urls: ["https://example.com"] },
      EXA_ANSWER: { query: "who is ada lovelace" },
      SERPAPI_SEARCH: { q: "coffee" },
      SERPAPI_NEWS_SEARCH: { q: "coffee" },
      SERPAPI_BING_SEARCH: { q: "coffee" },
      PERPLEXITYAI_SEARCH: { query: "stella" },
      PERPLEXITYAI_CREATE_CHAT_COMPLETION: {
        model: "sonar",
        messages: [{ role: "user", content: "hi" }],
      },
      POSTHOG_LIST_PROJECTS: {},
      POSTHOG_GET_INSIGHTS: { project_id: "1" },
      POSTHOG_LIST_FEATURE_FLAGS: { project_id: "1" },
      ABLY_GET_CHANNEL_HISTORY: { channel: "room" },
      ABLY_LIST_CHANNELS: {},
      ABLY_GET_STATS: {},
      ABLY_PUBLISH_MESSAGE: { channel: "room", name: "greeting", data: "hi" },
      ABUSEIPDB_CHECK_IP: { ipAddress: "8.8.8.8" },
      ABUSEIPDB_GET_BLACKLIST: {},
      ABUSEIPDB_CHECK_BLOCK: { network: "8.8.8.0/24" },
      ABUSEIPDB_REPORT_IP: { ip: "8.8.8.8", categories: "18" },
      SNOWFLAKE_LIST_DATABASES: {},
      SNOWFLAKE_DESCRIBE_TABLE: { table: "MY_DB.MY_SCHEMA.MY_TABLE" },
      SNOWFLAKE_EXECUTE_SQL_QUERY: { statement: "select 1" },
      ABSTRACT_VALIDATE_EMAIL: { email: "person@example.com" },
      ABSTRACT_VALIDATE_PHONE: { phone: "14154582468" },
      ABSTRACT_GET_IP_GEOLOCATION: { ip_address: "8.8.8.8" },
      FORTYFOUR_API_VALIDATE_VAT_NUMBER: {
        vatNumber: "69838046",
        countryCode: "SI",
      },
      FORTYFOUR_API_LIST_WHITELISTED_IPS: {},
      FORTYFOUR_API_ADD_WHITELISTED_IP: {
        ipAddress: "203.0.113.50",
        email: "admin@company.com",
      },
      FORTYFOUR_API_REMOVE_WHITELISTED_IP: { ipAddress: "203.0.113.50" },
    };

    for (const provider of DEFERRED_API_KEY_PROVIDERS) {
      for (const action of Object.keys(provider.actions)) {
        const request = buildApiKeyProviderRequest(
          provider.providerKey,
          action,
          samples[action] ?? {},
        );
        expect(request, `${provider.connectorId}:${action}`).not.toBeNull();
        expect(request?.path, `${provider.connectorId}:${action}`).toMatch(
          /^\/(?!\/)/u,
        );
        expect(request?.headers?.authorization).toBeUndefined();
      }
    }
  });

  it("plans Snowflake SQL API v2 requests and binds only allowlisted account origins", () => {
    expect(
      buildApiKeyProviderRequest("snowflake", "SNOWFLAKE_LIST_DATABASES", {}),
    ).toEqual({
      method: "POST",
      path: "/api/v2/statements",
      body: { statement: "SHOW DATABASES" },
    });
    expect(
      buildApiKeyProviderRequest("snowflake", "SNOWFLAKE_DESCRIBE_TABLE", {
        table: "DB.SCHEMA.T",
        warehouse: "WH",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v2/statements",
      body: {
        statement: "DESCRIBE TABLE IDENTIFIER(?)",
        warehouse: "WH",
        bindings: { "1": { type: "TEXT", value: "DB.SCHEMA.T" } },
      },
    });
    expect(() =>
      buildApiKeyProviderRequest(
        "snowflake",
        "SNOWFLAKE_EXECUTE_SQL_QUERY",
        {},
      ),
    ).toThrow();

    const snowflake = DEFERRED_API_KEY_PROVIDERS.find(
      (provider) => provider.connectorId === "snowflake",
    )!;
    // Never a fixed origin; binds only through the narrow suffix allowlist.
    expect(
      resolveDeferredActionOrigin(snowflake, "SNOWFLAKE_LIST_DATABASES"),
    ).toBeNull();
    expect(
      resolveDeferredTenantOrigin(
        snowflake,
        "https://acme-prod.snowflakecomputing.com",
      ),
    ).toBe("https://acme-prod.snowflakecomputing.com");
    expect(
      resolveDeferredTenantOrigin(
        snowflake,
        "https://org-account.us-east-1.aws.snowflakecomputing.com",
      ),
    ).toBe("https://org-account.us-east-1.aws.snowflakecomputing.com");
    // Arbitrary hosts, the bare suffix, look-alikes, and downgrades are rejected.
    for (const bad of [
      "https://evil.com",
      "https://snowflakecomputing.com",
      "https://acme.snowflakecomputing.com.evil.com",
      "https://evilsnowflakecomputing.com",
      "http://acme.snowflakecomputing.com",
      "https://acme.snowflakecomputing.com/api/v2/statements",
      "https://user:pass@acme.snowflakecomputing.com",
    ]) {
      expect(resolveDeferredTenantOrigin(snowflake, bad), bad).toBeNull();
    }
  });

  it("maps every Abstract action to its official per-product host under abstractapi.com", () => {
    const abstract = DEFERRED_API_KEY_PROVIDERS.find(
      (provider) => provider.connectorId === "abstract",
    )!;
    expect(abstract.fixedApiOrigin).toBeUndefined();
    const expected: Record<string, string> = {
      ABSTRACT_VALIDATE_EMAIL: "https://emailvalidation.abstractapi.com",
      ABSTRACT_VALIDATE_PHONE: "https://phonevalidation.abstractapi.com",
      ABSTRACT_GET_IP_GEOLOCATION: "https://ipgeolocation.abstractapi.com",
    };
    for (const action of Object.keys(abstract.actions)) {
      const origin = resolveDeferredActionOrigin(abstract, action);
      expect(origin, action).toBe(expected[action]);
      const url = new URL(origin!);
      expect(url.protocol).toBe("https:");
      expect(url.hostname.endsWith(".abstractapi.com"), action).toBe(true);
    }
    expect(
      buildApiKeyProviderRequest("abstract", "ABSTRACT_VALIDATE_EMAIL", {
        email: "person@example.com",
        auto_correct: true,
      }),
    ).toEqual({
      method: "GET",
      path: "/v1/?email=person%40example.com&auto_correct=true",
    });
    // The secret api_key query param is injected at execution, never planned.
    const emailPlan = buildApiKeyProviderRequest(
      "abstract",
      "ABSTRACT_VALIDATE_EMAIL",
      { email: "person@example.com", api_key: "secret" },
    );
    expect(emailPlan?.path).not.toContain("api_key");
  });

  it("keeps exact public 44API_* actions while canonicalizing the safe-action invariant", () => {
    const fortyfour = DEFERRED_API_KEY_PROVIDERS.find(
      (provider) => provider.connectorId === "44api",
    )!;
    // The stored catalog keys are the safe canonical aliases, not the public slug.
    for (const action of Object.keys(fortyfour.actions)) {
      expect(action.startsWith("FORTYFOUR_API_")).toBe(true);
      expect(action).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    }
    const publicActions = [
      "44API_VALIDATE_VAT_NUMBER",
      "44API_LIST_WHITELISTED_IPS",
      "44API_ADD_WHITELISTED_IP",
      "44API_REMOVE_WHITELISTED_IP",
    ];
    for (const publicAction of publicActions) {
      // The exact public slug is digit-leading and fails the strict invariant...
      expect(publicAction).not.toMatch(/^[A-Z][A-Z0-9_]*$/u);
      // ...but canonicalizes to a stored safe alias.
      const canonical = canonicalizeDeferredActionName("44api", publicAction);
      expect(Object.keys(fortyfour.actions)).toContain(canonical);
    }
    // Public and canonical names resolve to identical plans (aliasing, not renaming).
    const samples: Record<string, Record<string, unknown>> = {
      "44API_VALIDATE_VAT_NUMBER": { vatNumber: "69838046", countryCode: "SI" },
      "44API_LIST_WHITELISTED_IPS": {},
      "44API_ADD_WHITELISTED_IP": {
        ipAddress: "203.0.113.50",
        email: "admin@company.com",
      },
      "44API_REMOVE_WHITELISTED_IP": { ipAddress: "203.0.113.50" },
    };
    for (const publicAction of publicActions) {
      const canonical = canonicalizeDeferredActionName("44api", publicAction);
      const viaPublic = buildApiKeyProviderRequest(
        "44api",
        publicAction,
        samples[publicAction],
      );
      const viaCanonical = buildApiKeyProviderRequest(
        "44api",
        canonical,
        samples[publicAction],
      );
      expect(viaPublic).toEqual(viaCanonical);
      expect(viaPublic?.path.startsWith("/webhook/")).toBe(true);
    }
    expect(
      buildApiKeyProviderRequest("44api", "44API_VALIDATE_VAT_NUMBER", {
        vatNumber: "69838046",
        countryCode: "SI",
      }),
    ).toEqual({
      method: "POST",
      path: "/webhook/validate-vat",
      body: { vatNumber: "69838046", countryCode: "SI" },
    });
    expect(
      buildApiKeyProviderRequest("44api", "44API_ADD_WHITELISTED_IP", {
        ipAddress: "203.0.113.50",
        email: "admin@company.com",
      }),
    ).toEqual({
      method: "POST",
      path: "/webhook/ip-whitelist",
      body: {
        ipAddress: "203.0.113.50",
        email: "admin@company.com",
        action: "add",
      },
    });
    expect(fortyfour.fixedApiOrigin).toBe("https://api.44api.dev");
  });
});

describe("developer-data provider request adapters", () => {
  it("owns exact GitHub and Supabase actions with server-side operations", () => {
    for (const [provider, actions] of Object.entries(
      DEVELOPER_DATA_ACTION_OPERATIONS,
    )) {
      expect(Object.values(actions)).toContain("read");
      expect(Object.values(actions)).toContain("write");
      for (const action of Object.keys(actions)) {
        expect(
          DEVELOPER_DATA_ACTION_REQUIRED_SCOPES[provider]?.[action]?.length,
        ).toBeGreaterThan(0);
      }
    }
    expect(
      firstPartyProviderForConnectorAction("github", "GITHUB_CREATE_AN_ISSUE"),
    ).toBe("github");
    expect(
      firstPartyActionBelongsToConnector(
        "supabase",
        "github",
        "SUPABASE_GET_PROJECT",
      ),
    ).toBe(false);
  });

  it("builds fixed GitHub paths and strips path identifiers from bodies", () => {
    expect(
      buildDeveloperDataProviderRequest("github", "GITHUB_LIST_PULL_REQUESTS", {
        owner: "stella ai",
        repo: "desktop/client",
        state: "open",
        page: 2,
      }),
    ).toMatchObject({
      method: "GET",
      path: "/repos/stella%20ai/desktop%2Fclient/pulls?state=open&page=2",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    expect(
      buildDeveloperDataProviderRequest("github", "GITHUB_CREATE_AN_ISSUE", {
        owner: "stella",
        repo: "desktop",
        title: "Bug",
        body: "Details",
        ignored: "not forwarded",
      }),
    ).toMatchObject({
      method: "POST",
      path: "/repos/stella/desktop/issues",
      body: { title: "Bug", body: "Details" },
    });
  });

  it("builds Supabase Management API requests and fails closed", () => {
    expect(
      buildDeveloperDataProviderRequest("supabase", "SUPABASE_GET_PROJECT", {
        ref: "project/ref",
      }),
    ).toEqual({ method: "GET", path: "/v1/projects/project%2Fref" });
    expect(
      buildDeveloperDataProviderRequest(
        "supabase",
        "SUPABASE_CREATE_A_PROJECT",
        {
          name: "Project",
          organization_id: "org",
          region: "us-east-1",
          db_pass: "secret",
          ignored: true,
        },
      ),
    ).toEqual({
      method: "POST",
      path: "/v1/projects",
      body: {
        name: "Project",
        organization_id: "org",
        region: "us-east-1",
        db_pass: "secret",
      },
    });
    expect(() =>
      buildDeveloperDataProviderRequest("github", "GITHUB_GET_A_REPOSITORY", {
        owner: "stella",
      }),
    ).toThrow(/invalid_input/);
    expect(
      buildDeveloperDataProviderRequest("github", "GITHUB_UNKNOWN", {}),
    ).toBeNull();
  });
});

describe("productivity provider request adapters", () => {
  it("owns one canonical read and write for all eleven connectors", () => {
    const connectors = new Set<string>();
    for (const [provider, actions] of Object.entries(
      PRODUCTIVITY_ACTION_OPERATIONS,
    )) {
      expect(Object.values(actions)).toContain("read");
      expect(Object.values(actions)).toContain("write");
      for (const action of Object.keys(actions)) {
        expect(
          PRODUCTIVITY_ACTION_REQUIRED_SCOPES[provider]?.[action],
        ).toBeDefined();
      }
    }
    for (const [connector, action] of [
      ["notion", "NOTION_SEARCH_NOTION_PAGE"],
      ["slack", "SLACK_FETCH_CONVERSATION_HISTORY"],
      ["airtable", "AIRTABLE_LIST_RECORDS"],
      ["asana", "ASANA_GET_MULTIPLE_TASKS"],
      ["clickup", "CLICKUP_GET_TASKS"],
      ["slackbot", "SLACKBOT_FIND_CHANNELS"],
      ["monday", "MONDAY_BOARDS"],
      ["linear", "LINEAR_LIST_LINEAR_ISSUES"],
      ["jira", "JIRA_GET_ISSUE"],
      ["canvas", "CANVAS_LIST_COURSES"],
      ["7shifts", "7SHIFTS_LIST_SHIFTS"],
    ] as const) {
      connectors.add(connector);
      expect(
        firstPartyProviderForConnectorAction(connector, action),
      ).not.toBeNull();
    }
    expect(connectors.size).toBe(11);
  });

  it("builds fixed provider paths and headers", () => {
    expect(
      buildProductivityProviderRequest("notion", "NOTION_SEARCH_NOTION_PAGE", {
        query: "roadmap",
      }),
    ).toMatchObject({
      method: "POST",
      path: "/v1/search",
      headers: { "notion-version": "2022-06-28" },
    });
    expect(
      buildProductivityProviderRequest("airtable", "AIRTABLE_LIST_RECORDS", {
        baseId: "app/unsafe",
        tableIdOrName: "Tasks & Notes",
        pageSize: 25,
      })?.path,
    ).toBe("/v0/app%2Funsafe/Tasks%20%26%20Notes?pageSize=25");
    expect(
      buildProductivityProviderRequest("atlassian", "JIRA_GET_ISSUE", {
        cloudId: "cloud/id",
        issueIdOrKey: "ENG/1",
      })?.path,
    ).toBe("/ex/jira/cloud%2Fid/rest/api/3/issue/ENG%2F1");
    expect(
      buildProductivityProviderRequest("7shifts", "7SHIFTS_LIST_SHIFTS", {
        company_id: "42",
      }),
    ).toMatchObject({
      method: "GET",
      path: "/v2/company/42/shifts",
      headers: { "x-api-version": "2026-01-01" },
    });
  });

  it("plans every published action without accepting an origin or auth header", () => {
    const cases: readonly [string, string, Record<string, unknown>][] = [
      ["notion", "NOTION_SEARCH_NOTION_PAGE", { query: "roadmap" }],
      [
        "notion",
        "NOTION_CREATE_NOTION_PAGE",
        { parent_id: "page", title: "Roadmap" },
      ],
      ["slack", "SLACK_FETCH_CONVERSATION_HISTORY", { channel: "C123" }],
      [
        "slack",
        "SLACK_SEND_MESSAGE",
        { channel: "C123", markdown_text: "Hello" },
      ],
      [
        "airtable",
        "AIRTABLE_LIST_RECORDS",
        { baseId: "app123", tableIdOrName: "Tasks" },
      ],
      [
        "airtable",
        "AIRTABLE_CREATE_RECORDS",
        {
          baseId: "app123",
          tableIdOrName: "Tasks",
          records: [{ fields: { Name: "Hi" } }],
        },
      ],
      ["asana", "ASANA_GET_MULTIPLE_TASKS", { project: "project" }],
      [
        "asana",
        "ASANA_CREATE_A_TASK",
        { data: { name: "Ship", projects: ["project"] } },
      ],
      ["clickup", "CLICKUP_GET_TASKS", { list_id: "list" }],
      ["clickup", "CLICKUP_CREATE_TASK", { list_id: "list", name: "Ship" }],
      ["slack", "SLACKBOT_FIND_CHANNELS", {}],
      [
        "slack",
        "SLACKBOT_SEND_MESSAGE",
        { channel: "C123", markdown_text: "Hello" },
      ],
      ["monday", "MONDAY_BOARDS", { limit: 10 }],
      ["monday", "MONDAY_CREATE_ITEM", { board_id: "123", item_name: "Ship" }],
      ["linear", "LINEAR_LIST_LINEAR_ISSUES", { first: 10 }],
      [
        "linear",
        "LINEAR_CREATE_LINEAR_ISSUE",
        { team_id: "team", title: "Ship" },
      ],
      [
        "atlassian",
        "JIRA_GET_ISSUE",
        { cloudId: "cloud", issueIdOrKey: "ENG-1" },
      ],
      [
        "atlassian",
        "JIRA_CREATE_ISSUE",
        {
          cloudId: "cloud",
          project_key: "ENG",
          summary: "Ship",
          issue_type: "Task",
        },
      ],
      ["canvas", "CANVAS_LIST_COURSES", {}],
      ["canvas", "CANVAS_CREATE_COURSE", { account_id: "1", name: "Writing" }],
      ["7shifts", "7SHIFTS_LIST_SHIFTS", { company_id: "1" }],
      [
        "7shifts",
        "7SHIFTS_CREATE_DEPARTMENT",
        {
          company_id: "1",
          location_id: 2,
          name: "Front",
          default: false,
        },
      ],
    ];

    for (const [provider, action, input] of cases) {
      const request = buildProductivityProviderRequest(provider, action, {
        ...input,
        origin: "https://attacker.invalid",
        authorization: "Bearer attacker",
      });
      expect(request, action).not.toBeNull();
      expect(request!.path, action).toMatch(/^\//u);
      expect(request!.path, action).not.toContain("attacker.invalid");
      expect(
        Object.keys(request!.headers ?? {}).map((key) => key.toLowerCase()),
        action,
      ).not.toContain("authorization");
    }
  });

  it("rejects missing identifiers and unregistered actions", () => {
    expect(() =>
      buildProductivityProviderRequest("clickup", "CLICKUP_CREATE_TASK", {
        name: "unsafe without a list",
      }),
    ).toThrow(/invalid_input/u);
    expect(
      buildProductivityProviderRequest("linear", "LINEAR_DELETE_ISSUE", {}),
    ).toBeNull();
    expect(
      firstPartyActionBelongsToConnector(
        "slack",
        "slackbot",
        "SLACK_SEND_MESSAGE",
      ),
    ).toBe(false);
    expect(() =>
      buildProductivityProviderRequest("7shifts", "7SHIFTS_CREATE_DEPARTMENT", {
        company_id: "1",
        name: "Front",
      }),
    ).toThrow(/invalid_input/u);
  });

  it("maps canonical action inputs to provider-native request bodies", () => {
    expect(
      buildProductivityProviderRequest("slack", "SLACK_SEND_MESSAGE", {
        channel: "C123",
        markdown_text: "Hello",
      })?.body,
    ).toEqual({ channel: "C123", text: "Hello" });
    expect(
      buildProductivityProviderRequest("linear", "LINEAR_CREATE_LINEAR_ISSUE", {
        team_id: "team",
        title: "Ship",
        state_id: "state",
        label_ids: ["label"],
      })?.body,
    ).toMatchObject({
      variables: {
        input: {
          teamId: "team",
          title: "Ship",
          stateId: "state",
          labelIds: ["label"],
        },
      },
    });
    expect(
      buildProductivityProviderRequest("atlassian", "JIRA_CREATE_ISSUE", {
        cloudId: "cloud",
        project_key: "ENG",
        summary: "Ship",
        issue_type: "Task",
        description: "Details",
        additional_properties: JSON.stringify({
          summary: "must not override",
          resolution: { name: "Done" },
          customfield_10001: "allowed",
        }),
      })?.body,
    ).toMatchObject({
      fields: {
        project: { key: "ENG" },
        summary: "Ship",
        issuetype: { name: "Task" },
        description: { type: "doc", version: 1 },
        customfield_10001: "allowed",
      },
    });
    expect(
      (
        buildProductivityProviderRequest("atlassian", "JIRA_CREATE_ISSUE", {
          cloudId: "cloud",
          project_key: "ENG",
          summary: "Ship",
          issue_type: "Task",
          additional_properties: JSON.stringify({ resolution: "Done" }),
        })?.body as { fields: Record<string, unknown> }
      ).fields,
    ).not.toHaveProperty("resolution");
    expect(
      buildProductivityProviderRequest("monday", "MONDAY_CREATE_ITEM", {
        board_id: "123",
        item_name: "Ship",
        column_values: { status: { label: "Done" } },
      })?.body,
    ).toMatchObject({
      variables: {
        columns: JSON.stringify({ status: { label: "Done" } }),
      },
    });
    expect(
      buildProductivityProviderRequest("canvas", "CANVAS_CREATE_COURSE", {
        account_id: "1",
        name: "Writing",
        offer: true,
      })?.body,
    ).toEqual({ course: { name: "Writing" }, offer: true });
  });
});

// ---------------------------------------------------------------------------
// Pure unit: token-set merge rules
// ---------------------------------------------------------------------------

describe("token set merge", () => {
  it("parses both whitespace- and comma-delimited provider scope strings", () => {
    expect(parseScopeString("repo, read:user user:email")).toEqual([
      "repo",
      "read:user",
      "user:email",
    ]);
  });

  it("preserves an omitted refresh token and unions scopes", () => {
    const existing = {
      accessToken: "old",
      refreshToken: "refresh-keep",
      tokenType: "Bearer",
      scope: "a b",
    };
    const { tokenSet, grantedScopes } = mergeTokenSet(existing, {
      accessToken: "new",
      scopes: ["b", "c"],
    });
    expect(tokenSet.refreshToken).toBe("refresh-keep");
    expect(tokenSet.accessToken).toBe("new");
    expect(grantedScopes.sort()).toEqual(["a", "b", "c"]);
  });

  it("takes a newly issued refresh token when present", () => {
    const { tokenSet } = mergeTokenSet(
      { accessToken: "o", refreshToken: "r1", tokenType: "Bearer" },
      { accessToken: "n", refreshToken: "r2", scopes: [] },
    );
    expect(tokenSet.refreshToken).toBe("r2");
  });

  it("computes expiry and freshness with skew", () => {
    const now = 1_000_000;
    expect(expiryFromExpiresIn(3600, now)).toBe(now + 3_600_000);
    expect(expiryFromExpiresIn("bad", now)).toBeUndefined();
    expect(accessTokenIsFresh(now + 10 * 60_000, 5 * 60_000, now)).toBe(true);
    expect(accessTokenIsFresh(now + 60_000, 5 * 60_000, now)).toBe(false);
    expect(accessTokenIsFresh(undefined, 5 * 60_000, now)).toBe(false);
    expect(unionScopes(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: routing matrix
// ---------------------------------------------------------------------------

describe("route resolution", () => {
  const rollout = (
    mode: ConnectorRollout["mode"],
    extra: Partial<ConnectorRollout> = {},
  ): ConnectorRollout => ({
    connectorId: "c",
    mode,
    routeVersion: 1,
    ...extra,
  });
  const base = {
    ownerId,
    operation: "read" as const,
    killSwitchEnabled: true,
    hasFirstPartyReady: true,
  };

  it("disabled refuses both executors", () => {
    expect(
      resolveRoute({ ...base, rollout: rollout("disabled") }).executor,
    ).toBe("refused");
  });

  it("kill switch off forces composio, and refuses migrated connectors", () => {
    expect(
      resolveRoute({
        ...base,
        killSwitchEnabled: false,
        rollout: rollout("first_party_preferred"),
      }).executor,
    ).toBe("composio");
    expect(
      resolveRoute({
        ...base,
        killSwitchEnabled: false,
        rollout: rollout("first_party_only"),
      }).executor,
    ).toBe("refused");
  });

  it("composio_only and shadow keep composio; shadow flags read-only evaluation", () => {
    expect(
      resolveRoute({ ...base, rollout: rollout("composio_only") }).executor,
    ).toBe("composio");
    const shadow = resolveRoute({ ...base, rollout: rollout("shadow") });
    expect(shadow.executor).toBe("composio");
    expect(shadow.shadowEvaluate).toBe(true);
  });

  it("canary routes selected+ready owners to first-party only", () => {
    const selected = resolveRoute({
      ...base,
      rollout: rollout("first_party_canary", {
        canaryPercent: 100,
        saltVersion: 1,
      }),
    });
    expect(selected.executor).toBe("first_party");
    const notSelected = resolveRoute({
      ...base,
      rollout: rollout("first_party_canary", { canaryPercent: 0 }),
    });
    expect(notSelected.executor).toBe("composio");
    const selectedNotReady = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      rollout: rollout("first_party_canary", { canaryPercent: 100 }),
    });
    expect(selectedNotReady.executor).toBe("composio");
  });

  it("preferred uses first-party when ready, else suggests connect (no silent composio account for writes)", () => {
    expect(
      resolveRoute({ ...base, rollout: rollout("first_party_preferred") })
        .executor,
    ).toBe("first_party");
    const notReadyRead = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      operation: "read",
      rollout: rollout("first_party_preferred", {
        allowedFallbacks: ["composio"],
      }),
    });
    expect(notReadyRead.executor).toBe("composio");
    expect(notReadyRead.firstPartyConnectSuggested).toBe(true);
    expect(notReadyRead.allowReadFallbackToComposio).toBe(true);
    const notReadyWrite = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      operation: "write",
      rollout: rollout("first_party_preferred", {
        allowedFallbacks: ["composio"],
      }),
    });
    // Writes never get an automatic fallback flag.
    expect(notReadyWrite.allowReadFallbackToComposio).toBe(false);
  });

  it("first_party_only routes first-party and blocks the composio path", () => {
    expect(
      resolveRoute({ ...base, rollout: rollout("first_party_only") }).executor,
    ).toBe("first_party");
    expect(composioPathBlocked("first_party_only")).toBe(true);
    expect(composioPathBlocked("disabled")).toBe(true);
    expect(composioPathBlocked("composio_only")).toBe(false);
  });

  it("canary bucketing is deterministic and stable per owner/connector", () => {
    const a = canaryBucket(ownerId, "c", 1);
    const b = canaryBucket(ownerId, "c", 1);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(10000);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: error taxonomy
// ---------------------------------------------------------------------------

describe("error taxonomy", () => {
  it("maps codes to safe HTTP statuses", () => {
    expect(connectorErrorHttpStatus("invalid_input")).toBe(400);
    expect(connectorErrorHttpStatus("reauth_required")).toBe(409);
    expect(connectorErrorHttpStatus("state_replayed")).toBe(410);
    expect(connectorErrorHttpStatus("provider_rate_limited")).toBe(429);
    expect(connectorErrorHttpStatus("provider_unavailable")).toBe(503);
  });

  it("classifies provider status and token-endpoint errors", () => {
    expect(classifyProviderStatus(401).code).toBe("reauth_required");
    expect(classifyProviderStatus(429).retryable).toBe(true);
    expect(classifyProviderStatus(503).code).toBe("provider_unavailable");
    expect(classifyTokenEndpointError("invalid_grant").code).toBe(
      "invalid_grant",
    );
    expect(
      classifyTokenEndpointError("temporarily_unavailable").retryable,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Convex: connect attempts (state one-time / replay / expiry / owner isolation)
// ---------------------------------------------------------------------------

const createAttempt = async (
  t: ReturnType<typeof createTest>,
  overrides: Partial<{ stateHash: string; expiresAt: number }> = {},
) =>
  await t.mutation(internal.connectors.oauth.attempts.createConnectAttempt, {
    ownerId,
    provider: "mock",
    connectorId: "mockconn",
    scopeGroupIds: ["read"],
    stateHash: overrides.stateHash ?? "state-hash-1",
    encryptedVerifier: "enc",
    keyVersion: 1,
    returnSurface: "desktop",
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  });

describe("connect attempts", () => {
  it("consumes state exactly once and rejects replay", async () => {
    const t = createTest();
    await createAttempt(t, { stateHash: "s1" });
    const first = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s1" },
    );
    expect(first?.ownerId).toBe(ownerId);
    const replay = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s1" },
    );
    expect(replay).toBeNull();
  });

  it("rejects expired state and marks it expired", async () => {
    const t = createTest();
    await createAttempt(t, { stateHash: "s2", expiresAt: Date.now() - 1000 });
    const consumed = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s2" },
    );
    expect(consumed).toBeNull();
  });

  it("status polling is owner-isolated", async () => {
    const t = createTest();
    const attemptId = await createAttempt(t, { stateHash: "s3" });
    const own = await asOwner(t).query(
      api.connectors.oauth.attempts.getConnectAttemptStatus,
      { attemptId },
    );
    expect(own?.status).toBe("pending");
    const other = await t
      .withIdentity({
        issuer: "https://issuer.test",
        subject: "other-owner",
        tokenIdentifier: otherOwnerId,
      })
      .query(api.connectors.oauth.attempts.getConnectAttemptStatus, {
        attemptId,
      });
    expect(other).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Convex: encrypted vault + refresh leasing/generation
// ---------------------------------------------------------------------------

const commitTokens = async (
  t: ReturnType<typeof createTest>,
  incoming: {
    accessToken: string;
    refreshToken?: string;
    scopes: string[];
    accessTokenExpiresAt?: number;
  },
  providerAccountIdIntent?: string,
) =>
  await t.mutation(
    internal.connectors.oauth.vault.commitProviderAccountTokens,
    {
      ownerId,
      provider: "mock",
      providerAccountId: "mock-sub",
      providerAccountIdIntent,
      displayEmail: "u@example.com",
      incoming: {
        accessToken: incoming.accessToken,
        refreshToken: incoming.refreshToken,
        tokenType: "Bearer",
        accessTokenExpiresAt:
          incoming.accessTokenExpiresAt ?? Date.now() + 3_600_000,
        scopes: incoming.scopes,
      },
    },
  );

describe("encrypted token vault", () => {
  it("upserts account + credential, unions scopes, preserves omitted refresh token", async () => {
    const t = createTest();
    // Hyphenated sentinels: '-' is not in the base64 alphabet, so these strings
    // can never appear inside ciphertext by chance.
    const first = await commitTokens(t, {
      accessToken: "access-first-token",
      refreshToken: "refresh-keep-token",
      scopes: ["mock.profile", "mock.read"],
    });
    // Second incremental grant omits the refresh token and adds a scope.
    const second = await commitTokens(t, {
      accessToken: "access-second-token",
      scopes: ["mock.write"],
    });
    expect(second.accountId).toBe(first.accountId);
    expect(second.grantedScopes.sort()).toEqual(
      ["mock.profile", "mock.read", "mock.write"].sort(),
    );
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId: first.accountId },
    );
    expect(cred?.grantedScopes.sort()).toEqual(
      ["mock.profile", "mock.read", "mock.write"].sort(),
    );
    // Ciphertext is opaque; token payload never leaks in the query result.
    expect(JSON.stringify(cred)).not.toContain("access-second-token");
    expect(JSON.stringify(cred)).not.toContain("refresh-keep-token");
    // The preserved refresh token is still usable after the omitting grant.
    const decrypted = await t.run(async (ctx) => {
      const { decryptSecret } = await import("./data/secrets_crypto");
      const { parseTokenSet } = await import("./connectors/oauth/token_set");
      const row = await ctx.db
        .query("oauth_credentials")
        .withIndex("by_accountId", (q) => q.eq("accountId", first.accountId))
        .unique();
      return parseTokenSet(await decryptSecret(row!.encryptedTokenSet));
    });
    expect(decrypted.refreshToken).toBe("refresh-keep-token");
    expect(decrypted.accessToken).toBe("access-second-token");
  });

  it("rejects an account-mismatch on incremental grant", async () => {
    const t = createTest();
    await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    await expect(
      commitTokens(
        t,
        { accessToken: "a2", scopes: ["mock.write"] },
        "different-account",
      ),
    ).rejects.toThrow(/account_mismatch/);
  });

  it("single-flight refresh: second claimant is busy, late commit is rejected", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    const winner = await t.mutation(
      internal.connectors.oauth.vault.claimRefreshLease,
      { accountId, expectedGeneration: 1, leaseId: "lease-A" },
    );
    expect(winner.ok).toBe(true);
    const waiter = await t.mutation(
      internal.connectors.oauth.vault.claimRefreshLease,
      { accountId, expectedGeneration: 1, leaseId: "lease-B" },
    );
    expect(waiter.ok).toBe(false);
    expect(waiter.reason).toBe("busy");

    // A concurrent reconnect bumps the generation and clears the lease.
    await commitTokens(t, { accessToken: "a2", scopes: ["mock.read"] });
    const lateCommit = await t.mutation(
      internal.connectors.oauth.vault.commitRefreshedTokens,
      {
        accountId,
        leaseId: "lease-A",
        expectedGeneration: 1,
        incoming: {
          accessToken: "stale",
          tokenType: "Bearer",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: ["mock.read"],
        },
      },
    );
    expect(lateCommit.ok).toBe(false);
  });

  it("markAccountReauthRequired tombstones the credential", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    await t.mutation(
      internal.connectors.oauth.vault.markAccountReauthRequired,
      { accountId },
    );
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("reauth_required");
    expect(cred?.encryptedTokenSet).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Convex: scope-aware status, bindings, disconnect
// ---------------------------------------------------------------------------

const bind = async (
  t: ReturnType<typeof createTest>,
  accountId: string,
  requiredScopeGroups: string[],
) =>
  await t.mutation(internal.connectors.oauth.accounts.setConnectorBinding, {
    ownerId,
    connectorId: "mockconn",
    provider: "mock",
    accountId: accountId as never,
    requiredScopeGroups,
  });

describe("scope-aware status and disconnect", () => {
  it("reports missing_scope until granted scopes cover the required groups", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.profile", "mock.read"],
    });
    await bind(t, accountId, ["write"]);
    const before = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(before.connected).toBe(false);
    expect(before.missingScopeGroups).toContain("write");

    await commitTokens(t, { accessToken: "a2", scopes: ["mock.write"] });
    const after = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(after.connected).toBe(true);
    expect(after.status).toBe("connected");
  });

  it("disconnect revokes at provider and destroys ciphertext + bindings", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    await bind(t, accountId, ["read"]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const result = await asOwner(t).action(
      api.connectors.oauth.accounts.disconnectConnectorAccount,
      { accountId: accountId as never },
    );
    expect(result.revoked).toBe(true);
    expect(result.providerRevoked).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "mock-provider.stella.test/revoke",
    );
    const status = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(status.connected).toBe(false);
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// Convex: rollout admin
// ---------------------------------------------------------------------------

describe("connector rollouts", () => {
  it("bumps routeVersion on each change", async () => {
    const t = createTest();
    const first = await t.mutation(
      internal.connectors.rollouts.setConnectorRollout,
      { connectorId: "mockconn", mode: "shadow" },
    );
    expect(first.routeVersion).toBe(1);
    const second = await t.mutation(
      internal.connectors.rollouts.setConnectorRollout,
      { connectorId: "mockconn", mode: "first_party_only" },
    );
    expect(second.routeVersion).toBe(2);
    const read = await t.query(
      internal.connectors.rollouts.getConnectorRollout,
      { connectorId: "mockconn" },
    );
    expect(read?.mode).toBe("first_party_only");
  });
});

// ---------------------------------------------------------------------------
// Convex: first-party execution pipeline (mock provider)
// ---------------------------------------------------------------------------

const setupConnected = async (
  t: ReturnType<typeof createTest>,
  {
    scopes,
    requiredScopeGroups,
    mode,
    accessTokenExpiresAt,
  }: {
    scopes: string[];
    requiredScopeGroups: string[];
    mode: ConnectorRollout["mode"];
    accessTokenExpiresAt?: number;
  },
) => {
  const { accountId } = await commitTokens(t, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    scopes,
    accessTokenExpiresAt,
  });
  await bind(t, accountId, requiredScopeGroups);
  await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
    connectorId: "mockconn",
    mode,
  });
  return accountId;
};

const runFirstParty = (
  t: ReturnType<typeof createTest>,
  action: string,
  input: Record<string, unknown>,
  schemaJson?: string,
) =>
  t.action(internal.connectors.execute.runFirstPartyConnectorAction, {
    ownerId,
    connectorId: "mockconn",
    action,
    inputJson: JSON.stringify(input),
    schemaJson,
  });

describe("first-party execution", () => {
  it("executes a read against the fixed provider origin with the account token", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ items: [{ id: 1 }] }));

    const result = await runFirstParty(t, "MOCK_READ_ITEMS", {});
    expect(result.output).toEqual({ items: [{ id: 1 }] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mock-provider.stella.test/v1/items");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer access-1",
    );

    // Audit is metadata-only: it records the event but never the token.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("connector_audit_events")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    );
    expect(
      events.some((e) => e.event === "execution" && e.outcome === "ok"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("access-1");
  });

  it("validates input against the server schema before calling the provider", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read", "mock.write"],
      requiredScopeGroups: ["write"],
      mode: "first_party_only",
    });
    const schema = JSON.stringify({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "created-1" }));

    await expect(
      runFirstParty(t, "MOCK_CREATE_ITEM", { wrong: true }, schema),
    ).rejects.toThrow(/invalid_input/);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await runFirstParty(
      t,
      "MOCK_CREATE_ITEM",
      { title: "hi" },
      schema,
    );
    expect(ok.output).toEqual({ id: "created-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mock-provider.stella.test/v1/items");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "hi" });
  });

  it("refuses to first-party-execute a connector routed to composio", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "composio_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /route_not_first_party/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses on missing scope without contacting the provider", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["write"],
      mode: "first_party_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(runFirstParty(t, "MOCK_CREATE_ITEM", {})).rejects.toThrow(
      /missing_scope/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the global kill switch is off", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    delete process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED;
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /execution_disabled/,
    );
  });

  it("does not fall back or retry a provider error (single request)", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /provider_unavailable/,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Convex: refresh action (network) with lease + invalid_grant
// ---------------------------------------------------------------------------

describe("access token refresh", () => {
  it("refreshes an expired access token under a lease and bumps generation", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      scopes: ["mock.profile", "mock.read"],
      accessTokenExpiresAt: Date.now() - 1000,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/token")) {
        return jsonResponse({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
          scope: "mock.profile mock.read",
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    const result = await t.action(
      internal.connectors.execute.getAccessTokenForAccount,
      { accountId, requiredScopes: ["mock.profile", "mock.read"] },
    );
    expect(result.accessToken).toBe("new-access");
    expect(result.resourceOrigin).toBe("https://mock-provider.stella.test");
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.generation).toBe(2);
    expect(cred?.refreshLeaseId).toBeUndefined();
  });

  it("marks the account reauth_required on invalid_grant", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      scopes: ["mock.read"],
      accessTokenExpiresAt: Date.now() - 1000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    await expect(
      t.action(internal.connectors.execute.getAccessTokenForAccount, {
        accountId,
        requiredScopes: ["mock.read"],
      }),
    ).rejects.toThrow(/reauth_required/);
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("reauth_required");
  });
});

// ---------------------------------------------------------------------------
// Convex: hosted callback end-to-end (mock provider)
// ---------------------------------------------------------------------------

describe("hosted OAuth callback", () => {
  it("connects an account end-to-end and rejects state replay", async () => {
    const t = createTest();
    const start = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      { connectorId: "mockconn", provider: "mock", scopeGroupIds: ["read"] },
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(start.authorizationUrl).toContain(
      "mock-provider.stella.test/authorize",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return jsonResponse({
          access_token: "cb-access",
          token_type: "Bearer",
          refresh_token: "cb-refresh",
          expires_in: 3600,
          scope: "mock.profile mock.read",
        });
      }
      if (u.endsWith("/userinfo")) {
        return jsonResponse({ sub: "mock-sub", email: "u@example.com" });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const cb = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "auth-code" },
    );
    expect(cb.status).toBe("succeeded");

    const status = await asOwner(t).query(
      api.connectors.oauth.attempts.getConnectAttemptStatus,
      { attemptId: start.attemptId },
    );
    expect(status?.status).toBe("succeeded");

    const conn = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(conn.connected).toBe(true);
    expect(conn.displayEmail).toBe("u@example.com");

    // Replaying the same state is rejected.
    const replay = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "auth-code" },
    );
    expect(replay.status).toBe("invalid");
  });

  it("binds one Microsoft grant to every scope-satisfied family connector", async () => {
    const t = createTest();
    const start = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      { connectorId: "outlook", provider: "microsoft" },
    );
    const authorizationUrl = new URL(start.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state")!;
    expect(authorizationUrl.searchParams.get("scope")).toContain(
      "ChannelMessage.Read.All",
    );

    const manifest = getProviderManifest("microsoft")!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/token")) {
        return jsonResponse({
          access_token: "microsoft-access",
          token_type: "Bearer",
          refresh_token: "microsoft-refresh",
          expires_in: 3600,
          scope: scopesForGroups(manifest, ["microsoft_all"]).join(" "),
        });
      }
      if (parsed.pathname === "/v1.0/me") {
        return jsonResponse({
          id: "entra-object-id",
          displayName: "Stella Test",
          mail: "contact@fromyou.ai",
          userPrincipalName: "contact@fromyou.ai",
        });
      }
      throw new Error(`unexpected fetch ${parsed.origin}${parsed.pathname}`);
    });

    const callback = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "microsoft-code" },
    );
    expect(callback.status).toBe("succeeded");
    for (const connectorId of ["outlook", "microsoft_teams", "excel"]) {
      const status = await asOwner(t).query(
        api.connectors.oauth.accounts.getConnectorConnectionStatus,
        { connectorId },
      );
      expect(status.connected, connectorId).toBe(true);
      expect(status.provider).toBe("microsoft");
      expect(status.displayEmail).toBe("contact@fromyou.ai");
    }
  });

  it("records a denied outcome when the provider returns an error", async () => {
    const t = createTest();
    const start = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      { connectorId: "mockconn", provider: "mock", scopeGroupIds: ["read"] },
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const cb = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, error: "access_denied" },
    );
    expect(cb.status).toBe("denied");
    expect(cb.errorCode).toBe("consent_denied");
  });

  it("rejects an unregistered scope group at connect-start", async () => {
    const t = createTest();
    await expect(
      asOwner(t).mutation(api.connectors.oauth.connect.startConnectAttempt, {
        connectorId: "mockconn",
        provider: "mock",
        scopeGroupIds: ["does-not-exist"],
      }),
    ).rejects.toThrow(/unregistered_scope/);
  });
});

// ---------------------------------------------------------------------------
// Convex: Composio path stays authoritative under rollout
// ---------------------------------------------------------------------------

describe("composio path under rollout", () => {
  const inputSchema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
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
          title: "Query",
          inputSchemaJson: JSON.stringify(inputSchema),
        },
        {
          name: "OUTLOOK_LIST_MESSAGES",
          title: "List messages",
          inputSchemaJson: JSON.stringify({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
        },
      ],
      description: "Connect Outlook to Stella.",
      connector: { type: "composio", toolkit: "outlook", provider: "composio" },
      enabled: true,
      usagePolicy: "ready",
    });

  const connectFirstPartyOutlook = async (t: ReturnType<typeof createTest>) => {
    const committed = await t.mutation(
      internal.connectors.oauth.vault.commitProviderAccountTokens,
      {
        ownerId,
        provider: "microsoft",
        providerAccountId: "entra-object-id",
        displayEmail: "contact@fromyou.ai",
        incoming: {
          accessToken: "microsoft-access",
          refreshToken: "microsoft-refresh",
          tokenType: "Bearer",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: scopesForGroups(getProviderManifest("microsoft")!, [
            "outlook",
          ]),
        },
      },
    );
    await t.mutation(internal.connectors.oauth.accounts.setConnectorBinding, {
      ownerId,
      connectorId: "outlook",
      provider: "microsoft",
      accountId: committed.accountId,
      requiredScopeGroups: ["outlook"],
    });
  };

  it("keeps Composio status authoritative while exposing missing first-party scopes", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "composio-key";
    await publishOutlook(t);
    const committed = await t.mutation(
      internal.connectors.oauth.vault.commitProviderAccountTokens,
      {
        ownerId,
        provider: "microsoft",
        providerAccountId: "partial-entra-object-id",
        displayEmail: "contact@fromyou.ai",
        incoming: {
          accessToken: "partial-microsoft-access",
          refreshToken: "partial-microsoft-refresh",
          tokenType: "Bearer",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: scopesForGroups(getProviderManifest("microsoft")!, [
            "identity",
          ]),
        },
      },
    );
    await t.mutation(internal.connectors.oauth.accounts.setConnectorBinding, {
      ownerId,
      connectorId: "outlook",
      provider: "microsoft",
      accountId: committed.accountId,
      requiredScopeGroups: ["outlook"],
    });
    await t.mutation(internal.data.integrations.upsertUserIntegrationForOwner, {
      ownerId,
      provider: "outlook",
      mode: "composio",
      externalId: "status-composio-session",
      config: {},
    });
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_preferred",
      allowedFallbacks: ["composio"],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [
          {
            slug: "outlook",
            connected_account: { status: "ACTIVE" },
          },
        ],
      }),
    );

    const response = await asOwner(t).fetch(
      "/api/native-integrations/status?id=outlook",
      { method: "GET" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: true,
      executor: "composio",
      firstParty: {
        provider: "microsoft",
        accountStatus: "active",
        missingScopeGroups: ["outlook"],
      },
    });
  });

  it("runs a ready Microsoft read through Graph and keeps the Composio envelope", async () => {
    const t = createTest();
    await publishOutlook(t);
    await connectFirstPartyOutlook(t);
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_preferred",
    });
    const connection = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "outlook" },
    );
    expect(connection.connected, JSON.stringify(connection)).toBe(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ value: [{ id: "message-1" }] }));

    const response = await asOwner(t).fetch("/api/native-integrations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "outlook",
        action: "OUTLOOK_LIST_MESSAGES",
        input: {},
      }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      data: { value: [{ id: "message-1" }] },
      error: null,
      successful: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
    );
  });

  it("does not retry a failed first-party Outlook write through Composio", async () => {
    const t = createTest();
    await t.mutation(internal.data.integrations.upsertPublicIntegration, {
      id: "outlook",
      name: "Outlook",
      provider: "composio",
      category: "email",
      auth: ["OAUTH2"],
      catalogToolCount: 1,
      actions: [
        {
          name: "OUTLOOK_SEND_EMAIL",
          title: "Send",
          inputSchemaJson: JSON.stringify({
            type: "object",
            properties: {
              to: { type: "string" },
              body: { type: "string" },
              subject: { type: "string" },
            },
            required: ["to", "body", "subject"],
            additionalProperties: false,
          }),
        },
      ],
      description: "Connect Outlook to Stella.",
      connector: {
        type: "composio",
        toolkit: "outlook",
        provider: "composio",
      },
      enabled: true,
      usagePolicy: "ready",
    });
    await connectFirstPartyOutlook(t);
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_preferred",
      allowedFallbacks: ["composio"],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "provider unavailable" }, 503));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await asOwner(t).fetch("/api/native-integrations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "outlook",
        action: "OUTLOOK_SEND_EMAIL",
        input: {
          to: "person@example.com",
          body: "Hello",
          subject: "Hello",
        },
      }),
    });
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://graph.microsoft.com/v1.0/me/sendMail",
    );
  });

  it("falls back to a Composio connect link when preferred first-party setup is unavailable", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "composio-key";
    delete process.env.STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_ID;
    await publishOutlook(t);
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_preferred",
      allowedFallbacks: ["composio"],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/session")) {
          return jsonResponse({ id: "session-fallback" });
        }
        if (url.endsWith("/session/session-fallback/link")) {
          return jsonResponse({ link: "https://composio.test/connect" });
        }
        return jsonResponse({}, 500);
      });

    const response = await asOwner(t).fetch(
      "/api/native-integrations/connect-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "outlook" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://composio.test/connect",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses the composio run path once a connector is first_party_only", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "test-key";
    await publishOutlook(t);
    await t.mutation(internal.data.integrations.upsertUserIntegrationForOwner, {
      ownerId,
      provider: "outlook",
      mode: "composio",
      externalId: "existing-composio-session",
      config: {},
    });
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await asOwner(t).fetch("/api/native-integrations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "outlook",
        action: "OUTLOOK_QUERY_EMAILS",
        input: { q: "hi" },
      }),
    });
    expect(response.status).toBe(409);
    // Composio was never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the composio path untouched for connectors without a first-party rollout", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "test-key";
    await publishOutlook(t);
    // No rollout row -> default composio_only -> connect-link proceeds to Composio.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "sess_new" }));
    const response = await asOwner(t).fetch(
      "/api/native-integrations/connect-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "outlook" }),
      },
    );
    // Reaches Composio (session creation) rather than being refused by the guard.
    expect(fetchMock).toHaveBeenCalled();
    expect(response.status).not.toBe(409);
  });
});

// Sanity: ConnectorError shape is preserved for downstream mapping.
describe("ConnectorError", () => {
  it("carries a stable code and retryable flag", () => {
    const err = new ConnectorError("provider_rate_limited", true);
    expect(err.code).toBe("provider_rate_limited");
    expect(err.retryable).toBe(true);
  });
});
