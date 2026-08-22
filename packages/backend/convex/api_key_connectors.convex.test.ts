/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  API_KEY_PROVIDER_DESCRIPTORS,
  getApiKeyProviderDescriptor,
  requireReadyApiKeyProvider,
  validateApiKeyCredential,
  validateApiKeyProviderDescriptors,
} from "./connectors/api_keys/providers";
import {
  buildAuthenticatedApiKeyRequest,
  executeApiKeyProviderAction,
  redactApiKeyMaterial,
} from "./connectors/api_keys/execute";
import { ConnectorError } from "./connectors/errors";
import {
  firstPartyActionOperation,
  firstPartyProviderForConnectorAction,
} from "./connectors/executors/first_party";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|api-key-owner";
const otherOwnerId = "https://issuer.test|other-api-key-owner";
const API_KEY = "fc-test-secret-123456789";

const MASTER_KEY = btoa(
  String.fromCharCode(
    ...Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff),
  ),
);

const createTest = () => {
  const test = convexTest(schema, modules);
  registerRateLimiter(test);
  return test;
};

const asOwner = (test: ReturnType<typeof createTest>) =>
  test.withIdentity({
    issuer: "https://issuer.test",
    subject: "api-key-owner",
    tokenIdentifier: ownerId,
  });

const asOtherOwner = (test: ReturnType<typeof createTest>) =>
  test.withIdentity({
    issuer: "https://issuer.test",
    subject: "other-api-key-owner",
    tokenIdentifier: otherOwnerId,
  });

const setApiKeyEnv = () => {
  process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({
    "1": MASTER_KEY,
  });
  process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
  process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "1";
  process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS =
    "firecrawl,exa,serpapi,ashby";
  process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS =
    "firecrawl,exa,serpapi,ashby";
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connectFirecrawl = async (
  test: ReturnType<typeof createTest>,
  apiKey = API_KEY,
  expectedGeneration?: number,
) =>
  asOwner(test).action(api.connectors.api_keys.vault.connectApiKey, {
    connectorId: "firecrawl",
    apiKey,
    expectedGeneration,
  });

const enableFirecrawlFirstParty = async (
  test: ReturnType<typeof createTest>,
) => {
  await test.mutation(internal.connectors.rollouts.setConnectorRollout, {
    connectorId: "firecrawl",
    mode: "first_party_only",
  });
};

const publishFirecrawl = async (test: ReturnType<typeof createTest>) => {
  const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
  await test.mutation(internal.data.integrations.upsertPublicIntegration, {
    id: "firecrawl",
    name: "Firecrawl",
    provider: "composio",
    category: "developer-tools",
    auth: ["API_KEY"],
    catalogToolCount: Object.keys(descriptor.actions).length,
    actions: Object.entries(descriptor.actions).map(([name, action]) => ({
      name,
      title: name,
      inputSchemaJson: JSON.stringify(action.inputSchema),
    })),
    description: "Connect Firecrawl to Stella.",
    connector: {
      type: "composio",
      toolkit: "firecrawl",
      provider: "composio",
    },
    enabled: true,
    usagePolicy: "ready",
  });
};

const runFirecrawl = (
  test: ReturnType<typeof createTest>,
  action: string,
  input: Record<string, unknown>,
) =>
  test.action(internal.connectors.execute.runFirstPartyConnectorAction, {
    ownerId,
    connectorId: "firecrawl",
    action,
    inputJson: JSON.stringify(input),
  });

beforeEach(setApiKeyEnv);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("API-key provider descriptors", () => {
  it("publishes only reviewed fixed-origin descriptors consistent with planning", () => {
    expect(validateApiKeyProviderDescriptors()).toEqual([]);
    expect(
      API_KEY_PROVIDER_DESCRIPTORS.map((descriptor) => [
        descriptor.connectorId,
        descriptor.apiOrigin,
        descriptor.auth.type,
      ]),
    ).toEqual([
      ["firecrawl", "https://api.firecrawl.dev", "bearer"],
      ["exa", "https://api.exa.ai", "header"],
      ["serpapi", "https://serpapi.com", "query"],
      ["ashby", "https://api.ashbyhq.com", "basic"],
    ]);
  });

  it("classifies representative read and write actions for safe planning", () => {
    expect(
      firstPartyProviderForConnectorAction("firecrawl", "FIRECRAWL_SEARCH"),
    ).toBe("firecrawl");
    expect(firstPartyActionOperation("firecrawl", "FIRECRAWL_SEARCH")).toBe(
      "read",
    );
    expect(firstPartyActionOperation("firecrawl", "FIRECRAWL_CRAWL")).toBe(
      "write",
    );
    expect(firstPartyActionOperation("ashby", "ASHBY_CREATE_CANDIDATE")).toBe(
      "write",
    );
  });

  it("rejects malformed credentials and requires independent enablement and verification", async () => {
    for (const invalid of [
      "short",
      " leading-secret",
      "trailing-secret ",
      "line\nbreak-secret",
      "x".repeat(1025),
    ]) {
      expect(() => validateApiKeyCredential(invalid)).toThrow(
        /invalid_credential/,
      );
    }
    expect(() =>
      validateApiKeyCredential(
        "username:password-shaped-secret",
        getApiKeyProviderDescriptor("ashby")!.auth,
      ),
    ).toThrow(/invalid_credential/);

    delete process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS;
    expect(() => requireReadyApiKeyProvider("firecrawl")).toThrow(
      /provider_unverified/,
    );
    await expect(connectFirecrawl(createTest())).rejects.toThrow(
      /provider_unverified/,
    );
    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS = "firecrawl";
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "";
    expect(() => requireReadyApiKeyProvider("firecrawl")).toThrow(
      /provider_disabled/,
    );
    await expect(connectFirecrawl(createTest())).rejects.toThrow(
      /provider_disabled/,
    );
    expect(() => requireReadyApiKeyProvider("unknown-provider")).toThrow(
      /provider_not_configured/,
    );
  });
});

describe("API-key auth placement and egress controls", () => {
  it("places bearer, named header, query, and Basic credentials exactly once", () => {
    const cases = [
      {
        connectorId: "firecrawl",
        path: "/v2/search",
        expectedOrigin: "https://api.firecrawl.dev",
        assertAuth: (url: URL, headers: Headers) => {
          expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
          expect(url.search).not.toContain(API_KEY);
        },
      },
      {
        connectorId: "exa",
        path: "/search",
        expectedOrigin: "https://api.exa.ai",
        assertAuth: (url: URL, headers: Headers) => {
          expect(headers.get("x-api-key")).toBe(API_KEY);
          expect(headers.get("authorization")).toBeNull();
          expect(url.search).not.toContain(API_KEY);
        },
      },
      {
        connectorId: "serpapi",
        path: "/search.json?q=stella",
        expectedOrigin: "https://serpapi.com",
        assertAuth: (url: URL, headers: Headers) => {
          expect(url.searchParams.get("api_key")).toBe(API_KEY);
          expect(headers.get("authorization")).toBeNull();
          expect(headers.get("x-api-key")).toBeNull();
        },
      },
      {
        connectorId: "ashby",
        path: "/candidate.list",
        expectedOrigin: "https://api.ashbyhq.com",
        assertAuth: (url: URL, headers: Headers) => {
          expect(headers.get("authorization")).toBe(
            `Basic ${btoa(`${API_KEY}:`)}`,
          );
          expect(url.search).not.toContain(API_KEY);
        },
      },
    ] as const;

    for (const testCase of cases) {
      const descriptor = getApiKeyProviderDescriptor(testCase.connectorId)!;
      const prepared = buildAuthenticatedApiKeyRequest({
        descriptor,
        apiKey: API_KEY,
        request: { method: "POST", path: testCase.path, body: { value: 1 } },
      });
      const url = new URL(prepared.url);
      const headers = prepared.init.headers as Headers;
      expect(url.origin).toBe(testCase.expectedOrigin);
      expect(prepared.init.redirect).toBe("manual");
      expect(String(prepared.init.body)).not.toContain(API_KEY);
      testCase.assertAuth(url, headers);
    }
  });

  it("rejects cross-origin paths and provider-supplied arbitrary headers", () => {
    const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
    expect(() =>
      buildAuthenticatedApiKeyRequest({
        descriptor,
        apiKey: API_KEY,
        request: { method: "GET", path: "//attacker.test/collect" },
      }),
    ).toThrow(/normalization_error/);
    expect(() =>
      buildAuthenticatedApiKeyRequest({
        descriptor,
        apiKey: API_KEY,
        request: {
          method: "GET",
          path: "/v2/search",
          headers: { "x-forwarded-host": "attacker.test" },
        },
      }),
    ).toThrow(/normalization_error/);
  });

  it("does not follow redirects or expose credentials in output or errors", async () => {
    const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/collect" },
      }),
    );
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_SEARCH",
        input: { query: "stella" },
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        echo: API_KEY,
        [API_KEY]: "credential-shaped provider field name",
        nested: [
          `Bearer ${API_KEY}`,
          encodeURIComponent(API_KEY),
          new URLSearchParams([["api_key", API_KEY]]).toString(),
        ],
      }),
    );
    const result = await executeApiKeyProviderAction({
      descriptor,
      apiKey: API_KEY,
      action: "FIRECRAWL_SEARCH",
      input: { query: "stella" },
      operation: "read",
    });
    expect(JSON.stringify(result.output)).not.toContain(API_KEY);
    expect(JSON.stringify(result.output)).toContain("[REDACTED]");

    const queryKey = "query~key+sentinel";
    const queryEncoded = new URLSearchParams([
      ["api_key", queryKey],
    ]).toString();
    expect(queryEncoded).not.toContain(queryKey);
    expect(
      JSON.stringify(
        redactApiKeyMaterial({ requestUrl: queryEncoded }, queryKey),
      ),
    ).not.toContain(queryEncoded);
  });

  it("rejects credential-shaped action inputs before network egress", async () => {
    const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_SEARCH",
        input: { query: "stella", nested: { apiKey: "do-not-send" } },
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_SEARCH",
        input: { query: API_KEY },
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs no automatic retries and marks uncertain writes non-retryable", async () => {
    const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_SEARCH",
        input: { query: "stella" },
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
    let writeError: unknown;
    try {
      await executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_CRAWL",
        input: { url: "https://example.com" },
        operation: "write",
      });
    } catch (error) {
      writeError = error;
    }
    expect(writeError).toBeInstanceOf(ConnectorError);
    expect(writeError).toMatchObject({
      code: "ambiguous_write",
      retryable: false,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate limit" }, 429));
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: API_KEY,
        action: "FIRECRAWL_CRAWL",
        input: { url: "https://example.com" },
        operation: "write",
      }),
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("encrypted API-key vault lifecycle", () => {
  it("encrypts at rest and exposes only owner-scoped metadata", async () => {
    const test = createTest();
    expect(await connectFirecrawl(test)).toEqual({
      connected: true,
      provider: "firecrawl",
      generation: 1,
      replaced: false,
    });

    const row = await test.run(async (ctx) =>
      ctx.db
        .query("api_key_credentials")
        .withIndex("by_owner_provider", (query) =>
          query.eq("ownerId", ownerId).eq("provider", "firecrawl"),
        )
        .unique(),
    );
    expect(row?.encryptedKey).toBeTruthy();
    expect(row?.encryptedKey).not.toContain(API_KEY);
    expect(row?.keyVersion).toBe(1);

    const status = await asOwner(test).query(
      api.connectors.api_keys.vault.getApiKeyConnectionStatus,
      { connectorId: "firecrawl" },
    );
    expect(status).toMatchObject({
      connected: true,
      configured: true,
      ready: true,
      generation: 1,
    });
    expect(JSON.stringify(status)).not.toContain(API_KEY);

    const otherStatus = await asOtherOwner(test).query(
      api.connectors.api_keys.vault.getApiKeyConnectionStatus,
      { connectorId: "firecrawl" },
    );
    expect(otherStatus).toMatchObject({ connected: false, configured: false });
    await expect(
      test.action(internal.connectors.api_keys.vault.loadApiKeyForExecution, {
        ownerId: otherOwnerId,
        connectorId: "firecrawl",
      }),
    ).rejects.toThrow(/not_connected/);

    const events = await test.run(async (ctx) =>
      ctx.db
        .query("connector_audit_events")
        .withIndex("by_ownerId_and_createdAt", (query) =>
          query.eq("ownerId", ownerId),
        )
        .collect(),
    );
    expect(events.some((event) => event.event === "api_key_connected")).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(API_KEY);
    expect(JSON.stringify(events)).not.toContain(
      row?.encryptedKey ?? "missing",
    );
  });

  it("generation-checks replacement and destroys the prior envelope", async () => {
    const test = createTest();
    await connectFirecrawl(test);
    const original = await test.run(async (ctx) =>
      ctx.db
        .query("api_key_credentials")
        .withIndex("by_owner_provider", (query) =>
          query.eq("ownerId", ownerId).eq("provider", "firecrawl"),
        )
        .unique(),
    );
    const replacement = "fc-replacement-secret-987654321";
    expect(await connectFirecrawl(test, replacement, 1)).toMatchObject({
      generation: 2,
      replaced: true,
    });
    const current = await test.run(async (ctx) =>
      ctx.db
        .query("api_key_credentials")
        .withIndex("by_owner_provider", (query) =>
          query.eq("ownerId", ownerId).eq("provider", "firecrawl"),
        )
        .unique(),
    );
    expect(current?._id).toBe(original?._id);
    expect(current?.encryptedKey).not.toBe(original?.encryptedKey);
    expect(current?.encryptedKey).not.toContain(API_KEY);
    expect(current?.encryptedKey).not.toContain(replacement);
    await expect(
      connectFirecrawl(test, "fc-stale-update-secret", 1),
    ).rejects.toThrow(/credential_generation_conflict/);
    const loaded = await test.action(
      internal.connectors.api_keys.vault.loadApiKeyForExecution,
      { ownerId, connectorId: "firecrawl" },
    );
    expect(loaded.apiKey).toBe(replacement);
  });

  it("disconnect physically deletes the encrypted credential", async () => {
    const test = createTest();
    await connectFirecrawl(test);
    expect(
      await asOwner(test).action(
        api.connectors.api_keys.vault.disconnectApiKey,
        { connectorId: "firecrawl" },
      ),
    ).toEqual({ connected: false, disconnected: true });
    const rows = await test.run(async (ctx) =>
      ctx.db.query("api_key_credentials").collect(),
    );
    expect(rows).toEqual([]);
    const status = await asOwner(test).query(
      api.connectors.api_keys.vault.getApiKeyConnectionStatus,
      { connectorId: "firecrawl" },
    );
    expect(status).toMatchObject({ connected: false, configured: false });
  });
});

describe("API-key routing and execution", () => {
  it("keeps Composio as the default and requires a ready credential", async () => {
    const test = createTest();
    await connectFirecrawl(test);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { query: "stella" }),
    ).rejects.toThrow(/route_not_first_party/);
    expect(fetchMock).not.toHaveBeenCalled();

    await enableFirecrawlFirstParty(test);
    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS = "";
    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { query: "stella" }),
    ).rejects.toThrow(/provider_unverified/);
    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS = "firecrawl";
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "";
    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { query: "stella" }),
    ).rejects.toThrow(/provider_disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates descriptor schemas before representative read/write execution", async () => {
    const test = createTest();
    await connectFirecrawl(test);
    await enableFirecrawlFirstParty(test);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ ok: true }));

    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { missingQuery: true }),
    ).rejects.toThrow(/invalid_input/);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { query: "stella" }),
    ).resolves.toMatchObject({ executor: "first_party", output: { ok: true } });
    await expect(
      runFirecrawl(test, "FIRECRAWL_CRAWL", {
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({ executor: "first_party", output: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.firecrawl.dev/v2/search",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://api.firecrawl.dev/v2/crawl",
    );
  });

  it("destroys rejected credentials and redacts audit and error surfaces", async () => {
    const test = createTest();
    await connectFirecrawl(test);
    await enableFirecrawlFirstParty(test);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: `rejected ${API_KEY}` }, 401),
    );

    await expect(
      runFirecrawl(test, "FIRECRAWL_SEARCH", { query: "stella" }),
    ).rejects.toThrow(/invalid_credential/);
    const row = await test.run(async (ctx) =>
      ctx.db
        .query("api_key_credentials")
        .withIndex("by_owner_provider", (query) =>
          query.eq("ownerId", ownerId).eq("provider", "firecrawl"),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      encryptedKey: "",
      keyVersion: 0,
      status: "invalid",
      generation: 2,
    });
    const events = await test.run(async (ctx) =>
      ctx.db
        .query("connector_audit_events")
        .withIndex("by_ownerId_and_createdAt", (query) =>
          query.eq("ownerId", ownerId),
        )
        .collect(),
    );
    expect(events.some((event) => event.event === "api_key_invalidated")).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it("supports authenticated HTTP connect, status, and disconnect without returning key material", async () => {
    const test = createTest();
    await publishFirecrawl(test);
    await enableFirecrawlFirstParty(test);
    const connectResponse = await asOwner(test).fetch(
      "/api/native-integrations/api-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "firecrawl", apiKey: API_KEY }),
      },
    );
    const connectText = await connectResponse.text();
    expect(connectResponse.status, connectText).toBe(200);
    expect(connectText).not.toContain(API_KEY);

    const staleReplacementResponse = await asOwner(test).fetch(
      "/api/native-integrations/api-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "firecrawl",
          apiKey: "fc-replacement-without-generation",
        }),
      },
    );
    expect(staleReplacementResponse.status).toBe(409);
    expect(await staleReplacementResponse.text()).not.toContain(API_KEY);

    const malformedResponse = await asOwner(test).fetch(
      "/api/native-integrations/api-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "firecrawl",
          apiKey: " malformed-key",
          expectedGeneration: 1,
        }),
      },
    );
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.text()).not.toContain("malformed-key");

    const statusResponse = await asOwner(test).fetch(
      "/api/native-integrations/status?id=firecrawl",
      { method: "GET" },
    );
    const statusText = await statusResponse.text();
    expect(statusResponse.status, statusText).toBe(200);
    expect(statusText).not.toContain(API_KEY);
    expect(JSON.parse(statusText)).toMatchObject({
      connected: true,
      executor: "first_party",
      authType: "api_key",
      configured: true,
    });

    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS = "";
    const disabledPrompt = await asOwner(test).fetch(
      "/api/native-integrations/connect-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "firecrawl" }),
      },
    );
    expect(disabledPrompt.status).toBe(503);
    expect(await disabledPrompt.text()).not.toContain(API_KEY);

    const unverifiedStatus = await asOwner(test).fetch(
      "/api/native-integrations/status?id=firecrawl",
      { method: "GET" },
    );
    expect(await unverifiedStatus.json()).toMatchObject({
      connected: false,
      executor: "first_party",
      authType: "api_key",
      configured: true,
      providerVerified: false,
    });

    const disconnectResponse = await asOwner(test).fetch(
      "/api/native-integrations/disconnect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "firecrawl" }),
      },
    );
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toMatchObject({
      connected: false,
      disconnected: true,
    });
  });
});
