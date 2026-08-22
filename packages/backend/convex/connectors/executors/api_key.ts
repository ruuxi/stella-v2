import { ConnectorError } from "../errors";

export type ApiKeyProviderRequest = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type DeferredApiKeyProvider = {
  connectorId: string;
  providerKey: string;
  ownerFamily:
    | "design_finance_ops"
    | "developer_data"
    | "social"
    | "crm_recruiting_sales";
  fixedApiOrigin?: string;
  requiresTenantOrigin?: boolean;
  actions: Readonly<Record<string, "read" | "write">>;
  activationBlockers: readonly string[];
};

const API_KEY_CORE_BLOCKERS = [
  "server-side per-user API-key vault and credential lifecycle",
  "catalog schema publication",
  "real credential and representative provider call",
] as const;

const requiredString = (
  input: Record<string, unknown>,
  key: string,
): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorError("invalid_input");
  }
  return value.trim();
};

const queryPath = (
  path: string,
  input: Record<string, unknown>,
  keys: readonly string[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const key of keys) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
};

const odataPath = (entity: string, input: Record<string, unknown>): string => {
  const url = new URL(`/odata/${entity}`, "https://request.invalid");
  for (const key of [
    "top",
    "skip",
    "count",
    "filter",
    "select",
    "orderby",
    "expand",
  ]) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      url.searchParams.set(`$${key}`, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
};

const actions = (
  entries: readonly (readonly [string, "read" | "write"])[],
): Readonly<Record<string, "read" | "write">> => Object.fromEntries(entries);

export const DEFERRED_API_KEY_PROVIDERS: readonly DeferredApiKeyProvider[] = [
  {
    connectorId: "1password",
    providerKey: "1password",
    ownerFamily: "design_finance_ops",
    requiresTenantOrigin: true,
    actions: actions([
      ["ONEPASSWORD_LIST_VAULTS", "read"],
      ["ONEPASSWORD_LIST_ITEMS", "read"],
      ["ONEPASSWORD_GET_ITEM", "read"],
      ["ONEPASSWORD_CREATE_ITEM", "write"],
    ]),
    activationBlockers: [
      ...API_KEY_CORE_BLOCKERS,
      "validated per-connection 1Password Connect HTTPS origin",
    ],
  },
  {
    connectorId: "abyssale",
    providerKey: "abyssale",
    ownerFamily: "design_finance_ops",
    fixedApiOrigin: "https://api.abyssale.com",
    actions: actions([
      ["ABYSSALE_LIST_TEMPLATES", "read"],
      ["ABYSSALE_GET_TEMPLATE", "read"],
      ["ABYSSALE_GENERATE_IMAGE", "write"],
      ["ABYSSALE_GENERATE_IMAGE_ASYNC", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "0codekit",
    providerKey: "0codekit",
    ownerFamily: "design_finance_ops",
    fixedApiOrigin: "https://api.0codekit.com",
    actions: actions([
      ["ZEROCODEKIT_PDF_METADATA", "read"],
      ["ZEROCODEKIT_HTML_TO_PDF", "write"],
      ["ZEROCODEKIT_MERGE_PDF", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "peopledatalabs",
    providerKey: "peopledatalabs",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.peopledatalabs.com",
    actions: actions([
      ["PEOPLEDATALABS_ENRICH_PERSON_DATA", "read"],
      ["PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC", "read"],
      ["PEOPLEDATALABS_ENRICH_COMPANY_DATA", "read"],
      ["PEOPLEDATALABS_SEARCH_COMPANY_ELASTIC", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "21risk",
    providerKey: "21risk",
    ownerFamily: "crm_recruiting_sales",
    requiresTenantOrigin: true,
    actions: actions([
      ["TWENTY_ONE_RISK_GET_REPORTS", "read"],
      ["TWENTY_ONE_RISK_GET_COMPLIANCE", "read"],
      ["TWENTY_ONE_RISK_GET_ORGANIZATIONS", "read"],
      ["TWENTY_ONE_RISK_GET_PROPERTIES", "read"],
      ["TWENTY_ONE_RISK_GET_RISK_MODELS", "read"],
    ]),
    activationBlockers: [
      ...API_KEY_CORE_BLOCKERS,
      "tenant-specific 21RISK OData origin and base-path confirmation",
    ],
  },
  {
    connectorId: "2chat",
    providerKey: "2chat",
    ownerFamily: "social",
    fixedApiOrigin: "https://api.p.2chat.io",
    actions: actions([
      ["TWOCHAT_GET_INFO", "read"],
      ["TWOCHAT_LIST_WHATSAPP_NUMBERS", "read"],
      ["TWOCHAT_SEND_WHATSAPP_MESSAGE", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "7shifts",
    providerKey: "7shifts",
    ownerFamily: "design_finance_ops",
    fixedApiOrigin: "https://api.7shifts.com",
    actions: actions([
      ["SEVENSHIFTS_WHOAMI", "read"],
      ["SEVENSHIFTS_LIST_USERS", "read"],
      ["SEVENSHIFTS_LIST_SHIFTS", "read"],
      ["SEVENSHIFTS_CREATE_SHIFT", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "apollo",
    providerKey: "apollo",
    ownerFamily: "crm_recruiting_sales",
    fixedApiOrigin: "https://api.apollo.io",
    actions: actions([
      ["APOLLO_PEOPLE_SEARCH", "read"],
      ["APOLLO_ORGANIZATION_SEARCH", "read"],
      ["APOLLO_PEOPLE_ENRICH", "read"],
      ["APOLLO_CREATE_CONTACT", "write"],
      ["APOLLO_CREATE_TASK", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "ashby",
    providerKey: "ashby",
    ownerFamily: "crm_recruiting_sales",
    fixedApiOrigin: "https://api.ashbyhq.com",
    actions: actions([
      ["ASHBY_LIST_CANDIDATES", "read"],
      ["ASHBY_SEARCH_CANDIDATES", "read"],
      ["ASHBY_CREATE_CANDIDATE", "write"],
      ["ASHBY_LIST_JOBS", "read"],
      ["ASHBY_CREATE_NOTE", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "firecrawl",
    providerKey: "firecrawl",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.firecrawl.dev",
    actions: actions([
      ["FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM", "read"],
      ["FIRECRAWL_SEARCH", "read"],
      ["FIRECRAWL_CRAWL", "write"],
      ["FIRECRAWL_CRAWL_GET", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "tavily",
    providerKey: "tavily",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.tavily.com",
    actions: actions([
      ["TAVILY_SEARCH", "read"],
      ["TAVILY_EXTRACT", "read"],
      ["TAVILY_MAP", "read"],
      ["TAVILY_CRAWL", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "exa",
    providerKey: "exa",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.exa.ai",
    actions: actions([
      ["EXA_SEARCH", "read"],
      ["EXA_GET_CONTENTS_ACTION", "read"],
      ["EXA_ANSWER", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "serpapi",
    providerKey: "serpapi",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://serpapi.com",
    actions: actions([
      ["SERPAPI_SEARCH", "read"],
      ["SERPAPI_NEWS_SEARCH", "read"],
      ["SERPAPI_BING_SEARCH", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "perplexityai",
    providerKey: "perplexityai",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.perplexity.ai",
    actions: actions([
      ["PERPLEXITYAI_SEARCH", "read"],
      ["PERPLEXITYAI_CREATE_CHAT_COMPLETION", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "posthog",
    providerKey: "posthog",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://us.posthog.com",
    actions: actions([
      ["POSTHOG_LIST_PROJECTS", "read"],
      ["POSTHOG_GET_INSIGHTS", "read"],
      ["POSTHOG_LIST_FEATURE_FLAGS", "read"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "ably",
    providerKey: "ably",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://rest.ably.io",
    actions: actions([
      ["ABLY_GET_CHANNEL_HISTORY", "read"],
      ["ABLY_LIST_CHANNELS", "read"],
      ["ABLY_GET_STATS", "read"],
      ["ABLY_PUBLISH_MESSAGE", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
  {
    connectorId: "abuseipdb",
    providerKey: "abuseipdb",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.abuseipdb.com",
    actions: actions([
      ["ABUSEIPDB_CHECK_IP", "read"],
      ["ABUSEIPDB_GET_BLACKLIST", "read"],
      ["ABUSEIPDB_CHECK_BLOCK", "read"],
      ["ABUSEIPDB_REPORT_IP", "write"],
    ]),
    activationBlockers: API_KEY_CORE_BLOCKERS,
  },
];

export const buildApiKeyProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): ApiKeyProviderRequest | null => {
  switch (`${providerKey}:${action}`) {
    case "1password:ONEPASSWORD_LIST_VAULTS":
      return {
        method: "GET",
        path: queryPath("/v1/vaults", input, ["filter"]),
      };
    case "1password:ONEPASSWORD_LIST_ITEMS":
      return {
        method: "GET",
        path: queryPath(
          `/v1/vaults/${encodeURIComponent(requiredString(input, "vaultUuid"))}/items`,
          input,
          ["filter"],
        ),
      };
    case "1password:ONEPASSWORD_GET_ITEM":
      return {
        method: "GET",
        path: `/v1/vaults/${encodeURIComponent(requiredString(input, "vaultUuid"))}/items/${encodeURIComponent(requiredString(input, "itemUuid"))}`,
      };
    case "1password:ONEPASSWORD_CREATE_ITEM":
      requiredString(input, "vaultUuid");
      return {
        method: "POST",
        path: `/v1/vaults/${encodeURIComponent(requiredString(input, "vaultUuid"))}/items`,
        body: Object.fromEntries(
          Object.entries({
            ...input,
            category: requiredString(input, "category"),
            title: requiredString(input, "title"),
          }).filter(([key]) => key !== "vaultUuid"),
        ),
      };

    case "abyssale:ABYSSALE_LIST_TEMPLATES":
      return { method: "GET", path: "/templates" };
    case "abyssale:ABYSSALE_GET_TEMPLATE":
      return {
        method: "GET",
        path: `/templates/${encodeURIComponent(requiredString(input, "templateId"))}`,
      };
    case "abyssale:ABYSSALE_GENERATE_IMAGE":
    case "abyssale:ABYSSALE_GENERATE_IMAGE_ASYNC": {
      const prefix = action.endsWith("_ASYNC") ? "/async" : "";
      const templateId = encodeURIComponent(
        requiredString(input, "templateId"),
      );
      const { templateId: _templateId, ...body } = input;
      return {
        method: "POST",
        path: `${prefix}/banner-builder/${templateId}/generate`,
        body,
      };
    }

    case "0codekit:ZEROCODEKIT_PDF_METADATA":
      return { method: "POST", path: "/pdf/metadata/info", body: input };
    case "0codekit:ZEROCODEKIT_HTML_TO_PDF":
      return { method: "POST", path: "/pdf/html", body: input };
    case "0codekit:ZEROCODEKIT_MERGE_PDF":
      if (!Array.isArray(input.files) || input.files.length === 0) {
        throw new ConnectorError("invalid_input");
      }
      return { method: "POST", path: "/pdf/merge", body: input };

    case "peopledatalabs:PEOPLEDATALABS_ENRICH_PERSON_DATA":
      return {
        method: "GET",
        path: queryPath("/v5/person/enrich", input, Object.keys(input)),
      };
    case "peopledatalabs:PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC":
      return { method: "POST", path: "/v5/person/search", body: input };
    case "peopledatalabs:PEOPLEDATALABS_ENRICH_COMPANY_DATA":
      return {
        method: "GET",
        path: queryPath("/v5/company/enrich", input, Object.keys(input)),
      };
    case "peopledatalabs:PEOPLEDATALABS_SEARCH_COMPANY_ELASTIC":
      return { method: "POST", path: "/v5/company/search", body: input };

    case "21risk:TWENTY_ONE_RISK_GET_REPORTS":
    case "21risk:TWENTY_ONE_RISK_GET_COMPLIANCE":
    case "21risk:TWENTY_ONE_RISK_GET_ORGANIZATIONS":
    case "21risk:TWENTY_ONE_RISK_GET_PROPERTIES":
    case "21risk:TWENTY_ONE_RISK_GET_RISK_MODELS": {
      const entity = action
        .replace("TWENTY_ONE_RISK_GET_", "")
        .toLowerCase()
        .replace(/(^|_)([a-z])/gu, (_match, _prefix, letter: string) =>
          letter.toUpperCase(),
        );
      const aliases: Record<string, string> = {
        RiskModels: "RiskModels",
      };
      return {
        method: "GET",
        path: odataPath(aliases[entity] ?? entity, input),
      };
    }

    case "2chat:TWOCHAT_GET_INFO":
      return { method: "GET", path: "/open/info" };
    case "2chat:TWOCHAT_LIST_WHATSAPP_NUMBERS":
      return {
        method: "GET",
        path: queryPath("/open/whatsapp/get-numbers", input, ["page_number"]),
      };
    case "2chat:TWOCHAT_SEND_WHATSAPP_MESSAGE":
      requiredString(input, "to_number");
      requiredString(input, "from_number");
      requiredString(input, "text");
      return {
        method: "POST",
        path: "/open/whatsapp/send-message",
        body: input,
      };

    case "7shifts:SEVENSHIFTS_WHOAMI":
      return {
        method: "GET",
        path: "/v2/whoami",
        headers: { "x-api-version": "2026-01-01" },
      };
    case "7shifts:SEVENSHIFTS_LIST_USERS":
    case "7shifts:SEVENSHIFTS_LIST_SHIFTS": {
      const resource = action.endsWith("_USERS") ? "users" : "shifts";
      return {
        method: "GET",
        path: queryPath(
          `/v2/company/${encodeURIComponent(requiredString(input, "companyId"))}/${resource}`,
          input,
          ["limit", "cursor", "status", "start", "end", "location_id"],
        ),
        headers: { "x-api-version": "2026-01-01" },
      };
    }
    case "7shifts:SEVENSHIFTS_CREATE_SHIFT": {
      requiredString(input, "companyId");
      const { companyId, ...body } = input;
      for (const key of ["location_id", "user_id", "start", "end"]) {
        if (body[key] === undefined || body[key] === null) {
          throw new ConnectorError("invalid_input");
        }
      }
      return {
        method: "POST",
        path: `/v2/company/${encodeURIComponent(String(companyId))}/shifts`,
        body,
        headers: { "x-api-version": "2026-01-01" },
      };
    }

    case "apollo:APOLLO_PEOPLE_SEARCH":
      return { method: "POST", path: "/v1/mixed_people/search", body: input };
    case "apollo:APOLLO_ORGANIZATION_SEARCH":
      return {
        method: "POST",
        path: "/v1/mixed_companies/search",
        body: input,
      };
    case "apollo:APOLLO_PEOPLE_ENRICH":
      return { method: "POST", path: "/v1/people/match", body: input };
    case "apollo:APOLLO_CREATE_CONTACT":
      requiredString(input, "first_name");
      requiredString(input, "last_name");
      return { method: "POST", path: "/v1/contacts", body: input };
    case "apollo:APOLLO_CREATE_TASK":
      requiredString(input, "priority");
      requiredString(input, "type");
      if (!Array.isArray(input.contact_ids) || input.contact_ids.length === 0) {
        throw new ConnectorError("invalid_input");
      }
      return { method: "POST", path: "/v1/tasks/bulk_create", body: input };

    case "ashby:ASHBY_LIST_CANDIDATES":
      return { method: "POST", path: "/candidate.list", body: input };
    case "ashby:ASHBY_SEARCH_CANDIDATES":
      return { method: "POST", path: "/candidate.search", body: input };
    case "ashby:ASHBY_CREATE_CANDIDATE":
      requiredString(input, "name");
      return { method: "POST", path: "/candidate.create", body: input };
    case "ashby:ASHBY_LIST_JOBS":
      return { method: "POST", path: "/job.list", body: input };
    case "ashby:ASHBY_CREATE_NOTE":
      requiredString(input, "candidateId");
      requiredString(input, "note");
      return { method: "POST", path: "/candidate.createNote", body: input };

    case "firecrawl:FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM":
      requiredString(input, "url");
      return { method: "POST", path: "/v2/scrape", body: input };
    case "firecrawl:FIRECRAWL_SEARCH":
      requiredString(input, "query");
      return { method: "POST", path: "/v2/search", body: input };
    case "firecrawl:FIRECRAWL_CRAWL":
      requiredString(input, "url");
      return { method: "POST", path: "/v2/crawl", body: input };
    case "firecrawl:FIRECRAWL_CRAWL_GET":
      return {
        method: "GET",
        path: `/v2/crawl/${encodeURIComponent(requiredString(input, "id"))}`,
      };

    case "tavily:TAVILY_SEARCH":
      requiredString(input, "query");
      return { method: "POST", path: "/search", body: input };
    case "tavily:TAVILY_EXTRACT":
      return { method: "POST", path: "/extract", body: input };
    case "tavily:TAVILY_MAP":
      requiredString(input, "url");
      return { method: "POST", path: "/map", body: input };
    case "tavily:TAVILY_CRAWL":
      requiredString(input, "url");
      return { method: "POST", path: "/crawl", body: input };

    case "exa:EXA_SEARCH":
      requiredString(input, "query");
      return { method: "POST", path: "/search", body: input };
    case "exa:EXA_GET_CONTENTS_ACTION":
      return { method: "POST", path: "/contents", body: input };
    case "exa:EXA_ANSWER":
      requiredString(input, "query");
      return { method: "POST", path: "/answer", body: input };

    case "serpapi:SERPAPI_SEARCH":
    case "serpapi:SERPAPI_NEWS_SEARCH":
    case "serpapi:SERPAPI_BING_SEARCH": {
      requiredString(input, "q");
      const engine =
        action === "SERPAPI_NEWS_SEARCH"
          ? "google_news"
          : action === "SERPAPI_BING_SEARCH"
            ? "bing"
            : "google";
      return {
        method: "GET",
        path: queryPath("/search", { ...input, engine }, [
          "engine",
          "q",
          "location",
          "google_domain",
          "gl",
          "hl",
          "num",
          "start",
          "device",
          "safe",
        ]),
      };
    }

    case "perplexityai:PERPLEXITYAI_SEARCH":
      requiredString(input, "query");
      return { method: "POST", path: "/search", body: input };
    case "perplexityai:PERPLEXITYAI_CREATE_CHAT_COMPLETION":
      if (!Array.isArray(input.messages) || input.messages.length === 0) {
        throw new ConnectorError("invalid_input");
      }
      return { method: "POST", path: "/chat/completions", body: input };

    case "posthog:POSTHOG_LIST_PROJECTS":
      return { method: "GET", path: "/api/projects/" };
    case "posthog:POSTHOG_GET_INSIGHTS":
      return {
        method: "GET",
        path: queryPath(
          `/api/projects/${encodeURIComponent(requiredString(input, "project_id"))}/insights/`,
          input,
          ["limit", "offset", "short_id", "search"],
        ),
      };
    case "posthog:POSTHOG_LIST_FEATURE_FLAGS":
      return {
        method: "GET",
        path: queryPath(
          `/api/projects/${encodeURIComponent(requiredString(input, "project_id"))}/feature_flags/`,
          input,
          ["limit", "offset", "search"],
        ),
      };

    case "ably:ABLY_GET_CHANNEL_HISTORY":
      return {
        method: "GET",
        path: queryPath(
          `/channels/${encodeURIComponent(requiredString(input, "channel"))}/messages`,
          input,
          ["start", "end", "direction", "limit"],
        ),
      };
    case "ably:ABLY_LIST_CHANNELS":
      return {
        method: "GET",
        path: queryPath("/channels", input, ["limit", "prefix", "by"]),
      };
    case "ably:ABLY_GET_STATS":
      return {
        method: "GET",
        path: queryPath("/stats", input, [
          "start",
          "end",
          "direction",
          "limit",
          "unit",
        ]),
      };
    case "ably:ABLY_PUBLISH_MESSAGE": {
      const channel = encodeURIComponent(requiredString(input, "channel"));
      const { channel: _channel, ...body } = input;
      return { method: "POST", path: `/channels/${channel}/messages`, body };
    }

    case "abuseipdb:ABUSEIPDB_CHECK_IP":
      requiredString(input, "ipAddress");
      return {
        method: "GET",
        path: queryPath("/api/v2/check", input, [
          "ipAddress",
          "maxAgeInDays",
          "verbose",
        ]),
      };
    case "abuseipdb:ABUSEIPDB_GET_BLACKLIST":
      return {
        method: "GET",
        path: queryPath("/api/v2/blacklist", input, [
          "confidenceMinimum",
          "limit",
          "onlyCountries",
          "exceptCountries",
          "ipVersion",
        ]),
      };
    case "abuseipdb:ABUSEIPDB_CHECK_BLOCK":
      requiredString(input, "network");
      return {
        method: "GET",
        path: queryPath("/api/v2/check-block", input, [
          "network",
          "maxAgeInDays",
        ]),
      };
    case "abuseipdb:ABUSEIPDB_REPORT_IP":
      requiredString(input, "ip");
      requiredString(input, "categories");
      return { method: "POST", path: "/api/v2/report", body: input };

    default:
      return null;
  }
};

export const validateDeferredApiKeyProviderCatalog = (): string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const provider of DEFERRED_API_KEY_PROVIDERS) {
    if (ids.has(provider.connectorId)) {
      problems.push(`duplicate connector id ${provider.connectorId}`);
    }
    ids.add(provider.connectorId);
    if (!provider.fixedApiOrigin && !provider.requiresTenantOrigin) {
      problems.push(`${provider.connectorId} has no validated origin strategy`);
    }
    if (
      provider.fixedApiOrigin &&
      new URL(provider.fixedApiOrigin).protocol !== "https:"
    ) {
      problems.push(`${provider.connectorId} origin must be https`);
    }
    const actionNames = Object.keys(provider.actions);
    if (actionNames.length === 0) {
      problems.push(`${provider.connectorId} has no actions`);
    }
    for (const action of actionNames) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(action)) {
        problems.push(`${provider.connectorId} has unsafe action ${action}`);
      }
    }
  }
  return problems;
};
