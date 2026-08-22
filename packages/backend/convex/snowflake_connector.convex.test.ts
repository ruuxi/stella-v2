/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import Ajv from "ajv";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ConnectorError } from "./connectors/errors";
import {
  buildSnowflakeRequestPlan,
  executeSnowflakeStatement,
  fetchSnowflakeProviderIdentity,
  normalizeSnowflakeAccountOrigin,
  SNOWFLAKE_ACTION_SCHEMAS,
  snowflakeAccountEndpoints,
  validateSnowflakeStatusUrl,
} from "./connectors/snowflake";
import {
  getProviderManifest,
  requireEnabledProvider,
  resolveProviderManifestForAccount,
} from "./connectors/oauth/providers";
import {
  parseSnowflakeTenantRegistrations,
  resolveProviderClientCredentials,
} from "./connectors/oauth/client_credentials";
import {
  firstPartyActionBelongsToConnector,
  firstPartyActionInputSchema,
  firstPartyActionOperation,
  firstPartyActionRequiredScopes,
  firstPartyProviderForConnectorAction,
} from "./connectors/executors/first_party";
import { buildOAuthProviderReadiness } from "./http_routes/native_oauth";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|snowflake-owner";
const ORIGIN = "https://acme-prod.snowflakecomputing.com";
const OTHER_ORIGIN = "https://other-prod.snowflakecomputing.com";
const STATEMENT_HANDLE = "01b12345-0604-abcd-0000-1234567890ab";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "snowflake-owner",
    tokenIdentifier: ownerId,
  });

const key = (offset: number) =>
  btoa(
    String.fromCharCode(
      ...Array.from({ length: 32 }, (_, index) => (index * 11 + offset) & 0xff),
    ),
  );

const MASTER_KEY_1 = key(7);
const MASTER_KEY_2 = key(19);

const tenantRegistrations = (activeVersion = 1) =>
  JSON.stringify({
    "acme-prod.snowflakecomputing.com": {
      clientId: "snowflake-client",
      activeVersion,
      secrets: {
        "1": "snowflake-client-secret-v1",
        "2": "snowflake-client-secret-v2",
      },
    },
  });

const setConnectorEnv = () => {
  process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({
    "1": MASTER_KEY_1,
    "2": MASTER_KEY_2,
  });
  process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
  process.env.STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL =
    "https://connect.stella.test";
  process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "snowflake";
  process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "1";
  process.env.SNOWFLAKE_OAUTH_TENANTS_JSON = tenantRegistrations();
};

beforeEach(setConnectorEnv);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const successfulStatement = (data: unknown[][] = [[1]]) => ({
  statementHandle: STATEMENT_HANDLE,
  data,
  resultSetMetaData: { partitionInfo: [{ rowCount: data.length }] },
});

type FetchCall = [RequestInfo | URL, RequestInit?];
const fetchCalls = (mock: unknown): FetchCall[] =>
  (mock as { mock: { calls: FetchCall[] } }).mock.calls;

describe("Snowflake account origin and OAuth registration", () => {
  it("normalizes only exact HTTPS origins under snowflakecomputing.com", () => {
    expect(
      normalizeSnowflakeAccountOrigin(
        "  HTTPS://ACME-PROD.SNOWFLAKECOMPUTING.COM:443/  ",
      ),
    ).toBe(ORIGIN);
    expect(
      normalizeSnowflakeAccountOrigin(
        "https://org-account.us-east-1.aws.snowflakecomputing.com",
      ),
    ).toBe("https://org-account.us-east-1.aws.snowflakecomputing.com");

    for (const candidate of [
      "https://snowflakecomputing.com",
      "https://evil.test",
      "https://account.snowflakecomputing.com.evil.test",
      "https://evilsnowflakecomputing.com",
      "http://account.snowflakecomputing.com",
      "https://account.snowflakecomputing.com:8443",
      "https://account.snowflakecomputing.com/api/v2/statements",
      "https://account.snowflakecomputing.com?next=https://evil.test",
      "https://account.snowflakecomputing.com#fragment",
      "https://user:password@account.snowflakecomputing.com",
      "https://-account.snowflakecomputing.com",
      "https://account..snowflakecomputing.com",
      `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(42)}.snowflakecomputing.com`,
    ]) {
      expect(
        () => normalizeSnowflakeAccountOrigin(candidate),
        candidate,
      ).toThrowError(/invalid_input/);
    }
  });

  it("derives every OAuth and SQL endpoint from the one validated origin", () => {
    expect(snowflakeAccountEndpoints(ORIGIN)).toEqual({
      origin: ORIGIN,
      authorizationEndpoint: `${ORIGIN}/oauth/authorize`,
      tokenEndpoint: `${ORIGIN}/oauth/token-request`,
      refreshEndpoint: `${ORIGIN}/oauth/token-request`,
    });
    const base = getProviderManifest("snowflake")!;
    const resolved = resolveProviderManifestForAccount(base, ORIGIN);
    expect(resolved.apiOrigin).toBe(ORIGIN);
    expect(resolved.authorizationEndpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(resolved.tokenEndpoint).toBe(`${ORIGIN}/oauth/token-request`);
    expect(
      resolveProviderManifestForAccount(
        getProviderManifest("microsoft")!,
        ORIGIN,
      ),
    ).toBe(getProviderManifest("microsoft"));
  });

  it("uses an exact-host, versioned tenant registration and rejects aliases", () => {
    const registrations = parseSnowflakeTenantRegistrations(
      tenantRegistrations(2),
    );
    expect([...registrations.keys()]).toEqual([
      "acme-prod.snowflakecomputing.com",
    ]);
    process.env.SNOWFLAKE_OAUTH_TENANTS_JSON = tenantRegistrations(2);
    expect(
      resolveProviderClientCredentials("snowflake", undefined, ORIGIN),
    ).toEqual({
      clientId: "snowflake-client",
      clientSecret: "snowflake-client-secret-v2",
      clientSecretVersion: 2,
    });
    expect(resolveProviderClientCredentials("snowflake", 1, ORIGIN)).toEqual({
      clientId: "snowflake-client",
      clientSecret: "snowflake-client-secret-v1",
      clientSecretVersion: 1,
    });
    expect(() =>
      resolveProviderClientCredentials("snowflake", undefined, OTHER_ORIGIN),
    ).toThrowError(/provider_not_configured/);
    expect(() =>
      parseSnowflakeTenantRegistrations(
        JSON.stringify({
          "ACME-PROD.SNOWFLAKECOMPUTING.COM": {
            clientId: "one",
            activeVersion: 1,
            secrets: { "1": "one" },
          },
        }),
      ),
    ).toThrowError(/provider_not_configured/);
    expect(() =>
      parseSnowflakeTenantRegistrations(
        JSON.stringify({
          "ACME-PROD.SNOWFLAKECOMPUTING.COM": {
            clientId: "one",
            activeVersion: 1,
            secrets: { "1": "one" },
          },
          "acme-prod.snowflakecomputing.com": {
            clientId: "two",
            activeVersion: 1,
            secrets: { "1": "two" },
          },
        }),
      ),
    ).toThrowError(/provider_not_configured/);
  });

  it("reports executor code readiness without permitting activation", async () => {
    const readiness = buildOAuthProviderReadiness().find(
      (provider) => provider.id === "snowflake",
    );
    expect(readiness).toMatchObject({
      accountBound: true,
      configured: true,
      enabled: true,
      executorRegistered: true,
      executionEnabled: true,
      verificationStatus: "unverified",
      connectReady: false,
      externalCallbackReady: false,
    });
    expect(readiness?.blockers).toEqual(["verification_incomplete"]);
    expect(() => requireEnabledProvider("snowflake")).toThrowError(
      /provider_unverified/,
    );
    await expect(
      asOwner(createTest()).mutation(
        api.connectors.oauth.connect.startConnectAttempt,
        {
          connectorId: "snowflake",
          provider: "snowflake",
          accountOrigin: ORIGIN,
        },
      ),
    ).rejects.toThrow(/provider_unverified/);
  });
});

describe("Snowflake fixed request plans and schemas", () => {
  it("keeps action ownership, scope, operation, and schema server-authoritative", () => {
    for (const [action, operation] of Object.entries({
      SNOWFLAKE_LIST_DATABASES: "read",
      SNOWFLAKE_DESCRIBE_TABLE: "read",
      SNOWFLAKE_EXECUTE_SQL_QUERY: "write",
    })) {
      expect(firstPartyProviderForConnectorAction("snowflake", action)).toBe(
        "snowflake",
      );
      expect(
        firstPartyActionBelongsToConnector("snowflake", "snowflake", action),
      ).toBe(true);
      expect(firstPartyActionOperation("snowflake", action)).toBe(operation);
      expect(firstPartyActionRequiredScopes("snowflake", action)).toEqual([
        "session:role-any",
      ]);
      expect(firstPartyActionInputSchema("snowflake", action)).toBe(
        SNOWFLAKE_ACTION_SCHEMAS[
          action as keyof typeof SNOWFLAKE_ACTION_SCHEMAS
        ],
      );
    }
  });

  it("uses fixed SQL for metadata actions and binds table identifiers", () => {
    expect(buildSnowflakeRequestPlan("SNOWFLAKE_LIST_DATABASES", {})).toEqual({
      operation: "read",
      method: "POST",
      path: "/api/v2/statements/",
      body: { statement: "SHOW DATABASES" },
    });
    expect(
      buildSnowflakeRequestPlan("SNOWFLAKE_DESCRIBE_TABLE", {
        table: 'DB.SCHEMA.T; DROP TABLE "USERS"',
        warehouse: "REPORTING_WH",
      }),
    ).toEqual({
      operation: "read",
      method: "POST",
      path: "/api/v2/statements/",
      body: {
        statement: "DESCRIBE TABLE IDENTIFIER(?)",
        warehouse: "REPORTING_WH",
        bindings: {
          "1": { type: "TEXT", value: 'DB.SCHEMA.T; DROP TABLE "USERS"' },
        },
      },
    });
    expect(
      buildSnowflakeRequestPlan("SNOWFLAKE_EXECUTE_SQL_QUERY", {
        statement: "UPDATE DATA.PUBLIC.JOBS SET DONE = TRUE WHERE ID = 1",
        timeout: 20,
      }),
    ).toEqual({
      operation: "write",
      method: "POST",
      path: "/api/v2/statements/",
      body: {
        statement: "UPDATE DATA.PUBLIC.JOBS SET DONE = TRUE WHERE ID = 1",
        timeout: 20,
      },
    });
    expect(() =>
      buildSnowflakeRequestPlan("SNOWFLAKE_LIST_DATABASES", {
        statement: "select current_user()",
      }),
    ).toThrowError(/invalid_input/);
  });

  it("publishes strict schemas that match the planner's accepted inputs", () => {
    const ajv = new Ajv({ strict: true });
    const list = ajv.compile(SNOWFLAKE_ACTION_SCHEMAS.SNOWFLAKE_LIST_DATABASES);
    const describe = ajv.compile(
      SNOWFLAKE_ACTION_SCHEMAS.SNOWFLAKE_DESCRIBE_TABLE,
    );
    const execute = ajv.compile(
      SNOWFLAKE_ACTION_SCHEMAS.SNOWFLAKE_EXECUTE_SQL_QUERY,
    );
    expect(list({})).toBe(true);
    expect(list({ extra: true })).toBe(false);
    expect(describe({ table: "DB.SCHEMA.TABLE", warehouse: "WH" })).toBe(true);
    expect(describe({ table: "DB.SCHEMA.TABLE", extra: true })).toBe(false);
    expect(execute({ statement: "select 1", timeout: 1 })).toBe(true);
    expect(execute({ statement: "", timeout: 0 })).toBe(false);
  });
});

describe("Snowflake SQL API v2 executor", () => {
  it("submits once with OAuth headers, a UUID request id, and redirect refusal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successfulStatement()));
    const result = await executeSnowflakeStatement({
      accountOrigin: ORIGIN,
      accessToken: "access-token-do-not-return",
      body: { statement: "UPDATE T SET V = 1" },
      maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual(successfulStatement());
    expect(JSON.stringify(result)).not.toContain("access-token-do-not-return");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchCalls(fetchImpl)[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/api/v2/statements/");
    expect(url.searchParams.get("requestId")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer access-token-do-not-return",
    );
    expect(
      (init?.headers as Record<string, string>)[
        "x-snowflake-authorization-token-type"
      ],
    ).toBe("OAUTH");
  });

  it("never follows provider-returned cross-origin status URLs", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          statementHandle: STATEMENT_HANDLE,
          statementStatusUrl: `https://attacker.test/api/v2/statements/${STATEMENT_HANDLE}`,
        },
        202,
      ),
    );
    await expect(
      executeSnowflakeStatement({
        accountOrigin: ORIGIN,
        accessToken: "sensitive-token",
        body: { statement: "select 1" },
        maxResponseBytes: 64 * 1024,
        requestTimeoutMs: 5_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "normalization_error" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(fetchCalls(fetchImpl)[0]![0])).origin).toBe(ORIGIN);
  });

  it("polls a submitted handle through bounded 429s without replaying the POST", async () => {
    const responses = [
      jsonResponse(
        {
          statementHandle: STATEMENT_HANDLE,
          statementStatusUrl: `${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}`,
        },
        202,
      ),
      jsonResponse({ code: "333334", message: "query not complete" }, 429),
      jsonResponse(successfulStatement([["done"]])),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const result = await executeSnowflakeStatement({
      accountOrigin: ORIGIN,
      accessToken: "access-token",
      body: { statement: "select system$wait(1)" },
      maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.data).toEqual([["done"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchCalls(fetchImpl).filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    for (const [rawUrl, init] of fetchCalls(fetchImpl)) {
      expect(new URL(String(rawUrl)).origin).toBe(ORIGIN);
      expect(init?.redirect).toBe("error");
    }
  });

  it("does not automatically retry a failed write submission", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: "server_error" }, 503),
    );
    await expect(
      executeSnowflakeStatement({
        accountOrigin: ORIGIN,
        accessToken: "access-token",
        body: { statement: "DELETE FROM T" },
        maxResponseBytes: 64 * 1024,
        requestTimeoutMs: 5_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchCalls(fetchImpl)[0]![1]?.method).toBe("POST");
  });

  it("fetches only bounded same-account result partitions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          statementHandle: STATEMENT_HANDLE,
          statementStatusUrl: `${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}`,
          data: [["p0"]],
          resultSetMetaData: {
            partitionInfo: [{}, {}, {}],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [["p1"]] }))
      .mockResolvedValueOnce(jsonResponse({ data: [["p2"]] }));
    const result = await executeSnowflakeStatement({
      accountOrigin: ORIGIN,
      accessToken: "access-token",
      body: { statement: "select * from large_table" },
      maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.data).toEqual([["p0"], ["p1"], ["p2"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      new URL(String(fetchCalls(fetchImpl)[1]![0])).searchParams.get(
        "partition",
      ),
    ).toBe("1");
    expect(
      new URL(String(fetchCalls(fetchImpl)[2]![0])).searchParams.get(
        "partition",
      ),
    ).toBe("2");

    const oversized = vi.fn(async () =>
      jsonResponse(successfulStatement(), 200, { "content-length": "2048" }),
    );
    await expect(
      executeSnowflakeStatement({
        accountOrigin: ORIGIN,
        accessToken: "access-token",
        body: { statement: "select 1" },
        maxResponseBytes: 1024,
        requestTimeoutMs: 5_000,
        fetchImpl: oversized as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("accepts only the exact statement-handle status path", () => {
    expect(
      validateSnowflakeStatusUrl(
        ORIGIN,
        STATEMENT_HANDLE,
        `${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}?requestId=test`,
      ),
    ).toBe(`${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}`);
    for (const candidate of [
      `${OTHER_ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}`,
      `${ORIGIN}/api/v2/statements/other-handle`,
      `${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}/results`,
      `${ORIGIN}/api/v2/statements/${STATEMENT_HANDLE}?target=evil`,
    ]) {
      expect(() =>
        validateSnowflakeStatusUrl(ORIGIN, STATEMENT_HANDLE, candidate),
      ).toThrowError(/normalization_error/);
    }
  });

  it("derives account and user identity through a bounded account-local query", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(successfulStatement([["XY12345", "STELLA_USER"]])),
    );
    await expect(
      fetchSnowflakeProviderIdentity({
        accountOrigin: ORIGIN,
        accessToken: "access-token",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      id: "acme-prod.snowflakecomputing.com:XY12345:STELLA_USER",
      accountLocator: "XY12345",
      userName: "STELLA_USER",
      displayName: "STELLA_USER @ acme-prod.snowflakecomputing.com",
    });
    const body = JSON.parse(String(fetchCalls(fetchImpl)[0]![1]?.body));
    expect(body.statement).toBe(
      "SELECT CURRENT_ACCOUNT() AS ACCOUNT_LOCATOR, CURRENT_USER() AS USER_NAME",
    );
  });
});

const commitSnowflakeTokens = async (
  t: ReturnType<typeof createTest>,
  suffix: string,
  accessTokenExpiresAt = Date.now() + 3_600_000,
) =>
  await t.mutation(
    internal.connectors.oauth.vault.commitProviderAccountTokens,
    {
      ownerId,
      provider: "snowflake",
      providerAccountId: `acme-prod.snowflakecomputing.com:XY12345:${suffix}`,
      tenantId: "XY12345",
      accountOrigin: ORIGIN,
      displayLabel: `${suffix} @ acme-prod.snowflakecomputing.com`,
      registrationVersion: 1,
      incoming: {
        accessToken: `access-${suffix}-token`,
        refreshToken: `refresh-${suffix}-token`,
        tokenType: "Bearer",
        accessTokenExpiresAt,
        scopes: ["session:role-any"],
        resourceOrigin: ORIGIN,
      },
    },
  );

describe("Snowflake OAuth persistence lifecycle", () => {
  beforeEach(() => {
    getProviderManifest("snowflake")!.verificationStatus = "verified";
  });

  afterEach(() => {
    getProviderManifest("snowflake")!.verificationStatus = "unverified";
  });

  it("persists only the canonical account origin", async () => {
    const t = createTest();
    const nonCanonicalOrigin = "HTTPS://ACME-PROD.SNOWFLAKECOMPUTING.COM:443/";
    const { accountId } = await t.mutation(
      internal.connectors.oauth.vault.commitProviderAccountTokens,
      {
        ownerId,
        provider: "snowflake",
        providerAccountId:
          "acme-prod.snowflakecomputing.com:XY12345:CANONICAL_USER",
        accountOrigin: nonCanonicalOrigin,
        incoming: {
          accessToken: "canonical-access-token",
          refreshToken: "canonical-refresh-token",
          accessTokenExpiresAt: Date.now() + 60_000,
          scopes: ["session:role-any", "refresh_token"],
          resourceOrigin: nonCanonicalOrigin,
        },
      },
    );
    const account = await t.run(async (ctx) => await ctx.db.get(accountId));
    expect(account?.accountOrigin).toBe(ORIGIN);
  });

  it("binds origin before callback, encrypts tokens, rotates, disconnects, and deletes", async () => {
    const t = createTest();
    const started = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      {
        connectorId: "snowflake",
        provider: "snowflake",
        accountOrigin: ORIGIN,
        returnSurface: "desktop",
      },
    );
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe(ORIGIN);
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "session:role-any refresh_token",
    );
    const state = authorizationUrl.searchParams.get("state")!;

    const attemptBeforeCallback = await t.run(
      async (ctx) => await ctx.db.get(started.attemptId),
    );
    expect(attemptBeforeCallback?.accountOrigin).toBe(ORIGIN);
    expect(attemptBeforeCallback?.clientSecretVersion).toBe(1);
    expect(attemptBeforeCallback?.encryptedVerifier).not.toContain(state);

    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        expect(url.origin).toBe(ORIGIN);
        expect(init?.redirect).toBe("error");
        if (url.pathname === "/oauth/token-request") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("snowflake-client");
          expect(body.get("client_secret")).toBe("snowflake-client-secret-v1");
          expect(body.get("code_verifier")).toBeTruthy();
          return jsonResponse({
            access_token: "access-callback-token",
            refresh_token: "refresh-callback-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "session:role-any refresh_token",
            instance_url: "https://attacker.test",
          });
        }
        expect(url.pathname).toBe("/api/v2/statements/");
        return jsonResponse(
          successfulStatement([["XY12345", "CALLBACK_USER"]]),
        );
      });

    const callback = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "one-time-code" },
    );
    expect(callback.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const stored = await t.run(async (ctx) => {
      const account = await ctx.db
        .query("oauth_provider_accounts")
        .withIndex("by_ownerId_and_provider_and_updatedAt", (q) =>
          q.eq("ownerId", ownerId).eq("provider", "snowflake"),
        )
        .unique();
      const credential = account
        ? await ctx.db
            .query("oauth_credentials")
            .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
            .unique()
        : null;
      const binding = await ctx.db
        .query("connector_account_bindings")
        .withIndex("by_ownerId_and_connectorId", (q) =>
          q.eq("ownerId", ownerId).eq("connectorId", "snowflake"),
        )
        .unique();
      return { account, credential, binding };
    });
    expect(stored.account).toMatchObject({
      tenantId: "XY12345",
      accountOrigin: ORIGIN,
      grantedScopes: ["session:role-any", "refresh_token"],
      status: "active",
    });
    expect(stored.binding?.requiredScopeGroups).toEqual(["sql"]);
    expect(stored.credential?.encryptedTokenSet).not.toContain(
      "access-callback-token",
    );
    expect(stored.credential?.encryptedTokenSet).not.toContain(
      "refresh-callback-token",
    );
    expect(stored.credential?.keyVersion).toBe(1);

    const publicAccounts = await asOwner(t).query(
      api.connectors.oauth.accounts.listConnectorAccounts,
      {},
    );
    expect(publicAccounts).toHaveLength(1);
    expect(Object.keys(publicAccounts[0]!)).not.toContain("accountOrigin");
    expect(JSON.stringify(publicAccounts)).not.toContain("callback-token");

    process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "2";
    const rotation = await t.mutation(
      internal.connectors.oauth.vault.rotateConnectorCredentialsBatch,
      { batchSize: 10 },
    );
    expect(rotation).toMatchObject({
      activeKeyVersion: 2,
      rotated: 1,
      failed: 0,
    });
    const decryptedAfterRotation = await t.run(async (ctx) => {
      const { decryptSecret } = await import("./data/secrets_crypto");
      const { parseTokenSet } = await import("./connectors/oauth/token_set");
      const row = await ctx.db
        .query("oauth_credentials")
        .withIndex("by_accountId", (q) =>
          q.eq("accountId", stored.account!._id),
        )
        .unique();
      return {
        keyVersion: row?.keyVersion,
        tokenSet: parseTokenSet(await decryptSecret(row!.encryptedTokenSet)),
      };
    });
    expect(decryptedAfterRotation.keyVersion).toBe(2);
    expect(decryptedAfterRotation.tokenSet.refreshToken).toBe(
      "refresh-callback-token",
    );

    const disconnected = await asOwner(t).action(
      api.connectors.oauth.accounts.disconnectConnectorAccount,
      { accountId: stored.account!._id },
    );
    expect(disconnected).toEqual({ revoked: true, providerRevoked: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const tombstone = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId: stored.account!._id },
    );
    expect(tombstone).toMatchObject({
      accountStatus: "revoked",
      credentialStatus: "revoked",
      encryptedTokenSet: "",
      keyVersion: 0,
    });

    for (const table of [
      "oauth_credentials",
      "connector_account_bindings",
      "oauth_connect_attempts",
      "connector_audit_events",
      "oauth_provider_accounts",
    ] as const) {
      await t.mutation(internal.account_deletion._deleteExtraTableBatch, {
        ownerId,
        table,
      });
    }
    const remaining = await t.run(async (ctx) => ({
      attempts: await ctx.db
        .query("oauth_connect_attempts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
      accounts: await ctx.db
        .query("oauth_provider_accounts")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
      credentials: await ctx.db
        .query("oauth_credentials")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .collect(),
      audits: await ctx.db
        .query("connector_audit_events")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    }));
    expect(remaining).toEqual({
      attempts: [],
      accounts: [],
      credentials: [],
      audits: [],
    });
  });

  it("refreshes only through the persisted account token endpoint", async () => {
    const t = createTest();
    const { accountId } = await commitSnowflakeTokens(
      t,
      "REFRESH_USER",
      Date.now() - 60_000,
    );
    process.env.SNOWFLAKE_OAUTH_TENANTS_JSON = tenantRegistrations(2);
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (rawUrl, init) => {
        expect(String(rawUrl)).toBe(`${ORIGIN}/oauth/token-request`);
        expect(init?.redirect).toBe("error");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-REFRESH_USER-token");
        expect(body.get("client_secret")).toBe("snowflake-client-secret-v2");
        return jsonResponse({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "session:role-any",
          instance_url: "https://attacker.test",
        });
      });
    await expect(
      t.action(internal.connectors.execute.getAccessTokenForAccount, {
        accountId,
        requiredScopes: ["session:role-any"],
      }),
    ).resolves.toEqual({
      accessToken: "rotated-access-token",
      resourceOrigin: ORIGIN,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects persisted account/token origin mismatch before any fetch", async () => {
    const t = createTest();
    const { accountId } = await commitSnowflakeTokens(t, "MISMATCH_USER");
    await t.run(async (ctx) => {
      await ctx.db.patch(accountId, { accountOrigin: OTHER_ORIGIN });
    });
    const fetchImpl = vi.spyOn(globalThis, "fetch");
    await expect(
      t.action(internal.connectors.execute.getAccessTokenForAccount, {
        accountId,
        requiredScopes: ["session:role-any"],
      }),
    ).rejects.toThrow(/account_mismatch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to commit a refreshed token for a different account origin", async () => {
    const t = createTest();
    const { accountId } = await commitSnowflakeTokens(t, "REFRESH_MISMATCH");
    const leaseId = "snowflake-refresh-lease";
    await expect(
      t.mutation(internal.connectors.oauth.vault.claimRefreshLease, {
        accountId,
        expectedGeneration: 1,
        leaseId,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      t.mutation(internal.connectors.oauth.vault.commitRefreshedTokens, {
        accountId,
        expectedGeneration: 1,
        leaseId,
        incoming: {
          accessToken: "cross-account-access-token",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: ["session:role-any"],
          resourceOrigin: OTHER_ORIGIN,
        },
      }),
    ).rejects.toThrow(/account_mismatch/);
  });

  it("fails callback identity polling on a cross-origin status URL", async () => {
    const t = createTest();
    const started = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      {
        connectorId: "snowflake",
        provider: "snowflake",
        accountOrigin: ORIGIN,
      },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (rawUrl) => {
        const url = new URL(String(rawUrl));
        if (url.pathname === "/oauth/token-request") {
          return jsonResponse({
            access_token: "access-token",
            refresh_token: "refresh-token",
            scope: "session:role-any",
          });
        }
        expect(url.origin).toBe(ORIGIN);
        return jsonResponse(
          {
            statementHandle: STATEMENT_HANDLE,
            statementStatusUrl: `https://attacker.test/api/v2/statements/${STATEMENT_HANDLE}`,
          },
          202,
        );
      });
    const callback = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "one-time-code" },
    );
    expect(callback).toMatchObject({
      status: "failed",
      errorCode: "normalization_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [rawUrl] of fetchCalls(fetchImpl)) {
      expect(new URL(String(rawUrl)).origin).toBe(ORIGIN);
    }
    const accounts = await t.run(
      async (ctx) =>
        await ctx.db
          .query("oauth_provider_accounts")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .collect(),
    );
    expect(accounts).toEqual([]);
  });

  it("rejects a callback that does not issue the required refresh token", async () => {
    const t = createTest();
    const started = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      {
        connectorId: "snowflake",
        provider: "snowflake",
        accountOrigin: ORIGIN,
      },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        access_token: "short-lived-access-token",
        scope: "session:role-any",
      }),
    );

    await expect(
      t.action(internal.connectors.oauth.callback.handleOAuthCallback, {
        state,
        code: "one-time-code",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "code_exchange_failed",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      `${ORIGIN}/oauth/token-request`,
    );
  });
});
