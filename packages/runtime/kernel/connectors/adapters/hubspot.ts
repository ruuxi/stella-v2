import {
  optionalRecord,
  requireString,
  seg,
  type ConnectorAdapter,
} from "./types.js";

/**
 * HubSpot CRM v3 — https://developers.hubspot.com/docs/api/crm/
 * Auth: OAuth2 (bearer). Base: https://api.hubapi.com
 */
export const HUBSPOT_ADAPTER: ConnectorAdapter = {
  id: "hubspot",
  displayName: "HubSpot",
  auth: "oauth",
  baseUrl: "https://api.hubapi.com",
  apiAuthScheme: "bearer",
  scopes: [
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.deals.read",
    "crm.objects.deals.write",
    "crm.objects.companies.read",
  ],
  docsUrl: "https://developers.hubspot.com/docs/api/crm/contacts",
  actions: [
    {
      name: "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
      title: "Search Contacts",
      description:
        "Search CRM contacts with HubSpot filter groups and return selected properties.",
      kind: "read",
      scopes: ["crm.objects.contacts.read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filterGroups: { type: "array", items: { type: "object" } },
          query: { type: "string" },
          properties: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
          after: { type: "string" },
        },
      },
      buildRequest: (input) => ({
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
      }),
    },
    {
      name: "HUBSPOT_READ_CONTACT",
      title: "Get Contact",
      description: "Retrieve a single contact by id with optional properties.",
      kind: "read",
      scopes: ["crm.objects.contacts.read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["contactId"],
        properties: {
          contactId: { type: "string" },
          properties: { type: "array", items: { type: "string" } },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: `/crm/v3/objects/contacts/${seg(requireString(input, "contactId", "HUBSPOT_READ_CONTACT"))}`,
        ...(Array.isArray(input.properties) && input.properties.length
          ? { query: { properties: input.properties.join(",") } }
          : {}),
      }),
    },
    {
      name: "HUBSPOT_CREATE_CONTACT",
      title: "Create Contact",
      description: "Create a CRM contact from a properties map.",
      kind: "write",
      scopes: ["crm.objects.contacts.write"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["properties"],
        properties: {
          properties: { type: "object", additionalProperties: true },
          associations: { type: "array", items: { type: "object" } },
        },
      },
      buildRequest: (input) => {
        const properties = optionalRecord(input, "properties");
        if (!properties) {
          throw new Error(
            "HUBSPOT_CREATE_CONTACT requires a `properties` object.",
          );
        }
        return {
          method: "POST",
          path: "/crm/v3/objects/contacts",
          body: {
            properties,
            ...(Array.isArray(input.associations)
              ? { associations: input.associations }
              : {}),
          },
        };
      },
    },
    {
      name: "HUBSPOT_UPDATE_CONTACT",
      title: "Update Contact",
      description: "Update an existing contact's properties by id.",
      kind: "write",
      scopes: ["crm.objects.contacts.write"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["contactId", "properties"],
        properties: {
          contactId: { type: "string" },
          properties: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const properties = optionalRecord(input, "properties");
        if (!properties) {
          throw new Error(
            "HUBSPOT_UPDATE_CONTACT requires a `properties` object.",
          );
        }
        return {
          method: "PATCH",
          path: `/crm/v3/objects/contacts/${seg(requireString(input, "contactId", "HUBSPOT_UPDATE_CONTACT"))}`,
          body: { properties },
        };
      },
    },
    {
      name: "HUBSPOT_LIST_DEALS",
      title: "List Deals",
      description: "List CRM deals with paging and selected properties.",
      kind: "read",
      scopes: ["crm.objects.deals.read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number" },
          after: { type: "string" },
          properties: { type: "array", items: { type: "string" } },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/crm/v3/objects/deals",
        query: {
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.after === "string" ? { after: input.after } : {}),
          ...(Array.isArray(input.properties) && input.properties.length
            ? { properties: input.properties.join(",") }
            : {}),
        },
      }),
    },
    {
      name: "HUBSPOT_CREATE_DEAL",
      title: "Create Deal",
      description: "Create a CRM deal from a properties map.",
      kind: "write",
      scopes: ["crm.objects.deals.write"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["properties"],
        properties: {
          properties: { type: "object", additionalProperties: true },
          associations: { type: "array", items: { type: "object" } },
        },
      },
      buildRequest: (input) => {
        const properties = optionalRecord(input, "properties");
        if (!properties) {
          throw new Error(
            "HUBSPOT_CREATE_DEAL requires a `properties` object.",
          );
        }
        return {
          method: "POST",
          path: "/crm/v3/objects/deals",
          body: {
            properties,
            ...(Array.isArray(input.associations)
              ? { associations: input.associations }
              : {}),
          },
        };
      },
    },
  ],
};
