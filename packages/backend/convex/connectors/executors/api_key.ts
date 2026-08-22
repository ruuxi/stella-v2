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
