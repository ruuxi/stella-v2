import { ConnectorError } from "../errors";
import { isProviderEnabled } from "../env";
import {
  buildApiKeyProviderRequest,
  DEFERRED_API_KEY_PROVIDERS,
  type ApiKeyProviderRequest,
} from "../executors/api_key";

export type ApiKeyAuthPlacement =
  | { type: "bearer" }
  | { type: "header"; headerName: "x-api-key" }
  | { type: "query"; queryParam: "api_key" }
  | { type: "basic"; format: "username_empty_password" };

export type ApiKeyActionDescriptor = {
  operation: "read" | "write";
  inputSchema: Record<string, unknown>;
};

export type ApiKeyProviderDescriptor = {
  connectorId: string;
  providerKey: string;
  displayName: string;
  credentialLabel: string;
  apiOrigin: string;
  auth: ApiKeyAuthPlacement;
  actions: Readonly<Record<string, ApiKeyActionDescriptor>>;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  additionalProperties = true,
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties,
});

const FIRECRAWL_ACTIONS = {
  FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM: {
    operation: "read",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        formats: { type: "array" },
        onlyMainContent: { type: "boolean" },
        includeTags: { type: "array" },
        excludeTags: { type: "array" },
        waitFor: { type: "number" },
        timeout: { type: "number" },
      },
      ["url"],
    ),
  },
  FIRECRAWL_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        limit: { type: "number" },
        lang: { type: "string" },
        country: { type: "string" },
        location: { type: "string" },
        scrapeOptions: { type: "object" },
      },
      ["query"],
    ),
  },
  FIRECRAWL_CRAWL: {
    operation: "write",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        prompt: { type: "string" },
        includePaths: { type: "array" },
        excludePaths: { type: "array" },
        limit: { type: "number" },
        scrapeOptions: { type: "object" },
        webhook: { type: "object" },
      },
      ["url"],
    ),
  },
  FIRECRAWL_CRAWL_GET: {
    operation: "read",
    inputSchema: objectSchema(
      { id: { type: "string", minLength: 1 } },
      ["id"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const EXA_ACTIONS = {
  EXA_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        type: { type: "string" },
        category: { type: "string" },
        numResults: { type: "number" },
        contents: { type: "object" },
      },
      ["query"],
    ),
  },
  EXA_GET_CONTENTS_ACTION: {
    operation: "read",
    inputSchema: objectSchema(
      {
        ids: { type: "array", minItems: 1, items: { type: "string" } },
        text: {},
        highlights: {},
        summary: {},
      },
      ["ids"],
    ),
  },
  EXA_ANSWER: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        text: { type: "boolean" },
        stream: { type: "boolean" },
      },
      ["query"],
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const SERPAPI_ACTIONS = Object.fromEntries(
  ["SERPAPI_SEARCH", "SERPAPI_NEWS_SEARCH", "SERPAPI_BING_SEARCH"].map(
    (action) => [
      action,
      {
        operation: "read" as const,
        inputSchema: objectSchema(
          {
            q: { type: "string", minLength: 1 },
            location: { type: "string" },
            google_domain: { type: "string" },
            gl: { type: "string" },
            hl: { type: "string" },
            num: { type: "number" },
            start: { type: "number" },
            device: { type: "string" },
            safe: { type: "string" },
          },
          ["q"],
          false,
        ),
      },
    ],
  ),
) as Readonly<Record<string, ApiKeyActionDescriptor>>;

const ASHBY_ACTIONS = {
  ASHBY_LIST_CANDIDATES: {
    operation: "read",
    inputSchema: objectSchema(
      {
        limit: { type: "number" },
        cursor: { type: "string" },
        syncToken: { type: "string" },
      },
      [],
      false,
    ),
  },
  ASHBY_SEARCH_CANDIDATES: {
    operation: "read",
    inputSchema: objectSchema(
      { email: { type: "string" }, name: { type: "string" } },
      [],
      false,
    ),
  },
  ASHBY_CREATE_CANDIDATE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        name: { type: "string", minLength: 1 },
        email: { type: "string" },
        phoneNumber: { type: "string" },
        linkedInUrl: { type: "string" },
      },
      ["name"],
    ),
  },
  ASHBY_LIST_JOBS: {
    operation: "read",
    inputSchema: objectSchema(
      { limit: { type: "number" }, cursor: { type: "string" } },
      [],
      false,
    ),
  },
  ASHBY_CREATE_NOTE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        candidateId: { type: "string", minLength: 1 },
        note: { type: "string", minLength: 1 },
        sendNotifications: { type: "boolean" },
      },
      ["candidateId", "note"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

/**
 * This is deliberately a small reviewed activation set, not an open provider
 * registry. Every origin and credential placement is compiled into backend
 * code. The larger planner catalog remains deferred until a descriptor and
 * representative provider verification are added here.
 */
export const API_KEY_PROVIDER_DESCRIPTORS = [
  {
    connectorId: "firecrawl",
    providerKey: "firecrawl",
    displayName: "Firecrawl",
    credentialLabel: "Firecrawl API key",
    apiOrigin: "https://api.firecrawl.dev",
    auth: { type: "bearer" },
    actions: FIRECRAWL_ACTIONS,
  },
  {
    connectorId: "exa",
    providerKey: "exa",
    displayName: "Exa",
    credentialLabel: "Exa API key",
    apiOrigin: "https://api.exa.ai",
    auth: { type: "header", headerName: "x-api-key" },
    actions: EXA_ACTIONS,
  },
  {
    connectorId: "serpapi",
    providerKey: "serpapi",
    displayName: "SerpAPI",
    credentialLabel: "SerpAPI key",
    apiOrigin: "https://serpapi.com",
    auth: { type: "query", queryParam: "api_key" },
    actions: SERPAPI_ACTIONS,
  },
  {
    connectorId: "ashby",
    providerKey: "ashby",
    displayName: "Ashby",
    credentialLabel: "Ashby API key",
    apiOrigin: "https://api.ashbyhq.com",
    auth: { type: "basic", format: "username_empty_password" },
    actions: ASHBY_ACTIONS,
  },
] as const satisfies readonly ApiKeyProviderDescriptor[];

const descriptorByConnector = new Map<string, ApiKeyProviderDescriptor>(
  API_KEY_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.connectorId,
    descriptor as ApiKeyProviderDescriptor,
  ]),
);
const descriptorByProvider = new Map<string, ApiKeyProviderDescriptor>(
  API_KEY_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.providerKey,
    descriptor as ApiKeyProviderDescriptor,
  ]),
);

export const getApiKeyProviderDescriptor = (
  connectorId: string,
): ApiKeyProviderDescriptor | null =>
  descriptorByConnector.get(connectorId.trim().toLowerCase()) ?? null;

export const getApiKeyProviderDescriptorByKey = (
  providerKey: string,
): ApiKeyProviderDescriptor | null =>
  descriptorByProvider.get(providerKey.trim().toLowerCase()) ?? null;

export const apiKeyProviderForConnectorAction = (
  connectorId: string,
  action: string,
): ApiKeyProviderDescriptor | null => {
  const descriptor = getApiKeyProviderDescriptor(connectorId);
  return descriptor?.actions[action] ? descriptor : null;
};

export const validateApiKeyCredential = (
  value: string,
  auth?: ApiKeyAuthPlacement,
): string => {
  if (
    value.length < 8 ||
    value.length > 1024 ||
    value !== value.trim() ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    (auth?.type === "basic" && value.includes(":"))
  ) {
    throw new ConnectorError("invalid_credential");
  }
  return value;
};

export const isApiKeyProviderVerified = (providerKey: string): boolean => {
  const raw = process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(providerKey.trim().toLowerCase());
};

export const requireReadyApiKeyProvider = (
  connectorId: string,
): ApiKeyProviderDescriptor => {
  const descriptor = getApiKeyProviderDescriptor(connectorId);
  if (!descriptor) throw new ConnectorError("provider_not_configured");
  if (!isApiKeyProviderVerified(descriptor.providerKey)) {
    throw new ConnectorError("provider_unverified");
  }
  if (!isProviderEnabled(descriptor.providerKey)) {
    throw new ConnectorError("provider_disabled");
  }
  return descriptor;
};

export const buildDescriptorRequest = (
  descriptor: ApiKeyProviderDescriptor,
  action: string,
  input: Record<string, unknown>,
): ApiKeyProviderRequest => {
  if (!descriptor.actions[action]) throw new ConnectorError("action_not_found");
  const request = buildApiKeyProviderRequest(
    descriptor.providerKey,
    action,
    input,
  );
  if (!request) throw new ConnectorError("action_not_found");
  return request;
};

export const validateApiKeyProviderDescriptors = (): string[] => {
  const problems: string[] = [];
  const connectorIds = new Set<string>();
  const providerKeys = new Set<string>();
  const deferredByConnector = new Map(
    DEFERRED_API_KEY_PROVIDERS.map((provider) => [
      provider.connectorId,
      provider,
    ]),
  );
  for (const descriptor of API_KEY_PROVIDER_DESCRIPTORS) {
    if (connectorIds.has(descriptor.connectorId)) {
      problems.push(`duplicate connector ${descriptor.connectorId}`);
    }
    if (providerKeys.has(descriptor.providerKey)) {
      problems.push(`duplicate provider ${descriptor.providerKey}`);
    }
    connectorIds.add(descriptor.connectorId);
    providerKeys.add(descriptor.providerKey);
    const deferred = deferredByConnector.get(descriptor.connectorId);
    if (
      !deferred ||
      deferred.providerKey !== descriptor.providerKey ||
      deferred.fixedApiOrigin !== descriptor.apiOrigin
    ) {
      problems.push(
        `${descriptor.connectorId} does not match the planner catalog`,
      );
    }
    try {
      const origin = new URL(descriptor.apiOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== descriptor.apiOrigin ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      ) {
        problems.push(
          `${descriptor.connectorId} origin is not a fixed HTTPS origin`,
        );
      }
    } catch {
      problems.push(`${descriptor.connectorId} origin is invalid`);
    }
    for (const [action, actionDescriptor] of Object.entries(
      descriptor.actions,
    )) {
      if (deferred?.actions[action] !== actionDescriptor.operation) {
        problems.push(`${descriptor.connectorId}:${action} operation mismatch`);
      }
      if (actionDescriptor.inputSchema.type !== "object") {
        problems.push(
          `${descriptor.connectorId}:${action} has no object schema`,
        );
      }
    }
  }
  return problems;
};
