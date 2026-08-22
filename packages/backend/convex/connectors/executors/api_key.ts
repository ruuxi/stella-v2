import { ConnectorError } from "../errors";

export type ApiKeyProviderRequest = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  bodyEncoding?: "json" | "form";
  headers?: Record<string, string>;
};

export type DeferredApiKeyProvider = {
  connectorId: string;
  providerKey: string;
  ownerFamily:
    "design_finance_ops" | "developer_data" | "social" | "crm_recruiting_sales";
  fixedApiOrigin?: string;
  requiresTenantOrigin?: boolean;
  /**
   * Per-action official host map for providers that expose one host per product
   * (e.g. Abstract: emailvalidation./phonevalidation./ipgeolocation.abstractapi.com).
   * Every value is an https origin; the planner still emits only relative paths.
   */
  fixedApiOriginByAction?: Readonly<Record<string, string>>;
  /**
   * Narrowly-allowlisted suffix for account/tenant-scoped origins (e.g. Snowflake
   * `.snowflakecomputing.com`). Bound only through resolveDeferredTenantOrigin,
   * which rejects any host outside this suffix — never an arbitrary host.
   */
  tenantOriginSuffix?: string;
  actions: Readonly<Record<string, "read" | "write">>;
  activationBlockers: readonly string[];
};

const API_KEY_CORE_BLOCKERS = [
  "deployment provider enablement and independent verification allowlists",
  "active encrypted owner-scoped credential",
  "real credential and representative provider call before rollout",
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

const requiredIdentifier = (
  input: Record<string, unknown>,
  key: string,
): string => {
  const value = input[key];
  if (
    (typeof value === "string" && value.trim()) ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return String(value).trim();
  }
  throw new ConnectorError("invalid_input");
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

type ApolloQueryParameter = readonly [
  inputName: string,
  apiName: string,
  shape: "scalar" | "array",
];

const apolloQueryPath = (
  path: string,
  input: Record<string, unknown>,
  parameters: readonly ApolloQueryParameter[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const [inputName, apiName, shape] of parameters) {
    const value = input[inputName];
    if (value === undefined) continue;
    if (shape === "array") {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new ConnectorError("invalid_input");
      }
      for (const item of value) url.searchParams.append(apiName, item);
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new ConnectorError("invalid_input");
    }
    url.searchParams.set(apiName, String(value));
  }
  return `${url.pathname}${url.search}`;
};

const pickDefined = (
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );

const APOLLO_TASK_TYPES = [
  "call",
  "outreach_manual_email",
  "linkedin_step_connect",
  "linkedin_step_message",
  "linkedin_step_view_profile",
  "linkedin_step_interact_post",
  "action_item",
] as const;
const APOLLO_TASK_STATUSES = ["scheduled", "completed", "skipped"] as const;
const APOLLO_TASK_PRIORITIES = ["high", "medium", "low"] as const;

const requiredApolloEnum = (
  input: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string => {
  const value = requiredString(input, key);
  if (!allowed.includes(value)) throw new ConnectorError("invalid_input");
  return value;
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

/**
 * 44API's public/upstream Composio action slugs are digit-leading (`44API_*`)
 * while the deferred planner table uses the established
 * `FORTYFOUR_API_*` aliases. Preserve the exact public contract and
 * canonicalize only for planner lookup and dispatch.
 */
export const canonicalizeDeferredActionName = (
  providerKey: string,
  action: string,
): string =>
  providerKey === "44api" && action.startsWith("44API_")
    ? action.replace(/^44API_/u, "FORTYFOUR_API_")
    : action;

const SNOWFLAKE_STATEMENT_PARAMS = [
  "warehouse",
  "database",
  "schema",
  "role",
  "timeout",
] as const;

/**
 * Build a Snowflake SQL API v2 `/api/v2/statements` body. The SQL statement is
 * always server-constructed or a required input; identifiers are passed as
 * bound parameters so the planner never string-concatenates untrusted input.
 */
const snowflakeStatementBody = (
  statement: string,
  input: Record<string, unknown>,
  bindings?: Record<string, { type: string; value: string }>,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { statement };
  for (const key of SNOWFLAKE_STATEMENT_PARAMS) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      body[key] = value;
    }
  }
  if (bindings) body.bindings = bindings;
  return body;
};

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
    fixedApiOrigin: "https://prod.0codekit.com",
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
      ["7SHIFTS_LIST_SHIFTS", "read"],
      ["7SHIFTS_CREATE_DEPARTMENT", "write"],
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
    connectorId: "snowflake",
    providerKey: "snowflake",
    // Snowflake authenticates with an OAuth bearer token, not an API key; this
    // deferred catalog only plans request shape and validates the account-scoped
    // origin. Token custody/injection stay deferred activation blockers, so no
    // token is ever placed here.
    ownerFamily: "developer_data",
    requiresTenantOrigin: true,
    tenantOriginSuffix: ".snowflakecomputing.com",
    actions: actions([
      ["SNOWFLAKE_LIST_DATABASES", "read"],
      ["SNOWFLAKE_DESCRIBE_TABLE", "read"],
      ["SNOWFLAKE_EXECUTE_SQL_QUERY", "write"],
    ]),
    activationBlockers: [
      "reviewed first-party Snowflake credential model matching the public product contract",
      "validated per-connection Snowflake account-scoped origin and OAuth token exchange",
      "deployment enablement, independent representative-call verification, and rollout",
    ],
  },
  {
    connectorId: "abstract",
    providerKey: "abstract",
    ownerFamily: "developer_data",
    // Abstract exposes one official host per product, all under *.abstractapi.com.
    fixedApiOriginByAction: {
      ABSTRACT_VALIDATE_EMAIL: "https://emailvalidation.abstractapi.com",
      ABSTRACT_VALIDATE_PHONE: "https://phonevalidation.abstractapi.com",
      ABSTRACT_GET_IP_GEOLOCATION: "https://ipgeolocation.abstractapi.com",
    },
    actions: actions([
      ["ABSTRACT_VALIDATE_EMAIL", "read"],
      ["ABSTRACT_VALIDATE_PHONE", "read"],
      ["ABSTRACT_GET_IP_GEOLOCATION", "read"],
    ]),
    activationBlockers: [
      ...API_KEY_CORE_BLOCKERS,
      "per-product Abstract host selection and per-product API-key custody",
    ],
  },
  {
    connectorId: "44api",
    providerKey: "44api",
    ownerFamily: "developer_data",
    fixedApiOrigin: "https://api.44api.dev",
    // Public/upstream slugs stay 44API_*; planner keys remain FORTYFOUR_API_*.
    actions: actions([
      ["FORTYFOUR_API_VALIDATE_VAT_NUMBER", "read"],
      ["FORTYFOUR_API_LIST_WHITELISTED_IPS", "read"],
      ["FORTYFOUR_API_ADD_WHITELISTED_IP", "write"],
      ["FORTYFOUR_API_REMOVE_WHITELISTED_IP", "write"],
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
  const canonicalAction = canonicalizeDeferredActionName(providerKey, action);
  switch (`${providerKey}:${canonicalAction}`) {
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
          `/v2/company/${encodeURIComponent(requiredIdentifier(input, "companyId"))}/${resource}`,
          input,
          ["limit", "cursor", "status", "start", "end", "location_id"],
        ),
        headers: { "x-api-version": "2026-01-01" },
      };
    }
    case "7shifts:SEVENSHIFTS_CREATE_SHIFT": {
      requiredIdentifier(input, "companyId");
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
    case "7shifts:7SHIFTS_LIST_SHIFTS": {
      const companyId = requiredIdentifier(input, "company_id");
      return {
        method: "GET",
        path: queryPath(
          `/v2/company/${encodeURIComponent(companyId)}/shifts`,
          input,
          [
            "location_id",
            "department_id",
            "role_id",
            "user_id",
            "start",
            "end",
            "limit",
            "cursor",
            "status",
          ],
        ),
        headers: { "x-api-version": "2026-01-01" },
      };
    }
    case "7shifts:7SHIFTS_CREATE_DEPARTMENT": {
      const companyId = requiredIdentifier(input, "company_id");
      const { company_id: _companyId, ...body } = input;
      requiredIdentifier(body, "location_id");
      requiredString(body, "name");
      if (typeof body.default !== "boolean") {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "POST",
        path: `/v2/company/${encodeURIComponent(companyId)}/departments`,
        body,
        headers: { "x-api-version": "2026-01-01" },
      };
    }

    case "apollo:APOLLO_PEOPLE_SEARCH":
      return {
        method: "POST",
        path: apolloQueryPath("/api/v1/mixed_people/api_search", input, [
          ["page", "page", "scalar"],
          ["per_page", "per_page", "scalar"],
          ["q_keywords", "q_keywords", "scalar"],
          ["person_titles", "person_titles[]", "array"],
          ["organization_ids", "organization_ids[]", "array"],
          ["person_locations", "person_locations[]", "array"],
          ["person_seniorities", "person_seniorities[]", "array"],
          ["contact_email_status", "contact_email_status[]", "array"],
          ["organization_locations", "organization_locations[]", "array"],
          ["q_organization_domains", "q_organization_domains_list[]", "array"],
          [
            "organization_num_employees_ranges",
            "organization_num_employees_ranges[]",
            "array",
          ],
        ]),
      };
    case "apollo:APOLLO_ORGANIZATION_SEARCH":
      return {
        method: "POST",
        path: apolloQueryPath("/api/v1/mixed_companies/search", input, [
          ["page", "page", "scalar"],
          ["per_page", "per_page", "scalar"],
          ["organization_ids", "organization_ids[]", "array"],
          ["q_organization_name", "q_organization_name", "scalar"],
          ["organization_locations", "organization_locations[]", "array"],
          [
            "organization_not_locations",
            "organization_not_locations[]",
            "array",
          ],
          [
            "q_organization_domains_list",
            "q_organization_domains_list[]",
            "array",
          ],
          [
            "q_organization_keyword_tags",
            "q_organization_keyword_tags[]",
            "array",
          ],
          [
            "organization_num_employees_ranges",
            "organization_num_employees_ranges[]",
            "array",
          ],
        ]),
      };
    case "apollo:APOLLO_PEOPLE_ENRICH":
      return {
        method: "POST",
        path: apolloQueryPath("/api/v1/people/match", input, [
          ["id", "id", "scalar"],
          ["name", "name", "scalar"],
          ["email", "email", "scalar"],
          ["domain", "domain", "scalar"],
          ["last_name", "last_name", "scalar"],
          ["first_name", "first_name", "scalar"],
          ["webhook_url", "webhook_url", "scalar"],
          ["hashed_email", "hashed_email", "scalar"],
          ["linkedin_url", "linkedin_url", "scalar"],
          ["organization_name", "organization_name", "scalar"],
          ["reveal_phone_number", "reveal_phone_number", "scalar"],
          ["reveal_personal_emails", "reveal_personal_emails", "scalar"],
        ]),
      };
    case "apollo:APOLLO_CREATE_CONTACT": {
      requiredString(input, "first_name");
      requiredString(input, "last_name");
      return {
        method: "POST",
        path: "/api/v1/contacts",
        body: pickDefined(input, [
          "email",
          "title",
          "last_name",
          "account_id",
          "first_name",
          "home_phone",
          "label_names",
          "other_phone",
          "website_url",
          "direct_phone",
          "mobile_phone",
          "corporate_phone",
          "contact_stage_id",
          "organization_name",
          "present_raw_address",
        ]),
      };
    }
    case "apollo:APOLLO_CREATE_TASK": {
      const body = pickDefined(input, [
        "note",
        "type",
        "title",
        "due_at",
        "status",
        "user_id",
        "priority",
        "contact_id",
      ]);
      body.type = requiredApolloEnum(input, "type", APOLLO_TASK_TYPES);
      body.status = requiredApolloEnum(input, "status", APOLLO_TASK_STATUSES);
      body.user_id = requiredString(input, "user_id");
      body.contact_id = requiredString(input, "contact_id");
      body.due_at = requiredString(input, "due_at");
      if (input.priority !== undefined) {
        body.priority = requiredApolloEnum(
          input,
          "priority",
          APOLLO_TASK_PRIORITIES,
        );
      }
      return { method: "POST", path: "/api/v1/tasks", body };
    }

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
          `/api/projects/${encodeURIComponent(requiredIdentifier(input, "project_id"))}/insights/`,
          input,
          ["limit", "offset", "short_id", "search"],
        ),
      };
    case "posthog:POSTHOG_LIST_FEATURE_FLAGS":
      return {
        method: "GET",
        path: queryPath(
          `/api/projects/${encodeURIComponent(requiredIdentifier(input, "project_id"))}/feature_flags/`,
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
      return {
        method: "POST",
        path: "/api/v2/report",
        body: input,
        bodyEncoding: "form",
      };

    case "snowflake:SNOWFLAKE_LIST_DATABASES":
      return {
        method: "POST",
        path: "/api/v2/statements",
        body: snowflakeStatementBody("SHOW DATABASES", input),
      };
    case "snowflake:SNOWFLAKE_DESCRIBE_TABLE":
      return {
        method: "POST",
        path: "/api/v2/statements",
        body: snowflakeStatementBody("DESCRIBE TABLE IDENTIFIER(?)", input, {
          "1": { type: "TEXT", value: requiredString(input, "table") },
        }),
      };
    case "snowflake:SNOWFLAKE_EXECUTE_SQL_QUERY":
      return {
        method: "POST",
        path: "/api/v2/statements",
        body: snowflakeStatementBody(requiredString(input, "statement"), input),
      };

    case "abstract:ABSTRACT_VALIDATE_EMAIL":
      requiredString(input, "email");
      return {
        method: "GET",
        path: queryPath("/v1/", input, ["email", "auto_correct"]),
      };
    case "abstract:ABSTRACT_VALIDATE_PHONE":
      requiredString(input, "phone");
      return {
        method: "GET",
        path: queryPath("/v1/", input, ["phone", "country"]),
      };
    case "abstract:ABSTRACT_GET_IP_GEOLOCATION":
      requiredString(input, "ip_address");
      return {
        method: "GET",
        path: queryPath("/v1/", input, ["ip_address", "fields"]),
      };

    case "44api:FORTYFOUR_API_VALIDATE_VAT_NUMBER":
      requiredString(input, "vatNumber");
      requiredString(input, "countryCode");
      return { method: "POST", path: "/webhook/validate-vat", body: input };
    case "44api:FORTYFOUR_API_LIST_WHITELISTED_IPS":
      return {
        method: "POST",
        path: "/webhook/ip-whitelist",
        body: { ...input, action: "list" },
      };
    case "44api:FORTYFOUR_API_ADD_WHITELISTED_IP":
      requiredString(input, "ipAddress");
      requiredString(input, "email");
      return {
        method: "POST",
        path: "/webhook/ip-whitelist",
        body: { ...input, action: "add" },
      };
    case "44api:FORTYFOUR_API_REMOVE_WHITELISTED_IP":
      requiredString(input, "ipAddress");
      return {
        method: "POST",
        path: "/webhook/ip-whitelist",
        body: { ...input, action: "remove" },
      };

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
    const actionNames = Object.keys(provider.actions);
    if (
      !provider.fixedApiOrigin &&
      !provider.requiresTenantOrigin &&
      !provider.fixedApiOriginByAction
    ) {
      problems.push(`${provider.connectorId} has no validated origin strategy`);
    }
    if (
      provider.fixedApiOrigin &&
      new URL(provider.fixedApiOrigin).protocol !== "https:"
    ) {
      problems.push(`${provider.connectorId} origin must be https`);
    }
    if (provider.fixedApiOriginByAction) {
      for (const [action, origin] of Object.entries(
        provider.fixedApiOriginByAction,
      )) {
        if (!(action in provider.actions)) {
          problems.push(
            `${provider.connectorId} per-action origin for unknown action ${action}`,
          );
        }
        let originUrl: URL | null = null;
        try {
          originUrl = new URL(origin);
        } catch {
          originUrl = null;
        }
        if (!originUrl || originUrl.protocol !== "https:") {
          problems.push(
            `${provider.connectorId} per-action origin must be https: ${action}`,
          );
        }
      }
      for (const action of actionNames) {
        if (!(action in provider.fixedApiOriginByAction)) {
          problems.push(
            `${provider.connectorId} action ${action} has no per-action origin`,
          );
        }
      }
    }
    if (provider.tenantOriginSuffix) {
      if (!provider.requiresTenantOrigin) {
        problems.push(
          `${provider.connectorId} tenant suffix requires requiresTenantOrigin`,
        );
      }
      if (
        !/^\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(
          provider.tenantOriginSuffix,
        )
      ) {
        problems.push(
          `${provider.connectorId} tenant suffix is not a safe domain suffix`,
        );
      }
    }
    if (actionNames.length === 0) {
      problems.push(`${provider.connectorId} has no actions`);
    }
    for (const action of actionNames) {
      if (
        !/^[A-Z][A-Z0-9_]*$/u.test(action) &&
        !(
          provider.connectorId === "7shifts" &&
          /^7SHIFTS_[A-Z0-9_]+$/u.test(action)
        )
      ) {
        problems.push(`${provider.connectorId} has unsafe action ${action}`);
      }
    }
  }
  return problems;
};

/**
 * Resolve the official https origin for a deferred action. Per-product hosts
 * (Abstract) are looked up by action; all others use the single fixed origin.
 * Returns null for tenant-scoped providers (use resolveDeferredTenantOrigin).
 */
export const resolveDeferredActionOrigin = (
  provider: DeferredApiKeyProvider,
  action: string,
): string | null => {
  if (provider.fixedApiOriginByAction) {
    const canonical = canonicalizeDeferredActionName(
      provider.providerKey,
      action,
    );
    return (
      provider.fixedApiOriginByAction[canonical] ??
      provider.fixedApiOriginByAction[action] ??
      null
    );
  }
  return provider.fixedApiOrigin ?? null;
};

/**
 * Bind an account/tenant-scoped origin under the provider's narrowly-allowlisted
 * suffix. Enforces https, an origin-only URL, and a real subdomain of the
 * official suffix; any host outside the suffix (or the bare suffix) is rejected.
 * This is the only sanctioned way to derive a tenant origin — arbitrary hosts
 * and token egress are never permitted.
 */
export const resolveDeferredTenantOrigin = (
  provider: DeferredApiKeyProvider,
  candidateOrigin: string,
): string | null => {
  if (!provider.requiresTenantOrigin || !provider.tenantOriginSuffix) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidateOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const suffix = provider.tenantOriginSuffix.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, host.length - suffix.length);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/u.test(label)) return null;
  return `https://${host}`;
};
