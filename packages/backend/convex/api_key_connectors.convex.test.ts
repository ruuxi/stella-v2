/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import Ajv from "ajv";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  API_KEY_PROVIDER_DESCRIPTORS,
  getApiKeyProviderDescriptor,
  isApiKeyProviderVerified,
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
import {
  DEFERRED_API_KEY_PROVIDERS,
  resolveDeferredActionOrigin,
  resolveDeferredTenantOrigin,
} from "./connectors/executors/api_key";
import { isProviderEnabled } from "./connectors/env";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|api-key-owner";
const otherOwnerId = "https://issuer.test|other-api-key-owner";

const PROMOTED_PROVIDER_CASES = [
  {
    connectorId: "tavily",
    action: "TAVILY_SEARCH",
    operation: "read",
    expectedMethod: "POST",
    input: { query: "stella" },
    expectedUrl: "https://api.tavily.com/search",
    authHeader: "authorization",
  },
  {
    connectorId: "perplexityai",
    action: "PERPLEXITYAI_SEARCH",
    operation: "read",
    expectedMethod: "POST",
    input: { query: "stella" },
    expectedUrl: "https://api.perplexity.ai/search",
    authHeader: "authorization",
  },
  {
    connectorId: "posthog",
    action: "POSTHOG_LIST_PROJECTS",
    operation: "read",
    expectedMethod: "GET",
    input: {},
    expectedUrl: "https://us.posthog.com/api/projects/",
    authHeader: "authorization",
  },
  {
    connectorId: "ably",
    action: "ABLY_LIST_CHANNELS",
    operation: "read",
    expectedMethod: "GET",
    input: { prefix: "support" },
    expectedUrl: "https://rest.ably.io/channels?prefix=support",
    apiKey: "app.key-id:ably-secret-value",
    authHeader: "authorization",
  },
  {
    connectorId: "abuseipdb",
    action: "ABUSEIPDB_REPORT_IP",
    operation: "write",
    expectedMethod: "POST",
    input: { ip: "203.0.113.9", categories: "18,22", comment: "spam" },
    expectedUrl: "https://api.abuseipdb.com/api/v2/report",
    authHeader: "key",
    expectedContentType: "application/x-www-form-urlencoded",
    expectedBody: "ip=203.0.113.9&categories=18%2C22&comment=spam",
  },
  {
    connectorId: "peopledatalabs",
    action: "PEOPLEDATALABS_ENRICH_PERSON_DATA",
    operation: "read",
    expectedMethod: "GET",
    input: { email: "person@example.com" },
    expectedUrl:
      "https://api.peopledatalabs.com/v5/person/enrich?email=person%40example.com",
    authHeader: "x-api-key",
  },
  {
    connectorId: "apollo",
    action: "APOLLO_PEOPLE_SEARCH",
    operation: "read",
    expectedMethod: "POST",
    input: { q_keywords: "developer", person_titles: ["CTO"] },
    expectedUrl:
      "https://api.apollo.io/api/v1/mixed_people/api_search?q_keywords=developer&person_titles%5B%5D=CTO",
    authHeader: "x-api-key",
    expectsNoBody: true,
  },
  {
    connectorId: "2chat",
    action: "TWOCHAT_LIST_WHATSAPP_NUMBERS",
    operation: "read",
    expectedMethod: "GET",
    input: { page_number: 2 },
    expectedUrl:
      "https://api.p.2chat.io/open/whatsapp/get-numbers?page_number=2",
    authHeader: "x-user-api-key",
  },
  {
    connectorId: "7shifts",
    action: "7SHIFTS_LIST_SHIFTS",
    operation: "read",
    expectedMethod: "GET",
    input: { company_id: "123", limit: 5 },
    expectedUrl: "https://api.7shifts.com/v2/company/123/shifts?limit=5",
    authHeader: "authorization",
  },
  {
    connectorId: "abyssale",
    action: "ABYSSALE_GET_TEMPLATE",
    operation: "read",
    expectedMethod: "GET",
    input: { templateId: "template-1" },
    expectedUrl: "https://api.abyssale.com/templates/template-1",
    authHeader: "x-api-key",
  },
  {
    connectorId: "0codekit",
    action: "ZEROCODEKIT_PDF_METADATA",
    operation: "read",
    expectedMethod: "POST",
    input: { url: "https://example.com/file.pdf" },
    expectedUrl: "https://prod.0codekit.com/pdf/metadata/info",
    authHeader: "auth",
  },
  {
    connectorId: "44api",
    action: "44API_VALIDATE_VAT_NUMBER",
    operation: "read",
    expectedMethod: "POST",
    input: { vatNumber: "69838046", countryCode: "SI" },
    expectedUrl: "https://api.44api.dev/webhook/validate-vat",
    authHeader: "x-api-key",
  },
  {
    connectorId: "21risk",
    action: "TWENTY_ONE_RISK_GET_REPORTS",
    operation: "read",
    expectedMethod: "GET",
    input: { top: 5, filter: "Report Status eq 'published'" },
    expectedUrl:
      "https://21risk.com/odata/v5/reports?%24top=5&%24filter=Report+Status+eq+%27published%27",
    authHeader: "authorization",
  },
  {
    connectorId: "21risk",
    action: "TWENTY_ONE_RISK_GET_ORGANIZATIONS",
    operation: "read",
    expectedMethod: "GET",
    input: { orderby: "Name desc" },
    expectedUrl:
      "https://21risk.com/odata/v5/organizations?%24orderby=Name+desc",
    authHeader: "authorization",
  },
] as const;
const API_KEY = "fc-test-secret-123456789";

const APOLLO_ACTION_CASES = [
  {
    action: "APOLLO_PEOPLE_SEARCH",
    operation: "read",
    input: { q_keywords: "cto", person_titles: ["CTO"] },
    expectedUrl:
      "https://api.apollo.io/api/v1/mixed_people/api_search?q_keywords=cto&person_titles%5B%5D=CTO",
  },
  {
    action: "APOLLO_ORGANIZATION_SEARCH",
    operation: "read",
    input: {
      q_organization_name: "Acme",
      q_organization_domains_list: ["acme.example"],
    },
    expectedUrl:
      "https://api.apollo.io/api/v1/mixed_companies/search?q_organization_name=Acme&q_organization_domains_list%5B%5D=acme.example",
  },
  {
    action: "APOLLO_PEOPLE_ENRICH",
    operation: "read",
    input: { email: "ada+lead@example.com" },
    expectedUrl:
      "https://api.apollo.io/api/v1/people/match?email=ada%2Blead%40example.com",
  },
  {
    action: "APOLLO_CREATE_CONTACT",
    operation: "write",
    input: {
      first_name: "Ada",
      last_name: "Lovelace",
      account_id: "account-1",
    },
    expectedUrl: "https://api.apollo.io/api/v1/contacts",
    expectedBody: {
      last_name: "Lovelace",
      account_id: "account-1",
      first_name: "Ada",
    },
  },
  {
    action: "APOLLO_CREATE_TASK",
    operation: "write",
    input: {
      user_id: "user-1",
      contact_id: "contact-1",
      type: "call",
      status: "scheduled",
      due_at: "2026-08-15T10:00:00Z",
      priority: "high",
    },
    expectedUrl: "https://api.apollo.io/api/v1/tasks",
    expectedBody: {
      type: "call",
      due_at: "2026-08-15T10:00:00Z",
      status: "scheduled",
      user_id: "user-1",
      priority: "high",
      contact_id: "contact-1",
    },
  },
] as const;

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
  it("keeps deployment enablement and representative verification independent", () => {
    const providerKeys = API_KEY_PROVIDER_DESCRIPTORS.map(
      (descriptor) => descriptor.providerKey,
    );
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS =
      providerKeys.join(",");
    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS = "";
    for (const providerKey of providerKeys) {
      expect(isProviderEnabled(providerKey), providerKey).toBe(true);
      expect(isApiKeyProviderVerified(providerKey), providerKey).toBe(false);
    }

    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "";
    process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS =
      providerKeys.join(",");
    for (const providerKey of providerKeys) {
      expect(isProviderEnabled(providerKey), providerKey).toBe(false);
      expect(isApiKeyProviderVerified(providerKey), providerKey).toBe(true);
    }
  });

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
      ["tavily", "https://api.tavily.com", "bearer"],
      ["perplexityai", "https://api.perplexity.ai", "bearer"],
      ["posthog", "https://us.posthog.com", "bearer"],
      ["ably", "https://rest.ably.io", "basic"],
      ["abuseipdb", "https://api.abuseipdb.com", "header"],
      ["peopledatalabs", "https://api.peopledatalabs.com", "header"],
      ["apollo", "https://api.apollo.io", "header"],
      ["2chat", "https://api.p.2chat.io", "header"],
      ["7shifts", "https://api.7shifts.com", "bearer"],
      ["abyssale", "https://api.abyssale.com", "header"],
      ["0codekit", "https://prod.0codekit.com", "header"],
      ["44api", "https://api.44api.dev", "header"],
      ["21risk", "https://21risk.com", "bearer"],
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
    for (const testCase of PROMOTED_PROVIDER_CASES) {
      expect(
        firstPartyProviderForConnectorAction(
          testCase.connectorId,
          testCase.action,
        ),
        `${testCase.connectorId}:${testCase.action}`,
      ).toBe(testCase.connectorId);
      expect(
        firstPartyActionOperation(testCase.connectorId, testCase.action),
      ).toBe(testCase.operation);
    }
    expect(
      firstPartyProviderForConnectorAction(
        "44api",
        "FORTYFOUR_API_VALIDATE_VAT_NUMBER",
      ),
    ).toBe("44api");
    expect(
      firstPartyActionOperation("44api", "FORTYFOUR_API_VALIDATE_VAT_NUMBER"),
    ).toBe("read");
  });

  it("compiles every published action schema and accepts representative inputs", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const descriptor of API_KEY_PROVIDER_DESCRIPTORS) {
      for (const [action, actionDescriptor] of Object.entries(
        descriptor.actions,
      )) {
        expect(
          () => ajv.compile(actionDescriptor.inputSchema),
          `${descriptor.connectorId}:${action}`,
        ).not.toThrow();
      }
    }
    for (const testCase of PROMOTED_PROVIDER_CASES) {
      const action = getApiKeyProviderDescriptor(testCase.connectorId)!.actions[
        testCase.action
      ];
      expect(
        action,
        `${testCase.connectorId}:${testCase.action}`,
      ).toBeDefined();
      const validate = ajv.compile(action!.inputSchema);
      expect(validate(testCase.input), JSON.stringify(validate.errors)).toBe(
        true,
      );
      expect(
        validate({ ...testCase.input, unreviewed_argument: true }),
        `${testCase.connectorId}:${testCase.action} accepted an unknown field`,
      ).toBe(false);
    }
    for (const [connectorId, action] of [
      ["peopledatalabs", "PEOPLEDATALABS_ENRICH_PERSON_DATA"],
      ["peopledatalabs", "PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC"],
      ["apollo", "APOLLO_PEOPLE_ENRICH"],
    ] as const) {
      const schema =
        getApiKeyProviderDescriptor(connectorId)!.actions[action]!.inputSchema;
      expect(ajv.compile(schema)({}), `${connectorId}:${action}`).toBe(false);
    }
  });

  it("matches the reviewed public Apollo schemas and rejects legacy task input", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const descriptor = getApiKeyProviderDescriptor("apollo")!;
    for (const testCase of APOLLO_ACTION_CASES) {
      const validate = ajv.compile(
        descriptor.actions[testCase.action]!.inputSchema,
      );
      expect(
        validate(testCase.input),
        `${testCase.action}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
      expect(
        validate({ ...testCase.input, unreviewed_argument: true }),
        testCase.action,
      ).toBe(false);
    }

    const validateTask = ajv.compile(
      descriptor.actions.APOLLO_CREATE_TASK!.inputSchema,
    );
    expect(
      validateTask({
        priority: "high",
        type: "email",
        contact_ids: ["legacy-contact"],
      }),
    ).toBe(false);

    const validateEnrichment = ajv.compile(
      descriptor.actions.APOLLO_PEOPLE_ENRICH!.inputSchema,
    );
    expect(
      validateEnrichment({
        email: "ada@example.com",
        reveal_phone_number: true,
      }),
    ).toBe(false);
    expect(
      validateEnrichment({
        email: "ada@example.com",
        reveal_phone_number: true,
        webhook_url: "https://example.com/apollo-webhook",
      }),
    ).toBe(true);
  });

  it("rejects malformed credentials and requires independent enablement and verification", async () => {
    expect(isApiKeyProviderVerified("apollo")).toBe(false);
    expect(isProviderEnabled("apollo")).toBe(false);
    expect(() => requireReadyApiKeyProvider("apollo")).toThrow(
      /provider_unverified/,
    );
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
    expect(
      validateApiKeyCredential(
        "app.key-id:ably-secret-value",
        getApiKeyProviderDescriptor("ably")!.auth,
      ),
    ).toBe("app.key-id:ably-secret-value");
    expect(() =>
      validateApiKeyCredential(
        "ably-key-without-credentials-separator",
        getApiKeyProviderDescriptor("ably")!.auth,
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

  it("executes one fixed-origin authenticated request for every promoted provider", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ ok: true }));

    for (const testCase of PROMOTED_PROVIDER_CASES) {
      fetchMock.mockClear();
      const descriptor = getApiKeyProviderDescriptor(testCase.connectorId)!;
      const apiKey = "apiKey" in testCase ? testCase.apiKey : API_KEY;
      await expect(
        executeApiKeyProviderAction({
          descriptor,
          apiKey,
          action: testCase.action,
          input: { ...testCase.input },
          operation: testCase.operation,
        }),
        `${testCase.connectorId}:${testCase.action}`,
      ).resolves.toEqual({
        output: { ok: true },
        providerStatusClass: "ok",
      });
      expect(fetchMock, testCase.connectorId).toHaveBeenCalledOnce();
      const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
      expect(String(requestUrl)).toBe(testCase.expectedUrl);
      expect(requestInit?.method).toBe(testCase.expectedMethod);
      expect(requestInit?.redirect).toBe("manual");

      const headers = requestInit?.headers as Headers;
      const expectedAuth =
        testCase.connectorId === "ably"
          ? `Basic ${btoa(apiKey)}`
          : testCase.authHeader === "authorization"
            ? `Bearer ${apiKey}`
            : apiKey;
      expect(headers.get(testCase.authHeader)).toBe(expectedAuth);
      const safeHeaderNames = new Set([
        "accept",
        "auth",
        "authorization",
        "content-type",
        "key",
        "x-api-key",
        "x-api-version",
        "x-user-api-key",
      ]);
      for (const [name, value] of headers.entries()) {
        expect(
          safeHeaderNames.has(name),
          `${testCase.connectorId}:${name}`,
        ).toBe(true);
        if (name !== testCase.authHeader) expect(value).not.toContain(apiKey);
      }
      expect(String(requestUrl)).not.toContain(apiKey);
      expect(String(requestInit?.body ?? "")).not.toContain(apiKey);
      if ("expectedContentType" in testCase) {
        expect(headers.get("content-type")).toBe(testCase.expectedContentType);
      }
      if ("expectedBody" in testCase) {
        expect(requestInit?.body).toBe(testCase.expectedBody);
      } else if (
        "expectsNoBody" in testCase &&
        testCase.expectsNoBody === true
      ) {
        expect(requestInit?.body).toBeUndefined();
        expect(headers.get("content-type")).toBeNull();
      } else if (testCase.expectedMethod === "POST") {
        expect(JSON.parse(String(requestInit?.body))).toEqual(testCase.input);
      }
    }
  });

  it("executes every Apollo public action against its reviewed API v1 route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ ok: true }));
    const descriptor = getApiKeyProviderDescriptor("apollo")!;

    for (const testCase of APOLLO_ACTION_CASES) {
      fetchMock.mockClear();
      await expect(
        executeApiKeyProviderAction({
          descriptor,
          apiKey: API_KEY,
          action: testCase.action,
          input: { ...testCase.input },
          operation: testCase.operation,
        }),
        testCase.action,
      ).resolves.toEqual({
        output: { ok: true },
        providerStatusClass: "ok",
      });

      expect(fetchMock, testCase.action).toHaveBeenCalledOnce();
      const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
      const headers = requestInit?.headers as Headers;
      expect(String(requestUrl)).toBe(testCase.expectedUrl);
      expect(String(requestUrl)).not.toContain(API_KEY);
      expect(requestInit?.method).toBe("POST");
      expect(requestInit?.redirect).toBe("manual");
      expect(headers.get("x-api-key")).toBe(API_KEY);
      expect(headers.get("authorization")).toBeNull();
      expect(String(requestInit?.body ?? "")).not.toContain(API_KEY);

      if ("expectedBody" in testCase) {
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(requestInit?.body))).toEqual(
          testCase.expectedBody,
        );
        expect([...headers.keys()].sort()).toEqual([
          "accept",
          "content-type",
          "x-api-key",
        ]);
      } else {
        expect(requestInit?.body).toBeUndefined();
        expect(headers.get("content-type")).toBeNull();
        expect([...headers.keys()].sort()).toEqual(["accept", "x-api-key"]);
      }
    }
  });

  it("rejects cross-origin paths and provider-supplied arbitrary headers", () => {
    for (const descriptor of API_KEY_PROVIDER_DESCRIPTORS) {
      for (const path of [
        "//attacker.test/collect",
        "https://attacker.test/collect",
        "/safe\r\nx-forwarded-host: attacker.test",
      ]) {
        expect(() =>
          buildAuthenticatedApiKeyRequest({
            descriptor,
            apiKey:
              descriptor.providerKey === "ably" ? "id:secret-value" : API_KEY,
            request: { method: "GET", path },
          }),
        ).toThrow(/normalization_error/);
      }
    }
    const descriptor = getApiKeyProviderDescriptor("firecrawl")!;
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

  it("fails closed for unproven tenant origins and Snowflake look-alikes", () => {
    const deferred = new Map(
      DEFERRED_API_KEY_PROVIDERS.map((provider) => [
        provider.connectorId,
        provider,
      ]),
    );
    expect(
      resolveDeferredTenantOrigin(
        deferred.get("1password")!,
        "https://connect.internal.example",
      ),
    ).toBeNull();
    expect(
      resolveDeferredTenantOrigin(
        deferred.get("21risk")!,
        "https://tenant.21risk.example",
      ),
    ).toBeNull();

    const snowflake = deferred.get("snowflake")!;
    expect(
      resolveDeferredTenantOrigin(
        snowflake,
        "https://org-account.snowflakecomputing.com",
      ),
    ).toBe("https://org-account.snowflakecomputing.com");
    for (const candidate of [
      "https://snowflakecomputing.com",
      "https://account.snowflakecomputing.com.attacker.test",
      "http://account.snowflakecomputing.com",
      "https://account.snowflakecomputing.com/api/v2/statements",
    ]) {
      expect(resolveDeferredTenantOrigin(snowflake, candidate)).toBeNull();
    }
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

describe("21RISK fixed-origin OData contract", () => {
  const TWENTY_ONE_RISK_KEY = "21RISK.ND.testexamplekey000";

  it("pins the verified fixed origin, bearer auth, and read-only OData actions", () => {
    const descriptor = getApiKeyProviderDescriptor("21risk")!;
    expect(descriptor.apiOrigin).toBe("https://21risk.com");
    expect(descriptor.auth).toEqual({ type: "bearer" });
    expect(Object.keys(descriptor.actions).sort()).toEqual([
      "TWENTY_ONE_RISK_GET_ORGANIZATIONS",
      "TWENTY_ONE_RISK_GET_REPORTS",
    ]);
    for (const action of Object.values(descriptor.actions)) {
      expect(action.operation).toBe("read");
      expect(action.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("binds a fixed action origin and never a tenant origin", () => {
    const provider = DEFERRED_API_KEY_PROVIDERS.find(
      (entry) => entry.connectorId === "21risk",
    )!;
    expect(provider.fixedApiOrigin).toBe("https://21risk.com");
    expect(provider.requiresTenantOrigin).toBeUndefined();
    expect(
      resolveDeferredActionOrigin(provider, "TWENTY_ONE_RISK_GET_REPORTS"),
    ).toBe("https://21risk.com");
    for (const candidate of [
      "https://tenant.21risk.example",
      "https://21risk.com.attacker.test",
      "https://api.21risk.com",
    ]) {
      expect(resolveDeferredTenantOrigin(provider, candidate)).toBeNull();
    }
  });

  it("injects the API key only as an Authorization: Bearer header on the apex origin", () => {
    const descriptor = getApiKeyProviderDescriptor("21risk")!;
    const prepared = buildAuthenticatedApiKeyRequest({
      descriptor,
      apiKey: TWENTY_ONE_RISK_KEY,
      request: { method: "GET", path: "/odata/v5/reports?%24top=5" },
    });
    expect(prepared.url).toBe("https://21risk.com/odata/v5/reports?%24top=5");
    const headers = prepared.init.headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${TWENTY_ONE_RISK_KEY}`);
    expect(prepared.init.redirect).toBe("manual");
    expect(prepared.url).not.toContain(TWENTY_ONE_RISK_KEY);
  });

  it("rejects any cross-origin or CRLF-injected path", () => {
    const descriptor = getApiKeyProviderDescriptor("21risk")!;
    for (const path of [
      "https://attacker.test/odata/v5/reports",
      "//attacker.test/odata/v5/reports",
      "/odata/v5/reports\r\nx-forwarded-host: attacker.test",
    ]) {
      expect(() =>
        buildAuthenticatedApiKeyRequest({
          descriptor,
          apiKey: TWENTY_ONE_RISK_KEY,
          request: { method: "GET", path },
        }),
      ).toThrow(/normalization_error/);
    }
  });

  it("redacts the API key and its Bearer form from any output", () => {
    const redacted = redactApiKeyMaterial(
      {
        note: `token ${TWENTY_ONE_RISK_KEY}`,
        header: `Bearer ${TWENTY_ONE_RISK_KEY}`,
        nested: [{ key: TWENTY_ONE_RISK_KEY }],
      },
      TWENTY_ONE_RISK_KEY,
    );
    expect(JSON.stringify(redacted)).not.toContain(TWENTY_ONE_RISK_KEY);
    expect(redacted).toEqual({
      note: "token [REDACTED]",
      header: "[REDACTED]",
      nested: [{ key: "[REDACTED]" }],
    });
  });

  it("executes one fixed-origin bearer request and maps the vendor 401 to invalid_credential", async () => {
    const descriptor = getApiKeyProviderDescriptor("21risk")!;
    const okMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ value: [{ _KeyReportId: "r1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: TWENTY_ONE_RISK_KEY,
        action: "TWENTY_ONE_RISK_GET_REPORTS",
        input: { top: 1 },
        operation: "read",
      }),
    ).resolves.toEqual({
      output: { value: [{ _KeyReportId: "r1" }] },
      providerStatusClass: "ok",
    });
    const [requestUrl, requestInit] = okMock.mock.calls[0]!;
    expect(String(requestUrl)).toBe(
      "https://21risk.com/odata/v5/reports?%24top=1",
    );
    expect((requestInit?.headers as Headers).get("authorization")).toBe(
      `Bearer ${TWENTY_ONE_RISK_KEY}`,
    );
    expect(requestInit?.redirect).toBe("manual");
    okMock.mockRestore();

    // The apex OData service answers an invalid key with a 401 whose body names
    // the required scheme; the executor must classify it without leaking a body.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message:
            'Invalid auth header. Please provide "Bearer <api-key>". API-key should start with 21RISK.ND.xxxx',
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      executeApiKeyProviderAction({
        descriptor,
        apiKey: TWENTY_ONE_RISK_KEY,
        action: "TWENTY_ONE_RISK_GET_REPORTS",
        input: { top: 1 },
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "invalid_credential" });
    vi.restoreAllMocks();
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
