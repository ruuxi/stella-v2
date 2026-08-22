import { ConnectorError } from "../errors";

export type CrmProviderRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

const requiredString = (
  input: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new ConnectorError("invalid_input");
};

const requiredRecord = (
  input: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> => {
  for (const key of keys) {
    const value = input[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  throw new ConnectorError("invalid_input");
};

const withQuery = (
  path: string,
  input: Record<string, unknown>,
  allowed: readonly string[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const key of allowed) {
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

export const CRM_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, "read" | "write">>>
> = {
  hubspot: {
    HUBSPOT_LIST_CONTACTS: "read",
    HUBSPOT_CREATE_CONTACT: "write",
  },
  gong: {
    GONG_LIST_ALL_USERS_V2_USERS: "read",
    GONG_ADD_NEW_CALL_V2_CALLS: "write",
  },
  pipedrive: {
    PIPEDRIVE_GET_ALL_DEALS: "read",
    PIPEDRIVE_ADD_A_DEAL: "write",
  },
  salesforce: {
    SALESFORCE_RUN_SOQL_QUERY: "read",
    SALESFORCE_CREATE_A_RECORD: "write",
  },
  attio: {
    ATTIO_LIST_OBJECTS: "read",
    ATTIO_CREATE_RECORD: "write",
  },
};

export const CRM_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  hubspot: {
    HUBSPOT_LIST_CONTACTS: ["crm.objects.contacts.read"],
    HUBSPOT_CREATE_CONTACT: ["crm.objects.contacts.write"],
  },
  gong: {
    GONG_LIST_ALL_USERS_V2_USERS: ["api:users:read"],
    GONG_ADD_NEW_CALL_V2_CALLS: ["api:calls:create"],
  },
  pipedrive: {
    PIPEDRIVE_GET_ALL_DEALS: ["deals:read"],
    PIPEDRIVE_ADD_A_DEAL: ["deals:full"],
  },
  salesforce: {
    SALESFORCE_RUN_SOQL_QUERY: ["api"],
    SALESFORCE_CREATE_A_RECORD: ["api"],
  },
  attio: {
    ATTIO_LIST_OBJECTS: ["object_configuration:read"],
    ATTIO_CREATE_RECORD: ["record_permission:read-write"],
  },
};

/** Exact public connector ids owned by each CRM provider action. */
export const CRM_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  hubspot: {
    hubspot: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"],
  },
  gong: {
    gong: ["GONG_LIST_ALL_USERS_V2_USERS", "GONG_ADD_NEW_CALL_V2_CALLS"],
  },
  pipedrive: {
    pipedrive: ["PIPEDRIVE_GET_ALL_DEALS", "PIPEDRIVE_ADD_A_DEAL"],
  },
  salesforce: {
    salesforce: ["SALESFORCE_RUN_SOQL_QUERY", "SALESFORCE_CREATE_A_RECORD"],
  },
  attio: {
    attio: ["ATTIO_LIST_OBJECTS", "ATTIO_CREATE_RECORD"],
  },
};

export const buildCrmProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): CrmProviderRequest | null => {
  switch (`${providerKey}:${action}`) {
    case "hubspot:HUBSPOT_LIST_CONTACTS":
      return {
        method: "GET",
        path: withQuery("/crm/v3/objects/contacts", input, [
          "limit",
          "after",
          "archived",
          "properties",
          "associations",
        ]),
      };
    case "hubspot:HUBSPOT_CREATE_CONTACT":
      return {
        method: "POST",
        path: "/crm/v3/objects/contacts",
        body: {
          properties: requiredRecord(input, "properties"),
          ...(Array.isArray(input.associations)
            ? { associations: input.associations }
            : {}),
        },
      };

    case "gong:GONG_LIST_ALL_USERS_V2_USERS":
      return {
        method: "GET",
        path: withQuery("/v2/users", input, ["cursor", "includeAvatars"]),
      };
    case "gong:GONG_ADD_NEW_CALL_V2_CALLS":
      return { method: "POST", path: "/v2/calls", body: input };

    case "pipedrive:PIPEDRIVE_GET_ALL_DEALS":
      return {
        method: "GET",
        path: withQuery("/api/v1/deals", input, [
          "user_id",
          "filter_id",
          "stage_id",
          "status",
          "start",
          "limit",
          "sort",
          "owned_by_you",
        ]),
      };
    case "pipedrive:PIPEDRIVE_ADD_A_DEAL":
      requiredString(input, "title");
      return { method: "POST", path: "/api/v1/deals", body: input };

    case "salesforce:SALESFORCE_RUN_SOQL_QUERY": {
      const query = requiredString(input, "q", "query", "soql");
      return {
        method: "GET",
        path: `/services/data/v61.0/query?q=${encodeURIComponent(query)}`,
      };
    }
    case "salesforce:SALESFORCE_CREATE_A_RECORD": {
      const objectName = requiredString(
        input,
        "sobject",
        "object",
        "object_name",
        "objectType",
      );
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(objectName)) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "POST",
        path: `/services/data/v61.0/sobjects/${objectName}`,
        body: requiredRecord(input, "record", "data", "fields"),
      };
    }

    case "attio:ATTIO_LIST_OBJECTS":
      return { method: "GET", path: "/v2/objects" };
    case "attio:ATTIO_CREATE_RECORD": {
      const objectType = requiredString(input, "object_type", "object");
      return {
        method: "POST",
        path: `/v2/objects/${encodeURIComponent(objectType)}/records`,
        body: { data: { values: requiredRecord(input, "values") } },
      };
    }
    default:
      return null;
  }
};
