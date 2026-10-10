import { ConnectorError } from "../errors";

export type CrmProviderRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
    HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: "read",
    HUBSPOT_READ_CONTACT: "read",
    HUBSPOT_CREATE_CONTACT: "write",
    HUBSPOT_UPDATE_CONTACT: "write",
    HUBSPOT_LIST_DEALS: "read",
    HUBSPOT_CREATE_DEAL: "write",
  },
  gong: {
    GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS: "read",
    GONG_GET_CALL_BY_ID: "read",
    GONG_GET_CALL_TRANSCRIPT: "read",
    GONG_LIST_ALL_USERS_V2_USERS: "read",
    GONG_ADD_NEW_CALL_V2_CALLS: "write",
  },
  pipedrive: {
    PIPEDRIVE_GET_ALL_DEALS: "read",
    PIPEDRIVE_SEARCH_PERSONS: "read",
    PIPEDRIVE_CREATE_PERSON: "write",
    PIPEDRIVE_ADD_A_DEAL: "write",
    PIPEDRIVE_DEALS_UPDATE_DEAL: "write",
    PIPEDRIVE_ADD_NOTE: "write",
  },
  salesforce: {
    SALESFORCE_RUN_SOQL_QUERY: "read",
    SALESFORCE_GET_S_OBJECT_RECORD: "read",
    SALESFORCE_CREATE_A_RECORD: "write",
    SALESFORCE_UPDATE_RECORD: "write",
    SALESFORCE_CREATE_LEAD: "write",
  },
  attio: {
    ATTIO_LIST_OBJECTS: "read",
    ATTIO_QUERY_RECORDS: "read",
    ATTIO_GET_RECORD: "read",
    ATTIO_CREATE_RECORD: "write",
    ATTIO_UPDATE_RECORD: "write",
  },
};

export const CRM_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  hubspot: {
    HUBSPOT_LIST_CONTACTS: ["crm.objects.contacts.read"],
    HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: ["crm.objects.contacts.read"],
    HUBSPOT_READ_CONTACT: ["crm.objects.contacts.read"],
    HUBSPOT_CREATE_CONTACT: ["crm.objects.contacts.write"],
    HUBSPOT_UPDATE_CONTACT: ["crm.objects.contacts.write"],
    HUBSPOT_LIST_DEALS: ["crm.objects.deals.read"],
    HUBSPOT_CREATE_DEAL: ["crm.objects.deals.write"],
  },
  gong: {
    GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS: ["api:calls:read:basic"],
    GONG_GET_CALL_BY_ID: ["api:calls:read:basic"],
    GONG_GET_CALL_TRANSCRIPT: ["api:calls:read:transcript"],
    GONG_LIST_ALL_USERS_V2_USERS: ["api:users:read"],
    GONG_ADD_NEW_CALL_V2_CALLS: ["api:calls:create"],
  },
  pipedrive: {
    PIPEDRIVE_GET_ALL_DEALS: ["deals:read"],
    PIPEDRIVE_SEARCH_PERSONS: ["contacts:read"],
    PIPEDRIVE_CREATE_PERSON: ["contacts:full"],
    PIPEDRIVE_ADD_A_DEAL: ["deals:full"],
    PIPEDRIVE_DEALS_UPDATE_DEAL: ["deals:full"],
    PIPEDRIVE_ADD_NOTE: ["deals:full"],
  },
  salesforce: {
    SALESFORCE_RUN_SOQL_QUERY: ["api"],
    SALESFORCE_GET_S_OBJECT_RECORD: ["api"],
    SALESFORCE_CREATE_A_RECORD: ["api"],
    SALESFORCE_UPDATE_RECORD: ["api"],
    SALESFORCE_CREATE_LEAD: ["api"],
  },
  attio: {
    ATTIO_LIST_OBJECTS: ["object_configuration:read"],
    ATTIO_QUERY_RECORDS: ["record_permission:read"],
    ATTIO_GET_RECORD: ["record_permission:read"],
    ATTIO_CREATE_RECORD: ["record_permission:read-write"],
    ATTIO_UPDATE_RECORD: ["record_permission:read-write"],
  },
};

/** Exact public connector ids owned by each CRM provider action. */
export const CRM_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  hubspot: {
    hubspot: Object.keys(CRM_ACTION_OPERATIONS.hubspot),
  },
  gong: {
    gong: Object.keys(CRM_ACTION_OPERATIONS.gong),
  },
  pipedrive: {
    pipedrive: Object.keys(CRM_ACTION_OPERATIONS.pipedrive),
  },
  salesforce: {
    salesforce: Object.keys(CRM_ACTION_OPERATIONS.salesforce),
  },
  attio: {
    attio: Object.keys(CRM_ACTION_OPERATIONS.attio),
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
    case "hubspot:HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA":
      return {
        method: "POST",
        path: "/crm/v3/objects/contacts/search",
        body: {
          ...(Array.isArray(input.filterGroups)
            ? { filterGroups: input.filterGroups }
            : {}),
          ...(typeof input.query === "string" ? { query: input.query } : {}),
          ...(Array.isArray(input.properties)
            ? { properties: input.properties }
            : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.after === "string" ? { after: input.after } : {}),
        },
      };
    case "hubspot:HUBSPOT_READ_CONTACT": {
      const contactId = encodeURIComponent(requiredString(input, "contactId"));
      const path = `/crm/v3/objects/contacts/${contactId}`;
      return {
        method: "GET",
        path:
          Array.isArray(input.properties) && input.properties.length > 0
            ? `${path}?properties=${encodeURIComponent(input.properties.join(","))}`
            : path,
      };
    }
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
    case "hubspot:HUBSPOT_UPDATE_CONTACT":
      return {
        method: "PATCH",
        path: `/crm/v3/objects/contacts/${encodeURIComponent(requiredString(input, "contactId"))}`,
        body: { properties: requiredRecord(input, "properties") },
      };
    case "hubspot:HUBSPOT_LIST_DEALS": {
      const path = withQuery("/crm/v3/objects/deals", input, [
        "limit",
        "after",
        "archived",
      ]);
      const properties = Array.isArray(input.properties)
        ? input.properties.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return {
        method: "GET",
        path:
          properties.length > 0
            ? `${path}${path.includes("?") ? "&" : "?"}properties=${encodeURIComponent(properties.join(","))}`
            : path,
      };
    }
    case "hubspot:HUBSPOT_CREATE_DEAL":
      return {
        method: "POST",
        path: "/crm/v3/objects/deals",
        body: {
          properties: requiredRecord(input, "properties"),
          ...(Array.isArray(input.associations)
            ? { associations: input.associations }
            : {}),
        },
      };

    case "gong:GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS":
      return {
        method: "GET",
        path: withQuery("/v2/calls", input, [
          "fromDateTime",
          "toDateTime",
          "cursor",
        ]),
      };
    case "gong:GONG_GET_CALL_BY_ID":
      return {
        method: "GET",
        path: `/v2/calls/${encodeURIComponent(requiredString(input, "callId"))}`,
      };
    case "gong:GONG_GET_CALL_TRANSCRIPT":
      return {
        method: "POST",
        path: "/v2/calls/transcript",
        body: {
          filter:
            input.filter &&
            typeof input.filter === "object" &&
            !Array.isArray(input.filter)
              ? input.filter
              : {},
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        },
      };
    case "gong:GONG_LIST_ALL_USERS_V2_USERS":
      return {
        method: "GET",
        path: withQuery("/v2/users", input, ["cursor", "includeAvatars"]),
      };
    case "gong:GONG_ADD_NEW_CALL_V2_CALLS":
      return {
        method: "POST",
        path: "/v2/calls",
        body: requiredRecord(input, "call"),
      };

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
    case "pipedrive:PIPEDRIVE_SEARCH_PERSONS":
      requiredString(input, "term");
      return {
        method: "GET",
        path: withQuery("/api/v1/persons/search", input, [
          "term",
          "fields",
          "limit",
        ]),
      };
    case "pipedrive:PIPEDRIVE_CREATE_PERSON":
      requiredString(input, "name");
      return { method: "POST", path: "/api/v1/persons", body: input };
    case "pipedrive:PIPEDRIVE_DEALS_UPDATE_DEAL": {
      const id = input.id;
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        String(id).trim() === ""
      ) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "PUT",
        path: `/api/v1/deals/${encodeURIComponent(String(id))}`,
        body: requiredRecord(input, "fields"),
      };
    }
    case "pipedrive:PIPEDRIVE_ADD_NOTE":
      requiredString(input, "content");
      return { method: "POST", path: "/api/v1/notes", body: input };

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
    case "salesforce:SALESFORCE_GET_S_OBJECT_RECORD": {
      const objectName = requiredString(input, "sobject");
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(objectName)) {
        throw new ConnectorError("invalid_input");
      }
      const id = encodeURIComponent(requiredString(input, "id"));
      const path = `/services/data/v61.0/sobjects/${objectName}/${id}`;
      return {
        method: "GET",
        path:
          Array.isArray(input.fields) && input.fields.length > 0
            ? `${path}?fields=${encodeURIComponent(input.fields.join(","))}`
            : path,
      };
    }
    case "salesforce:SALESFORCE_UPDATE_RECORD": {
      const objectName = requiredString(input, "sobject");
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(objectName)) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "PATCH",
        path: `/services/data/v61.0/sobjects/${objectName}/${encodeURIComponent(requiredString(input, "id"))}`,
        body: requiredRecord(input, "fields"),
      };
    }
    case "salesforce:SALESFORCE_CREATE_LEAD":
      return {
        method: "POST",
        path: "/services/data/v61.0/sobjects/Lead",
        body: requiredRecord(input, "fields"),
      };

    case "attio:ATTIO_LIST_OBJECTS":
      return { method: "GET", path: "/v2/objects" };
    case "attio:ATTIO_QUERY_RECORDS": {
      const objectType = requiredString(input, "object", "object_type");
      return {
        method: "POST",
        path: `/v2/objects/${encodeURIComponent(objectType)}/records/query`,
        body: {
          ...(input.filter &&
          typeof input.filter === "object" &&
          !Array.isArray(input.filter)
            ? { filter: input.filter }
            : {}),
          ...(Array.isArray(input.sorts) ? { sorts: input.sorts } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        },
      };
    }
    case "attio:ATTIO_GET_RECORD": {
      const objectType = requiredString(input, "object", "object_type");
      return {
        method: "GET",
        path: `/v2/objects/${encodeURIComponent(objectType)}/records/${encodeURIComponent(requiredString(input, "recordId", "record_id"))}`,
      };
    }
    case "attio:ATTIO_CREATE_RECORD": {
      const objectType = requiredString(input, "object", "object_type");
      return {
        method: "POST",
        path: `/v2/objects/${encodeURIComponent(objectType)}/records`,
        body: { data: { values: requiredRecord(input, "values") } },
      };
    }
    case "attio:ATTIO_UPDATE_RECORD": {
      const objectType = requiredString(input, "object", "object_type");
      return {
        method: "PATCH",
        path: `/v2/objects/${encodeURIComponent(objectType)}/records/${encodeURIComponent(requiredString(input, "recordId", "record_id"))}`,
        body: { data: { values: requiredRecord(input, "values") } },
      };
    }
    default:
      return null;
  }
};
